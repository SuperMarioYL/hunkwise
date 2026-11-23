import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "../src/attestation.js";

/**
 * The CLI is exercised as it ships: `diff` and `review` must not require
 * `--base` in a repo where `init` already recorded one. Unit tests cannot
 * import src/cli.ts because it parses argv on load, so this drives dist/cli.js
 * and builds it first, which also keeps the test from reading a stale dist.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const scratch: string[] = [];

beforeAll(() => {
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`npm run build failed: ${build.stderr}`);
  }
});

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Hunkwise Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Hunkwise Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeRepo(initialize: boolean): string {
  const repo = mkdtempSync(path.join(tmpdir(), "hunkwise-cli-"));
  scratch.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "a.ts"), "export function f() {\n  return 1;\n}\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(repo, "a.ts"), 'export function f() {\n  throw new Error("boom");\n}\n');
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "change"]);
  if (initialize) {
    initProject({ cwd: repo, base: "main" });
  }
  return repo;
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: env() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("cli base default", () => {
  it("diff needs no --base once init recorded one", () => {
    const repo = makeRepo(true);
    const result = runCli(repo, ["diff"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(path.join(repo, ".hunkwise", "diff.json"), "utf8")) as {
      base: string;
    };
    expect(written.base).toBe("main");
    expect(result.stdout).toContain("hunks");
  });

  it("diff without init and without --base names both remedies", () => {
    const repo = makeRepo(false);
    const result = runCli(repo, ["diff"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not initialized|no base configured/);
  });
});
