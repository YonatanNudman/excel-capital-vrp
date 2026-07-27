#!/usr/bin/env bash
#
# Set the Plaid credentials for this project. Run it and answer the prompts.
#
#   ./scripts/set-plaid-creds.sh            # sandbox -> staging (the normal case)
#   ./scripts/set-plaid-creds.sh production # production (gated, asks to confirm)
#
# Your secret is typed into a hidden prompt and handed straight to Cloudflare.
# It is never echoed to the screen, never written to your shell history, and
# never printed in any log.

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET_ENV="${1:-staging}"

if [[ "$TARGET_ENV" != "staging" && "$TARGET_ENV" != "production" ]]; then
  echo "Usage: $0 [staging|production]" >&2
  exit 1
fi

# This machine's global Cloudflare token points at the TPG account. This project
# lives in a separate personal account, so always use the token from .dev.vars.
if [[ ! -f .dev.vars ]]; then
  echo "ERROR: .dev.vars not found. It holds this project's Cloudflare token." >&2
  exit 1
fi

read_dev_var() {
  # Print the value of a KEY=value line from .dev.vars, or nothing if absent.
  grep -E "^$1=" .dev.vars | head -n1 | cut -d= -f2- || true
}

CLOUDFLARE_API_TOKEN="$(read_dev_var CLOUDFLARE_API_TOKEN)"
CLOUDFLARE_ACCOUNT_ID="$(read_dev_var CLOUDFLARE_ACCOUNT_ID)"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN is missing from .dev.vars." >&2
  exit 1
fi

if [[ "$TARGET_ENV" == "production" ]]; then
  cat <<'WARN'

  ############################################################
  #  PRODUCTION. These credentials move real money.          #
  #  Only continue if every item in the go-live gate in       #
  #  docs/RUNBOOK.md is done and you have decided to ship.    #
  ############################################################

WARN
  read -r -p 'Type exactly GO LIVE to continue: ' CONFIRM
  if [[ "$CONFIRM" != "GO LIVE" ]]; then
    echo "Aborted. Nothing was changed."
    exit 1
  fi
  WHICH_SECRET="production"
else
  WHICH_SECRET="sandbox"
fi

echo
echo "Setting Plaid credentials for: $TARGET_ENV (use your $WHICH_SECRET keys)"
echo "Find them at https://dashboard.plaid.com/developers/keys"
echo

read -r -p "Plaid client_id: " PLAID_CLIENT_ID
if [[ -z "$PLAID_CLIENT_ID" ]]; then
  echo "ERROR: client_id cannot be empty." >&2
  exit 1
fi

# -s hides the typing, so the secret never appears on screen.
read -r -s -p "Plaid $WHICH_SECRET secret (hidden, just paste and press return): " PLAID_SECRET
echo
if [[ -z "$PLAID_SECRET" ]]; then
  echo "ERROR: secret cannot be empty." >&2
  exit 1
fi

echo
echo "Uploading to Cloudflare..."
printf '%s' "$PLAID_CLIENT_ID" | npx wrangler secret put PLAID_CLIENT_ID --env "$TARGET_ENV" >/dev/null
printf '%s' "$PLAID_SECRET"    | npx wrangler secret put PLAID_SECRET    --env "$TARGET_ENV" >/dev/null
echo "Done. Secrets set on $TARGET_ENV."

# Offer to mirror the sandbox values into .dev.vars so local dev also talks to
# real Plaid sandbox instead of the mock client. Never do this for production.
if [[ "$TARGET_ENV" == "staging" ]]; then
  echo
  read -r -p "Also use these for local development? [y/N] " LOCAL
  if [[ "$LOCAL" == "y" || "$LOCAL" == "Y" ]]; then
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    grep -vE '^(PLAID_CLIENT_ID|PLAID_SECRET)=' .dev.vars > "$tmp"
    printf 'PLAID_CLIENT_ID=%s\n' "$PLAID_CLIENT_ID" >> "$tmp"
    printf 'PLAID_SECRET=%s\n'    "$PLAID_SECRET"    >> "$tmp"
    cp "$tmp" .dev.vars
    echo "Written to .dev.vars (gitignored, stays on this machine)."
  fi
fi

unset PLAID_SECRET

echo
echo "Verifying which secrets now exist on $TARGET_ENV:"
npx wrangler secret list --env "$TARGET_ENV" 2>/dev/null \
  | grep -oE '"name": "[A-Z_]+"' | cut -d'"' -f4 | sort | sed 's/^/  /'
echo
echo "Names only. Values are write-only once they are in Cloudflare."
