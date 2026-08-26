#!/usr/bin/env bash
# Can a BORROWER actually use the setup link? Checks the way they experience it,
# with no login and no session.
#
#   ./scripts/check-borrower-access.sh staging
#   ./scripts/check-borrower-access.sh production
#
# Run this after ANY change to Cloudflare Access, and before telling anyone the
# borrower flow works.
#
# It exists because of a failure no test could catch. Access was configured to
# let borrowers reach /setup but not /_next, where the page's JavaScript lives.
# Borrowers got the HTML and then every script was redirected to a staff login
# they cannot pass, so React never started: the page rendered unstyled and
# "Connect your bank" did nothing at all, with no error anywhere, because no
# JavaScript was running to raise one.
#
# It looked intermittent, which is what made it expensive. Anyone with a staff
# session in the same browser loads the assets fine and sees it work perfectly,
# so it failed only for real borrowers on their own devices.
set -uo pipefail

ENV_NAME="${1:-staging}"
case "$ENV_NAME" in
  staging)    BASE="https://excel-capital-vrp-staging.excel-capital.workers.dev" ;;
  production) BASE="https://excel-capital-vrp-prod.excel-capital.workers.dev" ;;
  *) echo "usage: $0 <staging|production>" >&2; exit 1 ;;
esac

ok=1
pass() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; ok=0; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1"; }

echo
echo "BORROWER ACCESS CHECK: $ENV_NAME"
echo "  $BASE"
echo
echo "Must be reachable WITHOUT a login (a borrower has no account)"

c=$(code "$BASE/setup/not-a-real-token")
[ "$c" = "200" ] && pass "/setup reaches the app ($c)" \
  || fail "/setup is behind Access ($c). Borrowers cannot open their link."

# The chunk hashes change every build, so read one from THIS environment's own
# HTML. A filename borrowed from another environment simply fails to connect and
# proves nothing, which is a trap worth not repeating.
asset=$(curl -s --max-time 20 "$BASE/setup/not-a-real-token" \
  | grep -oE '"/_next/static/[^"]+\.js"' | tr -d '"' | head -1)
if [ -z "$asset" ]; then
  fail "could not find a script tag in the page to test"
else
  c=$(code "$BASE$asset")
  [ "$c" = "200" ] && pass "page JavaScript loads ($c)" \
    || fail "page JavaScript is behind Access ($c). The button will do NOTHING, silently."
fi

c=$(code "$BASE/api/webhooks/plaid")
[ "$c" != "302" ] && pass "Plaid webhook reaches the app ($c)" \
  || fail "Plaid webhook is behind Access ($c). Payments would never settle."

echo
echo "Must STAY protected (staff only)"
for p in /borrowers /staff /settings /payments /audit; do
  c=$(code "$BASE$p")
  [ "$c" = "302" ] && pass "$p requires sign in ($c)" \
    || fail "$p is NOT protected ($c)"
done

echo
if [ "$ok" = "1" ]; then
  echo "A borrower can complete setup on $ENV_NAME, and staff pages stay locked."
else
  echo "NOT SAFE to tell anyone the borrower flow works. See the FAIL lines."
fi
echo
exit $(( ok == 1 ? 0 : 1 ))
