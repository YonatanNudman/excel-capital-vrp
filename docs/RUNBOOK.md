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
- If wrangler or the integration tests die with "You installed workerd on another
  platform than the one you're currently using", naming the SAME package as both
  present and required, the native binary has been removed from
  `node_modules/@cloudflare/workerd-*/bin` while the package folder remains
  (security software quarantining an unsigned binary will do this). `npm ci`
  restores it. Nothing is wrong with the repo; CI installs fresh and is unaffected.
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

## Cloudflare Access: the borrower-facing paths

A borrower has no login. Any path they touch must BYPASS Access, and that
includes the page's own assets. Four applications per environment:

| Path | Policy | Why |
| --- | --- | --- |
| the hostname | allow (app approves) | staff dashboard |
| `/setup` | bypass | borrowers have no account |
| `/api/webhooks/plaid` | bypass | Plaid cannot log in |
| `/_next` | bypass | the page's own JavaScript and CSS |

`/_next` is the one that is easy to miss and the hardest to diagnose. Without it
a borrower loads `/setup/<token>`, gets the HTML, and then EVERY script and
stylesheet is redirected 302 to the Access login they cannot pass. React never
hydrates, so the page renders unstyled and "Connect your bank" does nothing at
all: no error, no console message, because there is no JavaScript running to
raise one.

Worse, it looks intermittent. Anyone with a staff Access session in the same
browser loads the assets fine and sees it work perfectly, so it fails only for
the actual borrowers and only on their own devices. That cost several days here,
with fixes aimed at the button while the real cause was the assets.

The bundles are client-side build output and contain no secrets, so making them
public costs nothing.

Check it with `./scripts/check-borrower-access.sh <staging|production>`, which
tests every borrower-facing path the way a borrower experiences it and confirms
the staff pages are still locked. Run it after ANY Access change, and before
telling anyone the borrower flow works.

Or by hand, with no session:

```
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/_next/static/chunks/<one>.js"   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/borrowers"                      # expect 302
```

Take the chunk filename from that environment's own HTML: the hashes differ
between builds, so a staging filename tested against production just fails to
connect and tells you nothing.

## Database

- Apply migrations:
  - local: `npm run db:migrate:local`
  - staging: `npm run db:migrate:staging`
  - production: `npm run db:migrate:prod` (go-live only)
- `npm run db:migrate:remote` targets `excel-capital-vrp`, the DEVELOPMENT
  database. It is NOT staging. Use the named scripts above.
- ALWAYS take row counts before and after a remote migration:
  `npm run db:counts:staging`. D1 rolls a migration back on an FK violation, so
  without counts a rollback looks exactly like a success (this bit us on 0004).
- Also confirm the FK clauses in `payments`/`payment_intents` are unchanged after
  any migration that touches a referenced table:
  `SELECT sql FROM sqlite_master WHERE name IN ('payments','payment_intents')`.
- The shell's global `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` are TPG's and
  cannot see this project's databases. Symptom: `could not be found [code: 7404]`
  or an empty `d1 list`. Export BOTH from `.dev.vars` first (the account id alone
  silently picks the wrong account; the token alone fails auth).
- D1 time-travel/backups: enable and confirm restore before go-live (the payment
  ledger must be recoverable).

## Deployed environments

Personal Cloudflare account `8a7709fc80e3e6188830ccc08e8692f3`. workers.dev
subdomain: `excel-capital.workers.dev`.

- STAGING — DEPLOYED. `https://excel-capital-vrp-staging.excel-capital.workers.dev`
  - D1 `excel-capital-vrp-staging` (`d1f11366-09cf-4eeb-a207-28fc497cd32b`),
    migrated through `0007_multiple_destinations` (2026-08-12, counts and FK
    targets verified unchanged).
  - Cron `0 6 * * *` registered. APP_ENV=staging, mock Plaid (sandbox).
  - Secrets set: APP_ENCRYPTION_KEY, CRON_SECRET, SETUP_LINK_SIGNING_SECRET.
  - The dashboard is intentionally LOCKED (returns "Not authorised") until
    Cloudflare Access is configured — staging does not honour the dev header.
- PRODUCTION — DEPLOYED 2026-08-24.
  `https://excel-capital-vrp-prod.excel-capital.workers.dev`
  - D1 `excel-capital-vrp-prod` (`21adc836-a680-44af-895d-b7b4edd78cee`),
    migrated through `0006_access_requests`.
  - Real Plaid production keys set. Cron `0 6 * * *` registered.
  - `COLLECTIONS_ENABLED=true` since 2026-08-24. Set it back to `"false"` and
    deploy to stop every collection at once.
  - Cloudflare Access: three applications, mirroring staging. The dashboard
    requires sign in; `/setup` and `/api/webhooks/plaid` bypass it, because
    borrowers have no account and Plaid cannot log in. Verified: the dashboard
    302s to `excel-capital-zt.cloudflareaccess.com`, the other two reach the
    Worker.
  - `EMAIL_FROM=onboarding@resend.dev`, so borrower emails reach the Resend
    account owner ONLY. Change it once `excelcapital.co.uk` is verified in
    Resend, or borrowers never receive their setup link.

## GitHub Actions (CI and deploys)

Three workflows in `.github/workflows`:

- **CI** (`ci.yml`) — typecheck, lint, unit tests, D1 integration tests, OpenNext
  build. Runs on every PR, and is called BY the deploy workflow so a deploy runs
  the same checks (one copy, so they cannot drift). Deliberately NOT triggered on
  push to main: deploy.yml already runs there and calls this.
- **Deploy** (`deploy.yml`) — staging deploys automatically when main goes green,
  but only for a commit that arrived via a merged pull request. Production is
  manual only (`workflow_dispatch`), refuses any ref but main, and requires the
  word `production` typed into a confirm box. Deploys code ONLY.
- **Migrate database** (`migrate-database.yml`) — manual only. Requires typing the
  environment name to confirm. Records row counts and FK targets before and after
  and FAILS if the FK targets changed (the migration 0004 detector).

Migrations are deliberately NOT part of a deploy. D1 rolls a migration back on an
FK violation and reports it like a success, so it needs the before/after
comparison a human actually looks at.

`scripts/d1-state.sh <staging|production> <before|after>` captures the same counts
and FK targets locally, for a migration applied by hand.

### Setup state (2026-08-19)

Done already:

- Environments `staging` and `production` exist.
- Repository secret `CLOUDFLARE_ACCOUNT_ID` is set. It is an identifier, not a
  credential, and appears in this runbook in plaintext.
- Production deploys require the word `production` typed into a confirm box.

Still required, and deliberately NOT automated because it means creating and
pasting an API token:

- Repository secret **`CLOUDFLARE_API_TOKEN`**. Create it at
  https://dash.cloudflare.com/profile/api-tokens on the **Excel Capital** account
  (NOT TPG). Start from the "Edit Cloudflare Workers" template, then ADD
  `Account · D1 · Edit` (the template omits D1, and the migration workflow needs
  it). Under Account Resources pick the Excel Capital account only. Then:
  `gh secret set CLOUDFLARE_API_TOKEN`
  Prefer a fresh CI-only token over reusing the one in `.dev.vars`, so it can be
  revoked without breaking local work.

Nothing publishes until that secret exists. Add it BEFORE merging to main, or the
first push will fail at the deploy step (the tests still pass; it is the publish
that cannot authenticate).

### Branch protection

There is none, and it is not an oversight. Both GitHub mechanisms for it,
classic branch protection and rulesets, return
`Upgrade to GitHub Pro or make this repository public` on a private repo on the
free plan. Making a lender's payment system public is not an option.

So a push straight to `main` cannot be blocked. Instead the deploy workflow
refuses to AUTO-publish any commit that did not arrive through a merged pull
request, which protects the part that actually reaches users. A deliberate
`workflow_dispatch` run still publishes, so an emergency fix is never trapped.

If the plan is upgraded, add a ruleset on `main` requiring a pull request and the
`test` check, and keep the workflow guard as well.

### Production protection

GitHub's "required reviewers" rule needs a paid plan on a private repo, and this
repo is private on a free plan, so that rule could not be added. Production is
guarded instead by three things in the workflow itself:

1. Manual dispatch only, never automatic.
2. Refuses any ref but `main`.
3. Requires the word `production` typed into a confirm box.

If the plan is ever upgraded, add the required-reviewer rule on the `production`
environment and keep all three.

### Letting a collaborator deploy

A fork cannot read repository secrets, which is correct: a PR from a fork must not
be able to use the deploy token. To let someone deploy staging themselves, add
them as a collaborator so they push branches to this repo, then they run the
Deploy workflow with `environment: staging` from their branch. Otherwise they send
the branch and the owner dispatches it.

## GitHub Actions (CI and deploys)

Three workflows in `.github/workflows`:

- **CI** (`ci.yml`) — typecheck, lint, unit tests, D1 integration tests, OpenNext
  build. Runs on every PR, and is called BY the deploy workflow so a deploy runs
  the same checks (one copy, so they cannot drift). Deliberately NOT triggered on
  push to main: deploy.yml already runs there and calls this.
- **Deploy** (`deploy.yml`) — staging deploys automatically when main goes green,
  but only for a commit that arrived via a merged pull request. Production is
  manual only (`workflow_dispatch`), refuses any ref but main, and requires the
  word `production` typed into a confirm box. Deploys code ONLY.
- **Migrate database** (`migrate-database.yml`) — manual only. Requires typing the
  environment name to confirm. Records row counts and FK targets before and after
  and FAILS if the FK targets changed (the migration 0004 detector).

Migrations are deliberately NOT part of a deploy. D1 rolls a migration back on an
FK violation and reports it like a success, so it needs the before/after
comparison a human actually looks at.

`scripts/d1-state.sh <staging|production> <before|after>` captures the same counts
and FK targets locally, for a migration applied by hand.

### Setup state (2026-08-19)

Done already:

- Environments `staging` and `production` exist.
- Repository secret `CLOUDFLARE_ACCOUNT_ID` is set. It is an identifier, not a
  credential, and appears in this runbook in plaintext.
- Production deploys require the word `production` typed into a confirm box.

Still required, and deliberately NOT automated because it means creating and
pasting an API token:

- Repository secret **`CLOUDFLARE_API_TOKEN`**. Create it at
  https://dash.cloudflare.com/profile/api-tokens on the **Excel Capital** account
  (NOT TPG). Start from the "Edit Cloudflare Workers" template, then ADD
  `Account · D1 · Edit` (the template omits D1, and the migration workflow needs
  it). Under Account Resources pick the Excel Capital account only. Then:
  `gh secret set CLOUDFLARE_API_TOKEN`
  Prefer a fresh CI-only token over reusing the one in `.dev.vars`, so it can be
  revoked without breaking local work.

Nothing publishes until that secret exists. Add it BEFORE merging to main, or the
first push will fail at the deploy step (the tests still pass; it is the publish
that cannot authenticate).

### Branch protection

There is none, and it is not an oversight. Both GitHub mechanisms for it,
classic branch protection and rulesets, return
`Upgrade to GitHub Pro or make this repository public` on a private repo on the
free plan. Making a lender's payment system public is not an option.

So a push straight to `main` cannot be blocked. Instead the deploy workflow
refuses to AUTO-publish any commit that did not arrive through a merged pull
request, which protects the part that actually reaches users. A deliberate
`workflow_dispatch` run still publishes, so an emergency fix is never trapped.

If the plan is upgraded, add a ruleset on `main` requiring a pull request and the
`test` check, and keep the workflow guard as well.

### Production protection

GitHub's "required reviewers" rule needs a paid plan on a private repo, and this
repo is private on a free plan, so that rule could not be added. Production is
guarded instead by three things in the workflow itself:

1. Manual dispatch only, never automatic.
2. Refuses any ref but `main`.
3. Requires the word `production` typed into a confirm box.

If the plan is ever upgraded, add the required-reviewer rule on the `production`
environment and keep all three.

### Letting a collaborator deploy

A fork cannot read repository secrets, which is correct: a PR from a fork must not
be able to use the deploy token. To let someone deploy staging themselves, add
them as a collaborator so they push branches to this repo, then they run the
Deploy workflow with `environment: staging` from their branch. Otherwise they send
the branch and the owner dispatches it.

## Deploy commands

Prefer the GitHub Actions workflows above: they run the tests first, and nobody
has to hold the right Cloudflare credentials locally.

Manual fallback (export this project's own credentials first, see Database):

- Staging: `npx opennextjs-cloudflare build && npx wrangler deploy --env staging`
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

## Access requests (approve / deny)

Anyone Cloudflare authenticates who is NOT staff sees an "Ask for access" screen
instead of a dead end. They can leave a note. An admin approves (choosing the
role) or denies them on `/staff`, where a pending count also appears as a badge
on the Staff tab.

Design decisions worth keeping:
- The requester's email comes from the verified Access token, never the form, so
  nobody can request on behalf of an address they do not control.
- One row per email, and a DENIED row is kept deliberately: it is what stops the
  same address asking again.
- Approval requires an explicit role. `decideRequest` throws rather than
  defaulting someone's permissions.
- The decision UPDATE is guarded on `status = 'pending'`, so two admins clicking
  at once cannot both grant access; the second is told it was already decided.
- Domain auto-provisioning is now OFF (`STAFF_AUTO_PROVISION_DOMAIN` removed), so
  nobody is granted access silently. `STAFF_BOOTSTRAP_ADMINS` still admits the
  named owner, which is the way back in if the queue is ever mishandled.
- Notification email goes to STAFF_BOOTSTRAP_ADMINS and silently no-ops until
  RESEND_API_KEY and EMAIL_FROM are set, which is why the in-app badge exists.

ACCESS POLICY: OPEN (changed 2026-08-06, owner's decision). The staging Access
policy is now `{"everyone": {}}` with decision allow, so anyone who completes the
one-time PIN reaches the app. The app is the real gate: an unapproved visitor gets
the request screen only, with no data and no navigation. Verified after the change
that /borrowers, /staff and /api/payments/export all still require sign-in.

The tradeoff accepted: any future authorisation bug is now internet-reachable
rather than reachable only by staff. To revert, set the policy include back to
`[{"email_domain": {"domain": "excelcapital.co.uk"}}]` on Access app
3c37a2bb-fd31-4008-9b1a-03239d2878a2, policy a32ef67a-7b7d-452a-84f0-c6bb4f5b4108.

EMAIL WITHOUT A DOMAIN. Resend's `onboarding@resend.dev` sender needs no domain
verification but can only deliver to the address that owns the Resend account.
So with EMAIL_FROM set to it:
  - Access-request notifications to the owner DO arrive, provided the address in
    STAFF_BOOTSTRAP_ADMINS is the Resend account email.
  - Every borrower email (setup links, receipts, failure notices) gets a 403.
    ResendMailer returns { ok: false } rather than throwing, so the flow is
    unaffected and the UI correctly says "Not emailed", with the provider error
    recorded in the audit log.
Borrower email therefore still needs a verified domain, and it should be Excel
Capital's own (or a subdomain such as mail.excelcapital.co.uk), since borrowers
should receive mail from the lender rather than from a third party. That requires
DNS records added by whoever controls that domain.

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

## One-off payments (late fees, missed payments)

"Take a one-off payment" on the borrower page collects an amount outside the
schedule, with a short reason that becomes the statement reference so the
borrower can tell it from a scheduled collection.

IMPORTANT constraint to set expectations with staff: a one-off payment still
cannot exceed the VRP limits the borrower authorised with their bank. That is the
basis of VRP being safe for them, and it is enforced by the bank, not by us.
`checkAmountAgainstConsent` refuses over-cap amounts locally first, quoting both
figures, so the operator is not left staring at a provider rejection. For late
fees to be collectable at all, the per-payment and periodic caps must be set with
headroom ABOVE the normal schedule amount at onboarding.

The periodic cap is deliberately not pre-checked: deciding what counts towards
the current period needs the consent alignment and the provider's own view of
settled payments. The bank enforces it and the failure lands on the payment.

If the coordinated collection throws before an outcome is known (for example the
Durable Object is unreachable), the operator is told we cannot confirm whether it
was sent and explicitly warned not to send it again, rather than seeing a crash.
Reconciliation resolves a payment that did go out.

## Companies House lookup

Onboarding can search the register so a borrower's legal name and company number
always match Companies House rather than being typed by hand.

Setup (one step, free):
1. Register at https://developer.company-information.service.gov.uk/ and create
   a **REST** key for the Public Data API. Not Streaming (a change firehose) and
   not Web (OAuth, for users signing in with their own CH identity).
   Leave "Restricted IPs" EMPTY: Cloudflare Workers egress from many rotating
   IPs, so pinning one would break every call. Leave "JavaScript domains" EMPTY
   too: the key is only ever used server-side, never from the browser.
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
- The registered office is pulled from the company profile at onboarding and
  stored on the borrower (migration 0005: `registered_address` as one formatted
  display line in postal order, plus `registered_postcode`). It shows on the
  borrower profile under Business. Borrowers entered by hand simply have none.

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

## Going live, in order

Run `./scripts/prod-preflight.sh` at any point. It reports what production is
still missing and changes nothing.

Production ships with `COLLECTIONS_ENABLED=false`, which is the point: the whole
thing can be deployed, logged into and exercised before it can take a penny.
Flipping that to `true` IS go-live, and it is the LAST step.

1. **Decide the hostname.** `APP_BASE_URL` and `PLAID_WEBHOOK_URL` currently
   point at `excel-capital-vrp-prod.excel-capital.workers.dev`. If Excel Capital
   want their own domain, change both now, before anything is registered with
   Plaid. Changing it later means re-registering the OAuth redirect and breaks
   borrower authorisation until it is.
2. **Migrate the production database:** the "Migrate database" workflow with
   `production`, or `npm run db:migrate:prod`. It is currently EMPTY (no tables).
3. **Deploy once, with collections still off.** Nothing can move money yet.
4. **Set the secrets** (`wrangler secret put NAME --env production`):
   `APP_ENCRYPTION_KEY` (generate a NEW one; it can never change afterwards
   without orphaning every encrypted bank detail), `CRON_SECRET`,
   `COMPANIES_HOUSE_API_KEY` (required: production sets
   `COMPANIES_HOUSE_ENFORCE=true`), `RESEND_API_KEY`, `EMAIL_FROM`.
   Plaid keys via `./scripts/set-plaid-creds.sh production`.
5. **Configure Cloudflare Access** for the production hostname, then set
   `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Until both exist the app fails closed
   and NOBODY can sign in, which is deliberate.
6. **Re-deploy** so the secrets are picked up, and check
   `./scripts/prod-preflight.sh` is all OK.
7. **Walk it through with collections still off:** sign in, create a real
   borrower (Companies House is enforced here), send a setup link, confirm the
   borrower can authorise with their bank. Everything except taking money works.
8. **Only then** set `COLLECTIONS_ENABLED` to `"true"` and deploy. Take one small
   real payment and confirm it reaches `settled`, not just `executed`.

Before step 8, the gate below must be satisfied.

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
