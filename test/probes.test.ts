import { describe, expect, it } from "vitest";
import {
  DIFF_SCHEMA,
  DiffFileSchema,
  extractFacts,
  parseDiff,
  toHunk,
  type DiffFile,
  type ParsedHunk,
} from "../src/diff.js";
import { buildProbes } from "../src/probes.js";

function section(file: string, body: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;
}

function addHunk(file: string, at: number, lines: string[]): string {
  return section(file, `@@ -${at},0 +${at},${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`);
}

function delHunk(file: string, at: number, line: string): string {
  return section(file, `@@ -${at},1 +${Math.max(0, at - 1)},0 @@\n-${line}\n`);
}

function replaceHunk(file: string, at: number, before: string, after: string): string {
  return section(file, `@@ -${at},1 +${at},1 @@\n-${before}\n+${after}\n`);
}

function makeDiff(raw: string): { diff: DiffFile; parsed: ParsedHunk[] } {
  const parsed = parseDiff(raw);
  const diff = DiffFileSchema.parse({
    schema: DIFF_SCHEMA,
    base: "main",
    head: "a".repeat(40),
    hunks: parsed.map((hunk) => toHunk(hunk)),
  });
  return { diff, parsed };
}

function bodyOf(parsed: ParsedHunk[]): string {
  return parsed.map((hunk) => hunk.body.join("\n")).join("\n");
}

describe("buildProbes", () => {
  it("turns a deleted guard into a gradable probe with an in-hunk answer", () => {
    const { diff, parsed } = makeDiff(delHunk("src/auth/session.ts", 5, "  if (!user) return null;"));
    const probes = buildProbes(diff).probes;

    expect(probes).toHaveLength(1);
    expect(probes[0].kind).toBe("guard_removed");
    expect(probes[0].hunk_id).toBe(diff.hunks[0].id);
    expect(probes[0].options).toHaveLength(4);
    expect(new Set(probes[0].options).size).toBe(4);
    expect(probes[0].answer_index).toBeGreaterThanOrEqual(0);
    expect(probes[0].answer_index).toBeLessThanOrEqual(3);

    const answer = probes[0].options[probes[0].answer_index];
    expect(parsed[0].body.join("\n")).toContain(answer);
    expect(parsed[0].removed.some((line) => line.line === probes[0].evidence_line)).toBe(true);
    expect(probes[0].prompt).toContain("src/auth/session.ts");
  });

  it("answers a deleted brace guard with its condition line", () => {
    const raw = section(
      "src/auth/session.ts",
      "@@ -4,3 +3,0 @@\n-  if (!user) {\n-    return null;\n-  }\n",
    );
    const { diff, parsed } = makeDiff(raw);
    const probes = buildProbes(diff).probes;

    expect(probes).toHaveLength(1);
    expect(probes[0].kind).toBe("guard_removed");
    const answer = probes[0].options[probes[0].answer_index];
    expect(answer).toBe("if (!user) {");
    expect(parsed[0].body.join("\n")).toContain(answer);
  });

  it("turns an added error path into a gradable probe", () => {
    const { diff, parsed } = makeDiff(addHunk("src/auth/errors.ts", 8, ['  throw new Error("session expired");']));
    const probes = buildProbes(diff).probes;

    expect(probes).toHaveLength(1);
    expect(probes[0].kind).toBe("error_path_changed");
    const answer = probes[0].options[probes[0].answer_index];
    expect(answer).toContain("throw new Error");
    expect(bodyOf(parsed)).toContain(answer);
  });

  it("turns an added branch into a gradable probe", () => {
    const { diff, parsed } = makeDiff(addHunk("src/auth/session.ts", 12, ["  if (token.rotated) return refresh(token);"]));
    const probes = buildProbes(diff).probes;

    expect(probes).toHaveLength(1);
    expect(probes[0].kind).toBe("new_branch");
    const answer = probes[0].options[probes[0].answer_index];
    expect(answer).toContain("token.rotated");
    expect(bodyOf(parsed)).toContain(answer);
  });

  it("turns a rename into a gradable probe naming the post-image symbol", () => {
    const { diff, parsed } = makeDiff(
      replaceHunk("src/auth/store.ts", 4, "  return loadSession(user);", "  return readSession(user);"),
    );
    const probes = buildProbes(diff).probes;

    expect(probes).toHaveLength(1);
    expect(probes[0].kind).toBe("symbol_renamed");
    const answer = probes[0].options[probes[0].answer_index];
    expect(answer).toBe("readSession");
    expect(parsed[0].added.map((line) => line.text).join("\n")).toContain(answer);
  });

  it("covers all four fact kinds when a branch contains all of them", () => {
    const raw = [
      delHunk("src/auth/session.ts", 5, "  if (!user) return null;"),
      addHunk("src/auth/errors.ts", 3, ['  throw new Error("boom");']),
      addHunk("src/auth/token.ts", 7, ["  if (expired) return rotate();"]),
      replaceHunk("src/auth/store.ts", 4, "  return loadSession(user);", "  return readSession(user);"),
    ].join("");
    const { diff, parsed } = makeDiff(raw);
    const probes = buildProbes(diff).probes;

    expect(new Set(probes.map((probe) => probe.kind))).toEqual(
      new Set(["guard_removed", "error_path_changed", "new_branch", "symbol_renamed"]),
    );
    expect(probes).toHaveLength(4);
    for (const probe of probes) {
      const hunk = diff.hunks.find((entry) => entry.id === probe.hunk_id);
      expect(hunk).toBeDefined();
      expect(hunk?.facts.some((fact) => fact.kind === probe.kind)).toBe(true);
      expect(parsed.map((entry) => entry.body.join("\n")).join("\n")).toContain(
        probe.options[probe.answer_index],
      );
    }
  });

  it("asks at most three probes per hunk", () => {
    const { diff } = makeDiff(
      addHunk("src/a.ts", 1, [
        '  throw new Error("a");',
        '  throw new Error("b");',
        '  throw new Error("c");',
        '  throw new Error("d");',
        '  throw new Error("e");',
      ]),
    );
    const probes = buildProbes(diff).probes;
    expect(probes).toHaveLength(3);
    expect(new Set(probes.map((probe) => probe.hunk_id)).size).toBe(1);
  });

  it("skips exempt hunks entirely", () => {
    const raw = [
      section("src/notes.ts", "@@ -1,0 +1,1 @@\n+// only a comment\n"),
      section("package-lock.json", '@@ -1,0 +1,1 @@\n+{"lockfileVersion":3}\n'),
      addHunk("src/a.ts", 2, ['  throw new Error("real");']),
    ].join("");
    const { diff } = makeDiff(raw);

    expect(diff.hunks.filter((hunk) => hunk.exempt).length).toBe(2);
    const probes = buildProbes(diff).probes;
    expect(probes).toHaveLength(1);
    expect(probes[0].hunk_id).toBe(diff.hunks[2].id);
  });

  it("pulls distractors from sibling hunks", () => {
    const raw = [
      delHunk("src/auth/session.ts", 5, "  if (!user) return null;"),
      addHunk("src/auth/errors.ts", 2, ['  throw new Error("sibling detail");']),
    ].join("");
    const { diff } = makeDiff(raw);
    const probes = buildProbes(diff);

    const guard = probes.probes.find((probe) => probe.kind === "guard_removed");
    expect(guard).toBeDefined();
    const distractors = guard?.options.filter((_, index) => index !== guard.answer_index) ?? [];
    expect(distractors.some((option) => option.includes("sibling detail"))).toBe(true);
  });

  it("never draws a distractor from the hunk's own answers", () => {
    const raw = [
      // Two facts in one hunk: a pool that collated the hunk's own answers
      // would offer the first answer as a distractor for the second probe.
      addHunk("src/api/handler.ts", 5, ["  if (!req.tenant) {", "  if (!req.scope) {"]),
      addHunk("src/auth/errors.ts", 3, ['  throw new Error("sibling detail");']),
    ].join("");
    const { diff } = makeDiff(raw);
    const probes = buildProbes(diff).probes;

    const byHunk = new Map<string, typeof probes>();
    for (const probe of probes) {
      const list = byHunk.get(probe.hunk_id) ?? [];
      list.push(probe);
      byHunk.set(probe.hunk_id, list);
    }
    const multi = byHunk.get(diff.hunks[0].id) ?? [];
    expect(multi).toHaveLength(2);

    for (const hunkProbes of byHunk.values()) {
      const ownAnswers = new Set(hunkProbes.map((probe) => probe.options[probe.answer_index]));
      for (const probe of hunkProbes) {
        for (const [index, option] of probe.options.entries()) {
          if (index === probe.answer_index) {
            continue;
          }
          expect(ownAnswers.has(option)).toBe(false);
        }
      }
    }
  });

  it("is deterministic for a fixed diff and fingerprint", () => {
    const raw = [
      delHunk("src/auth/session.ts", 5, "  if (!user) return null;"),
      addHunk("src/auth/errors.ts", 3, ['  throw new Error("boom");']),
      addHunk("src/auth/token.ts", 7, ["  if (expired) return rotate();"]),
    ].join("");
    const first = buildProbes(makeDiff(raw).diff);
    const second = buildProbes(makeDiff(raw).diff);
    expect(second).toEqual(first);

    // Metadata does not participate in the seed: the same hunks with another
    // base/head keep identical options and answer indexes.
    const diff = makeDiff(raw).diff;
    const rehead = DiffFileSchema.parse({ ...diff, base: "upstream/main", head: "f".repeat(40) });
    expect(buildProbes(rehead)).toEqual(first);
  });

  it("keeps a fixed fingerprint's option order stable", () => {
    const { diff } = makeDiff(addHunk("src/a.ts", 1, ['  throw new Error("stable");']));
    const first = buildProbes(diff).probes[0];
    const second = buildProbes(diff).probes[0];
    expect(second.options).toEqual(first.options);
    expect(second.answer_index).toBe(first.answer_index);

    // The seed is content-derived, so a different fingerprint is free to move
    // the answer; it must still point at the correct option.
    const changed = DiffFileSchema.parse({
      ...diff,
      hunks: diff.hunks.map((hunk) => ({ ...hunk, fingerprint: "b".repeat(64) })),
    });
    const reshuffled = buildProbes(changed).probes[0];
    expect(reshuffled.options[reshuffled.answer_index]).toBe(
      first.options[first.answer_index],
    );
  });
});

describe("comment bodies without their opener", () => {
  it("treats a changed line inside an open block comment as comment text", () => {
    const raw = section(
      "src/auth/session.ts",
      "@@ -4,0 +4,1 @@\n+    throw when it fails\n",
    );
    const parsed = parseDiff(raw)[0];

    const inComment = toHunk(parsed, { addedStartsInBlock: true });
    expect(inComment.exempt).toBe("comment-only");
    expect(inComment.facts).toHaveLength(0);
    expect(extractFacts(parsed, { addedStartsInBlock: true })).toHaveLength(0);

    // Without the file context the same line looks like an added error path;
    // this is exactly what tracking block state across the full file prevents.
    expect(extractFacts(parsed).some((fact) => fact.kind === "error_path_changed")).toBe(true);
  });
});
