# Multiple payout destinations ("Option B")

How one borrower can repay into more than one Excel Capital bank account, and
why it is built the way it is. Added 2026-08-12.

## The one thing to understand first

**You do not choose a destination when collecting. You choose which mandate to
collect against.**

Plaid's `consent/payment/execute` accepts only a `consent_id` and an amount.
There is no recipient parameter, so a payment cannot be pointed at a different
account after the borrower has approved it. Each mandate (consent) is
permanently bound to one recipient (bank account) at the moment it is created.

So "send this money to the backup account" really means "collect against the
mandate that pays into the backup account".

This is the safety property, not a workaround. The client originally asked
whether money could be **rerouted** after approval. It cannot, and that is
correct: a borrower agrees to pay a specific account, and nothing we do should
change where their money lands after they agreed to it.

## Proven before it was built

Tested against the Plaid UK sandbox on 2026-08-12, because Plaid's docs do not
cover this and Tobi Jacob recommended running a test first:

| Check | Result |
| --- | --- |
| Two mandates for one borrower, same bank, same login | both `AUTHORISED` at the same time |
| Confirmed via `/payment_initiation/consent/get`, not the UI | both `AUTHORISED` |
| £1 executed against mandate A | `EXECUTED`, landed in account `12345678` |
| £1 executed against mandate B | `EXECUTED`, landed in account `87654321` |

Authorising the second mandate did **not** revoke the first, and each payment
went to its own account. That is the whole feature, verified end to end.

One incidental finding worth keeping: Plaid **Link** reported
`INTERNAL_SERVER_ERROR` for mandate B even though it had authorised correctly.
Link's exit callback is therefore not trustworthy; the API is the authority. The
setup flow reflects this (see below).

## Data model

```
borrowers
  └── recipients          one row per payout bank account
        │                 label, is_default, archived_at
        └── consents      one mandate per account (consents.recipient_id)
              └── payments  payments.consent_id already existed
```

- A payment's destination is derived through `payments.consent_id` →
  `consents.recipient_id`. There is deliberately **no** `payments.recipient_id`:
  a second copy could drift from the mandate that actually moved the money.
- `recipients.is_default` marks where scheduled collections go. At most one per
  borrower, enforced by the partial unique index `idx_recipients_one_default`,
  not by remembering to clear the old one in code. This is why
  `setDefaultRecipient` clears and sets inside a single `db.batch`.
- `repayment_schedules.consent_id` says which mandate a schedule collects
  against. `NULL` means "the borrower's default account", which is every
  schedule created before this feature existed.
- Retiring an account sets `archived_at`. Rows are never deleted, because
  payment history reaches them through their consent and must stay readable.

## A mandate with no local account row is still collectable

`Destination.recipient` is nullable. A mandate whose `recipients` row is missing
(data predating this model) can still be collected against.

This is deliberate and was learned the hard way: requiring the row turned 24
previously-working collections into `skipped`. Plaid executes against the consent
alone, so a gap in **our** bookkeeping must never block a payment the borrower
already authorised.

Provisioning is the one exception. Creating a Plaid recipient needs the sort code
and account number, so `provisionLinkToken` excludes those rows.

## Staff workflow

1. **Borrower page → "Where repayments are sent" → Add another bank account.**
   Give it a label (staff-only, this is what you pick from later), the account
   details, and its own limits. Each account has its own caps.
2. **Send a new setup link.** The borrower must approve each account separately
   with their bank; a new account starts unapproved and can receive nothing.
3. The borrower approves the accounts **one at a time**, using the same bank
   login each time. They see "Account 1 of 2".
4. Once approved, the account appears in the **"Pay into"** picker on one-off
   payments, and can be selected on the schedule page.

Other controls:

- **Make default** moves where scheduled collections go.
- **Retire** removes an account from the picker while keeping its history. It
  refuses to retire the default (schedules depend on it) or the last remaining
  account.

## Single-account borrowers see none of this

No picker, no "Went to" column, no default or retire controls, no schedule
selector. Everything above appears only once a borrower has a second account.
Any behaviour change for a single-account borrower is a bug — that was verified
against a real one and should be re-checked if this area is touched.

## Borrower setup flow

Accounts are provisioned and approved sequentially, with a **fresh Link token
minted per step**. Tokens are short-lived, so one minted upfront for account 2
would already be dead by the time the borrower reached it.

- The setup link stays usable until **every** account is approved, so a borrower
  is never stranded halfway through with staff unaware.
- Confirmation asks Plaid for each mandate's real status rather than trusting
  Link's callback, for the `INTERNAL_SERVER_ERROR` reason above.
- Confirmation and borrower-progress read two different lists. Retired accounts
  are still **confirmed** (their bank may hold a live mandate) but excluded from
  what the borrower is **asked** to do (an abandoned account would otherwise
  leave them permanently unfinished). See `allPendingConsentsForBorrower` vs
  `pendingConsentsForBorrower`.

## The real risk is not technical

**Two £1,500/month mandates mean the borrower's banks will together permit
£3,000/month.** Nobody reading a single mandate would guess that.

The borrower page states the combined figure (`combinedCeiling`) whenever there
is more than one live mandate with the same period and currency. Caps across
different periods are never summed, because that number would be confident and
meaningless.

**OPEN QUESTION, raised with Plaid (Tobi Jacob) and unanswered as of
2026-08-12:** whether a borrower holding two mandates is acceptable when it
doubles their effective ceiling. This is a compliance answer, not an engineering
one, and it should be closed before production keys.

## Where the risk is in the code

If you change anything here, these are the places that move money:

- `src/lib/destinations.ts` — `resolveDestination`. The security boundary.
  `requestedConsentId` comes from a form; an id belonging to another borrower is
  refused, never used. It deliberately does **not** fall back to the default when
  an explicitly chosen account is unavailable: quietly paying a different
  account is worse than refusing.
- `src/lib/engine/collect.ts` — resolves the destination itself rather than
  trusting the caller, so every collection path gets the same ownership check.
- **Retries must inherit the original payment's `consent_id`**
  (`retryPaymentAction`, `runAutoRetries`). Falling back to the default would
  retry a backup-account payment into the main account. This was a real bug.
- `src/lib/repo/destinations.ts` — `setDefaultRecipient` and `archiveRecipient`
  are both guarded on `borrower_id`, not just the row id.
- Account numbers are decrypted and masked **server-side** in
  `src/app/(dashboard)/borrowers/[id]/page.tsx`. The panel and picker are client
  components and must only ever receive the masked string.

## Migration 0007

Additive only: `ALTER TABLE ... ADD COLUMN`, no table rebuild. Migration 0004
taught us that renaming a table makes SQLite silently rewrite the FK clauses in
`payments` and `payment_intents`, which cost a rollback.

Applied to staging 2026-08-12 and verified:

- Row counts identical before and after (3 borrowers / 3 recipients /
  3 consents / 9 payments / 3 schedules), `rows_written: 0`.
- FK clauses in `payments` and `payment_intents` byte-identical.
- Backfill correct: one default per borrower, every mandate bound to an account,
  zero orphans, every existing schedule still on `consent_id = NULL`.

**Always take row counts before and after a remote migration**
(`npm run db:counts:staging`). D1 rolls a migration back on an FK violation, and
without counts a rollback is indistinguishable from a success.

## Applying migrations to the right database

`npm run db:migrate:remote` targets `excel-capital-vrp`, the **development**
database. Staging and production live in `env` blocks:

```bash
npm run db:migrate:staging   # excel-capital-vrp-staging
npm run db:migrate:prod      # excel-capital-vrp-prod, go-live only
```

These use the `DB` binding with `--env`, so the target comes from the env block
rather than a name typed by hand.

**The shell's global `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` point at
the TPG account and will not find this project's databases.** The symptom is
`The database <uuid> could not be found [code: 7404]`, or a `d1 list` that
returns nothing. This project's credentials are in `.dev.vars`:

```bash
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' .dev.vars | cut -d= -f2-)"
export CLOUDFLARE_ACCOUNT_ID="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' .dev.vars | cut -d= -f2-)"
```

`scripts/set-plaid-creds.sh` does the same thing. Export **both** variables: the
account id alone silently selects the wrong account, and the token alone fails
authentication.

## Tests

- `tests/destinations.test.ts` — resolution and ownership logic, including the
  regression tests named after the "mandate with no account row" incident.
- `tests/integration/destinations.test.ts` — the same against real D1, plus the
  one-default invariant and cross-borrower refusals.
- `tests/readiness.test.ts` — `destinationsReadiness` checks every account the
  borrower will be asked to approve, not just one.

The ownership guard in `resolveDestination` was mutation-tested: deleting it
fails a test, so it is genuinely load-bearing rather than decoratively covered.

## Not yet verified

- Two mandates authorised by a **real** borrower at a **real** bank. The sandbox
  proved the mechanism; different banks may behave differently.
- `settled` status for a payment collected against a non-default account.
- The combined-ceiling compliance question above.
