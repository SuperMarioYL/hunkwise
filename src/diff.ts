import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Parses `git diff --unified=0 <base>...HEAD` into the hunk table that the
 * rest of hunkwise works from. Everything here is text-level on purpose: no
 * AST, no language server, no model call.
 */

export const DIFF_SCHEMA = "hunkwise/diff@1" as const;

export const FactKindSchema = z.enum([
  "guard_removed",
  "error_path_changed",
  "new_branch",
  "symbol_renamed",
]);

export const FactSchema = z.object({
  kind: FactKindSchema,
  line: z.number().int().min(1),
  detail: z.string().min(1),
});

/**
 * Why a hunk is excluded from the coverage denominator. Content reasons
 * (`comment-only`, `whitespace`, `no_fact`) mean the hunk carries no gradable
 * fact. File/structural reasons (`lockfile`, `generated`, `binary`,
 * `mode-change`, `rename-only`) mean there is nothing a line probe could ask
 * about. The plan's `exempt?: string` field is open-ended; this enum is the
 * v0.1 authority.
 */
export const ExemptReasonSchema = z.enum([
  "comment-only",
  "whitespace",
  "lockfile",
  "generated",
  "no_fact",
  "binary",
  "mode-change",
  "rename-only",
]);

export const HunkSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  facts: z.array(FactSchema),
  exempt: ExemptReasonSchema.optional(),
});

export const DiffFileSchema = z.object({
  schema: z.literal(DIFF_SCHEMA),
  base: z.string().min(1),
  head: z.string().min(1),
  hunks: z.array(HunkSchema),
});

export type Fact = z.infer<typeof FactSchema>;
export type FactKind = z.infer<typeof FactKindSchema>;
export type ExemptReason = z.infer<typeof ExemptReasonSchema>;
export type Hunk = z.infer<typeof HunkSchema>;
export type DiffFile = z.infer<typeof DiffFileSchema>;

type LineRef = { line: number; text: string };

export type ParsedHunk = {
  file: string;
  /** Pre-image path; differs from `file` for renames and deletions. */
  oldFile?: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context: string;
  added: LineRef[];
  removed: LineRef[];
  body: string[];
  /** Set for synthetic sections (binary, mode-only, 100%-rename). */
  exempt?: ExemptReason;
};

/**
 * Block-comment state at the first changed line of a hunk, taken from the full
 * pre-/post-image file. `--unified=0` strips the surrounding context, so a
 * comment opened above the hunk would otherwise look like code.
 */
export type CommentContext = {
  addedStartsInBlock?: boolean;
  removedStartsInBlock?: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

type SectionState = {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  rename: boolean;
  hunkCount: number;
};

function emptySection(): SectionState {
  return {
    oldPath: null,
    newPath: null,
    binary: false,
    oldMode: null,
    newMode: null,
    rename: false,
    hunkCount: 0,
  };
}

/**
 * A section with no `@@` hunks still carries meaning when it flips a mode,
 * swaps a binary, or is a 100%-similarity rename. Those become synthetic
 * exempt hunks so the branch is visibly exempt instead of silently clean.
 */
function sectionExemption(section: SectionState): ExemptReason | undefined {
  if (section.hunkCount > 0) {
    return undefined;
  }
  if (section.binary) {
    return "binary";
  }
  if (
    section.oldMode !== null &&
    section.newMode !== null &&
    section.oldMode !== section.newMode
  ) {
    return "mode-change";
  }
  if (section.rename) {
    return "rename-only";
  }
  return undefined;
}

/**
 * Decodes git's C-style path quoting. Git escapes each UTF-8 byte as an octal
 * run (`\344\270\255`), so byte runs are collected and decoded together
 * instead of being handed to JSON.parse (which cannot read octal escapes).
 */
function decodeGitQuoted(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const parts: string[] = [];
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      parts.push(Buffer.from(bytes).toString("utf8"));
      bytes = [];
    }
  };
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
  };

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\") {
      flush();
      parts.push(char);
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) {
      flush();
      parts.push("\\");
      break;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(index + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += octal[0].length;
      continue;
    }
    flush();
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(inner.slice(index + 2, index + 6))) {
      parts.push(String.fromCharCode(parseInt(inner.slice(index + 2, index + 6), 16)));
      index += 5;
      continue;
    }
    parts.push(simple[next] ?? next);
    index += 1;
  }

  flush();
  return parts.join("");
}

/**
 * Splits raw unified diff text into hunks. `hunk.file` comes from the `+++`
 * line (the post-image path), so renamed files report their new name; deleted
 * files fall back to the `---` line because their post-image is /dev/null.
 * Sections with no `@@` header (binary, mode-only, 100%-rename) produce a
 * synthetic exempt hunk instead of disappearing.
 */
export function parseDiff(raw: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let section = emptySection();
  let minusPath: string | null = null;
  let plusPath: string | null = null;
  let current: ParsedHunk | null = null;
  let newLine = 0;

  const finishHunk = (): void => {
    if (current) {
      hunks.push(current);
      current = null;
    }
  };

  const finishSection = (): void => {
    finishHunk();
    const exempt = sectionExemption(section);
    const file = section.newPath ?? section.oldPath;
    if (exempt && file) {
      hunks.push({
        file,
        oldStart: 0,
        oldCount: 0,
        newStart: 0,
        newCount: 0,
        context: exempt,
        added: [],
        removed: [],
        body: [`[${exempt}] ${file}`],
        exempt,
      });
    }
  };

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      finishSection();
      section = emptySection();
      const paths = parseDiffGitLine(line);
      section.oldPath = paths.oldPath;
      section.newPath = paths.newPath;
      minusPath = null;
      plusPath = null;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      finishHunk();
      const file = plusPath ?? minusPath ?? section.newPath ?? section.oldPath;
      if (file) {
        current = {
          file,
          oldFile: minusPath ?? section.oldPath ?? file,
          oldStart: Number(header[1]),
          oldCount: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newCount: header[4] === undefined ? 1 : Number(header[4]),
          context: header[5] ?? "",
          added: [],
          removed: [],
          body: [],
        };
        newLine = current.newStart;
        section.hunkCount += 1;
      }
      continue;
    }

    if (current) {
      if (line === "") {
        continue;
      }
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" is a marker, not hunk content.
        continue;
      }
      if (line.startsWith("+")) {
        current.added.push({ line: Math.max(1, newLine), text: line.slice(1) });
        current.body.push(line.trimEnd());
        newLine += 1;
        continue;
      }
      if (line.startsWith("-")) {
        // A removed line has no post-image line of its own; anchor it at the
        // post-image position where the deletion happened.
        current.removed.push({ line: Math.max(1, newLine), text: line.slice(1) });
        current.body.push(line.trimEnd());
        continue;
      }
      if (line.startsWith(" ")) {
        current.body.push(line.trimEnd());
        newLine += 1;
        continue;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      minusPath = parseHeaderPath(line.slice(4));
      if (minusPath) {
        section.oldPath = minusPath;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      plusPath = parseHeaderPath(line.slice(4));
      if (plusPath) {
        section.newPath = plusPath;
      }
      continue;
    }
    if (line.startsWith("old mode ")) {
      section.oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new mode ")) {
      section.newMode = line.slice("new mode ".length).trim();
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      section.rename = true;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      section.binary = true;
      continue;
    }
  }

  finishSection();
  return hunks;
}

/** Parses the two paths on a `diff --git a/... b/...` line. */
function parseDiffGitLine(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice("diff --git ".length);
  const tokens: string[] = [];

  if (rest.startsWith('"')) {
    let index = 0;
    while (tokens.length < 2 && index < rest.length) {
      if (rest[index] === '"') {
        let end = index + 1;
        while (end < rest.length) {
          if (rest[end] === "\\") {
            end += 2;
            continue;
          }
          if (rest[end] === '"') {
            break;
          }
          end += 1;
        }
        tokens.push(rest.slice(index, end + 1));
        index = end + 1;
      } else {
        let end = rest.indexOf(" ", index);
        if (end === -1) {
          end = rest.length;
        }
        tokens.push(rest.slice(index, end));
        index = end + 1;
      }
      while (rest[index] === " ") {
        index += 1;
      }
    }
  } else {
    // Git does not quote spaces, so split on the boundary before the
    // post-image's `b/` prefix.
    const boundary = rest.indexOf(" b/");
    if (boundary === -1) {
      tokens.push(...rest.split(" "));
    } else {
      tokens.push(rest.slice(0, boundary), rest.slice(boundary + 1));
    }
  }

  const normalize = (token: string | undefined): string | null => {
    if (!token) {
      return null;
    }
    const value = token.startsWith('"') ? decodeGitQuoted(token) : token;
    return value.replace(/^[ab]\//, "");
  };

  return { oldPath: normalize(tokens[0]), newPath: normalize(tokens[1]) };
}

/** Turns `b/src/foo.ts` or `"b/src/foo bar.ts"` into `src/foo bar.ts`. */
export function parseHeaderPath(raw: string): string | null {
  let value = raw.split("\t")[0]?.trim() ?? "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = decodeGitQuoted(value);
  }
  if (value === "/dev/null") {
    return null;
  }
  return value.replace(/^[ab]\//, "");
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "Cargo.lock",
  "podfile.lock",
]);

const GENERATED_PATH =
  /(^|\/)(?:dist|build|out|coverage|vendor|node_modules|\.next|target)\/|\.min\.(?:js|css)$|\.map$|(^|\/)__generated__\/|\.generated\.[^/]+$/;

function fileExemption(file: string): ExemptReason | undefined {
  const base = path.posix.basename(file);
  if (LOCKFILE_NAMES.has(base) || base.endsWith(".lock")) {
    return "lockfile";
  }
  if (GENERATED_PATH.test(file)) {
    return "generated";
  }
  return undefined;
}

const COMMENT_LINE =
  /^\s*(?:\/\/|\/\*|\*(?:\s|$)|\*\/|#(?!\s*(?:include|define|if|ifdef|ifndef|else|elif|endif|pragma|import)\b)|<!--|-->|--(?:\s|$)|\/\*|%)/;

/** Compares non-empty line content with all whitespace removed. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

function contentExemption(hunk: ParsedHunk, context?: CommentContext): ExemptReason | undefined {
  const added = hunk.added.map((entry) => entry.text);
  const removed = hunk.removed.map((entry) => entry.text);
  const changed = [...added, ...removed];
  if (changed.length === 0) {
    return undefined;
  }
  if (changed.every((text) => text.trim() === "")) {
    return "whitespace";
  }
  // Pure re-indentation: the same non-empty content appears on both sides once
  // whitespace is ignored. This runs before fact extraction so re-indenting a
  // guard line is not reported as guard_removed + new_branch.
  const addedCode = added.map(squeeze).filter((text) => text !== "").sort();
  const removedCode = removed.map(squeeze).filter((text) => text !== "").sort();
  if (
    addedCode.length > 0 &&
    addedCode.length === removedCode.length &&
    addedCode.every((text, index) => text === removedCode[index])
  ) {
    return "whitespace";
  }
  // A line whose comment-stripped, string-aware form is empty carries no code.
  // That catches block-comment body lines whose `/*` opener sits above the
  // hunk: they have no `//`, `*` or `#` marker of their own.
  const cleanedAdded = cleanChangedLines(hunk.added, context?.addedStartsInBlock ?? false);
  const cleanedRemoved = cleanChangedLines(
    hunk.removed,
    context?.removedStartsInBlock ?? false,
  );
  const isCommentLike = (text: string, index: number): boolean => {
    if (text.trim() === "" || COMMENT_LINE.test(text)) {
      return true;
    }
    const code = index < added.length ? cleanedAdded[index] : cleanedRemoved[index - added.length];
    return code.trim() === "";
  };
  if (changed.every(isCommentLike)) {
    return "comment-only";
  }
  return undefined;
}

export function normalizeHunkText(hunk: ParsedHunk): string {
  const context = hunk.context.trimEnd();
  return `${hunk.file}\n@@ ${context}\n${hunk.body.join("\n")}`;
}

export function fingerprintHunk(hunk: ParsedHunk): string {
  return createHash("sha256").update(normalizeHunkText(hunk)).digest("hex");
}

/** Removes string literal contents so keywords inside strings are not facts. */
function stripStrings(text: string): string {
  return text
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Strips comments and blanks string literal contents on one physical line,
 * carrying block-comment state forward. Without this, a comment such as
 * `// throw if that fails` would be mined for an error path, so comments are
 * removed before fact detection. Strings are blanked for the same reason.
 */
function scanCodeLine(text: string, inBlock: boolean): { code: string; block: boolean } {
  const trimmed = text.trimStart();
  // A JSDoc continuation can appear without its opener inside a unified=0
  // hunk (`* ...` or `*/`); treat it as a comment line.
  if (trimmed.startsWith("*") && (trimmed.length === 1 || /^[\s/]/.test(trimmed[1]))) {
    return { code: "", block: trimmed.startsWith("*/") ? false : inBlock };
  }

  let code = "";
  let block = inBlock;
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (block) {
      if (char === "*" && next === "/") {
        block = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        code += char;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code += char;
      continue;
    }

    if (char === "/" && next === "/") {
      break;
    }
    if (char === "/" && next === "*") {
      block = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      const previous = index === 0 ? "" : text[index - 1];
      const rest = text.slice(index + 1);
      const directive =
        /^\s*(?:include|define|if|ifdef|ifndef|else|elif|endif|pragma|import)\b/.test(rest);
      if ((index === 0 || /\s/.test(previous)) && !directive) {
        break;
      }
    }

    code += char;
  }

  return { code, block };
}

/**
 * Comment-stripped, string-blanked code for each changed line. Pre-image and
 * post-image are scanned independently because they are two different files:
 * a `/*` removed on one side must not blank the other side's added code.
 */
function cleanChangedLines(entries: LineRef[], startsInBlock = false): string[] {
  let inBlock = startsInBlock;
  return entries.map((entry) => {
    const scanned = scanCodeLine(entry.text, inBlock);
    inBlock = scanned.block;
    return scanned.code;
  });
}

const GUARD_ASSERT = /^\s*(?:assert|invariant|ensure)\s*\(/;
const IF_STATEMENT = /\bif\s*\(/;
const EARLY_EXIT = /\b(?:return|throw|continue|break|exit)\b/;

function isGuardLine(code: string): boolean {
  if (GUARD_ASSERT.test(code)) {
    return true;
  }
  return IF_STATEMENT.test(code) && EARLY_EXIT.test(code);
}

const EARLY_EXIT_STATEMENT = /^(?:return|throw|continue|break)\b/;

/**
 * Detects deleted brace-style guard blocks:
 *
 *   if (!user) {
 *     return null;
 *   }
 *
 * With --unified=0 the `if` and its body are separate removed lines, so
 * `isGuardLine` (which needs the exit on the same line) never fires. A guard
 * block opens a brace and its body is exactly one early-exit statement. This
 * also walks each `else if` branch as its own guard.
 */
function detectGuardBlocks(removed: LineRef[], code: string[]): Fact[] {
  const facts: Fact[] = [];

  for (let index = 0; index < removed.length; index += 1) {
    const line = code[index];
    if (!IF_STATEMENT.test(line)) {
      continue;
    }
    const opensBlock =
      /\{\s*$/.test(line.trim()) || (code[index + 1] ?? "").trim() === "{";
    if (!opensBlock) {
      continue;
    }

    const body: string[] = [];
    let cursor = index + 1;
    if ((code[cursor] ?? "").trim() === "{") {
      cursor += 1;
    }
    while (cursor < removed.length) {
      const statement = code[cursor].trim();
      if (statement.startsWith("}")) {
        break;
      }
      if (statement !== "" && statement !== "{") {
        body.push(statement);
      }
      cursor += 1;
    }

    if (body.length === 1 && EARLY_EXIT_STATEMENT.test(body[0])) {
      facts.push({
        kind: "guard_removed",
        line: removed[index].line,
        detail: `deleted guard block: ${removed[index].text.trim()} -> ${body[0]}`,
      });
    }
  }

  return facts;
}

const ERROR_PATH =
  /\bthrow\b|\braise\b|\bpanic!?\s*\(|\breject\s*\(|\.catch\s*\(|\bcatch\s*\(|\bprocess\.exit\b|\bexit\s*\(|\bnew\s+[A-Za-z_$][\w$]*Error\b/;

const BRANCH_KEYWORD = /\b(?:if|else\s+if|else|switch|case|catch)\b/;
const TERNARY = /\?\s*[^?;:\s][^?;]*:/;

function isErrorLine(code: string): boolean {
  return ERROR_PATH.test(code);
}

function isBranchLine(code: string): boolean {
  return BRANCH_KEYWORD.test(code) || TERNARY.test(code);
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "do",
  "elif",
  "else",
  "end",
  "enum",
  "except",
  "export",
  "extends",
  "false",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "lambda",
  "let",
  "map",
  "new",
  "nil",
  "not",
  "null",
  "of",
  "or",
  "package",
  "pass",
  "private",
  "protected",
  "public",
  "raise",
  "range",
  "readonly",
  "return",
  "self",
  "static",
  "struct",
  "switch",
  "then",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function shapeOf(text: string): string {
  return stripStrings(text)
    .replace(IDENTIFIER, "ID")
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

function identifiersOf(text: string): string[] {
  return stripStrings(text).match(IDENTIFIER) ?? [];
}

/**
 * Detects `foo(...)` -> `bar(...)` on line pairs that have the same textual
 * shape but different identifier sequences. Keyword swaps (`let` -> `const`)
 * are ignored because they are not symbol renames.
 */
function detectSymbolRenames(added: LineRef[], removed: LineRef[]): Fact[] {
  const facts: Fact[] = [];
  const used = new Set<number>();

  for (const removedLine of removed) {
    const removedShape = shapeOf(removedLine.text);
    if (!removedShape) {
      continue;
    }
    let best = -1;
    for (let index = 0; index < added.length; index += 1) {
      if (used.has(index) || shapeOf(added[index].text) !== removedShape) {
        continue;
      }
      if (
        best === -1 ||
        Math.abs(added[index].line - removedLine.line) <
          Math.abs(added[best].line - removedLine.line)
      ) {
        best = index;
      }
    }
    if (best === -1) {
      continue;
    }
    used.add(best);
    const addedLine = added[best];
    const from = identifiersOf(removedLine.text);
    const to = identifiersOf(addedLine.text);
    if (from.length !== to.length) {
      continue;
    }
    for (let index = 0; index < from.length; index += 1) {
      const before = from[index];
      const after = to[index];
      if (before === after || KEYWORDS.has(before) || KEYWORDS.has(after)) {
        continue;
      }
      facts.push({
        kind: "symbol_renamed",
        line: addedLine.line,
        detail: `renamed symbol: ${before} -> ${after}`,
      });
    }
  }

  return facts;
}

export function extractFacts(hunk: ParsedHunk, context?: CommentContext): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const push = (fact: Fact): void => {
    const key = `${fact.kind}:${fact.line}:${fact.detail}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    facts.push(fact);
  };

  const addedCode = cleanChangedLines(hunk.added, context?.addedStartsInBlock ?? false);
  const removedCode = cleanChangedLines(hunk.removed, context?.removedStartsInBlock ?? false);

  hunk.added.forEach((entry, index) => {
    const code = addedCode[index];
    if (isErrorLine(code)) {
      push({
        kind: "error_path_changed",
        line: entry.line,
        detail: `added error path: ${entry.text.trim()}`,
      });
    }
    if (isBranchLine(code)) {
      push({
        kind: "new_branch",
        line: entry.line,
        detail: `new branch: ${entry.text.trim()}`,
      });
    }
  });

  hunk.removed.forEach((entry, index) => {
    const code = removedCode[index];
    if (isGuardLine(code)) {
      push({
        kind: "guard_removed",
        line: entry.line,
        detail: `deleted guard: ${entry.text.trim()}`,
      });
    }
    if (isErrorLine(code)) {
      push({
        kind: "error_path_changed",
        line: entry.line,
        detail: `removed error path: ${entry.text.trim()}`,
      });
    }
  });

  for (const fact of detectGuardBlocks(hunk.removed, removedCode)) {
    push(fact);
  }

  const cleanedAdded = hunk.added.map((entry, index) => ({
    line: entry.line,
    text: addedCode[index],
  }));
  const cleanedRemoved = hunk.removed.map((entry, index) => ({
    line: entry.line,
    text: removedCode[index],
  }));
  for (const fact of detectSymbolRenames(cleanedAdded, cleanedRemoved)) {
    push(fact);
  }

  facts.sort((left, right) => left.line - right.line);
  return facts;
}

export function toHunk(parsed: ParsedHunk, context?: CommentContext): Hunk {
  const structural = parsed.exempt;
  const fileLevel = fileExemption(parsed.file);
  const content = structural || fileLevel ? undefined : contentExemption(parsed, context);

  let exempt = structural ?? fileLevel ?? content;
  let facts: Fact[] = [];
  if (exempt === undefined) {
    facts = extractFacts(parsed, context);
    if (facts.length === 0) {
      // A hunk with no recognized fact can never receive a probe, so it must
      // not enter the coverage denominator.
      exempt = "no_fact";
    }
  }

  // Pure deletions have no post-image range. Anchor their id on the pre-image
  // range (or 0-0 for synthetic sections) so it stays distinguishable from a
  // real one-line post-image hunk instead of collapsing to `1-1`.
  const id =
    parsed.newCount > 0
      ? `${parsed.file}:${parsed.newStart}-${parsed.newStart + parsed.newCount - 1}`
      : `${parsed.file}:${parsed.oldStart}-${parsed.oldStart + Math.max(parsed.oldCount, 1) - 1}`;

  const hunk: Hunk = {
    id,
    file: parsed.file,
    fingerprint: fingerprintHunk(parsed),
    facts,
  };
  if (exempt) {
    hunk.exempt = exempt;
  }
  return hunk;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`failed to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // git appends a full usage dump to some failures; the first line says why.
    const stderr = (result.stderr ?? "").trim().split("\n")[0] ?? "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout ?? "";
}

/**
 * Runs the real diff. The base ref must be threaded into argv: a bare
 * `git diff --unified=0` compares the working tree, which yields zero hunks on
 * a committed branch. `head` defaults to HEAD but is explicit so the pre-push
 * gate can diff the ref being pushed rather than the checkout. `color.ui=false`
 * and `--no-color` are both passed because a user with `color.ui=always`
 * otherwise gets ANSI escapes woven into the `diff --git` / `@@` prefixes,
 * which the parser cannot match (zero hunks and a silent false green).
 */
export function readRawDiff(base: string, cwd = process.cwd(), head = "HEAD"): string {
  return git(
    [
      "-c",
      "core.quotePath=false",
      "-c",
      "color.ui=false",
      "diff",
      "-M",
      "--no-color",
      "--unified=0",
      `${base}...${head}`,
    ],
    cwd,
  );
}

/** Repo-relative/absolute path of the persisted diff document. */
export function diffFilePath(cwd = process.cwd()): string {
  return path.join(cwd, ".hunkwise", "diff.json");
}

export function readDiffFile(cwd = process.cwd()): DiffFile {
  const raw = readFileSync(diffFilePath(cwd), "utf8");
  return DiffFileSchema.parse(JSON.parse(raw));
}

type FileTextCache = Map<string, string[] | null>;

/**
 * Full file text at `rev`, or null when it cannot be read (added/deleted file,
 * binary blob). A NUL byte means binary; comment state is meaningless there.
 */
function fileLinesAt(
  rev: string,
  file: string,
  cwd: string,
  cache: FileTextCache,
): string[] | null {
  if (!file) {
    return null;
  }
  const key = `${rev}\u0000${file}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  const result = spawnSync("git", ["show", `${rev}:${file}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let lines: string[] | null = null;
  if (!result.error && result.status === 0) {
    const text = result.stdout ?? "";
    lines = text.includes("\u0000") ? null : text.split("\n");
  }
  cache.set(key, lines);
  return lines;
}

/** Block-comment state just before a 1-based line of a whole file. */
function blockStateBefore(lines: string[], line: number): boolean {
  const limit = Math.min(Math.max(line - 1, 0), lines.length);
  let inBlock = false;
  for (let index = 0; index < limit; index += 1) {
    inBlock = scanCodeLine(lines[index], inBlock).block;
  }
  return inBlock;
}

/**
 * Resolves the block-comment state at each side's first changed line from the
 * full files. Vitest and the parser stay pure; this lookup is what lets
 * `collectDiff` know that a changed line is comment body even though its `/*`
 * opener is outside the zero-context hunk.
 */
function commentContextFor(
  hunk: ParsedHunk,
  base: string,
  head: string,
  cwd: string,
  cache: FileTextCache,
): CommentContext | undefined {
  if (hunk.exempt) {
    return undefined;
  }
  const post = fileLinesAt(head, hunk.file, cwd, cache);
  const pre = fileLinesAt(base, hunk.oldFile ?? hunk.file, cwd, cache);
  if (!post && !pre) {
    return undefined;
  }
  return {
    addedStartsInBlock: post ? blockStateBefore(post, hunk.newStart) : false,
    removedStartsInBlock: pre ? blockStateBefore(pre, hunk.oldStart) : false,
  };
}

export function collectDiff(base: string, cwd = process.cwd(), head = "HEAD"): DiffFile {
  const raw = readRawDiff(base, cwd, head);
  const headOid = git(["rev-parse", head], cwd).trim();
  const cache: FileTextCache = new Map();
  const hunks = parseDiff(raw).map((parsed) =>
    toHunk(parsed, commentContextFor(parsed, base, headOid, cwd, cache)),
  );
  return DiffFileSchema.parse({ schema: DIFF_SCHEMA, base, head: headOid, hunks });
}

export function writeDiffFile(diff: DiffFile, cwd = process.cwd()): string {
  const output = diffFilePath(cwd);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
  return output;
}

export type DisplayLine = {
  type: "add" | "del" | "ctx";
  text: string;
  line: number;
};

/**
 * Renders a parsed hunk's body as typed lines for the workbench. The post-image
 * line number is carried on every row so the UI can reveal an evidence line
 * without re-deriving unified-diff arithmetic.
 */
export function displayLines(hunk: ParsedHunk): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let newLine = hunk.newStart;
  for (const raw of hunk.body) {
    const prefix = raw[0];
    if (prefix === "+") {
      lines.push({ type: "add", text: raw.slice(1), line: Math.max(1, newLine) });
      newLine += 1;
    } else if (prefix === "-") {
      lines.push({ type: "del", text: raw.slice(1), line: Math.max(1, newLine) });
    } else if (prefix === " ") {
      lines.push({ type: "ctx", text: raw.slice(1), line: Math.max(1, newLine) });
      newLine += 1;
    } else {
      lines.push({ type: "ctx", text: raw, line: Math.max(1, newLine) });
    }
  }
  return lines;
}
