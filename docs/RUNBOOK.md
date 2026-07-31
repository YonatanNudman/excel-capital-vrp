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
- NOTE: `next dev` does NOT register the BorrowerPaymentCoordinator Durable
  Object, so any collection fails locally with "no such actor class". Use
  `npx wrangler dev --local` to exercise payments, or test them on staging.
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
4. Copy the application **AUD tag** and your team domain, and set them as Worker
   secrets/vars: `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`).
   When these are set, the app **cryptographically verifies** the
   `Cf-Access-Jwt-Assertion` JWT (RS256, issuer/audience/expiry) — it does NOT
   trust the plaintext email header. If they are unset in a deployed env, the
   app fails closed (nobody is authenticated).
5. **Disable the `workers.dev` route** in production so the Worker is only
   reachable behind Access (prevents header spoofing off the Access path).
6. Set `STAFF_BOOTSTRAP_ADMINS` (comma-separated emails) to the initial admins;
   they are auto-provisioned as admin on first login. Everyone else must be
   seeded into `staff_users` with a role by an admin. There is NO
   "first arrival becomes admin".
7. Local dev has no Access: leave `ACCESS_*` blank and set header
   `X-Dev-User-Email` (only honoured when `APP_ENV=development`). Put that dev
   email in `STAFF_BOOTSTRAP_ADMINS` so it provisions.

## Database

- Apply migrations: `npm run db:migrate:local` / `npm run db:migrate:remote`.
- D1 time-travel/backups: enable and confirm restore before go-live (the payment
  ledger must be recoverable).

## Deployed environments

Personal Cloudflare account `8a7709fc80e3e6188830ccc08e8692f3`. workers.dev
subdomain: `excel-capital.workers.dev`.

- STAGING — DEPLOYED. `https://excel-capital-vrp-staging.excel-capital.workers.dev`
  - D1 `excel-capital-vrp-staging` (`d1f11366-09cf-4eeb-a207-28fc497cd32b`), migrated.
  - Cron `0 6 * * *` registered. APP_ENV=staging, mock Plaid (sandbox).
  - Secrets set: APP_ENCRYPTION_KEY, CRON_SECRET, SETUP_LINK_SIGNING_SECRET.
  - The dashboard is intentionally LOCKED (returns "Not authorised") until
    Cloudflare Access is configured — staging does not honour the dev header.
- PRODUCTION — NOT deployed. D1 `excel-capital-vrp-prod`
  (`21adc836-a680-44af-895d-b7b4edd78cee`) created for env separation. Deploy
  only at go-live (real Plaid + Access + owner approval).

## Deploy commands

- Staging: `npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy -- --env staging`
- Production: same with `--env production` — ONLY after owner approves go-live
  and Plaid production secrets are set.
- Set secrets per env: `wrangler secret bulk secrets.json --env <env>` (never
  commit that file) or `wrangler secret put NAME --env <env>`.

## Make staging usable (Access on workers.dev, done 2026-07-20)

Staging is behind Cloudflare Access on the workers.dev URL (no custom domain
required). Zero Trust org: `excel-capital-zt.cloudflareaccess.com`. Login is
one-time PIN email. Allowed / bootstrap admin: `nudman.yonatan@gmail.com`.
Worker secrets `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` are set;
`STAFF_BOOTSTRAP_ADMINS` provisions that admin on first login.

Open: https://excel-capital-vrp-staging.excel-capital.workers.dev/borrowers

### Access path bypasses (done 2026-07-24)

Two narrowly scoped Access applications bypass Access on exactly the paths that
external parties must reach. More specific paths win over the host-wide app.

| Access app | Scoped path | Policy |
|---|---|---|
| Excel Capital VRP Staging | whole hostname | allow, staff emails only |
| Plaid Webhook Bypass | `/api/webhooks/plaid` | bypass, everyone |
| Borrower Setup Bypass | `/setup` (and subpaths) | bypass, everyone |

Neither bypass weakens a real control: the webhook is still authenticated by
Plaid JWT verification plus a 64 KiB body limit, and setup links are still
hashed, single-use and expiring. Access was only ever blocking reachability.
Do NOT bypass Access for dashboard or export paths. Verify after any change:

```
# expect an Access redirect (302 to cloudflareaccess.com)
curl -sI <host>/borrowers <host>/api/payments/export
# expect to reach the Worker (no Access redirect)
curl -s <host>/setup/bogus ; curl -s -X POST <host>/api/webhooks/plaid -d '{}'
```

Policy changes take a few minutes to propagate across edge colos, so expect
mixed results immediately after editing. Cron triggers invoke the Worker
directly and are unaffected by Access.

For a custom production hostname later: add a zone, attach a Custom Domain to
the Worker, create a matching Access app, and disable the public workers.dev
route.

## Tester access to staging (Excel Capital)

Cloudflare Access allows any address at `excelcapital.co.uk`, plus the named
admin. On first sign-in the app provisions a domain address as **operator**
(collect, pause, retry) and never as admin, via
`STAFF_AUTO_PROVISION_DOMAIN` in the staging block of `wrangler.jsonc`.

Testers just open the URL and enter their work email; Access emails a one-time
PIN. Nobody maintains a list.

This deliberately trusts everyone who can receive mail at that domain, which is
acceptable for sandbox money only. `autoProvisionRole` in `src/lib/auth.ts`
refuses domain provisioning when `APP_ENV=production`, and the variable is
absent from the production env. Production staff must be added deliberately.
Covered by `tests/auth-provisioning.test.ts`, including lookalike domains such
as `notexcelcapital.co.uk` and `excelcapital.co.uk@evil.example`.

## Automated E2E access to staging (service token)

Staging login is a human one-time PIN, which automation cannot receive. A single
Cloudflare Access service token drives staging tests instead.

- Access service token: "E2E Sandbox Test (staging only)", token id
  `e98d681b-7da8-44ac-a5be-5337d2c1bcbf`, client id
  `fe2d68d9fa57529df430962a8f984970.access`. The client secret was shown once at
  creation and is not stored in this repo.
- Access policy "E2E service token" (`non_identity`) on the staging app permits
  it. The human email policy is unchanged.
- Passing Access is not enough: the app requires an identity. `src/lib/access.ts`
  maps this one token's verified `common_name` to the staff account in
  `ACCESS_SERVICE_ACCOUNT_EMAIL`, which is seeded as **operator** (not admin) in
  the staging DB. Both variables live in the staging block of `wrangler.jsonc`
  only, and the mapping is refused outright when `APP_ENV=production`.
- Use it by sending `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

To revoke: delete the service token in Zero Trust (or unset
`ACCESS_SERVICE_TOKEN_CN` and redeploy). Either alone is sufficient.

This path must never be configured in production. There are three independent
guards: the variables are absent from the production env, the code refuses when
`APP_ENV=production`, and `tests/access.test.ts` asserts that refusal.

## Companies House lookup

Onboarding can search the register so a borrower's legal name and company number
always match Companies House rather than being typed by hand.

Setup (one step, free):
1. Register at https://developer.company-information.service.gov.uk/ and create
   an application key for the **Public Data API**.
2. `npx wrangler secret put COMPANIES_HOUSE_API_KEY --env staging`
   (and `--env production` at go-live).

Behaviour:
- No key configured: the search box does not render and onboarding is plain
  manual entry. Nothing breaks.
- Key configured: staff search by name or number, and picking a result fills the
  official name and number. Non-active companies (dissolved, liquidation and so
  on) are flagged in amber at the point of choosing.
- `COMPANIES_HOUSE_ENFORCE` decides whether verification is advisory or binding.
  It is `false` on staging, so testers can onboard invented companies, and
  `true` on production, where a borrower must exist on the register AND be
  active. When enforcing, a Companies House outage fails closed rather than
  letting an unverified company through.
- The API key is a Worker secret. The browser talks to `/api/companies/search`,
  which requires an operator role, so the key never reaches the client and the
  search is not a public endpoint.
- Field names differ between endpoints: search results use `title`, the company
  profile uses `company_name`. Both are pinned by tests/companies-house.test.ts.

## Plaid consent type: SWEEPING (settled 2026-07-31)

1. **OAuth redirect URI: DONE for staging.**
   `https://excel-capital-vrp-staging.excel-capital.workers.dev/setup/complete`
   is registered and verified. Production will need its own hostname registered
   at go-live. The value is `{APP_BASE_URL}/setup/complete`, so changing
   APP_BASE_URL means registering a new URI.

2. **Consent type is SWEEPING, per Plaid.** Tobi Jacob at Plaid confirmed by
   email on 2026-07-31 that this account is provisioned for Sweeping VRP and
   that sweeping is the consent type Plaid considers correct for collecting
   scheduled loan repayments from borrowers. COMMERCIAL returns
   UNAUTHORIZED_ROUTE_ACCESS on this account.

   `PLAID_CONSENT_TYPE` is therefore set to SWEEPING in both staging and
   production. `getPlaidClient` refuses an unrecognised value anywhere, and
   refuses to start in production unless the value is set explicitly, so nobody
   goes live on an inherited default.

   Worth getting in writing, since it is a regulated money flow: sweeping is
   conventionally described as moving money between accounts held by the SAME
   party, and this flow is borrower to lender. Plaid have said it is the right
   product for this use case; ask them to confirm that specific flow in writing
   and keep it on file.

## Plaid go-live gate

Do NOT set `PLAID_ENV=production` or production Plaid secrets until:
- Migration `0003_payment_safety.sql` has been applied to that environment.
  (Applied to staging D1 `excel-capital-vrp-staging` on 2026-07-24. Production
  D1 `excel-capital-vrp-prod` still needs it before its first deploy.)
- Full sandbox flow tested (setup → consent → execute → webhook → settle).
- Timeout-after-submit recovery has been observed via reconciliation without a
  second payment.
- All scenario evals pass in CI.
- `PLAID_CONSENT_TYPE` is set explicitly for the environment (SWEEPING today).

### Double-collection defences (verified 2026-07-30)

Three independent layers, so no single mistake charges a borrower twice:

1. `executePaymentNowAction` refuses outright if a payment already exists for
   that schedule today (`getSchedulePaymentCreatedOn`).
2. A manual "execute now" that settles a due schedule reuses the cron's
   DETERMINISTIC `scheduledKey(borrower, schedule, dueDate)`, so it collides
   with the cron run and returns `duplicate` instead of creating a second row.
3. The Durable Object lease serialises anything that does overlap in time.

Confirmed live on staging: pressing "Execute payment now" after the scheduled
payment had been submitted reported "Today's payment was already sent" and
created no second payment.

Ad-hoc collections with an explicit override amount deliberately use a random
key and are NOT deduped, because staff request them one at a time behind a
confirm step. That is intended, and is covered by a test in
`tests/integration/coordinator.test.ts`.

`COLLECTIONS_ENABLED` is a separate final kill switch and defaults to `false` in
all Wrangler environments. Keep it false while applying migrations and running
read-only checks. Set it to `true` only after the items above are complete, then
deploy. Setting it back to `false` immediately blocks manual, scheduled, and
retry execution while leaving webhook processing and reconciliation active.
