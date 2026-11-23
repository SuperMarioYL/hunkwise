#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  answersMatchDiff,
  DEFAULT_BASE,
  grade,
  initProject,
  readAnswers,
  readAttestation,
  requireInit,
  resolveBase,
  seal,
} from "./attestation.js";
import { collectDiff, readDiffFile, writeDiffFile, type DiffFile } from "./diff.js";
import { installHook, verify, verifyPushedRefs } from "./gate.js";
import { buildProbes, readProbesFile, writeProbesFile } from "./probes.js";
import { startWorkbench } from "./server.js";

type Row = {
  hunk: string;
  facts: string;
  fingerprint: string;
  exempt: string;
};

function printHunkTable(diff: DiffFile): void {
  if (diff.hunks.length === 0) {
    console.log(`No hunks between ${diff.base} and HEAD.`);
    return;
  }

  const rows: Row[] = diff.hunks.map((hunk) => ({
    hunk: hunk.id,
    facts:
      hunk.facts.length > 0
        ? [...new Set(hunk.facts.map((fact) => fact.kind))].join(",")
        : "-",
    fingerprint: hunk.fingerprint.slice(0, 12),
    exempt: hunk.exempt ?? "-",
  }));

  const header: Row = {
    hunk: "HUNK",
    facts: "FACTS",
    fingerprint: "FINGERPRINT",
    exempt: "EXEMPT",
  };

  const width = (key: keyof Row): number =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length), 0);

  const widths = {
    hunk: width("hunk"),
    facts: width("facts"),
    fingerprint: width("fingerprint"),
    exempt: width("exempt"),
  };

  const format = (row: Row): string =>
    `${row.hunk.padEnd(widths.hunk)}  ${row.facts.padEnd(widths.facts)}  ${row.fingerprint.padEnd(
      widths.fingerprint,
    )}  ${row.exempt}`;

  console.log(format(header));
  console.log(
    `${"-".repeat(widths.hunk)}  ${"-".repeat(widths.facts)}  ${"-".repeat(
      widths.fingerprint,
    )}  ${"-".repeat(widths.exempt)}`,
  );
  for (const row of rows) {
    console.log(format(row));
  }
}

function relative(target: string): string {
  return path.relative(process.cwd(), target) || target;
}

function fail(error: unknown): void {
  console.error(`hunkwise: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function run(action: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(action)
    .catch(fail);
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const program = new Command();

program
  .name("hunkwise")
  .description("Turn a branch diff into per-hunk facts, probes, and a merge gate.");

program
  .command("init")
  .description("Create .hunkwise/config.json, the local HMAC key, and the .gitignore entry")
  .option("--base <ref>", "default base ref stored in config.json", DEFAULT_BASE)
  .action((options: { base: string }) => {
    run(() => {
      const result = initProject({ base: options.base });
      console.log(`initialized ${relative(result.dir)} (base ${result.base})`);
      console.log(
        `  config: ${relative(result.configPath)} ${result.configCreated ? "created" : "kept"}`,
      );
      console.log(
        `  key: ${relative(result.keyPath)} ${
          result.keyCreated ? "created (32 bytes, mode 0600)" : "kept existing"
        }`,
      );
      console.log(
        `  ${relative(result.gitignorePath)}: ${
          result.gitignoreUpdated ? "added .hunkwise/" : ".hunkwise/ already ignored"
        }`,
      );
    });
  });

program
  .command("diff")
  .description("Parse the diff against a base ref and write .hunkwise/diff.json")
  .option("--base <ref>", "git ref to diff against; defaults to the base in .hunkwise/config.json")
  .action((options: { base?: string }) => {
    run(() => {
      requireInit();
      const diff = collectDiff(resolveBase({ base: options.base }));
      const output = writeDiffFile(diff);
      printHunkTable(diff);

      const exempt = diff.hunks.filter((hunk) => hunk.exempt !== undefined).length;
      const facts = diff.hunks.reduce((total, hunk) => total + hunk.facts.length, 0);
      console.log("");
      console.log(
        `${diff.hunks.length} hunks, ${exempt} exempt, ${facts} facts written to ${relative(output)}`,
      );
    });
  });

program
  .command("probes")
  .description("Turn .hunkwise/diff.json into gradable probes in .hunkwise/probes.json")
  .action(() => {
    run(() => {
      requireInit();
      const diff = readDiffFile();
      const probes = buildProbes(diff);
      const output = writeProbesFile(probes);
      const gradable = diff.hunks.filter((hunk) => hunk.exempt === undefined).length;
      console.log(
        `${probes.probes.length} probes over ${gradable} hunks written to ${relative(output)}`,
      );
    });
  });

program
  .command("review")
  .description("Serve the local workbench at 127.0.0.1:4321")
  .option("--base <ref>", "git ref to diff against; defaults to the base in .hunkwise/config.json")
  .option("--port <port>", "loopback port for the workbench", "4321")
  .action((options: { base?: string; port: string }) => {
    run(async () => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid --port: ${options.port}`);
      }
      requireInit();
      const workbench = await startWorkbench({
        base: resolveBase({ base: options.base }),
        port,
      });
      const exempt = workbench.diff.hunks.filter((hunk) => hunk.exempt).length;
      console.log(
        `${workbench.diff.hunks.length} hunks, ${exempt} exempt, ${workbench.probes.probes.length} probes`,
      );
      console.log(`workbench: ${workbench.url} (loopback only; Ctrl+C to stop)`);
    });
  });

program
  .command("status")
  .description("Print covered/total hunks from the state on disk")
  .action(() => {
    run(() => {
      const diff = readDiffFile();
      const probes = readProbesFile();
      const saved = readAnswers();
      const answers = saved && answersMatchDiff(saved, diff) ? saved.entries : {};
      const { coverage } = grade(diff, probes, answers);
      console.log(
        `${coverage.covered}/${coverage.total} hunks covered (${Math.round(
          coverage.ratio * 100,
        )}%), ${coverage.exempt} exempt, ${probes.probes.length} probes`,
      );
      const attestation = readAttestation(diff.head);
      if (attestation) {
        console.log(
          `sealed: .hunkwise/attestations/${diff.head}.json (reviewer ${attestation.reviewer})`,
        );
      }
    });
  });

program
  .command("attest")
  .description("Seal the current coverage into .hunkwise/attestations/<head>.json")
  .action(() => {
    run(() => {
      const diff = readDiffFile();
      const probes = readProbesFile();
      const saved = readAnswers();
      const answers = saved && answersMatchDiff(saved, diff) ? saved.entries : {};
      const result = seal({ diff, probes, answers });
      const { coverage } = result.record;
      console.log(
        `sealed ${coverage.covered}/${coverage.total} hunks (${Math.round(
          coverage.ratio * 100,
        )}%), ${coverage.exempt} exempt`,
      );
      console.log(`reviewer: ${result.record.reviewer}`);
      console.log(`record: ${relative(result.path)}`);
    });
  });

program
  .command("verify")
  .description("Exit 1 when any non-exempt hunk is uncovered")
  .option("--base <ref>", "git ref to diff against; defaults to the base in .hunkwise/config.json")
  .option("--head <rev>", "commit to verify instead of HEAD")
  .action((options: { base?: string; head?: string }) => {
    run(() => {
      requireInit();
      const result = verify({ base: resolveBase({ base: options.base }), head: options.head });
      if (result.ok) {
        console.log(
          `covered ${result.coverage.covered}/${result.coverage.total} hunks for ${result.head.slice(
            0,
            12,
          )} (${result.coverage.exempt} exempt)`,
        );
        return;
      }
      console.error(
        `hunkwise: ${result.uncovered.length}/${result.coverage.total} non-exempt hunks are uncovered`,
      );
      for (const hunk of result.uncovered) {
        console.error(`  ${hunk.id}  ${hunk.reason}`);
      }
      process.exitCode = 1;
    });
  });

program
  .command("verify-push")
  .description("Pre-push entry: verify every local commit a push would publish")
  .option("--base <ref>", "git ref to diff each pushed commit against; defaults to config.json's base")
  .action((options: { base?: string }) => {
    run(() => {
      requireInit();
      const result = verifyPushedRefs(readStdin(), {
        base: resolveBase({ base: options.base }),
      });
      for (const ref of result.refs) {
        if (ref.status === "skipped-deletion" || ref.status === "skipped-not-commit") {
          continue;
        }
        if (ref.status === "covered") {
          const coverage = ref.result?.coverage;
          console.log(
            `covered ${coverage?.covered ?? 0}/${coverage?.total ?? 0} hunks for ${ref.ref} (${ref.oid.slice(0, 12)})`,
          );
          continue;
        }
        if (ref.status === "unverifiable") {
          console.error(
            `hunkwise: could not verify ${ref.ref} (${ref.oid.slice(0, 12)}): ${ref.error ?? "unknown error"}`,
          );
          continue;
        }
        const gate = ref.result;
        console.error(
          `hunkwise: ${ref.ref} (${ref.oid.slice(0, 12)}) has ${gate?.uncovered.length ?? 0}/${
            gate?.coverage.total ?? 0
          } non-exempt hunks uncovered`,
        );
        for (const hunk of gate?.uncovered ?? []) {
          console.error(`  ${hunk.id}  ${hunk.reason}`);
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  });

program
  .command("install-hook")
  .description("Write .git/hooks/pre-push so verify blocks uncovered pushes")
  .option("--base <ref>", "git ref the pre-push hook should diff against; defaults to config.json's base")
  .action((options: { base?: string }) => {
    run(() => {
      const base = resolveBase({ base: options.base });
      const result = installHook({ base });
      console.log(`installed pre-push hook at ${relative(result.path)}`);
      console.log(`it runs: ${result.command} for every pushed commit`);
    });
  });

program.parseAsync().catch(fail);
