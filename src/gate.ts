import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  diffDigest,
  isInitialized,
  loadKey,
  readAttestation,
  verifyDigest,
  type Attestation,
  type Coverage,
} from "./attestation.js";
import { collectDiff } from "./diff.js";
import { buildProbes } from "./probes.js";

/** install-hook wires the same gate into pre-push. */

export type UncoveredHunk = { id: string; file: string; reason: string };

export type GateResult = {
  ok: boolean;
  base: string;
  head: string;
  uncovered: UncoveredHunk[];
  coverage: Coverage;
};

/**
 * Verify recomputes the diff and the probe keys from the branch itself, then
 * checks the sealed record against both: this is why editing the branch after
 * sealing, or hand-editing the record, cannot produce a green gate. `head`
 * names the commit to verify; it defaults to HEAD and is passed explicitly by
 * the pre-push gate so a checkout cannot vouch for another branch.
 */
export function verify(options: { base: string; head?: string; cwd?: string }): GateResult {
  const cwd = options.cwd ?? process.cwd();
  const diff = collectDiff(options.base, cwd, options.head);
  const probes = buildProbes(diff);
  const nonExempt = diff.hunks.filter((hunk) => hunk.exempt === undefined);
  const exempt = diff.hunks.length - nonExempt.length;
  const reasons = new Map<string, string>();
  const failAll = (reason: string): void => {
    for (const hunk of nonExempt) {
      if (!reasons.has(hunk.id)) {
        reasons.set(hunk.id, reason);
      }
    }
  };

  const key = loadKey(cwd);
  const record: Attestation | null = readAttestation(diff.head, cwd);

  if (!isInitialized(cwd)) {
    failAll("run `hunkwise init` first: .hunkwise/config.json or the local key is missing");
  } else if (!record) {
    failAll(`no attestation for ${diff.head.slice(0, 12)}`);
  } else if (!key) {
    failAll("no .hunkwise/key; run hunkwise init");
  } else if (!verifyDigest(record, key)) {
    failAll("attestation digest is invalid");
  } else if (record.diff_sha256 !== diffDigest(diff)) {
    failAll("branch diff changed since the attestation");
  } else if (record.coverage.total !== nonExempt.length) {
    failAll("attestation covers a different number of hunks");
  } else {
    const attested = new Map(record.hunks.map((hunk) => [hunk.id, hunk]));
    const probesByHunk = new Map<string, typeof probes.probes>();
    for (const probe of probes.probes) {
      const list = probesByHunk.get(probe.hunk_id) ?? [];
      list.push(probe);
      probesByHunk.set(probe.hunk_id, list);
    }

    for (const hunk of nonExempt) {
      const sealed = attested.get(hunk.id);
      if (!sealed) {
        reasons.set(hunk.id, "hunk is not in the attestation");
        continue;
      }
      if (sealed.fingerprint !== hunk.fingerprint) {
        reasons.set(hunk.id, "hunk changed since the attestation");
        continue;
      }
      if (!sealed.covered) {
        reasons.set(hunk.id, "not covered");
        continue;
      }
      // Re-grade against the freshly derived keys: a record whose answer keys
      // no longer match the diff is stale even if its digest is valid.
      const sealedProbes = new Map(sealed.probes.map((probe) => [probe.id, probe]));
      for (const probe of probesByHunk.get(hunk.id) ?? []) {
        const answered = sealedProbes.get(probe.id);
        if (!answered || !answered.correct) {
          reasons.set(hunk.id, `probe ${probe.id} is unanswered`);
          break;
        }
        if (answered.answer_index !== probe.answer_index) {
          reasons.set(hunk.id, `answer key for ${probe.id} changed`);
          break;
        }
      }
    }
  }

  const uncovered: UncoveredHunk[] = nonExempt
    .filter((hunk) => reasons.has(hunk.id))
    .map((hunk) => ({ id: hunk.id, file: hunk.file, reason: reasons.get(hunk.id) ?? "uncovered" }));
  const covered = nonExempt.length - uncovered.length;
  const total = nonExempt.length;
  return {
    ok: uncovered.length === 0,
    base: diff.base,
    head: diff.head,
    uncovered,
    coverage: {
      total,
      covered,
      exempt,
      ratio: total === 0 ? 1 : covered / total,
    },
  };
}

const HOOK_MARKER = "hunkwise:pre-push";

export type PushRef = {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
};

export type PushedRefResult = {
  ref: string;
  oid: string;
  status: "skipped-deletion" | "skipped-not-commit" | "covered" | "blocked" | "unverifiable";
  result?: GateResult;
  error?: string;
};

export type PushGateResult = { ok: boolean; refs: PushedRefResult[]; checked: number };

/**
 * Parses the four space-separated fields git sends to pre-push. A line that
 * does not have exactly four fields is unverifiable, so it rejects rather than
 * being silently ignored.
 */
export function parsePushRefs(input: string): PushRef[] {
  const refs: PushRef[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(`malformed pre-push ref line: ${line}`);
    }
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    refs.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return refs;
}

type PushObject =
  | { kind: "commit"; oid: string }
  | { kind: "skip" }
  | { kind: "missing" };

/**
 * Resolves a pushed object to a commit. Tags are peeled; blobs/trees are not
 * pushable branch commits and are skipped; a missing object is unverifiable.
 */
function resolvePushedObject(oid: string, cwd: string): PushObject {
  const type = gitOutput(["cat-file", "-t", oid], cwd);
  if (type.status !== 0) {
    return { kind: "missing" };
  }
  const kind = type.stdout.trim();
  if (kind === "commit") {
    return { kind: "commit", oid };
  }
  if (kind !== "tag") {
    return { kind: "skip" };
  }
  const peeled = gitOutput(["rev-parse", "--verify", `${oid}^{commit}`], cwd);
  return peeled.status === 0 ? { kind: "commit", oid: peeled.stdout.trim() } : { kind: "skip" };
}

/**
 * Runs the gate over every commit a push would publish. Deletions (all-zero
 * local oid) are allowed, non-commit objects are skipped, and any pushed
 * branch that is uncovered or cannot be checked blocks the whole push. The
 * checked-out HEAD is never used as a substitute for the pushed ref.
 */
export function verifyPushedRefs(
  input: string,
  options: { base: string; cwd?: string },
): PushGateResult {
  const cwd = options.cwd ?? process.cwd();
  const refs = parsePushRefs(input);
  const byCommit = new Map<string, PushedRefResult>();
  const results: PushedRefResult[] = [];

  for (const ref of refs) {
    if (/^0+$/.test(ref.localOid)) {
      results.push({ ref: ref.localRef, oid: ref.localOid, status: "skipped-deletion" });
      continue;
    }

    const object = resolvePushedObject(ref.localOid, cwd);
    if (object.kind === "skip") {
      results.push({ ref: ref.localRef, oid: ref.localOid, status: "skipped-not-commit" });
      continue;
    }
    if (object.kind === "missing") {
      results.push({
        ref: ref.localRef,
        oid: ref.localOid,
        status: "unverifiable",
        error: "object is missing from the local repository",
      });
      continue;
    }

    const cached = byCommit.get(object.oid);
    if (cached) {
      results.push({ ...cached, ref: ref.localRef });
      continue;
    }

    try {
      const result = verify({ base: options.base, head: object.oid, cwd });
      const entry: PushedRefResult = {
        ref: ref.localRef,
        oid: object.oid,
        status: result.ok ? "covered" : "blocked",
        result,
      };
      byCommit.set(object.oid, entry);
      results.push(entry);
    } catch (error) {
      results.push({
        ref: ref.localRef,
        oid: object.oid,
        status: "unverifiable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = results.every(
    (entry) => entry.status === "covered" || entry.status.startsWith("skipped-"),
  );
  const checked = results.filter(
    (entry) =>
      entry.status === "covered" || entry.status === "blocked" || entry.status === "unverifiable",
  ).length;
  return { ok, refs: results, checked };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitOutput(args: string[], cwd: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`failed to run git: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

export type InstallHookResult = { path: string; command: string };

/**
 * The absolute path the hook will run. It must survive the process that is
 * writing it: `process.argv[1]` may be a `node_modules/.bin` symlink (npm
 * link, local install), so it is resolved through realpath, and a path inside
 * the npx cache is refused outright — `~/.npm/_npx/<hash>/...` is deleted when
 * the cache is pruned, and a hook pointing there fails on a day nobody is
 * debugging it. Installing the package locally or globally gives a stable path.
 */
function resolveEntryPoint(): string {
  const invoked = process.argv[1];
  if (!invoked) {
    throw new Error(
      "cannot determine the hunkwise entry point; run install-hook through the installed hunkwise binary",
    );
  }
  const absolute = path.resolve(invoked);
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    throw new Error(`cannot resolve the hunkwise entry point at ${absolute}`);
  }
  const segments = resolved.split(path.sep);
  const npxIndex = segments.indexOf("_npx");
  if (npxIndex !== -1) {
    throw new Error(
      "refusing to write a pre-push hook that points into the npx cache " +
        `(${segments.slice(0, npxIndex + 2).join(path.sep)}): that directory is temporary, ` +
        "so the hook would break later. Install hunkwise in this repo (npm i -D hunkwise) or " +
        "globally (npm i -g hunkwise), then run install-hook again.",
    );
  }
  return resolved;
}

/**
 * Writes an executable pre-push hook that hands git's ref list to verify-push,
 * which checks every pushed commit. It refuses to pretend: when
 * `core.hooksPath` points somewhere else, `.git/hooks/pre-push` would never
 * run, so that is an error rather than a silent no-op. An unrecognized
 * existing hook is preserved, not overwritten.
 */
export function installHook(options: { base: string; cwd?: string }): InstallHookResult {
  const cwd = options.cwd ?? process.cwd();

  const hooksPath = gitOutput(["rev-parse", "--git-path", "hooks"], cwd);
  if (hooksPath.status !== 0) {
    throw new Error("not a git repository; run install-hook inside the repo");
  }
  const hooksDir = path.resolve(cwd, hooksPath.stdout.trim());

  const configured = gitOutput(["config", "--get", "core.hooksPath"], cwd);
  if (configured.status === 0) {
    const hooksPathValue = configured.stdout.trim();
    if (hooksPathValue !== "") {
      throw new Error(
        `core.hooksPath is set to "${hooksPathValue}", so .git/hooks/pre-push would be ignored. ` +
          "Unset it (git config --unset core.hooksPath) or add the hunkwise verify call to that hooks directory manually.",
      );
    }
  } else if (configured.status > 1) {
    throw new Error("could not read core.hooksPath from git config");
  }

  const hookPath = path.join(hooksDir, "pre-push");
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(HOOK_MARKER)) {
      throw new Error(
        `refusing to overwrite the existing pre-push hook at ${hookPath}; ` +
          "move it aside or add the hunkwise verify call manually.",
      );
    }
  }

  const nodePath = process.execPath;
  const scriptPath = resolveEntryPoint();
  const script = [
    "#!/bin/sh",
    `# ${HOOK_MARKER} - reject pushes with uncovered hunks.`,
    '# stdin carries "<local_ref> <local_oid> <remote_ref> <remote_oid>" per ref.',
    "# verify-push checks every pushed commit, never the checked-out HEAD.",
    `${shellQuote(nodePath)} ${shellQuote(scriptPath)} verify-push --base ${shellQuote(options.base)}`,
    "status=$?",
    'if [ "$status" -ne 0 ]; then',
    `  echo "hunkwise: push rejected; answer the probes and seal before pushing again." >&2`,
    "fi",
    'exit "$status"',
    "",
  ].join("\n");

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, { encoding: "utf8", mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return {
    path: hookPath,
    command: `${nodePath} ${scriptPath} verify-push --base ${options.base}`,
  };
}
