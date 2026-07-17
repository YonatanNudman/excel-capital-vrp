# Excel Capital VRP Platform — Implementation Plan

Staged, reviewable, test-first for money/security logic. Each stage is
independently demoable in sandbox. Nothing touches production Plaid until the
owner approves after sandbox testing.

## Model & effort routing

Rule: **Opus for anything where a mistake moves money or breaks security;
Sonnet for standard app code; Fable for boilerplate.**

| Work | Model | Effort |
|---|---|---|
| Architecture, D1 schema, state machine | Opus 4.8 | high |
| Plaid recipient/consent/link-token/execute | Opus 4.8 | ultra |
| Webhook receiver + signature verification | Opus 4.8 | high |
| Idempotency + Durable Object lock | Opus 4.8 | ultra |
| Cloudflare Access + role checks | Opus 4.8 | medium |
| Cron collection worker | Opus 4.8 | high |
| Borrower CRUD / list / profile | Sonnet 5 | medium |
| Onboarding wizard + Settings | Sonnet 5 | medium |
| Payment history / audit UI | Sonnet 5 | low–medium |
| Tests for payment/state logic | Opus 4.8 | high |
| Tests for UI/CRUD | Sonnet 5 | low |
| Scaffolding, wrangler config, env templates | Fable 5 | low |
| Docs, seed data, READMEs | Fable 5 | low |

## Stage 0 — Foundations (this stage)

- Git repo, `.gitignore`, `.dev.vars` (gitignored) + `.dev.vars.example`. [done]
- Cloudflare token verified. [done]
- Next.js (App Router, TS) + OpenNext Cloudflare adapter.
- `wrangler.jsonc` with D1 binding, Cron trigger placeholder, env separation.
- D1 schema migrations (all tables in SPEC §5).
- Vitest test harness (Workers pool) + first passing schema/util tests.
- Cloudflare Access middleware stub reading the verified-email header.
- Health check route. First deploy to a dev Worker to prove the pipeline.

## Stage 1 — Borrower CRUD + dashboard

- staff_users seeding + role guard middleware.
- Borrower list (search + status filter), profile, create.
- Repayment schedule settings (all frequency/end options).
- Audit log writes on mutations. No Plaid yet.

## Stage 2 — Setup flow (sandbox)

- Signed, single-use, expiring setup links (rate-limited).
- Backend recipient + consent + link-token creation (Plaid sandbox).
- `/setup/[token]` page + Plaid Link + confirmation.
- Persist consent (encrypted consent id) + limits.
- Re-consent flow scaffolding.

## Stage 3 — Payment execution (sandbox)

- Execute endpoint with unique idempotency key.
- Internal state machine + transitions.
- Webhook receiver with signature verification + dedupe.
- Manual "execute now". INITIATED-as-submitted handling.

## Stage 4 — Automation + resilience

- Cron worker scanning due schedules; Durable Object per-borrower lock.
- Pause collections; retry eligible failures per policy.
- Consent-expiry monitoring + early re-consent email.
- Reconciliation view. Full audit coverage.

## Stage 5 — Hardening + go-live gate

- End-to-end sandbox test pass. Security review. Observability.
- D1 backups/time-travel confirmed. Secret rotation runbook.
- **Owner explicitly approves production. Only then flip Plaid to production.**

## Testing / scenario evals (money-logic safety net)

Built test-first. All must pass in CI before production-ready:

1. Same scheduled payment triggered twice → exactly one payment.
2. `PAYMENT_STATUS_INITIATED` → internal `submitted`/`initiated`, not failed, not settled.
3. Failed / insufficient funds → retry-eligible, respects retry policy.
4. Revoked/expired consent → collection blocked, borrower flagged, no execute.
5. Duplicate webhook delivery → processed once.
6. Cron vs manual "execute now" concurrently → no double-charge (DO lock).
7. Paused borrower → cron skips.
8. Schedule math correct for weekly/fortnightly/monthly/custom + all end modes.
9. Role checks: viewer cannot execute/pause/retry; operator/admin can.
10. Setup link: single-use, expired token rejected, tampered token rejected.
