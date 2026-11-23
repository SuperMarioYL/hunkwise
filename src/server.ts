import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ATTEMPTS,
  diffDigest,
  grade,
  readAnswers,
  seal,
  answersMatchDiff,
  writeAnswers,
  type AnswerLog,
  type Coverage,
} from "./attestation.js";
import {
  collectDiff,
  displayLines,
  parseDiff,
  readRawDiff,
  writeDiffFile,
  type DiffFile,
} from "./diff.js";
import {
  PROBES_SCHEMA,
  buildProbes,
  writeProbesFile,
  type Probe,
  type ProbesFile,
} from "./probes.js";

/**
 * The local workbench. One process, bound to loopback, no accounts, no network
 * calls: diff on the left, one probe at a time on the right, coverage live.
 * No route returns `answer_index`: the browser only sees prompts and options,
 * fact details stay redacted until the hunk is answered, and an evidence line
 * is revealed after an answer is submitted.
 */

const DEFAULT_PORT = 4321;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

// dist/server.js -> ../src/ui/workbench.html; src/server.ts -> ../src/ui/... too.
// A packaged build that copies the file next to dist/server.js is also honored.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_CANDIDATES = [
  path.join(MODULE_DIR, "..", "src", "ui", "workbench.html"),
  path.join(MODULE_DIR, "ui", "workbench.html"),
];

type WorkbenchState = {
  cwd: string;
  diff: DiffFile;
  probes: ProbesFile;
  patch: string;
  answers: AnswerLog;
  evidence: Map<string, { line: number; text: string }>;
  port: number;
};

export type Workbench = {
  url: string;
  port: number;
  diff: DiffFile;
  probes: ProbesFile;
  close: () => Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Rejects DNS-rebinding style requests that arrive with a foreign Host. */
function trustedHost(header: string | undefined, port: number): boolean {
  if (!header) {
    return false;
  }
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return allowed.has(header);
}

function evidenceMap(diff: DiffFile, probes: ProbesFile, patch: string): WorkbenchState["evidence"] {
  const parsed = parseDiff(patch);
  const linesByHunk = new Map<string, ReturnType<typeof displayLines>>();
  diff.hunks.forEach((hunk, index) => {
    const parsedHunk = parsed[index];
    linesByHunk.set(hunk.id, parsedHunk ? displayLines(parsedHunk) : []);
  });

  const evidence = new Map<string, { line: number; text: string }>();
  for (const probe of probes.probes) {
    const lines = linesByHunk.get(probe.hunk_id) ?? [];
    const answer = probe.options[probe.answer_index]?.trim() ?? "";
    // A replacement hunk has both a deleted and an added row at the same
    // post-image line. The answer is the option text, so reveal the row that
    // actually contains it, preferring the added (post-image) side; otherwise
    // a rename would unveil the line it replaced.
    const row =
      (answer === ""
        ? undefined
        : lines.find((line) => line.type === "add" && line.text.includes(answer))) ??
      (answer === ""
        ? undefined
        : lines.find((line) => line.type !== "add" && line.text.includes(answer))) ??
      lines.find((line) => line.line === probe.evidence_line && line.type !== "ctx") ??
      lines.find((line) => line.line === probe.evidence_line);
    if (row) {
      evidence.set(probe.id, { line: row.line, text: row.text });
    }
  }
  return evidence;
}

/**
 * A fact's detail names the correct option text, so `/api/diff` withholds it
 * until every probe of that hunk has been answered correctly. Otherwise the
 * answer key would be readable from the diff endpoint before answering, even
 * though `answer_index` itself never leaves the server.
 */
function revealedHunks(state: WorkbenchState): Set<string> {
  const byHunk = new Map<string, Probe[]>();
  for (const probe of state.probes.probes) {
    const list = byHunk.get(probe.hunk_id) ?? [];
    list.push(probe);
    byHunk.set(probe.hunk_id, list);
  }
  const revealed = new Set<string>();
  for (const [hunkId, hunkProbes] of byHunk) {
    if (hunkProbes.every((probe) => state.answers[probe.id]?.correct === true)) {
      revealed.add(hunkId);
    }
  }
  return revealed;
}

function hunkPayload(state: WorkbenchState): unknown {
  const parsed = parseDiff(state.patch);
  const revealed = revealedHunks(state);
  return {
    base: state.diff.base,
    head: state.diff.head,
    patch: state.patch,
    hunks: state.diff.hunks.map((hunk, index) => ({
      id: hunk.id,
      file: hunk.file,
      fingerprint: hunk.fingerprint,
      facts: hunk.facts.map((fact) => ({
        kind: fact.kind,
        line: fact.line,
        detail: hunk.exempt !== undefined || revealed.has(hunk.id) ? fact.detail : null,
      })),
      exempt: hunk.exempt ?? null,
      header: parsed[index]?.context ?? "",
      lines: parsed[index] ? displayLines(parsed[index]) : [],
    })),
  };
}

function probePayload(probes: ProbesFile): unknown {
  return {
    schema: PROBES_SCHEMA,
    // answer_index and evidence_line stay server-side until an answer arrives.
    probes: probes.probes.map((probe) => ({
      id: probe.id,
      hunk_id: probe.hunk_id,
      kind: probe.kind,
      prompt: probe.prompt,
      options: probe.options,
    })),
  };
}

function coveragePayload(state: WorkbenchState): Coverage & {
  hunks: { id: string; covered: boolean; attempts: number }[];
  probes: {
    id: string;
    hunk_id: string;
    attempts: number;
    correct: boolean;
    locked: boolean;
  }[];
} {
  const graded = grade(state.diff, state.probes, state.answers);
  return {
    ...graded.coverage,
    hunks: graded.hunks.map((hunk) => ({
      id: hunk.id,
      covered: hunk.covered,
      attempts: hunk.attempts,
    })),
    probes: state.probes.probes.map((probe) => {
      const answer = state.answers[probe.id];
      const attempts = answer?.attempts ?? 0;
      return {
        id: probe.id,
        hunk_id: probe.hunk_id,
        attempts,
        correct: answer?.correct === true,
        locked: answer?.correct !== true && attempts >= MAX_ATTEMPTS,
      };
    }),
  };
}

function persistAnswers(state: WorkbenchState): void {
  writeAnswers(
    {
      base: state.diff.base,
      head: state.diff.head,
      diff_sha256: diffDigest(state.diff),
      entries: state.answers,
    },
    state.cwd,
  );
}

function findProbe(state: WorkbenchState, probeId: string): Probe | undefined {
  return state.probes.probes.find((probe) => probe.id === probeId);
}

async function handle(state: WorkbenchState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (!trustedHost(req.headers.host, state.port)) {
    text(res, 403, "hunkwise: refusing a request with an untrusted Host header\n");
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = readFileSync(UI_CANDIDATES.find((file) => existsSync(file)) ?? UI_CANDIDATES[0], "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
    } catch {
      text(res, 500, "hunkwise: src/ui/workbench.html is missing\n");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/diff") {
    json(res, 200, hunkPayload(state));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/probes") {
    json(res, 200, probePayload(state.probes));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/coverage") {
    json(res, 200, coveragePayload(state));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/answer") {
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
      return;
    }
    const probeId = body.probe_id;
    const answerIndex = body.answer_index;
    if (typeof probeId !== "string" || typeof answerIndex !== "number") {
      json(res, 400, { error: "probe_id (string) and answer_index (number) are required" });
      return;
    }
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
      json(res, 400, { error: "answer_index must be an integer from 0 to 3" });
      return;
    }
    const probe = findProbe(state, probeId);
    if (!probe) {
      json(res, 404, { error: `unknown probe ${probeId}` });
      return;
    }

    const current = state.answers[probe.id] ?? { attempts: 0, correct: false };
    if (!current.correct && current.attempts >= MAX_ATTEMPTS) {
      json(res, 409, {
        error: "this probe is locked: two misses leave the hunk uncovered",
        attempts: current.attempts,
      });
      return;
    }

    let correct = current.correct;
    let attempts = current.attempts;
    if (!current.correct) {
      correct = answerIndex === probe.answer_index;
      attempts = current.attempts + 1;
      state.answers[probe.id] = { attempts, correct };
      persistAnswers(state);
    }

    const evidence = state.evidence.get(probe.id);
    json(res, 200, {
      probe_id: probe.id,
      correct,
      attempts,
      retry_allowed: !correct && attempts < MAX_ATTEMPTS,
      evidence_line: evidence?.line ?? probe.evidence_line,
      evidence_text: evidence?.text ?? "",
      coverage: grade(state.diff, state.probes, state.answers).coverage,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/seal") {
    try {
      await readBody(req);
      persistAnswers(state);
      const sealed = seal({
        diff: state.diff,
        probes: state.probes,
        answers: state.answers,
        cwd: state.cwd,
      });
      json(res, 200, {
        ok: true,
        path: path.relative(state.cwd, sealed.path) || sealed.path,
        coverage: sealed.record.coverage,
        reviewer: sealed.record.reviewer,
        digest: sealed.record.digest,
      });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "seal failed" });
    }
    return;
  }

  json(res, 404, { error: `no route for ${req.method ?? "GET"} ${url.pathname}` });
}

export type StartOptions = {
  base: string;
  cwd?: string;
  port?: number;
  host?: string;
};

export async function startWorkbench(options: StartOptions): Promise<Workbench> {
  const cwd = options.cwd ?? process.cwd();
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const diff = collectDiff(options.base, cwd);
  const probes = buildProbes(diff);
  writeDiffFile(diff, cwd);
  writeProbesFile(probes, cwd);
  const patch = readRawDiff(options.base, cwd);

  const saved = readAnswers(cwd);
  const answers: AnswerLog =
    saved && answersMatchDiff(saved, diff) ? { ...saved.entries } : {};

  const state: WorkbenchState = {
    cwd,
    diff,
    probes,
    patch,
    answers,
    evidence: evidenceMap(diff, probes, patch),
    port,
  };

  const server: Server = createServer((req, res) => {
    handle(state, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: error instanceof Error ? error.message : "internal error" });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  state.port = boundPort;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    diff,
    probes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
