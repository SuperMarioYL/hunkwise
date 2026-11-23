#!/usr/bin/env bash
# Records docs/demo.cast from the real CLI.
#
# The script builds a throwaway repository pair under $TMPDIR, installs the
# packed tarball as a normal devDependency, then runs the quickstart in a
# 96x30 asciinema session. Every command and every line of output in the cast
# is produced by the shipped build; nothing is typed in by hand.
#
#   ./docs/record-demo.sh [output.cast]
#
# Requires: node 22+, npm, git, asciinema 2.x/3.x.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "$(dirname "${1:-$REPO_DIR/docs/demo.cast}")" 2>/dev/null && pwd || echo "$REPO_DIR/docs")/$(basename "${1:-demo.cast}")"
DEMO_ROOT="${TMPDIR:-/tmp}/hunkwise-demo"
FIXTURE="$DEMO_ROOT/acme-service"

echo "packing hunkwise from $REPO_DIR"
rm -rf "$DEMO_ROOT"
mkdir -p "$DEMO_ROOT" "$(dirname "$OUT")"
(cd "$REPO_DIR" && npm pack --silent --pack-destination "$DEMO_ROOT" >/dev/null)
TARBALL="$(find "$DEMO_ROOT" -maxdepth 1 -name 'hunkwise-*.tgz' | head -1)"
[ -n "$TARBALL" ] || { echo "npm pack produced no tarball" >&2; exit 1; }

# --- fixture: a bare origin and a clone that looks like a real service ------
git init --bare -q "$DEMO_ROOT/origin.git"
git clone -q "$DEMO_ROOT/origin.git" "$FIXTURE"
cd "$FIXTURE"
git symbolic-ref HEAD refs/heads/main
# A synthetic identity keeps the recording free of the recorder's own address.
git config user.name "Acme Reviewer"
git config user.email "reviewer@acme.test"

mkdir -p src/auth src/api

cat > package.json <<'JSON'
{
  "name": "acme-service",
  "version": "0.3.0",
  "private": true,
  "scripts": {
    "start": "node src/api/handler.js"
  }
}
JSON

cat > package-lock.json <<'JSON'
{
  "name": "acme-service",
  "version": "0.3.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "acme-service",
      "version": "0.3.0"
    }
  }
}
JSON

cat > src/auth/store.ts <<'TS'
type Row = { userId: string; expiresAt: number };

const rows = new Map<string, Row>();

export function lookupSession(token: string): Row | null {
  return rows.get(token) ?? null;
}
TS

cat > src/auth/session.ts <<'TS'
import { lookupSession } from "./store.js";

export type Session = { userId: string; expiresAt: number };

export function readSession(token: string): Session | null {
  const user = lookupSession(token);
  if (!user) {
    return null;
  }
  if (user.expiresAt < Date.now()) {
    return null;
  }
  return user;
}
TS

cat > src/auth/errors.ts <<'TS'
export class SessionError extends Error {}

export function assertFresh(expiresAt: number): void {
  if (expiresAt < Date.now()) {
    return;
  }
}
TS

cat > src/api/handler.ts <<'TS'
import { readSession } from "../auth/session.js";

export function handle(req: { token: string }): string {
  const session = readSession(req.token);
  return session ? `hello ${session.userId}` : "anonymous";
}
TS

cat > README.md <<'MD'
# acme-service

Internal checkout service used by the Hunkwise demo.
MD

printf 'node_modules/\n.hunkwise/\n' > .gitignore

# Hunkwise is a real local devDependency, so install-hook can bake a path that
# is stable for this repository (node_modules/hunkwise/dist/cli.js).
npm install --silent --no-audit --no-fund --save-dev "$TARBALL"

git add -A
git commit -q -m "feat: checkout service skeleton"
git push -q -u origin main

# --- the agent branch: three behavioral hunks plus a lockfile bump -----------
git switch -q -c agent/checkout

python3 - <<'PY'
import pathlib

pathlib.Path("src/auth/session.ts").write_text('''import { lookupSession } from "./store.js";

export type Session = { userId: string; expiresAt: number };

export function readSession(token: string): Session | null {
  const user = lookupSession(token);
  if (user.expiresAt < Date.now()) {
    return null;
  }
  return user;
}
''')

pathlib.Path("src/auth/errors.ts").write_text('''export class SessionError extends Error {}

export function assertFresh(expiresAt: number): void {
  if (expiresAt < Date.now()) {
    throw new SessionError("session expired");
  }
}
''')

pathlib.Path("src/api/handler.ts").write_text('''import { readSession } from "../auth/session.js";

export function handle(req: { token: string; tenant?: string }): string {
  const session = readSession(req.token);
  if (!req.tenant) {
    return "unknown tenant";
  }
  return session ? `hello ${session.userId}@${req.tenant}` : "anonymous";
}
''')
PY

node -e '
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.packages[""].dependencies = { zod: "^3.23.8" };
lock.packages["node_modules/zod"] = {
  version: "3.23.8",
  resolved: "https://registry.npmjs.org/zod/-/zod-3.23.8.tgz",
  integrity: "sha512-0000000000000000000000000000000000000000000000000000000000000000"
};
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
'

git add -A
git commit -q -m "feat: tenant scoping and stricter session expiry"
git push -q -u origin agent/checkout

# --- a second agent branch, not reviewed and not pushed ----------------------
git switch -q -c agent/checkout-legacy main
python3 - <<'PY'
import pathlib

session = pathlib.Path("src/auth/session.ts")
session.write_text(
    session.read_text().replace(
        '''  const user = lookupSession(token);
  if (!user) {
    return null;
  }
''',
        '''  const user = lookupSession(token);
''',
    )
)
errors = pathlib.Path("src/auth/errors.ts")
errors.write_text(errors.read_text().replace("    return;", '    throw new SessionError("session expired");'))
PY
git commit -qam "refactor: drop the null-session guard"
git switch -q agent/checkout

# --- the recorded session ---------------------------------------------------
cat > "$DEMO_ROOT/driver.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/acme-service"

c() { printf '\n\033[1;36m$\033[0m %s\n' "$*"; sleep 0.2; }
code() { printf '\033[2mexit %s\033[0m\n' "$1"; }

answer() {
  local payload=$1
  c "curl -s -XPOST 127.0.0.1:4321/api/answer -H 'content-type: application/json' -d '$payload'"
  curl -s -XPOST 127.0.0.1:4321/api/answer -H 'content-type: application/json' -d "$payload"
  echo
}

# The option order is seeded by the hunk fingerprint, so the demo reads the
# index it is about to submit instead of hard-coding one. The payload shown in
# the cast is the payload that was sent.
answer_probe() {
  local id=$1 index
  index="$(node -e 'const p=require("./.hunkwise/probes.json").probes.find((x)=>x.id===process.argv[1]);process.stdout.write(String(p.answer_index));' "$id")"
  answer "{\"probe_id\":\"$id\",\"answer_index\":$index}"
}

show_probes() {
  c "node -e 'for (const p of require(\"./.hunkwise/probes.json\").probes) { console.log(\"\\n\"+p.prompt); p.options.forEach((o,i)=>console.log(\"  \"+i+\") \"+o)); }'"
  node -e 'for (const p of require("./.hunkwise/probes.json").probes) { console.log("\n"+p.prompt); p.options.forEach((o,i)=>console.log("  "+i+") "+o)); }'
}

start_review() {
  c "npx hunkwise review --base origin/main &"
  npx hunkwise review --base origin/main &
  SERVER=$!
  sleep 1
}

stop_review() {
  c "kill $SERVER   # Ctrl+C in the real workbench"
  kill "$SERVER"
  wait "$SERVER" 2>/dev/null || true
}

verify_and_code() {
  c "npx hunkwise verify --base origin/main"
  set +e
  npx hunkwise verify --base origin/main
  local status=$?
  set -e
  code "$status"
}

c "npx hunkwise init"; npx hunkwise init
c "npx hunkwise diff --base origin/main"; npx hunkwise diff --base origin/main
c "npx hunkwise probes"; npx hunkwise probes
start_review
show_probes

answer_probe 'src/api/handler.ts:5-8#1'
answer_probe 'src/api/handler.ts:5-8#2'
answer_probe 'src/auth/errors.ts:5-5#1'
answer_probe 'src/auth/session.ts:7-9#1'
stop_review

c "npx hunkwise status"; npx hunkwise status
c "npx hunkwise attest"; npx hunkwise attest
verify_and_code
c "npx hunkwise install-hook"; npx hunkwise install-hook

c "git switch agent/checkout-legacy"; git switch agent/checkout-legacy
c "npx hunkwise diff --base origin/main"; npx hunkwise diff --base origin/main
start_review
show_probes
answer_probe 'src/auth/session.ts:7-9#1'
stop_review
c "npx hunkwise attest"; npx hunkwise attest
verify_and_code

c "git push origin agent/checkout-legacy"
set +e
git push origin agent/checkout-legacy
code "$?"
set -e
SH
chmod +x "$DEMO_ROOT/driver.sh"

echo "recording $OUT"
asciinema rec \
  --output-format asciicast-v2 \
  --overwrite \
  --window-size 96x30 \
  --idle-time-limit 1 \
  --title "Hunkwise quickstart: probes, attestation, verify" \
  --command "bash $DEMO_ROOT/driver.sh" \
  "$OUT"

# The header records the recorder's temp path in `command`; the cast ships in a
# public repo, so drop that one metadata field.
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const lines = fs.readFileSync(file, "utf8").split("\n");
const header = JSON.parse(lines[0]);
delete header.command;
lines[0] = JSON.stringify(header);
fs.writeFileSync(file, lines.join("\n"));
' "$OUT"

echo "done: $OUT ($(wc -l <"$OUT") lines)"