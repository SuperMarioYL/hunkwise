# Changelog

All notable changes to Hunkwise are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Distractors are drawn only from other hunks in the diff; a hunk's own answers are never used as
  options (the pool previously mixed them in), with canned false statements as the deterministic
  fallback when the branch has too few sibling answers.
- `diff` and `review` fall back to the base recorded by `init`, the same as `verify`, `verify-push`
  and `install-hook`, so no command needs `--base` after `init`.
- `/api/diff` redacts a fact's `detail` until every probe of its hunk is answered correctly, so the
  correct option text is not readable from the diff endpoint before answering.
- Documentation corrected to match the code: `verify` re-derives probes from the diff instead of
  reading `probes.json`; `grade()` is shared by the workbench, `status` and `attest`, while `verify`
  compares the sealed record against fresh keys; `package.json` is not a lockfile; `__generated__/`
  (not `generated/`) is exempt; `init --base` does not rewrite an existing config; the tool makes a
  few read-only git calls, not one.
- Demo re-recorded against the shipped build, and `docs/demo-results.json` now quotes the same
  commit ids and `it runs:` hook line as `docs/demo.cast`.

## [0.1.0] - 2026-11-24

The first release: a branch diff becomes per-hunk facts, facts become gradable probes whose
answer keys are computed from the diff itself, and a sealed record lets a local `verify`
exit 0 or 1. No model is called anywhere in the grading path.

### Added

**m1 — parse the diff into hunks**

- `hunkwise init` writes `.hunkwise/config.json` (with the default base ref), a local 32-byte
  HMAC key at mode `0600`, and adds `.hunkwise/` to `.gitignore`. It never overwrites an existing
  key, and it validates a corrupt key before writing anything else.
- `hunkwise diff [--base <ref>]` runs `git diff -M --unified=0 <base>...HEAD` and prints a hunk
  table (id, fact kinds, fingerprint prefix, exemption reason), then writes `.hunkwise/diff.json`
  with schema `hunkwise/diff@1`. `--base` defaults to the base recorded by `init`.
- Four text-level fact kinds: `guard_removed`, `error_path_changed`, `new_branch`,
  `symbol_renamed`. Fact extraction strips comments and blanks string literals first, so a
  comment such as `// throw if that fails` is not mined for an error path.
- Eight explicit exemption reasons: `no_fact`, `comment-only`, `whitespace`, `lockfile`,
  `generated`, `binary`, `mode-change`, `rename-only`. Exempt hunks are listed with their reason
  and excluded from the coverage denominator.
- Hunk ids use the post-image line range (`src/auth/session.ts:7-9`), and fingerprints are
  sha256 over normalized hunk text, so the same change always gets the same id and key seed.

**m2 — synthesize gradable probes**

- `hunkwise probes` turns `diff.json` into `.hunkwise/probes.json` (schema `hunkwise/probes@1`).
  Each probe has a prompt, four options, one answer index and an evidence line.
- Every correct option is literal text from the hunk. Distractors are answer strings from *other*
  hunks (sorted for stability), never from the hunk being asked about, padded with canned false
  statements when the branch is too small.
- Option order is a seeded shuffle keyed by the hunk fingerprint, so a fixed diff reproduces
  byte-identical probes; at most three probes per hunk, preferring one per fact kind.
- `test/probes.test.ts` asserts, per fact kind, that the answer text occurs in the hunk and that
  the shuffle is stable for a fixed fingerprint.

**m3 — serve the review workbench**

- `hunkwise review [--base <ref>]` serves `src/ui/workbench.html` on `127.0.0.1:4321` (the port is
  configurable; `--base` defaults to the base recorded by `init`). Left pane: the unified diff with
  the current hunk highlighted. Right pane: one probe with radio options. Above both: live per-hunk
  coverage.
- `POST /api/answer` grades and persists to `.hunkwise/answers.json`, bound to the current
  `diff_sha256`, so a refresh or a restart resumes instead of starting over. A wrong answer
  reveals the diff line the answer came from and allows exactly one retry; a second miss locks the
  probe and leaves its hunk uncovered.
- Answer keys stay server-side: no route returns `answer_index`; `/api/probes` returns prompts and
  options only, and `/api/diff` redacts a fact's `detail` until its hunk is answered.
- Host-header checking rejects DNS-rebinding requests, and the server binds loopback only.
- `hunkwise status` prints the same `covered/total` numbers from disk, through the same `grade()`.

**m4 — seal the attestation and gate the push**

- `hunkwise attest` writes `.hunkwise/attestations/<head>.json` with `diff_sha256`, per-hunk
  fingerprints and coverage, the reviewer identity from `git config user.email`, and an
  HMAC-SHA256 digest over canonical JSON using the local key. `POST /api/seal` does the same from
  the workbench.
- `hunkwise verify` recomputes the diff, re-derives the probes and re-grades the sealed answers;
  it exits 0 when every non-exempt hunk is covered and exits 1 listing each uncovered hunk and
  why (not covered, branch changed, record missing, digest invalid).
- `hunkwise verify-push` reads git's pre-push ref list and verifies every pushed commit, never
  substituting the checked-out HEAD. Deletions are allowed, non-commit objects are skipped, and
  an unverifiable ref blocks the push.
- `hunkwise install-hook` writes an executable `.git/hooks/pre-push`. It resolves the CLI through
  realpath so a local or global install gets a stable path, refuses to point into the npx cache,
  refuses to silently do nothing when `core.hooksPath` is set, and refuses to overwrite a foreign
  hook.
- `docs/GRADING.md` states the answer-key rule, the four fact kinds, every exemption reason, the
  two-attempt limit, and what the HMAC record does and does not prove.
- `docs/demo.cast` records the real quickstart (asciicast v2, 96×30, ~12s), and
  `docs/demo-results.json` records the commands, exit codes and coverage numbers it observed.

### Notes

- v0.1 is a local gate: a CLI plus a pre-push hook. `git push --no-verify` bypasses it, and the
  record is tamper-evident, not attribution — anyone with the repo and the key can re-sign one.
  Server-side enforcement is the v0.2 team tier, which is not implemented.
- Grading is text-level only: no AST, no type inference, no model. A semantic change outside the
  four fact kinds is exempted as `no_fact` rather than guessed at.
- The recorded demo is synthetic (a throwaway `acme-service` repo, reviewer
  `reviewer@acme.test`); the commands and numbers are real.
