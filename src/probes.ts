import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DIFF_SCHEMA,
  FactKindSchema,
  type DiffFile,
  type Fact,
  type FactKind,
  type Hunk,
} from "./diff.js";

/**
 * Turns a diff into gradable probes. The answer key is harvested from the hunk
 * text itself: every correct option is a substring of a changed line, and every
 * distractor comes from a sibling hunk (or a canned false statement when the
 * branch is too small). The shuffle is seeded by the hunk fingerprint, so the
 * same diff always produces byte-identical probes.json. No model call.
 */

export const PROBES_SCHEMA = "hunkwise/probes@1" as const;

export const ProbeSchema = z.object({
  id: z.string().min(1),
  hunk_id: z.string().min(1),
  kind: FactKindSchema,
  prompt: z.string().min(1),
  options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  answer_index: z.number().int().min(0).max(3),
  evidence_line: z.number().int().min(1),
});

export const ProbesFileSchema = z.object({
  schema: z.literal(PROBES_SCHEMA),
  diff_schema: z.literal(DIFF_SCHEMA),
  probes: z.array(ProbeSchema),
});

export type Probe = z.infer<typeof ProbeSchema>;
export type ProbesFile = z.infer<typeof ProbesFileSchema>;

/**
 * The option text shown to the reviewer. It is always literal text from the
 * hunk: comment markers and the diff prefix are stripped, nothing is invented.
 * For a rename the visible answer is the new symbol, because that is the text
 * that appears in the post-image.
 */
type FactAnswer = {
  answer: string;
  /** Old symbol for a rename, so the prompt can name what disappeared. */
  previous?: string;
};

function describeFact(fact: Fact): FactAnswer | null {
  switch (fact.kind) {
    case "guard_removed": {
      const block = /^deleted guard block: (.*?) -> /.exec(fact.detail);
      if (block) {
        return { answer: block[1].trim() };
      }
      const single = /^deleted guard: (.*)$/.exec(fact.detail);
      return single ? { answer: single[1].trim() } : null;
    }
    case "error_path_changed": {
      const match = /^(?:added|removed) error path: (.*)$/.exec(fact.detail);
      return match ? { answer: match[1].trim() } : null;
    }
    case "new_branch": {
      const match = /^new branch: (.*)$/.exec(fact.detail);
      return match ? { answer: match[1].trim() } : null;
    }
    case "symbol_renamed": {
      const match = /^renamed symbol: (.*?) -> (.*)$/.exec(fact.detail);
      return match ? { answer: match[2].trim(), previous: match[1].trim() } : null;
    }
    default:
      return null;
  }
}

const KIND_ORDER: FactKind[] = [
  "guard_removed",
  "error_path_changed",
  "new_branch",
  "symbol_renamed",
];

function promptFor(kind: FactKind, hunk: Hunk, fact: Fact, previous?: string): string {
  switch (kind) {
    case "guard_removed":
      return `Which guard was deleted in ${hunk.file} at line ${fact.line}?`;
    case "error_path_changed":
      return `Which error-handling line changed in ${hunk.file} at line ${fact.line}?`;
    case "new_branch":
      return `Which new branch is introduced in ${hunk.file} at line ${fact.line}?`;
    case "symbol_renamed":
      return previous
        ? `Which symbol replaced \`${previous}\` in ${hunk.file} at line ${fact.line}?`
        : `Which symbol was renamed in ${hunk.file} at line ${fact.line}?`;
    default:
      return `What changed in ${hunk.file} at line ${fact.line}?`;
  }
}

/** Seeded PRNG so option order depends only on content, not on call order. */
function makeRandom(seedText: string): () => number {
  let state = createHash("sha256").update(seedText).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/**
 * Distractors are answer strings from *other* hunks of the same diff. A hunk's
 * own answers are never reused: offering one of them next to the right answer
 * turns the question into "which of these two lines sits in my hunk", which the
 * diff pane already answers, and the plan promises sibling-hunk distractors.
 * Sorting the pool before the seeded pick keeps selection independent of hunk
 * order in the diff document.
 */
function siblingAnswers(diff: DiffFile, hunkId: string): string[] {
  const answers: string[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.exempt || hunk.id === hunkId) {
      continue;
    }
    for (const fact of hunk.facts) {
      const described = describeFact(fact);
      if (described && described.answer !== "") {
        answers.push(described.answer);
      }
    }
  }
  return [...new Set(answers)].sort();
}

/** Every answer text this hunk can grade on; none of them may be a distractor. */
function ownAnswers(hunk: Hunk): Set<string> {
  const answers = new Set<string>();
  for (const fact of hunk.facts) {
    const described = describeFact(fact);
    if (described && described.answer !== "") {
      answers.add(described.answer);
    }
  }
  return answers;
}

/**
 * Canned false statements, used only when the branch has too few sibling
 * answers to fill three slots. They never describe hunk text, so they cannot
 * collide with an answer by accident.
 */
const FALLBACK_DISTRACTORS = [
  "no behavioral change at this line",
  "only whitespace or formatting changed",
  "a comment was reworded",
  "an import was reordered",
  "the file was only renamed",
  "this line was reformatted",
  "a constant value was changed",
  "a log message was added",
  "a type annotation changed",
  "a dependency version was bumped",
];

function pickDistractors(
  siblings: string[],
  forbidden: Set<string>,
  random: () => number,
): string[] {
  const chosen: string[] = [];
  const take = (option: string): void => {
    if (chosen.length < 3 && !forbidden.has(option) && !chosen.includes(option)) {
      chosen.push(option);
    }
  };
  for (const option of shuffled(siblings, random)) {
    take(option);
  }
  for (const option of FALLBACK_DISTRACTORS) {
    take(option);
  }
  return chosen;
}

/**
 * One probe per fact, capped at three, preferring one fact per kind so a hunk
 * that removes a guard and adds a branch is not graded on three error lines.
 */
function chooseFacts(facts: Fact[]): Fact[] {
  const chosen: Fact[] = [];
  for (const kind of KIND_ORDER) {
    if (chosen.length === 3) {
      break;
    }
    const first = facts.find((fact) => fact.kind === kind);
    if (first) {
      chosen.push(first);
    }
  }
  for (const fact of facts) {
    if (chosen.length === 3) {
      break;
    }
    if (!chosen.includes(fact)) {
      chosen.push(fact);
    }
  }
  return chosen.sort(
    (left, right) =>
      left.line - right.line || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind),
  );
}

function makeProbe(
  hunk: Hunk,
  fact: Fact,
  ordinal: number,
  siblings: string[],
  forbidden: Set<string>,
): Probe | null {
  const described = describeFact(fact);
  if (!described || described.answer === "") {
    return null;
  }
  const id = `${hunk.id}#${ordinal}`;
  // The seed uses only content-derived values (fingerprint, kind, line), so a
  // fixed fingerprint keeps its option order even if the diff is re-serialized.
  const random = makeRandom(`${hunk.fingerprint}:${fact.kind}:${fact.line}:${id}`);
  const distractors = pickDistractors(siblings, forbidden, random);
  const options = shuffled([described.answer, ...distractors], random);
  const answerIndex = options.indexOf(described.answer);
  if (answerIndex < 0 || new Set(options).size !== 4) {
    return null;
  }
  return {
    id,
    hunk_id: hunk.id,
    kind: fact.kind,
    prompt: promptFor(fact.kind, hunk, fact, described.previous),
    options: options as [string, string, string, string],
    answer_index: answerIndex,
    evidence_line: fact.line,
  };
}

export function buildProbes(diff: DiffFile): ProbesFile {
  const probes: Probe[] = [];
  for (const hunk of diff.hunks) {
    if (hunk.exempt) {
      continue;
    }
    const siblings = siblingAnswers(diff, hunk.id);
    const forbidden = ownAnswers(hunk);
    chooseFacts(hunk.facts).forEach((fact, index) => {
      const probe = makeProbe(hunk, fact, index + 1, siblings, forbidden);
      if (probe) {
        probes.push(probe);
      }
    });
  }
  return ProbesFileSchema.parse({
    schema: PROBES_SCHEMA,
    diff_schema: DIFF_SCHEMA,
    probes,
  });
}

export function probesFilePath(cwd = process.cwd()): string {
  return path.join(cwd, ".hunkwise", "probes.json");
}

export function readProbesFile(cwd = process.cwd()): ProbesFile {
  return ProbesFileSchema.parse(JSON.parse(readFileSync(probesFilePath(cwd), "utf8")));
}

export function writeProbesFile(probes: ProbesFile, cwd = process.cwd()): string {
  const output = probesFilePath(cwd);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(probes, null, 2)}\n`, "utf8");
  return output;
}
