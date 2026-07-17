# Excel Capital — Plaid UK VRP Repayment Platform

Internal staff app to manage Plaid UK Variable Recurring Payment (VRP) mandates
for incorporated business borrowers and automatically collect repayments via UK
Open Banking / Faster Payments.

Full Cloudflare stack: Next.js on Workers (OpenNext) · D1 · Cloudflare Access ·
Cron Triggers · Plaid Payment Initiation.

## Docs
- [Spec](docs/SPEC.md)
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md)

## Safety
- No production payments until sandbox is tested and the owner explicitly approves.
- Plaid/Cloudflare secrets live in `.dev.vars` (local, gitignored) and
  `wrangler secret put` (production). Never committed, never in the browser.

## Local setup
1. `cp .dev.vars.example .dev.vars` and fill in values (or ask an admin).
2. `npm install`
3. `npm run dev`
