# Manual setup left for you

Everything the build could automate is done: source, tests, CI, the release workflow, the demo
cast, both READMEs, the grading document and the changelog are in place. The steps below need your
accounts or your hands.

## 1. Publish to npm (so `npm i -D hunkwise` and `npx hunkwise` work)

`package.json` already declares `name: hunkwise`, `bin: hunkwise`, `files: [dist]` and
`prepack: npm run build`. The release workflow publishes only when the `NPM_TOKEN` secret is set,
so a fresh repo never fails a release on a missing token.

1. Confirm the name is free: `npm view hunkwise` (a 404 means free; if it was taken, rename to
   `@<you>/hunkwise` in `package.json` and update the install snippets in both READMEs).
2. Create an **Automation** token (not Publish/Read-only) at
   <https://www.npmjs.com/settings/~/tokens>.
3. Add it: `gh secret set NPM_TOKEN --body "<token>" --repo SuperMarioYL/hunkwise`.
4. Claim the name with the first local publish:
   ```bash
   npm login
   npm publish --access public
   ```
   After that, tag releases publish automatically through `release.yml` when `NPM_TOKEN` exists.

Every tag push already attaches `hunkwise-<version>.tgz` plus `checksums.txt` to the GitHub
Release, whether or not npm publishing is enabled. That is the tarball the source-install path in
the README uses.

## 2. Homebrew tap (optional, for reviewers who don't use Node tooling)

1. Create a public repo `<you>/homebrew-hunkwise`.
2. Add `Formula/hunkwise.rb` that installs the npm tarball from the latest GitHub Release and links
   the `hunkwise` bin (a `Formula` with `url` + `sha256` from `dist/checksums.txt`).
3. Users then run `brew install <you>/hunkwise/hunkwise`.
4. Keep the formula's `sha256` in sync per release; a small scheduled workflow can bump it.

This is a convenience path only; it is not required for `brew` / `npm` installs.

## 3. GitHub App (the v0.2 server-side check)

v0.1 is a local gate on purpose. A GitHub App does not change the grading rule; it moves the
enforcement from the reviewer's laptop to the host:

1. Register a GitHub App with `checks: write`, `contents: read` and `pull_requests: read`.
2. Have it run `hunkwise verify --base <base> --head <sha>` in a checkout, then post a check run
   whose conclusion is `success` for exit 0 and `failure` for exit 1, with the uncovered hunk ids
   in the summary.
3. Mark that check as required in branch protection. This is the step that makes
   `git push --no-verify` irrelevant — and it is exactly what v0.1 does not claim.
4. For self-hosted GitLab/Gitee, the same shape is a CI job plus a required status check; no App
   registration is needed there.

Do not add the App until at least one pilot team runs `verify` in a hook or CI; the App is
distribution work, not a prerequisite for the first users.

## 4. v0.2 Team tier (paid, unbuilt)

From the go-to-market plan, the first payer is a platform-engineering / developer-productivity lead
at a 200–2000 person org on self-hosted GitLab or Gitee, in payments or infrastructure, who has to
show an auditor that merges were reviewed, not clicked.

- **Scope:** org-side attestation storage, branch-protection enforcement, quarterly audit export
  (CSV/JSON), self-hosted Docker image plus a license file.
- **Price:** ¥1,200 per seat per year, 20-seat minimum (¥24,000/year). A two-week paid pilot at
  ¥5,000, credited in full against the annual contract.
- **Smallest demo:** 30 minutes on their repo — run `hunkwise review` on an already-merged agent PR,
  show `verify` exit 1 on the guard hunk they missed, answer it, show exit 0.
- **First engineering task:** a read-only attestation sink (an HTTP endpoint the CLI can push a
  sealed record to, with the org's public key) before any enforcement work. Enforcement without a
  record store is just a bot.

## 5. Re-record the demo

`docs/demo.cast` is a real recording of the 0.1.0 build (asciicast v2, 96×30, ~12s) and
`docs/demo-results.json` pins the numbers it observed. Re-record after a behavior change:

```bash
./docs/record-demo.sh          # creates a throwaway repo under $TMPDIR and records docs/demo.cast
asciinema play docs/demo.cast  # asciinema 3.x: `asciinema cat` now concatenates files
```

If any observed number changes, update `docs/demo-results.json`, the demo tables in both READMEs
and the m1–m4 notes in `CHANGELOG.md` in the same commit. Do not hand-edit the cast.

## 6. First users (from the launch plan)

- **Three pilot teams** on self-hosted GitLab or Gitee: one repo, two weeks, success = at least one
  merge blocked by a missed hunk. Recruit through 研发效能/平台工程 groups and 阿里云开发者社区.
- **One 掘金 post**: 「我们让评审者答完三道题才能合并」, with the cast. One V2EX 分享创造 thread.
  One LinkedIn 中文 post aimed at engineering managers.
- **Show HN** after the first pilot reports a blocked merge: "We made reviewers answer three
  questions before the merge button works."
- **Kill criteria** (do not add features first): 30 days after the third launch activity, if the
  repo is under 50 stars, no team runs `verify` in a hook or CI, and ten interviews return only
  throughput answers, stop.

## 7. Later versions

Bump `VERSION`, `package.json` `version` and add a `CHANGELOG.md` entry in one commit, then
`git tag v0.1.1 && git push origin v0.1.1`. `release.yml` refuses a tag that does not match
`package.json`. `docs/GRADING.md` §6 lists the changes that count as changing the grading rule and
therefore require a synchronized documentation update.
