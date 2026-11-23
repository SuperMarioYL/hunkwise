import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DiffFile, Hunk } from "./diff.js";
import type { Probe, ProbesFile } from "./probes.js";

/**
 * Seals the reviewer's coverage into a tamper-evident record.
 *
 * The digest is HMAC-SHA256 over canonical JSON with a local key, so editing
 * any field after sealing is detectable. It is not an identity claim: anyone
 * with the repo and the key can produce a record. docs/GRADING.md says so
 * plainly.
 */

export const ATTESTATION_SCHEMA = "hunkwise/attestation@1" as const;
export const ANSWERS_SCHEMA = "hunkwise/answers@1" as const;

const HEX64 = /^[0-9a-f]{64}$/;

export const AttestedProbeSchema = z.object({
  id: z.string().min(1),
  answer_index: z.number().int().min(0).max(3),
  correct: z.boolean(),
});

export const AttestedHunkSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().regex(HEX64),
  covered: z.boolean(),
  attempts: z.number().int().min(0),
  probes: z.array(AttestedProbeSchema),
});

export const CoverageSchema = z.object({
  total: z.number().int().min(0),
  covered: z.number().int().min(0),
  exempt: z.number().int().min(0),
  ratio: z.number().min(0).max(1),
});

export const AttestationSchema = z.object({
  schema: z.literal(ATTESTATION_SCHEMA),
  base: z.string().min(1),
  head: z.string().min(1),
  diff_sha256: z.string().regex(HEX64),
  reviewer: z.string().min(1),
  hunks: z.array(AttestedHunkSchema),
  coverage: CoverageSchema,
  digest: z.string().regex(HEX64),
});

export type AttestedProbe = z.infer<typeof AttestedProbeSchema>;
export type AttestedHunk = z.infer<typeof AttestedHunkSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Attestation = z.infer<typeof AttestationSchema>;

/** Per-probe state persisted by the workbench so a later `attest` can seal it. */
export type AnswerState = { attempts: number; correct: boolean };
export type AnswerLog = Record<string, AnswerState>;

export type AnswersFile = {
  schema: typeof ANSWERS_SCHEMA;
  base: string;
  head: string;
  diff_sha256: string;
  entries: AnswerLog;
};

/** Final answer is allowed twice: one wrong answer unlocks exactly one retry. */
export const MAX_ATTEMPTS = 2;

/** Stable JSON: object keys sorted, arrays kept in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 over the canonical diff document; binds a record to one branch state. */
export function diffDigest(diff: DiffFile): string {
  return createHash("sha256").update(canonicalJson(diff)).digest("hex");
}

function keyPath(cwd: string): string {
  return path.join(cwd, ".hunkwise", "key");
}

function parseKey(raw: string): Buffer | null {
  const hex = raw.trim();
  return HEX64.test(hex) ? Buffer.from(hex, "hex") : null;
}

export function loadKey(cwd = process.cwd()): Buffer | null {
  const file = keyPath(cwd);
  if (!existsSync(file)) {
    return null;
  }
  return parseKey(readFileSync(file, "utf8"));
}

export const CONFIG_SCHEMA = "hunkwise/config@1" as const;
export const DEFAULT_BASE = "origin/main";

export const ConfigSchema = z.object({
  schema: z.literal(CONFIG_SCHEMA),
  base: z.string().min(1),
});

export type HunkwiseConfig = z.infer<typeof ConfigSchema>;

export function configPath(cwd = process.cwd()): string {
  return path.join(cwd, ".hunkwise", "config.json");
}

/** Reads the init marker; a missing or malformed file means "not initialized". */
export function readConfig(cwd = process.cwd()): HunkwiseConfig | null {
  const file = configPath(cwd);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function isInitialized(cwd = process.cwd()): boolean {
  return readConfig(cwd) !== null && loadKey(cwd) !== null;
}

/**
 * The base ref a command should gate on: an explicit --base wins, otherwise
 * the base recorded by `init`. `init` always writes one, so a repo that has
 * run init never needs the flag; a repo that has not gets a message telling
 * the user which of the two remedies applies.
 */
export function resolveBase(options: { base?: string; cwd?: string } = {}): string {
  const explicit = options.base?.trim();
  if (explicit) {
    return explicit;
  }
  const config = readConfig(options.cwd ?? process.cwd());
  if (config) {
    return config.base;
  }
  throw new Error("no base configured — run hunkwise init or pass --base <ref>");
}

export function requireInit(cwd = process.cwd()): void {
  if (!isInitialized(cwd)) {
    throw new Error(
      "this repo is not initialized; run `hunkwise init` to write .hunkwise/config.json and the local HMAC key",
    );
  }
}

const GITIGNORE_LINE = ".hunkwise/";

export type InitResult = {
  dir: string;
  configPath: string;
  configCreated: boolean;
  base: string;
  keyPath: string;
  keyCreated: boolean;
  gitignorePath: string;
  gitignoreUpdated: boolean;
};

/**
 * Creates the local state every other command relies on. It is safe to run
 * twice: the config, key, and .gitignore line are each left alone when they
 * already exist, so an existing key is never overwritten.
 */
export function initProject(options: { base?: string; cwd?: string } = {}): InitResult {
  const cwd = options.cwd ?? process.cwd();
  const dir = path.join(cwd, ".hunkwise");
  mkdirSync(dir, { recursive: true });

  // Validate an existing key before writing anything, so a corrupt key stops
  // init instead of leaving a half-initialized project behind.
  const keyFile = keyPath(cwd);
  if (existsSync(keyFile) && parseKey(readFileSync(keyFile, "utf8")) === null) {
    throw new Error(
      `existing key at ${keyFile} is not a 32-byte hex key; refusing to overwrite it. Remove it and run hunkwise init again.`,
    );
  }

  const configFile = configPath(cwd);
  const existingConfig = readConfig(cwd);
  // An existing config wins because init never rewrites one.
  const base = existingConfig?.base ?? options.base ?? DEFAULT_BASE;
  let configCreated = false;
  if (!existsSync(configFile)) {
    writeFileSync(
      configFile,
      `${JSON.stringify({ schema: CONFIG_SCHEMA, base }, null, 2)}\n`,
      "utf8",
    );
    configCreated = true;
  }

  let keyCreated = false;
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // writeFileSync's mode is masked by umask; chmod makes 0600 exact.
    chmodSync(keyFile, 0o600);
    keyCreated = true;
  }

  const gitignore = path.join(cwd, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const listed = current
    .split(/\r?\n/)
    .some((line) => line.trim() === GITIGNORE_LINE || line.trim() === ".hunkwise");
  let gitignoreUpdated = false;
  if (!listed) {
    const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    writeFileSync(gitignore, `${prefix}${GITIGNORE_LINE}\n`, "utf8");
    gitignoreUpdated = true;
  }

  return {
    dir,
    configPath: configFile,
    configCreated,
    base,
    keyPath: keyFile,
    keyCreated,
    gitignorePath: gitignore,
    gitignoreUpdated,
  };
}

/** `init` owns key creation; attest creates one lazily so a direct run works. */
export function loadOrCreateKey(cwd = process.cwd()): Buffer {
  const existing = loadKey(cwd);
  if (existing) {
    return existing;
  }
  const file = keyPath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const hex = randomBytes(32).toString("hex");
  writeFileSync(file, `${hex}\n`, { encoding: "utf8", mode: 0o600 });
  return Buffer.from(hex, "hex");
}

function digestBody(body: Omit<Attestation, "digest">, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(body)).digest("hex");
}

export function verifyDigest(record: Attestation, key: Buffer): boolean {
  const { digest, ...body } = record;
  const expected = digestBody(body, key);
  const actual = Buffer.from(digest, "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * A hunk is covered only when every probe generated for it is correct. A probe
 * answered wrong twice stays incorrect, so its hunk stays uncovered: the plan's
 * "two misses leave the hunk uncovered" is enforced here, not in the UI.
 */
export function grade(
  diff: DiffFile,
  probes: ProbesFile,
  answers: AnswerLog,
): { hunks: AttestedHunk[]; coverage: Coverage } {
  const byHunk = new Map<string, Probe[]>();
  for (const probe of probes.probes) {
    const list = byHunk.get(probe.hunk_id) ?? [];
    list.push(probe);
    byHunk.set(probe.hunk_id, list);
  }

  const nonExempt = diff.hunks.filter((hunk) => hunk.exempt === undefined);
  const hunks: AttestedHunk[] = nonExempt.map((hunk: Hunk) => {
    const hunkProbes = byHunk.get(hunk.id) ?? [];
    const attested: AttestedProbe[] = hunkProbes.map((probe) => {
      const state = answers[probe.id];
      return {
        id: probe.id,
        answer_index: probe.answer_index,
        correct: state?.correct === true,
      };
    });
    return {
      id: hunk.id,
      fingerprint: hunk.fingerprint,
      // No probe means nothing was proved, so it cannot count as covered.
      covered: attested.length > 0 && attested.every((probe) => probe.correct),
      // The hunk's attempt count is its hardest probe's, i.e. how many tries
      // the retry allowance actually consumed.
      attempts: hunkProbes.reduce(
        (max, probe) => Math.max(max, answers[probe.id]?.attempts ?? 0),
        0,
      ),
      probes: attested,
    };
  });

  const covered = hunks.filter((hunk) => hunk.covered).length;
  const total = hunks.length;
  return {
    hunks,
    coverage: {
      total,
      covered,
      exempt: diff.hunks.length - total,
      ratio: total === 0 ? 1 : covered / total,
    },
  };
}

/**
 * `git config user.email` is self-declared and may be unset (exit 1, empty
 * output). Recording "unknown" keeps attestation working in a bare CI checkout
 * instead of crashing on a missing identity.
 */
export function resolveReviewer(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", ["config", "--get", "user.email"], {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.error || result.status !== 0) {
    return "unknown";
  }
  return (result.stdout ?? "").trim() || "unknown";
}

export type SealResult = { record: Attestation; path: string };

export function seal(options: {
  diff: DiffFile;
  probes: ProbesFile;
  answers: AnswerLog;
  reviewer?: string;
  cwd?: string;
}): SealResult {
  const cwd = options.cwd ?? process.cwd();
  const key = loadOrCreateKey(cwd);
  const { hunks, coverage } = grade(options.diff, options.probes, options.answers);
  const body: Omit<Attestation, "digest"> = {
    schema: ATTESTATION_SCHEMA,
    base: options.diff.base,
    head: options.diff.head,
    diff_sha256: diffDigest(options.diff),
    reviewer: options.reviewer ?? resolveReviewer(cwd),
    hunks,
    coverage,
  };
  const record = AttestationSchema.parse({ ...body, digest: digestBody(body, key) });
  const output = attestationPath(options.diff.head, cwd);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { record, path: output };
}

export function attestationPath(head: string, cwd = process.cwd()): string {
  return path.join(cwd, ".hunkwise", "attestations", `${head}.json`);
}

export function readAttestation(head: string, cwd = process.cwd()): Attestation | null {
  const file = attestationPath(head, cwd);
  if (!existsSync(file)) {
    return null;
  }
  return AttestationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function answersPath(cwd = process.cwd()): string {
  return path.join(cwd, ".hunkwise", "answers.json");
}

export function readAnswers(cwd = process.cwd()): AnswersFile | null {
  const file = answersPath(cwd);
  if (!existsSync(file)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    schema?: unknown;
    base?: unknown;
    head?: unknown;
    diff_sha256?: unknown;
    entries?: unknown;
  };
  if (
    parsed.schema !== ANSWERS_SCHEMA ||
    typeof parsed.base !== "string" ||
    typeof parsed.head !== "string" ||
    typeof parsed.diff_sha256 !== "string" ||
    typeof parsed.entries !== "object" ||
    parsed.entries === null
  ) {
    return null;
  }
  const entries: AnswerLog = {};
  for (const [probeId, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
    const entry = value as { attempts?: unknown; correct?: unknown };
    if (typeof entry?.attempts !== "number" || typeof entry?.correct !== "boolean") {
      continue;
    }
    entries[probeId] = {
      attempts: Math.max(0, Math.floor(entry.attempts)),
      correct: entry.correct,
    };
  }
  return {
    schema: ANSWERS_SCHEMA,
    base: parsed.base,
    head: parsed.head,
    diff_sha256: parsed.diff_sha256,
    entries,
  };
}

export function writeAnswers(
  state: Omit<AnswersFile, "schema">,
  cwd = process.cwd(),
): string {
  const output = answersPath(cwd);
  mkdirSync(path.dirname(output), { recursive: true });
  const document: AnswersFile = { schema: ANSWERS_SCHEMA, ...state };
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return output;
}

/** Answers belong to one exact branch state; anything else starts empty. */
export function answersMatchDiff(state: AnswersFile | null, diff: DiffFile): boolean {
  return (
    state !== null && state.head === diff.head && state.diff_sha256 === diffDigest(diff)
  );
}
