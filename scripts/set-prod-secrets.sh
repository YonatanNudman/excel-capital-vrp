#!/usr/bin/env bash
#
# Set the production secrets, one prompt at a time.
#
#   ./scripts/set-prod-secrets.sh
#
# Secrets are typed into hidden prompts and handed straight to Cloudflare. They
# are never echoed, never written to shell history, and never printed in a log.
# The two random ones are generated here, so nobody ever has to see or paste them.
#
# Press Enter to skip any secret and leave it as it is. Plaid keys are handled by
# set-plaid-creds.sh, which gates them behind a "GO LIVE" confirmation.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -f .dev.vars ]] || { echo "ERROR: .dev.vars not found (holds this project's Cloudflare token)." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .dev.vars | head -1 | cut -d= -f2-)"
export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' .dev.vars | head -1 | cut -d= -f2-)"

put() { # put NAME <<< value
  if npx wrangler secret put "$1" --env production >/dev/null 2>&1; then
    echo "  set $1"
  else
    echo "  FAILED to set $1" >&2
  fi
}

already() {
  npx wrangler secret list --env production 2>/dev/null | grep -q "\"$1\""
}

echo
echo "PRODUCTION SECRETS"
echo "Press Enter to skip anything you do not have yet."
echo

# --- generated, never seen by a human -----------------------------------------
# APP_ENCRYPTION_KEY encrypts borrower bank details at rest. It can NEVER change
# once anything has been saved: every existing account number becomes unreadable.
if already APP_ENCRYPTION_KEY; then
  echo "APP_ENCRYPTION_KEY already set. Leaving it alone (changing it would make"
  echo "  every saved bank detail unreadable)."
else
  openssl rand -base64 32 | tr -d '\n' | put APP_ENCRYPTION_KEY
fi

if already CRON_SECRET; then
  echo "CRON_SECRET already set. Leaving it alone."
else
  openssl rand -hex 32 | tr -d '\n' | put CRON_SECRET
fi

# --- typed in, hidden ---------------------------------------------------------
prompt_secret() { # prompt_secret NAME "where to get it"
  local name="$1" where="$2" value
  echo
  echo "$name"
  echo "  $where"
  read -r -s -p "  Paste it (or Enter to skip): " value
  echo
  [[ -z "$value" ]] && { echo "  skipped"; return; }
  printf '%s' "$value" | put "$name"
}

prompt_plain() { # prompt_plain NAME "where to get it"
  local name="$1" where="$2" value
  echo
  echo "$name"
  echo "  $where"
  read -r -p "  Type it (or Enter to skip): " value
  [[ -z "$value" ]] && { echo "  skipped"; return; }
  printf '%s' "$value" | put "$name"
}

prompt_secret COMPANIES_HOUSE_API_KEY \
  "https://developer.company-information.service.gov.uk/manage-applications
  Required: production checks every borrower is a real, active company."

prompt_secret RESEND_API_KEY \
  "https://resend.com/api-keys
  Sends setup links and failure notices to borrowers."

prompt_plain EMAIL_FROM \
  "The address emails come FROM, e.g. noreply@excelcapital.co.uk
  Must be on a domain verified in Resend, or delivery silently fails."

prompt_plain ACCESS_TEAM_DOMAIN \
  "Your Cloudflare Zero Trust team domain, e.g. excelcapital.cloudflareaccess.com
  Set this AFTER creating the Access application."

prompt_plain ACCESS_AUD \
  "The Access application's Application Audience (AUD) tag.
  Until ACCESS_AUD and ACCESS_TEAM_DOMAIN are both set, nobody can sign in."

echo
echo "Done. Check what is left with:  ./scripts/prod-preflight.sh"
echo "Plaid keys are separate:        ./scripts/set-plaid-creds.sh production"
echo
