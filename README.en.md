**English** | [简体中文](./README.md)

<div align="center">

[![npm](https://img.shields.io/npm/v/hunkwise.svg?label=npm&color=4f46e5)](https://www.npmjs.com/package/hunkwise)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-4f46e5.svg)](./LICENSE)
[![no model](https://img.shields.io/badge/grading-no%20model%20in%20the%20loop-16a34a)](./docs/GRADING.md)
[![release](https://img.shields.io/github/v/release/SuperMarioYL/hunkwise?label=release)](https://github.com/SuperMarioYL/hunkwise/releases)

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Noto+Sans&weight=600&size=22&duration=3200&pause=900&color=4F46E5&center=true&vCenter=true&width=780&height=64&lines=One%20gradable%20question%20per%20changed%20hunk;Answer%20keys%20computed%20from%20the%20diff%2C%20never%20a%20model;Sealed%20when%20covered%2C%20blocked%20when%20not;verify%20exits%200%20or%201%2C%20and%20you%20can%20recompute%20it)](https://github.com/SuperMarioYL/hunkwise)

# Hunkwise

**Turn "I actually understood this" into a checkable precondition for merging: every changed hunk gets machine-gradable probes, the reviewer seals a record when they answer, and an uncovered hunk blocks the push.**

When you review a branch an agent wrote, the PR description and the tests were written by the same agent.
The only second opinion is the artifact's own account of itself. Hunkwise removes that premise: a text
rule turns behavioral changes inside a hunk into facts, a fact becomes a question, the answer key is
computed from the diff on the spot, and `verify` only exits 0 once the reviewer has answered.

<sub>One process · loopback only · no model in the grading path · all state in the repo's <code>.hunkwise/</code> · tamper-evident HMAC record · local pre-push gate</sub>

</div>

---

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3 -4.3"/></svg> Why Hunkwise

A pull request touches eleven files, written by a coding agent. The description reads well, the tests are
green, CI is green. You have exactly one action: approve, or request changes. Nothing distinguishes
"I walked through this change" from "I read the summary, saw the checks, and clicked approve" — and under
delivery pressure the second is always cheaper.

So "merged" records permission, not comprehension. After an incident, what you can produce is who clicked
the button, not who understood which hunk.

Hunkwise moves comprehension down to the hunk and makes it machine-gradable:

- **Hunk** — one `@@` block from `git diff -U0`, identified like `src/auth/session.ts:7-9`.
- **Fact** — a gradable behavioral change in that hunk: a deleted guard, a changed error path, a new branch, a renamed symbol.
- **Probe** — one four-option question per fact. The correct option is literal text from the hunk; distractors come from sibling hunks in the same branch.
- **Attestation** — per-hunk covered / uncovered, plus a `diff_sha256` and an HMAC digest.

No free-text answers, and no second model deciding whether an answer was "good enough." Correct is correct.
The answer key and the grader live on your machine, so you can recompute them yourself.

**Which half this fills.** Automated review tools (things like `alibaba/open-code-review`) move the
*reading* onto a model and produce more commentary for a human to read. Tools such as
`kyy-logs/code-review-gate-skill` answer diff-derived probes with fresh model contexts and say plainly that
this is not human review. Hunkwise is not competing on comment quality; it asks the person: where did the
guard in this hunk go? Answer it and leave a record; don't, and the gate stays closed.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16a4 4 0 1 1 .9 -7.9a6 6 0 0 1 11.6 1.7a3.5 3.5 0 0 1 -.5 6.9h-11"/><path d="M12 12v6"/><path d="M9 15l3 3l3 -3"/></svg> Install

Node 22+. Hunkwise downloads no binaries and talks to no external service.

```bash
# A: from npm (not published yet; available once it is)
npm i -D hunkwise      # or npm i -g hunkwise

# B: from source (what works today: build from a local checkout)
git clone https://github.com/SuperMarioYL/hunkwise.git   # works once the public repo ships
cd hunkwise && npm ci && npm run build && npm pack
# then, inside the repository you want to gate:
npm i -D /path/to/hunkwise/hunkwise-0.1.0.tgz
```

> **Publish status.** `hunkwise` is not on npm yet, and the public repository is not live yet, so
> both `npm i` and `git clone` above wait for the publish. What works today is path B from a local
> checkout. Publishing changes where you get the package, not a single command.

> **A note on npx.** A bare `npx hunkwise ...` can run `init` / `diff` / `review` / `verify`, but
> `install-hook` refuses to point a hook into the npx cache (`~/.npm/_npx/...` gets deleted).
> To wire the pre-push gate, install hunkwise as a devDependency of that repo or globally, then run
> `install-hook`. This is deliberate: a hook aimed at a path that vanishes tomorrow is worse than no hook.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5l-5 5"/><line x1="12" y1="19" x2="19" y2="19"/></svg> Quickstart (10 minutes)

In a repository with an `origin`, on the agent branch you need to review, copy-paste in order:

```bash
# 1) Initialize: .hunkwise/config.json, a local HMAC key, and a .gitignore entry
npx hunkwise init

# 2) Make sure the base branch exists locally
git fetch origin main

# 3) Split the branch into hunks, print the table, write .hunkwise/diff.json
npx hunkwise diff --base origin/main

# 4) Generate probes into .hunkwise/probes.json
npx hunkwise probes

# 5) Serve the workbench (loopback only) and answer in the browser
npx hunkwise review --base origin/main
#   6 hunks, 3 exempt, 4 probes
#   workbench: http://127.0.0.1:4321 (loopback only; Ctrl+C to stop)

# 6) Check coverage any time (second terminal)
npx hunkwise status
#   3/3 hunks covered (100%), 3 exempt, 4 probes

# 7) Seal the record
npx hunkwise attest
#   sealed 3/3 hunks (100%), 3 exempt
#   record: .hunkwise/attestations/<head>.json

# 8) Run the gate: exit 0 when covered, exit 1 with the uncovered hunk ids when not
npx hunkwise verify --base origin/main
#   covered 3/3 hunks for <head> (3 exempt)

# 9) Run the same command on pre-push
npx hunkwise install-hook
```

The workbench shows the unified diff with the current hunk highlighted on the left, one probe at a time on
the right, and live coverage above both. A wrong answer names the diff line the answer came from and allows
one retry; **a second miss locks that probe, and its hunk stays uncovered for this branch state.** Refreshing
does not lose answered probes — answers live in `.hunkwise/answers.json`, bound to the current `diff_sha256`;
change the branch and the old answers are discarded.

> The numbers in the comments above come from the demo repository (6 hunks, 3 in the denominator); your
> repository will produce different counts, while the commands and exit codes stay the same. If
> `npm i -D hunkwise` changed `package-lock.json` and you committed it, that hunk is exempt as
> `lockfile` and does not affect the denominator. `package.json` is not on the lockfile list, so its
> hunks are graded like any other file (exempt only as `no_fact` when no fact is recognized).

If you would rather not open a browser, the page uses these endpoints (and so can you):

```console
$ curl -s 127.0.0.1:4321/api/probes
$ curl -s -XPOST 127.0.0.1:4321/api/answer \
    -d '{"probe_id":"src/auth/session.ts:7-9#1","answer_index":2}'
{"probe_id":"src/auth/session.ts:7-9#1","correct":true,"attempts":1,
 "evidence_line":6,"evidence_text":"  if (!user) {",
 "coverage":{"total":3,"covered":3,"exempt":3,"ratio":1}}
$ curl -s -XPOST 127.0.0.1:4321/api/seal
```

`answer_index` is never sent to the browser: `/api/probes` returns prompts and options only, and
`/api/diff` withholds a fact's `detail` (which is the correct option's text) until every probe of its hunk is answered correctly.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16l13 -8z"/></svg> Demo

Full recording: [`docs/demo.cast`](./docs/demo.cast) (asciicast v2, 96×30, about 12 seconds). Play it:

```bash
asciinema play docs/demo.cast
```

The recording is a real run, not hand-assembled output: the script installs the packed release into a
throwaway repository and walks `init → diff → probes → review → answers → attest → verify (0) → install-hook`,
then switches to a second, half-reviewed branch to show `verify` exiting 1 and `git push` being refused by
the hook. The recorder is [`docs/record-demo.sh`](./docs/record-demo.sh).

```console
$ npx hunkwise diff --base origin/main
HUNK                     FACTS               FINGERPRINT   EXEMPT
-----------------------  ------------------  ------------  --------
package-lock.json:12-14  -                   6423404c9341  lockfile
package-lock.json:45-47  -                   437cc0f047d0  lockfile
src/api/handler.ts:3-3   -                   6ca2e53878df  no_fact
src/api/handler.ts:5-8   new_branch          a5787c4cc0f7  -
src/auth/errors.ts:5-5   error_path_changed  e7a3b31ff628  -
src/auth/session.ts:7-9  guard_removed       c98bb1f8f548  -

6 hunks, 3 exempt, 4 facts written to .hunkwise/diff.json

$ npx hunkwise verify --base origin/main
covered 3/3 hunks for 3f79732815f8 (3 exempt)

$ npx hunkwise verify --base origin/main     # second branch, only answered halfway
hunkwise: 1/2 non-exempt hunks are uncovered
  src/auth/errors.ts:5-5  not covered
```

Every number from that run (commands, exit codes, hunk counts, coverage) is in
[`docs/demo-results.json`](./docs/demo-results.json); the README quotes it rather than inventing figures:

| Observation | Reviewed branch | Half-reviewed branch |
| --- | --- | --- |
| Hunks total | 6 | 2 |
| Hunks in the denominator | 3 | 2 |
| Exempt | 3 (2 lockfile + 1 no_fact) | 0 |
| Facts / probes | 4 / 4 | 2 / 2 |
| Coverage | `3/3` (ratio 1) | `1/2` (ratio 0.5) |
| `verify` exit code | `0` | `1` |

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2"/><circle cx="12" cy="14" r="2"/><path d="M14 12l2 -2"/></svg> Architecture

One Node process, a few read-only git calls, no database, no daemon, no accounts.

```
git diff -U0 <base>...HEAD
        │
        ▼
  src/diff.ts ────────────────  hunks / facts / fingerprints / exemption reasons
        │  .hunkwise/diff.json
        ▼
  src/probes.ts ──────────────  four templates · sibling-hunk distractors · fingerprint-seeded shuffle
        │  .hunkwise/probes.json
        ▼
  src/server.ts ── src/ui/workbench.html      left: diff   right: one probe   top: coverage
        │  POST /api/answer   POST /api/seal
        ▼
  src/attestation.ts ─────────  zod schema · coverage math · HMAC-SHA256
        │  .hunkwise/attestations/<head>.json
        ▼
  src/gate.ts  ←  src/cli.ts    verify recomputes diff and keys, exits 0 / 1
```

- `src/cli.ts` only parses flags and prints: `init`, `diff`, `probes`, `review`, `status`, `attest`,
  `verify`, `verify-push`, `install-hook`.
- `src/server.ts` binds `127.0.0.1` only: no route returns `answer_index`, `/api/diff` withholds a
  fact's `detail` until every probe of its hunk is answered correctly, and `/api/probes` returns prompts and options only. Answer
  state is persisted so a refresh resumes.
- `src/gate.ts` is shared by `verify` and pre-push. It neither reads the on-disk `probes.json` nor
  trusts the record: it recomputes the diff from the branch, re-derives probes, re-grades, and only
  then compares `diff_sha256`, hunk fingerprints and the HMAC digest.
- `src/attestation.ts` is the only writer of records; `grade()` is shared by the workbench, `status` and
  `attest`. `verify` applies the same grading rule but compares the record itself (digest,
  `diff_sha256`, fingerprints, freshly derived answer keys), so the UI and the gate cannot disagree.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3l8 -8"/><path d="M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9"/></svg> Capabilities (v0.1)

| Command | What it does | Exit |
| --- | --- | --- |
| `hunkwise init` | Creates `.hunkwise/`, `config.json`, a local HMAC key (0600), adds `.hunkwise/` to `.gitignore` | 0 / 1 |
| `hunkwise diff [--base <ref>]` | Prints the hunk table (facts, fingerprint prefix, exemption reason) and writes `diff.json`; `--base` defaults to `config.json`'s base | 0 / 1 |
| `hunkwise probes` | Turns `diff.json` into `probes.json`, deterministically | 0 / 1 |
| `hunkwise review [--base <ref>]` | Serves the workbench on `127.0.0.1:4321` with live per-hunk coverage; `--base` defaults to `config.json`'s base | 0 / 1 |
| `hunkwise status` | Prints the same `covered/total` numbers from disk | 0 / 1 |
| `hunkwise attest` | Writes `.hunkwise/attestations/<head>.json` with `diff_sha256` and an HMAC digest | 0 / 1 |
| `hunkwise verify [--base] [--head]` | Recomputes diff and keys, lists each uncovered hunk | 0 (covered) / 1 (uncovered or stale) |
| `hunkwise verify-push` | Pre-push entry: reads git's refs and checks every pushed commit, never substituting the checked-out HEAD | 0 / 1 |
| `hunkwise install-hook` | Writes `.git/hooks/pre-push`; refuses to clobber a foreign hook, `core.hooksPath`, or an npx cache path | 0 / 1 |

What v0.1 actually does:

- Four text-level fact kinds and eight explicit exemption reasons (see [`docs/GRADING.md`](./docs/GRADING.md));
- 1–3 probes per hunk, the correct option is literal hunk text, option order is seeded by the hunk
  fingerprint, and the same diff reproduces byte-identical probes;
- Per-hunk grading: one wrong answer reveals the evidence line, two misses lock the probe and leave the hunk
  uncovered;
- `verify` trusts no cache: it recomputes the diff and the keys from the branch, so editing the branch or
  the sealed record (including its answer keys) makes it exit 1. Editing `probes.json` does not affect
  `verify`, which never reads it;
- A local `pre-push` hook that verifies each pushed commit;
- All state as flat JSON under `.hunkwise/`; no database, no network calls.

What it deliberately does not do (the v0.1 boundary, stated so you don't assume otherwise):

- **No server-side enforcement.** This is a local gate: CLI plus pre-push hook. `git push --no-verify`
  bypasses it. Branch protection and server-side merge refusal are the v0.2 team tier; v0.1 makes no such claim.
- **The record is tamper-evident, not identity.** The HMAC key lives in the repo (`.hunkwise/` is
  gitignored); anyone with the record and the key can re-sign it. It proves the record was not edited, not
  who answered.
- **No model grading, no free text.** Only four text-level facts; a semantic change outside them is exempted
  as `no_fact` instead of being turned into a guessed question.
- **No AST, type inference or cross-language semantic analysis.** The rules are textual, and v0.1 is
  exercised on JS/TS.
- **No hosted service, accounts, multi-user sync or team dashboards**; no backfilling history or bulk-scoring
  old PRs; no billing.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2"/></svg> How coverage is computed

In one sentence: **answer keys come from diff facts, never from a model; a hunk counts as covered only when
all of its probes are correct, and two misses leave it uncovered for good.**

| Fact kind | Trigger | Correct answer |
| --- | --- | --- |
| `guard_removed` | Deleting a same-line condition + early exit, or an `if (...) {` block whose body is exactly one `return` / `throw` | The deleted line's text |
| `error_path_changed` | An added or removed line containing `throw`, `raise`, `panic!(`, `reject(`, `.catch(`, `process.exit`, `new XxxError`, and similar | That error-handling line's text |
| `new_branch` | An added line containing `if` / `else if` / `switch` / `case` / `catch` or a ternary | That branch line's text |
| `symbol_renamed` | A removed/added pair with the same shape and identifier count, where a non-keyword identifier differs | The new symbol |

Exemption reasons (excluded from the denominator): `no_fact`, `comment-only`, `whitespace`, `lockfile`,
`generated`, `binary`, `mode-change`, `rename-only`. Lockfiles and generated files are exempt because making
someone prove they read a version bump in `package-lock.json` says nothing about this change.

The full rule, the edges of each fact kind, and what the record does and does not prove are in
[`docs/GRADING.md`](./docs/GRADING.md) (Chinese; the summary above is the English restatement).

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06 .06a2 2 0 1 1 -2.83 2.83l-.06 -.06a1.65 1.65 0 0 0 -1.82 -.33a1.65 1.65 0 0 0 -1 1.51v.17a2 2 0 1 1 -4 0v-.09a1.65 1.65 0 0 0 -1.08 -1.51a1.65 1.65 0 0 0 -1.82 .33l-.06 .06a2 2 0 1 1 -2.83 -2.83l.06 -.06a1.65 1.65 0 0 0 .33 -1.82a1.65 1.65 0 0 0 -1.51 -1h-.17a2 2 0 1 1 0 -4h.09a1.65 1.65 0 0 0 1.51 -1.08a1.65 1.65 0 0 0 -.33 -1.82l-.06 -.06a2 2 0 1 1 2.83 -2.83l.06 .06a1.65 1.65 0 0 0 1.82 .33h.01a1.65 1.65 0 0 0 1 -1.51v-.17a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51a1.65 1.65 0 0 0 1.82 -.33l.06 -.06a2 2 0 1 1 2.83 2.83l-.06 .06a1.65 1.65 0 0 0 -.33 1.82v.01a1.65 1.65 0 0 0 1.51 1h.17a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0 -1.51 1z"/></svg> Configuration

After `init`, only two files are configuration; the rest is runtime state.

| Path | Contents | Notes |
| --- | --- | --- |
| `.hunkwise/config.json` | `{"schema":"hunkwise/config@1","base":"origin/main"}` | `init --base <ref>` sets the base when the file is first created; an existing file is never rewritten (edit it to change the base) |
| `.hunkwise/key` | 32 bytes of hex, mode `0600` | HMAC key; `init` creates it only when missing |
| `.hunkwise/diff.json` | Hunks, facts, fingerprints, exemptions | Written by `diff` / `review` |
| `.hunkwise/probes.json` | Probes and answer keys | Written by `probes` / `review`; a working artifact, not a trust anchor — `verify` never reads it and re-derives the probes from the diff |
| `.hunkwise/answers.json` | Answers and attempt counts | Written by the workbench, bound to the current `diff_sha256` |
| `.hunkwise/attestations/<head>.json` | Record and digest | Written by `attest` / `/api/seal` |

Flags:

| Flag | Effect |
| --- | --- |
| `--base <ref>` | Base branch for `diff` / `review` / `verify` / `verify-push` / `install-hook`; falls back to `config.json`'s `base` |
| `--head <rev>` | `verify` checks this commit instead of `HEAD` |
| `--port <n>` | `review` port, default `4321`, always bound to `127.0.0.1` |

No environment variables, no remote config, no accounts. `init` adds `.hunkwise/` to `.gitignore`, so keys
and answers do not travel with the branch; a new machine needs a fresh `init` (old records can still be
verified if you bring the key along).

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z"/><path d="M3 10l18 0"/></svg> Team tier (v0.2, not built)

The CLI is MIT, fully local, and free. The layer above it is for organizations that need to show evidence:

- **Org-side attestation storage** — records live in the team's own service, not on each reviewer's laptop;
- **Merge enforcement** — coverage wired into required checks on GitLab / Gitee / GitHub, instead of relying on a local hook;
- **Audit export** — quarterly CSV / JSON: which merge, which reviewer, which hunks were understood;
- **Self-hosted** — Docker plus a license file, no cloud dependency, for internal-network and procurement reviews.

Reference price: **¥1,200 per seat per year, 20-seat minimum = ¥24,000 per year**, aimed at platform-engineering
and developer-productivity teams of 200–2,000 people on self-hosted GitLab/Gitee, in payments or infrastructure.
The smallest "yes" is a 30-minute session on an agent PR you already merged: `verify` exits 1 on the hunk you
missed, then 0 after you answer it. A two-week paid pilot is ¥5,000, credited in full against the annual contract.

v0.1 ships no billing code and no cloud console — this is a stated direction, not a shipped feature.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l6 -3l6 3l6 -3v13l-6 3l-6 -3l-6 3v-13"/><path d="M9 4v13"/><path d="M15 7v13"/></svg> Roadmap

**Shipped (v0.1)**

- m1: `diff` splits the branch into hunks, identifies facts, fingerprints and exemption reasons;
- m2: `probes` generates gradable probes for all four fact kinds, deterministic and reproducible;
- m3: `review` serves the loopback workbench; answers resume, and `status` reads the same grading;
- m4: `attest` seals an HMAC record, `verify` exits 0/1, `install-hook` wires it into pre-push.

Details in [`CHANGELOG.md`](./CHANGELOG.md).

**Next (ordered by demand, no dates promised)**

- v0.2 team tier: org-side records, merge enforcement, audit export, self-hosted image;
- More fact kinds and fewer `no_fact` exemptions — the four text rules are the biggest known gap;
- Real-world coverage of non-JS/TS languages (Python / Go guard and error-path idioms differ);
- A copy-pasteable GitLab / Gitee runner recipe so `verify` runs in CI, not only in a local hook;
- If agents start emitting per-hunk intent and invariants, extend the workbench from "answer probes" to
  "check the agent's invariants."

**Not planned**: see the boundary list under "Capabilities (v0.1)" — that is the v0.1 contract, not a backlog.

## <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg> License

MIT. See [`LICENSE`](./LICENSE).

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
