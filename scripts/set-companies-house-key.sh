#!/usr/bin/env bash
#
# Set the Companies House API key. Run it and paste the key when asked.
#
#   ./scripts/set-companies-house-key.sh              # production (the default)
#   ./scripts/set-companies-house-key.sh staging
#
# The key is typed into a hidden prompt, never echoed, never written to shell
# history, and never printed in any log.
#
# It is also TESTED against the real register before being saved, because a bad
# key does not announce itself: Companies House answers a malformed one with
# HTTP 400, which the app could only report as "could not reach". Pasting from a
# browser or a PDF very often brings a trailing newline or space along with it,
# and that alone is enough to break every lookup.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_ENV="${1:-production}"
if [[ "$TARGET_ENV" != "staging" && "$TARGET_ENV" != "production" ]]; then
  echo "Usage: $0 [staging|production]" >&2
  exit 1
fi

[[ -f .dev.vars ]] || { echo "ERROR: .dev.vars not found (holds this project's Cloudflare token)." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .dev.vars | head -1 | cut -d= -f2-)"
export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' .dev.vars | head -1 | cut -d= -f2-)"

echo
echo "Companies House API key for: $TARGET_ENV"
echo "Find it at https://developer.company-information.service.gov.uk/manage-applications"
echo "It must be a REST API key. Nothing you type will appear on screen."
echo
read -rs -p "Paste the key, then press Enter: " RAW
echo

# The actual fix. Strip carriage returns, newlines and surrounding whitespace:
# these are invisible, survive a copy and paste, and are the whole reason the
# lookups were failing.
KEY="$(printf '%s' "$RAW" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [[ -z "$KEY" ]]; then
  echo "ERROR: nothing was pasted. Nothing changed." >&2
  exit 1
fi
if [[ ${#RAW} -ne ${#KEY} ]]; then
  echo "Note: removed $(( ${#RAW} - ${#KEY} )) stray character(s) from the paste."
fi

echo "Checking the key against Companies House..."
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
  -u "$KEY:" "https://api.company-information.service.gov.uk/search/companies?q=test&items_per_page=1" || echo "000")

case "$STATUS" in
  200)
    echo "  OK. The register accepted it."
    ;;
  400)
    echo "  FAILED (HTTP 400). The key is malformed, so Companies House cannot read the request." >&2
    echo "  Copy it again straight from the dashboard and retry. Nothing was changed." >&2
    exit 1
    ;;
  401|403)
    echo "  FAILED (HTTP $STATUS). The register rejected this key." >&2
    echo "  Check you copied a REST API key, and that it has no IP restrictions. Nothing was changed." >&2
    exit 1
    ;;
  000)
    echo "  Could not reach Companies House from this machine. Nothing was changed." >&2
    exit 1
    ;;
  *)
    echo "  FAILED (HTTP $STATUS). Nothing was changed." >&2
    exit 1
    ;;
esac

printf '%s' "$KEY" | npx wrangler secret put COMPANIES_HOUSE_API_KEY --env "$TARGET_ENV" >/dev/null 2>&1
echo "Saved to $TARGET_ENV."
echo
echo "Now redeploy so it takes effect:"
echo "  gh workflow run deploy.yml -f environment=$TARGET_ENV -f confirm=$TARGET_ENV"
echo
