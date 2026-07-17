# Excel Capital — Plaid UK VRP Repayment Platform — Spec

Status: approved design (2026-07-17). Source of truth for what we are building.

## 1. Purpose

An internal web application for Excel Capital Group Ltd staff to manage
Plaid UK Variable Recurring Payment (VRP) mandates for multiple incorporated
business borrowers, and to automatically collect repayments via UK Open
Banking / Faster Payments.

Excel Capital lends only to incorporated businesses. Borrowers repay Excel
Capital directly. This uses Plaid **Payment Initiation (PIS) / VRP**, not US ACH.

## 2. Non-negotiable safety rules

- No real (production) payments until the sandbox flow is tested and the
  owner (Yonatan) explicitly approves production.
- Plaid secrets live only server-side (Cloudflare Worker secrets). Never in the
  browser bundle, never in git.
- Never store online banking usernames/passwords. Plaid handles bank auth.
- Every payment attempt carries a unique idempotency key. Double-collection is
  the highest-severity failure mode and is defended at multiple layers.
- Do not invent repayment rules, consent limits, credentials, or business
  requirements. Anything unknown becomes staff-configurable in-app.

## 3. Stack (full Cloudflare-native)

- **Frontend/Backend:** Next.js (App Router, TypeScript) deployed to
  **Cloudflare Workers** via the OpenNext adapter (`@opennextjs/cloudflare`).
- **Database:** **Cloudflare D1** (SQLite). Money stored as integer minor units
  (pence) plus a currency code. Never floats.
- **Staff auth:** **Cloudflare Access** (Zero Trust) in front of the staff app.
  Access authenticates the human (Google or one-time email PIN against an
  allowlist); the app reads the verified email from the Access JWT and looks up
  the person's role in `staff_users`. Roles: `admin`, `operator`, `viewer`.
- **Scheduled collections:** Cloudflare **Cron Triggers**.
- **Concurrency safety:** `UNIQUE(idempotency_key)` in D1 + a **Durable Object
  lock per borrower** to serialise collection attempts.
- **Email notifications:** Cloudflare email sending (setup links, receipts,
  failures). Wired later; will use a Cloudflare-provided domain.
- **Object storage (optional, later):** R2 for uploaded documents.
- **Repo:** GitHub. **Environments:** local → sandbox/staging → production,
  with separate secrets per environment.

## 4. Roles & access

| Role | Capabilities |
|---|---|
| admin | Everything: manage staff, settings, execute/pause/retry payments, view all |
| operator | Manage borrowers, send setup links, execute/pause/retry payments |
| viewer | Read-only: borrowers, payments, audit |

Authentication boundary = Cloudflare Access (edge). Authorization = role lookup
in app + D1. All money-moving actions require `operator` or `admin`.

## 5. Data model (D1)

Money = integer minor units + currency. All ids are UUIDs (text). Timestamps ISO.

- **staff_users**: id, email (unique), role, created_at, last_login_at
- **borrowers**: id, legal_name, company_number, contact_email, contact_phone,
  status(onboarding|active|paused|revoked|expired), created_at, created_by
- **recipients**: id, borrower_id, plaid_recipient_id, name, account_number,
  sort_code, created_at  (who receives the money; configured per borrower in onboarding)
- **consents**: id, borrower_id, plaid_consent_id (encrypted), plaid_recipient_id,
  status(pending|authorized|revoked|expired|rejected), currency,
  max_payment_amount_minor, period, periodic_alignment, periodic_max_amount_minor,
  valid_from, valid_to, authorized_at, raw_constraints (json)
- **repayment_schedules**: id, borrower_id, amount_minor, currency,
  frequency(weekly|fortnightly|monthly|custom), interval_days (for custom),
  start_date, end_mode(date|count|total), end_date, end_count, end_total_minor,
  next_run_date, active
- **payments**: id, borrower_id, consent_id, idempotency_key (unique),
  plaid_payment_id, amount_minor, currency, reference,
  status(pending|submitted|initiated|executed|settled|failed|rejected|cancelled),
  scheduled_for, submitted_at, last_status_at, failure_reason, retry_of (self fk)
- **setup_links**: id, borrower_id, token_hash, expires_at, used_at, created_by
- **webhook_events**: id, plaid_webhook_type, plaid_payment_id, payload (json),
  signature_verified, received_at, processed_at (dedupe on provider event id)
- **settings**: id (singleton), default_retry_max, default_retry_spacing_hours,
  default_reference_format, sending_domain, retention_days, updated_at, updated_by
- **audit_log**: id, actor_staff_id, action, entity_type, entity_id, metadata(json), created_at

## 6. Payment state machine

Internal states and the Plaid signals that drive them:

- `pending` → row created, not yet sent.
- `submitted` → execute call accepted (request succeeded).
- `initiated` → Plaid `PAYMENT_STATUS_INITIATED`: **treated as successfully
  submitted** (bank accepted for processing). NOT failure, NOT final success.
- `executed` → `PAYMENT_STATUS_EXECUTED`.
- `settled` → `PAYMENT_STATUS_SETTLED` (terminal success).
- `failed` → `PAYMENT_STATUS_FAILED` / `INSUFFICIENT_FUNDS` (retry-eligible per policy).
- `rejected` → `PAYMENT_STATUS_REJECTED` / blocked.
- `cancelled` → cancelled before processing.

Consent revoked/expired → no execute attempted; borrower flagged for re-consent.

## 7. Plaid VRP flow

1. Backend `/payment_initiation/recipient/create` (idempotent) → recipient id.
2. Backend `/payment_initiation/consent/create` with limits derived from the
   borrower's configured repayment terms → consent id.
3. Backend `/link/token/create` containing the consent id.
4. Borrower opens the signed setup URL, launches Plaid Link, authorizes.
5. Confirmation stored; consent status → authorized.
6. Future collections: `/payment_initiation/consent/payment/execute` with
   consent id, amount, reference, and a unique idempotency key.
7. Webhooks (`PAYMENT_STATUS_UPDATE`) update internal state.
8. Re-consent flow for expired/revoked consent.

## 8. Pages

- `/login` handled by Cloudflare Access (edge), not an app form.
- `/borrowers` — list, search (name/company number), status filters.
- `/borrowers/new` — onboarding wizard (recipient, consent limits, schedule, reference).
- `/borrowers/[id]` — profile: consent status + limits, schedule, payment history, actions.
- `/borrowers/[id]/schedule` — repayment settings.
- `/setup/[token]` — borrower-facing Plaid Link + confirmation / re-consent (public, token-gated).
- `/payments` — global payment log, retry-eligible view, reconciliation.
- `/settings` — global defaults (retry policy, reference format, sending domain, retention).
- `/audit` — read-only audit log.

## 9. Features that absorbed the "unknowns"

Per owner decision, business specifics are staff-configurable, not hardcoded:
- Per-borrower **onboarding wizard**: recipient bank details, consent limits,
  schedule, reference format.
- Global **Settings** screen: default retry policy, reference format, sending
  domain, retention window. Editable anytime by admins.

## 10. Additions beyond the original brief

- Observability: Workers logging + lightweight error tracking for failed collections.
- Three environments (local / staging / production).
- D1 backups / time-travel enabled; payment ledger must be recoverable.
- Reconciliation view (expected vs settled).
- Consent-expiry monitoring → early re-consent email before a collection fails.
- Setup-link security: single-use, short-expiry, rate-limited signed tokens.
- UK GDPR basics: soft-delete + retention + audit (flag to Excel compliance; not legal advice).
- Secret rotation runbook.

## 11. Data retention

Keep everything; soft-delete only. Retention window configurable in Settings.
UK lenders commonly retain financial records ~6 years (owner to confirm with
Excel compliance before go-live). Not legal advice.

## 12. Testing & evals

TDD for all Opus-tier (money/security) logic. See IMPLEMENTATION-PLAN.md §Testing
for the full scenario-eval list (idempotency, INITIATED-as-submitted, retries,
revoked/expired blocking, duplicate webhooks, cron-vs-manual race, paused skip).
CI gate: all scenario tests pass before anything is flagged production-ready.

## 13. Open items before go-live

1. Personal Cloudflare account + token — DONE (token verified; rotate post-setup).
2. Plaid credentials (client_id, sandbox secret, production secret, webhook/redirect
   URIs) — pending; build proceeds with names wired and Plaid calls mocked/skipped.
3. Owner's explicit production approval after sandbox testing — required gate.
