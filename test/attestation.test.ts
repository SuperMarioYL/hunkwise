import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  answersMatchDiff,
  attestationPath,
  canonicalJson,
  diffDigest,
  grade,
  initProject,
  readAttestation,
  resolveBase,
  resolveReviewer,
  seal,
  verifyDigest,
  writeAnswers,
  readAnswers,
  type AnswerLog,
} from "../src/attestation.js";
import {
  DIFF_SCHEMA,
  DiffFileSchema,
  collectDiff,
  parseDiff,
  toHunk,
  type DiffFile,
} from "../src/diff.js";
import { buildProbes } from "../src/probes.js";
import { verify, verifyPushedRefs } from "../src/gate.js";

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hunkwise-test-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function section(file: string, body: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;
}

function fixtureDiff(): DiffFile {
  const raw = [
    section("src/auth/session.ts", "@@ -5,1 +4,0 @@\n-  if (!user) return null;\n"),
    section("src/auth/errors.ts", '@@ -3,0 +3,1 @@\n+  throw new Error("boom");\n'),
    section("src/notes.ts", "@@ -1,0 +1,1 @@\n+// only a comment\n"),
    section("package-lock.json", '@@ -1,0 +1,1 @@\n+{"lockfileVersion":3}\n'),
  ].join("");
  return DiffFileSchema.parse({
    schema: DIFF_SCHEMA,
    base: "main",
    head: "c".repeat(40),
    hunks: parseDiff(raw).map((hunk) => toHunk(hunk)),
  });
}

function writeKey(dir: string, hex = "a".repeat(64)): void {
  mkdirSync(path.join(dir, ".hunkwise"), { recursive: true });
  writeFileSync(path.join(dir, ".hunkwise", "key"), `${hex}\n`);
}

function allCorrect(diff: DiffFile): AnswerLog {
  const probes = buildProbes(diff);
  const answers: AnswerLog = {};
  for (const probe of probes.probes) {
    answers[probe.id] = { attempts: 1, correct: true };
  }
  return answers;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Hunkwise Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Hunkwise Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout ?? "";
}

function makeRepo(): string {
  const repo = tempDir();
  git(repo, ["init", "-q"]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "a.ts"), "export function f() {\n  return 1;\n}\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(repo, "a.ts"), 'export function f() {\n  throw new Error("boom");\n}\n');
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "change"]);
  initProject({ cwd: repo });
  return repo;
}

describe("coverage math", () => {
  it("counts only non-exempt hunks and excludes exempt ones from the denominator", () => {
    const diff = fixtureDiff();
    const probes = buildProbes(diff);
    const { coverage, hunks } = grade(diff, probes, allCorrect(diff));

    expect(coverage.total).toBe(2);
    expect(coverage.exempt).toBe(2);
    expect(coverage.covered).toBe(2);
    expect(coverage.ratio).toBe(1);
    expect(hunks.map((hunk) => hunk.id)).toEqual(
      diff.hunks.filter((hunk) => hunk.exempt === undefined).map((hunk) => hunk.id),
    );
  });

  it("leaves a hunk uncovered after two misses", () => {
    const diff = fixtureDiff();
    const probes = buildProbes(diff);
    const answers = allCorrect(diff);
    const victim = probes.probes[0];
    answers[victim.id] = { attempts: 2, correct: false };

    const { coverage, hunks } = grade(diff, probes, answers);
    expect(coverage.total).toBe(2);
    expect(coverage.covered).toBe(1);
    expect(coverage.ratio).toBe(0.5);
    expect(hunks.find((hunk) => hunk.id === victim.hunk_id)?.covered).toBe(false);
    expect(hunks.find((hunk) => hunk.id === victim.hunk_id)?.attempts).toBe(2);
  });

  it("treats a hunk with no probe as uncovered", () => {
    const diff = fixtureDiff();
    const probes = buildProbes(diff);
    const { hunks } = grade(diff, probes, allCorrect(diff));
    const empty = { schema: probes.schema, diff_schema: probes.diff_schema, probes: [] };
    const { coverage } = grade(diff, empty, allCorrect(diff));
    expect(coverage.covered).toBe(0);
    expect(hunks.every((hunk) => hunk.covered)).toBe(true);
  });
});

describe("attestation digest", () => {
  it("is canonical: key order does not change the bytes", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });

  it("is stable for the same record and key, and detects tampering", () => {
    const diff = fixtureDiff();
    const probes = buildProbes(diff);
    const answers = allCorrect(diff);

    const dirA = tempDir();
    const dirB = tempDir();
    writeKey(dirA);
    writeKey(dirB);
    const first = seal({ diff, probes, answers, reviewer: "dev@example.com", cwd: dirA });
    const second = seal({ diff, probes, answers, reviewer: "dev@example.com", cwd: dirB });
    expect(second.record.digest).toBe(first.record.digest);

    const key = Buffer.from("a".repeat(64), "hex");
    expect(verifyDigest(first.record, key)).toBe(true);
    expect(verifyDigest({ ...first.record, reviewer: "someone@else" }, key)).toBe(false);
    expect(
      verifyDigest(
        { ...first.record, coverage: { ...first.record.coverage, covered: 0 } },
        key,
      ),
    ).toBe(false);
    expect(verifyDigest(first.record, Buffer.from("b".repeat(64), "hex"))).toBe(false);
  });

  it("writes and reads a schema-valid record with coverage and reviewer", () => {
    const diff = fixtureDiff();
    const probes = buildProbes(diff);
    const dir = tempDir();
    writeKey(dir);
    const result = seal({
      diff,
      probes,
      answers: allCorrect(diff),
      reviewer: "reviewer@example.com",
      cwd: dir,
    });

    expect(result.path).toBe(attestationPath(diff.head, dir));
    const stored = readAttestation(diff.head, dir);
    expect(stored).not.toBeNull();
    expect(stored?.schema).toBe("hunkwise/attestation@1");
    expect(stored?.reviewer).toBe("reviewer@example.com");
    expect(stored?.diff_sha256).toBe(diffDigest(diff));
    expect(stored?.coverage).toEqual({ total: 2, covered: 2, exempt: 2, ratio: 1 });
    expect(stored?.digest).toBe(result.record.digest);
  });
});

describe("answers persistence", () => {
  it("round-trips the answer log and binds it to the diff", () => {
    const diff = fixtureDiff();
    const dir = tempDir();
    writeAnswers(
      { base: diff.base, head: diff.head, diff_sha256: diffDigest(diff), entries: allCorrect(diff) },
      dir,
    );
    const saved = readAnswers(dir);
    expect(saved?.entries).toEqual(allCorrect(diff));
    expect(saved && answersMatchDiff(saved, diff)).toBe(true);

    const moved = DiffFileSchema.parse({ ...diff, head: "d".repeat(40) });
    expect(saved && answersMatchDiff(saved, moved)).toBe(false);
  });
});

describe("reviewer identity", () => {
  it("records unknown when git has no user.email", () => {
    const repo = tempDir();
    git(repo, ["init", "-q"]);
    const env = {
      ...gitEnv(),
      HOME: repo,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    expect(resolveReviewer(repo, env)).toBe("unknown");
  });

  it("reads the local user.email when set", () => {
    const repo = tempDir();
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "dev@example.com"]);
    expect(resolveReviewer(repo, gitEnv())).toBe("dev@example.com");
  });
});

describe("base resolution", () => {
  it("defaults to the base recorded by init, with --base still overriding it", () => {
    const repo = tempDir();
    initProject({ cwd: repo, base: "origin/trunk" });

    expect(resolveBase({ cwd: repo })).toBe("origin/trunk");
    expect(resolveBase({ base: "origin/main", cwd: repo })).toBe("origin/main");
    expect(() => resolveBase({ cwd: tempDir() })).toThrow(/no base configured/);
  });
});

describe("verify gate", () => {
  it("passes only for a sealed, current, fully covered branch", () => {
    const repo = makeRepo();
    const diff = collectDiff("main", repo);
    const probes = buildProbes(diff);
    expect(probes.probes.length).toBeGreaterThan(0);

    const sealed = seal({ diff, probes, answers: allCorrect(diff), reviewer: "tester", cwd: repo });
    expect(sealed.record.coverage.covered).toBe(sealed.record.coverage.total);
    expect(verify({ base: "main", cwd: repo }).ok).toBe(true);

    // Two misses on a probe leave its hunk uncovered, so verify blocks.
    const wrong: AnswerLog = {};
    for (const probe of probes.probes) {
      wrong[probe.id] = { attempts: 2, correct: false };
    }
    seal({ diff, probes, answers: wrong, reviewer: "tester", cwd: repo });
    const blocked = verify({ base: "main", cwd: repo });
    expect(blocked.ok).toBe(false);
    expect(blocked.uncovered.length).toBe(diff.hunks.filter((h) => h.exempt === undefined).length);
    expect(blocked.uncovered.every((hunk) => hunk.reason === "not covered")).toBe(true);

    // Restore a good seal, then edit the record: the digest catches it.
    seal({ diff, probes, answers: allCorrect(diff), reviewer: "tester", cwd: repo });
    const file = attestationPath(diff.head, repo);
    const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    (document.coverage as Record<string, number>).covered = 0;
    writeFileSync(file, JSON.stringify(document));
    const tampered = verify({ base: "main", cwd: repo });
    expect(tampered.ok).toBe(false);
    expect(tampered.uncovered.every((hunk) => hunk.reason === "attestation digest is invalid")).toBe(
      true,
    );

    // Re-sealing fixes it; a new commit moves HEAD and invalidates the record.
    seal({ diff, probes, answers: allCorrect(diff), reviewer: "tester", cwd: repo });
    expect(verify({ base: "main", cwd: repo }).ok).toBe(true);

    writeFileSync(
      path.join(repo, "a.ts"),
      'export function f() {\n  throw new Error("boom");\n  throw new Error("again");\n}\n',
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "more change"]);
    const moved = verify({ base: "main", cwd: repo });
    expect(moved.ok).toBe(false);
    expect(moved.uncovered.every((hunk) => hunk.reason.startsWith("no attestation"))).toBe(true);
  });

  it("blocks a branch with no attestation at all", () => {
    const repo = makeRepo();
    const result = verify({ base: "main", cwd: repo });
    expect(result.ok).toBe(false);
    expect(result.uncovered.length).toBeGreaterThan(0);
  });
});

function pushLine(localRef: string, oid: string): string {
  return `${localRef} ${oid} ${localRef} ${"0".repeat(40)}`;
}

describe("pre-push ref gate", () => {
  it("verifies each pushed commit instead of the checked-out HEAD", () => {
    const repo = makeRepo();
    const coveredOid = git(repo, ["rev-parse", "HEAD"]).trim();
    const coveredDiff = collectDiff("main", repo);
    seal({
      diff: coveredDiff,
      probes: buildProbes(coveredDiff),
      answers: allCorrect(coveredDiff),
      reviewer: "tester",
      cwd: repo,
    });

    // A second branch from main: its change is different and never sealed.
    git(repo, ["checkout", "-q", "-b", "feature-uncovered", "main"]);
    writeFileSync(
      path.join(repo, "a.ts"),
      'export function f() {\n  throw new Error("uncovered");\n}\n',
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "uncovered change"]);
    const uncoveredOid = git(repo, ["rev-parse", "HEAD"]).trim();

    // HEAD is the covered branch while the uncovered one is pushed.
    git(repo, ["checkout", "-q", "feature"]);

    const coveredOnly = verifyPushedRefs(
      pushLine("refs/heads/feature", coveredOid),
      { base: "main", cwd: repo },
    );
    expect(coveredOnly.ok).toBe(true);
    expect(coveredOnly.refs[0].status).toBe("covered");

    const uncoveredOnly = verifyPushedRefs(
      pushLine("refs/heads/feature-uncovered", uncoveredOid),
      { base: "main", cwd: repo },
    );
    expect(uncoveredOnly.ok).toBe(false);
    expect(uncoveredOnly.refs[0].status).toBe("blocked");
    expect(uncoveredOnly.refs[0].result?.head).toBe(uncoveredOid);
    expect(uncoveredOnly.refs[0].result?.uncovered.length).toBeGreaterThan(0);

    // One bad ref blocks a push that also carries a good one.
    const both = verifyPushedRefs(
      `${pushLine("refs/heads/feature", coveredOid)}\n${pushLine(
        "refs/heads/feature-uncovered",
        uncoveredOid,
      )}\n`,
      { base: "main", cwd: repo },
    );
    expect(both.ok).toBe(false);
    expect(both.refs.map((ref) => ref.status)).toEqual(["covered", "blocked"]);

    // A deletion sends an all-zero local oid and must be allowed.
    const deletion = verifyPushedRefs(
      `(delete) ${"0".repeat(40)} refs/heads/old ${"c".repeat(40)}`,
      { base: "main", cwd: repo },
    );
    expect(deletion.ok).toBe(true);
    expect(deletion.refs[0].status).toBe("skipped-deletion");
  });
});
