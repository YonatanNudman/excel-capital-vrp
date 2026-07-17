# Runbook — Excel Capital VRP Platform

Operational procedures. Keep this current as infrastructure changes.

## Local development

- Install: `npm install`. Secrets: `cp .dev.vars.example .dev.vars` and fill in
  (or reuse the existing gitignored `.dev.vars`).
- Migrate local D1: `npm run db:migrate:local`.
- Run the Worker locally: export the personal Cloudflare token, then
  `npx wrangler dev --local`. (Do NOT use the shell's global TPG token.)
- Auth in local dev: there is no Cloudflare Access, so send a
  `X-Dev-User-Email: you@example.com` header to simulate a signed-in staff user.
  The first authenticated email becomes an admin (bootstrap).
- Tests: `npm test` (unit + D1 integration). `npm run typecheck` for types.
- Trigger the cron sweep locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"`
  or `POST /api/cron/run` with `Authorization: Bearer $CRON_SECRET`.

## Plaid mock vs real

The app runs end-to-end WITHOUT Plaid credentials: `getPlaidClient()` returns a
deterministic mock when `PLAID_CLIENT_ID`/`PLAID_SECRET` are absent, and the real
fetch-based client when they are present. No code changes are needed to switch;
just set the secrets. The real client's request/response shapes follow Plaid's
Payment Initiation API but MUST be validated against live sandbox once
credentials arrive (see comments in `src/lib/plaid/real.ts`, especially the VRP
consent `scope` and webhook JWT verification).

## Cloudflare account

- Personal "Excel Capital" account. Account ID: `8a7709fc80e3e6188830ccc08e8692f3`.
- D1 database `excel-capital-vrp` (id `02118551-a7a3-406c-a9ed-786e893ade96`).
- Secrets: local in `.dev.vars` (gitignored); production via `wrangler secret put`.
- Never use the TPG Cloudflare env vars for this project. All wrangler commands
  in this repo must run with the personal token exported explicitly.

## Secret rotation (do this after any secret touches a chat/log)

1. Cloudflare dashboard → My Profile → API Tokens → roll the token.
2. R2 → Manage API tokens → roll the R2 access key + secret.
3. Update `.dev.vars` locally.
4. Re-run `wrangler secret put` for each production secret.
5. Verify: `curl .../tokens/verify` and a health check.

## Staff auth — Cloudflare Access (set up before go-live)

1. Zero Trust dashboard → Access → Applications → Add a self-hosted app.
2. Domain = the app's production hostname.
3. Policy: allow the specific staff email addresses (or the company domain).
   Identity provider: Google or one-time PIN.
4. The app reads the verified email from `Cf-Access-Authenticated-User-Email`.
5. Seed each staff email into `staff_users` with a role (admin/operator/viewer).
6. Local dev has no Access: set header `X-Dev-User-Email` to simulate a user
   (only honoured when APP_ENV !== production).

## Database

- Apply migrations: `npm run db:migrate:local` / `npm run db:migrate:remote`.
- D1 time-travel/backups: enable and confirm restore before go-live (the payment
  ledger must be recoverable).

## Deploy

- Staging: `npx opennextjs-cloudflare build && npx wrangler deploy --env staging`
- Production: same with `--env production` — ONLY after owner approves go-live
  and Plaid production secrets are set.

## Plaid go-live gate

Do NOT set `PLAID_ENV=production` or production Plaid secrets until:
- Full sandbox flow tested (setup → consent → execute → webhook → settle).
- All scenario evals pass in CI.
- Owner (Yonatan) has explicitly approved production.
