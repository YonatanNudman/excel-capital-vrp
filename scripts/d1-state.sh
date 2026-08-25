#!/usr/bin/env bash
# Capture the D1 state that tells you whether a migration really did what it said.
#
# Usage: scripts/d1-state.sh <staging|production> <before|after>
#
# Writes /tmp/counts-<phase>.txt and /tmp/fk-<phase>.txt. Run it either side of a
# migration and compare. Two things matter:
#
#  1. Row counts. D1 rolls a migration back on a foreign key violation and reports
#     it the same way it reports success, so counts are the only way to tell.
#  2. The FK clauses in payments and payment_intents. An ALTER TABLE ... RENAME
#     makes SQLite rewrite references in other tables, which is how migration 0004
#     silently repointed the payment ledger at a temporary table.
#
# Locally, export this project's own Cloudflare credentials first. The shell's
# global ones are TPG's and cannot see these databases:
#   export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .dev.vars | cut -d= -f2-)"
#   export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' .dev.vars | cut -d= -f2-)"
set -euo pipefail

ENV_NAME="${1:?usage: d1-state.sh <staging|production> <before|after>}"
PHASE="${2:?usage: d1-state.sh <staging|production> <before|after>}"

case "$ENV_NAME" in
  staging|production) ;;
  *) echo "ERROR: environment must be 'staging' or 'production', got '$ENV_NAME'" >&2; exit 1 ;;
esac

d1() {
  npx wrangler d1 execute DB --remote --env "$ENV_NAME" --command "$1" --json
}

# wrangler prefixes its banner before the JSON, so take from the first bracket on.
json_only() { sed -n '/^\[/,$p'; }

# A database with no tables yet is a normal state, not an error: it is exactly
# what the FIRST migration of a new environment starts from. Counting rows in
# tables that do not exist makes wrangler error and the snapshot crash, which
# previously took the whole migration down before it applied anything.
tables=$(d1 "SELECT name FROM sqlite_master WHERE type='table';" \
  | json_only \
  | python3 -c 'import json,sys; print(" ".join(r["name"] for r in json.load(sys.stdin)[0]["results"]))' \
  2>/dev/null || echo "")

if ! grep -qw "borrowers" <<<"$tables"; then
  echo '{"database": "empty, no tables yet"}' > "/tmp/counts-${PHASE}.txt"
  : > "/tmp/fk-${PHASE}.txt"
  echo "--- counts ($PHASE) ---"
  cat "/tmp/counts-${PHASE}.txt"
  echo "--- foreign key targets ($PHASE) ---"
  echo "(none: no tables yet)"
  exit 0
fi

d1 "SELECT
      (SELECT COUNT(*) FROM borrowers) AS borrowers,
      (SELECT COUNT(*) FROM recipients) AS recipients,
      (SELECT COUNT(*) FROM consents) AS consents,
      (SELECT COUNT(*) FROM payments) AS payments,
      (SELECT COUNT(*) FROM repayment_schedules) AS schedules,
      (SELECT COUNT(*) FROM staff_users) AS staff;" \
  | json_only \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["results"][0], indent=2))' \
  > "/tmp/counts-${PHASE}.txt"

# Normalised to just the reference targets: the exact column order and whitespace
# of the CREATE TABLE text is noise, but a changed target is the alarm.
d1 "SELECT sql FROM sqlite_master
     WHERE type = 'table' AND name IN ('payments','payment_intents');" \
  | json_only \
  | grep -oE 'REFERENCES [a-z_]+' \
  | sort | uniq -c > "/tmp/fk-${PHASE}.txt"

echo "--- counts ($PHASE) ---"
cat "/tmp/counts-${PHASE}.txt"
echo "--- foreign key targets ($PHASE) ---"
cat "/tmp/fk-${PHASE}.txt"
