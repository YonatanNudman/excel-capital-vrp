#!/usr/bin/env bash
# Is production actually ready? Reports what is missing; changes nothing.
#
#   ./scripts/prod-preflight.sh
#
# Read-only by design. Going live is a sequence of small steps that are easy to
# half-finish, and a half-finished production is worse than none: setup links
# that 404, payments that never settle, or a dashboard nobody can log in to.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -f .dev.vars ]] || { echo "ERROR: .dev.vars not found (holds this project's Cloudflare token)." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .dev.vars | head -1 | cut -d= -f2-)"
export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' .dev.vars | head -1 | cut -d= -f2-)"

ready=1
pass() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mTODO\033[0m  %s\n' "$1"; ready=0; }

echo
echo "PRODUCTION PREFLIGHT"
echo

echo "Worker"
if npx wrangler deployments list --env production >/dev/null 2>&1; then
  pass "excel-capital-vrp-prod exists"
  WORKER_EXISTS=1
else
  fail "Worker not deployed yet (deploy once with collections OFF)"
  WORKER_EXISTS=0
fi

echo
echo "Database"
tables=$(npx wrangler d1 execute DB --remote --env production \
  --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE '\_cf%' ESCAPE '\\';" \
  --json 2>/dev/null | sed -n '/^\[/,$p' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['n'])" 2>/dev/null || echo 0)
if [[ "${tables:-0}" -gt 0 ]]; then
  pass "excel-capital-vrp-prod has $tables tables (migrations applied)"
else
  fail "No tables. Run: npm run db:migrate:prod"
fi

echo
echo "Secrets"
if [[ "$WORKER_EXISTS" == "1" ]]; then
  have=$(npx wrangler secret list --env production 2>/dev/null | grep -oE '"name": *"[A-Z_]+"' | grep -oE '[A-Z_]{4,}' || true)
  # Every secret the code reads that is not a plain var in wrangler.jsonc.
  # COMPANIES_HOUSE_API_KEY is required here specifically because production sets
  # COMPANIES_HOUSE_ENFORCE=true, so a lookup failure blocks onboarding.
  for s in PLAID_CLIENT_ID PLAID_SECRET APP_ENCRYPTION_KEY CRON_SECRET \
           ACCESS_AUD ACCESS_TEAM_DOMAIN COMPANIES_HOUSE_API_KEY \
           RESEND_API_KEY EMAIL_FROM; do
    if grep -qx "$s" <<<"$have"; then pass "$s"; else fail "$s is not set"; fi
  done
else
  fail "Cannot check secrets until the Worker exists"
fi

echo
echo "Configuration"
for v in APP_BASE_URL PLAID_WEBHOOK_URL; do
  val=$(./scripts/read-wrangler-var.py production "$v" 2>/dev/null)
  case $? in
    0) pass "$v = $val" ;;
    1) fail "$v missing for production (setup links and settlement need it)" ;;
    *) fail "$v could not be read (wrangler.jsonc did not parse)" ;;
  esac
done

echo
echo "Money switch"
enabled=$(./scripts/read-wrangler-var.py production COLLECTIONS_ENABLED 2>/dev/null)
case $? in
  0)
    if [[ "$enabled" == "false" ]]; then
      echo "  SAFE  wrangler.jsonc says COLLECTIONS_ENABLED=false: once deployed,"
      echo "        production cannot take money."
    else
      echo "  LIVE  wrangler.jsonc says COLLECTIONS_ENABLED=$enabled. Once deployed,"
      echo "        production CAN take real money."
    fi
    # This file is the INTENT, not the running Worker. Editing it changes
    # nothing until a deploy, so a reader who takes "SAFE" as a statement about
    # what is live right now can be badly wrong: the Worker deployed last week
    # is still collecting tonight whatever this file now says.
    echo "        This reads the repository file, NOT the deployed Worker. The"
    echo "        value only takes effect on the next deploy; check the live one"
    echo "        with: npx wrangler deployments status --env production"
    ;;
  # Never assume "safe" and never assume "live" when the answer is unreadable.
  # An earlier version of this script printed "Production CAN take real money"
  # purely because its config parser had failed, which is exactly the kind of
  # false alarm that gets a checker ignored.
  *) fail "Could not read COLLECTIONS_ENABLED. Treat production as UNKNOWN." ;;
esac

echo
[[ "$ready" == "1" ]] && echo "Everything above is done." || echo "Not ready. See the TODO lines."
echo
