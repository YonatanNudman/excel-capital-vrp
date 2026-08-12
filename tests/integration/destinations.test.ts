import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  addRecipient,
  archiveRecipient,
  consentBelongsToBorrower,
  listDestinations,
  resolveCollectionDestination,
  setDefaultRecipient,
} from "@/lib/repo/destinations";
import { createBorrower } from "@/lib/repo/borrowers";
import { createPendingConsent, getActiveConsent, setConsentStatus } from "@/lib/repo/consents";

let n = 0;
const borrower = () => createBorrower(env.DB, { legalName: `Dest ${n++} Ltd`, createdBy: null });

/** An account with an authorised, provisioned mandate: ready to collect. */
async function seedLive(borrowerId: string, label: string, makeDefault = false) {
  const recipient = await addRecipient(env.DB, borrowerId, {
    name: `${label} account`,
    label,
    accountNumber: "12345678",
    sortCode: "123456",
    makeDefault,
  });
  const consent = await createPendingConsent(env.DB, borrowerId, {
    recipientId: recipient.id,
    maxPaymentAmountMinor: 60_000,
    periodicMaxAmountMinor: 300_000,
    period: "MONTH",
  });
  await env.DB.prepare("UPDATE consents SET plaid_consent_id = 'cipher' WHERE id = ?")
    .bind(consent.id)
    .run();
  await setConsentStatus(env.DB, consent.id, "authorized");
  return { recipient, consentId: consent.id };
}

describe("destinations: two accounts for one borrower", () => {
  /**
   * The shape proven against the Plaid UK sandbox before this was built: two
   * mandates authorised at once, each paying its own account.
   */
  it("holds two live destinations at the same time", async () => {
    const b = await borrower();
    const main = await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");

    const dests = await listDestinations(env.DB, b.id);
    expect(dests).toHaveLength(2);
    expect(dests.map((d) => d.consent?.id).sort()).toEqual(
      [main.consentId, backup.consentId].sort(),
    );
    expect(dests.every((d) => d.consent?.status === "authorized")).toBe(true);
  });

  it("makes the first account the default without being asked", async () => {
    // A borrower with one account must never have to think about defaults.
    const b = await borrower();
    const only = await seedLive(b.id, "Only");
    const row = await env.DB.prepare("SELECT is_default FROM recipients WHERE id = ?")
      .bind(only.recipient.id)
      .first<{ is_default: number }>();
    expect(row?.is_default).toBe(1);
  });

  it("does not let a newly added account steal the default", async () => {
    // Scheduled collections follow the default, and a brand new account has not
    // been approved by the borrower yet, so it can receive nothing.
    const b = await borrower();
    const main = await seedLive(b.id, "Main");
    await seedLive(b.id, "Backup");
    const dests = await listDestinations(env.DB, b.id);
    const defaults = dests.filter((d) => d.recipient?.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].recipient?.id).toBe(main.recipient.id);
  });
});

describe("setDefaultRecipient", () => {
  it("moves the default and leaves exactly one", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");

    expect(await setDefaultRecipient(env.DB, b.id, backup.recipient.id)).toBe(true);

    const dests = await listDestinations(env.DB, b.id);
    const defaults = dests.filter((d) => d.recipient?.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].recipient?.id).toBe(backup.recipient.id);
  });

  /**
   * The clear-then-set has to be one transaction: a partial unique index permits
   * only one default per borrower, so doing it in two round trips would either
   * violate the index or leave the borrower with no default at all.
   */
  it("never leaves the borrower with two defaults", async () => {
    const b = await borrower();
    const a = await seedLive(b.id, "A");
    const c = await seedLive(b.id, "C");
    await setDefaultRecipient(env.DB, b.id, c.recipient.id);
    await setDefaultRecipient(env.DB, b.id, a.recipient.id);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM recipients WHERE borrower_id = ? AND is_default = 1",
    )
      .bind(b.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("refuses another borrower's account", async () => {
    // Otherwise a form post could redirect this borrower's scheduled collections
    // into a stranger's bank account.
    const mine = await borrower();
    const theirs = await borrower();
    await seedLive(mine.id, "Mine");
    const foreign = await seedLive(theirs.id, "Theirs");
    expect(await setDefaultRecipient(env.DB, mine.id, foreign.recipient.id)).toBe(false);
  });
});

describe("resolveCollectionDestination against real rows", () => {
  it("picks the default when nothing is requested", async () => {
    const b = await borrower();
    const main = await seedLive(b.id, "Main");
    await seedLive(b.id, "Backup");
    const r = await resolveCollectionDestination(env.DB, b.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.consent?.id).toBe(main.consentId);
  });

  it("honours an explicit choice of the non-default account", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");
    const r = await resolveCollectionDestination(env.DB, b.id, backup.consentId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.consent?.id).toBe(backup.consentId);
  });

  /** The security boundary, exercised end to end rather than on fixtures. */
  it("refuses a mandate belonging to a different borrower", async () => {
    const mine = await borrower();
    const theirs = await borrower();
    await seedLive(mine.id, "Mine");
    const foreign = await seedLive(theirs.id, "Theirs");

    const r = await resolveCollectionDestination(env.DB, mine.id, foreign.consentId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not set up for this borrower/i);
  });

  it("refuses an account the borrower has not approved", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const pendingRecipient = await addRecipient(env.DB, b.id, { name: "Pending", label: "Pending" });
    const pendingConsent = await createPendingConsent(env.DB, b.id, {
      recipientId: pendingRecipient.id,
      maxPaymentAmountMinor: 10_000,
      periodicMaxAmountMinor: 50_000,
      period: "MONTH",
    });
    const r = await resolveCollectionDestination(env.DB, b.id, pendingConsent.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not approved|borrower/i);
  });

  /**
   * A mandate with no account row must stay collectable. Requiring one turned 24
   * previously-working collections into "skipped" while this was being built:
   * Plaid executes against the consent alone, so a gap in our own bookkeeping
   * must not stop a payment the borrower already authorised.
   */
  it("still collects against a mandate that has no account row", async () => {
    const b = await borrower();
    const orphan = await createPendingConsent(env.DB, b.id, {
      maxPaymentAmountMinor: 60_000,
      periodicMaxAmountMinor: 300_000,
      period: "MONTH",
    });
    await env.DB.prepare("UPDATE consents SET plaid_consent_id = 'cipher' WHERE id = ?")
      .bind(orphan.id)
      .run();
    await setConsentStatus(env.DB, orphan.id, "authorized");

    const r = await resolveCollectionDestination(env.DB, b.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.destination.consent?.id).toBe(orphan.id);
  });
});

describe("archiveRecipient", () => {
  it("retires a spare account and removes it from resolution", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");

    expect(await archiveRecipient(env.DB, b.id, backup.recipient.id)).toEqual({ ok: true });

    const r = await resolveCollectionDestination(env.DB, b.id, backup.consentId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/retired/i);
  });

  it("keeps the archived row readable, since payment history points at it", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");
    await archiveRecipient(env.DB, b.id, backup.recipient.id);

    const dests = await listDestinations(env.DB, b.id);
    const archived = dests.find((d) => d.recipient?.id === backup.recipient.id);
    expect(archived).toBeDefined();
    expect(archived!.recipient!.archived_at).not.toBeNull();
  });

  it("refuses to retire the default, which scheduled collections rely on", async () => {
    const b = await borrower();
    const main = await seedLive(b.id, "Main");
    await seedLive(b.id, "Backup");
    const result = await archiveRecipient(env.DB, b.id, main.recipient.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/default/i);
  });

  it("refuses to retire the only account", async () => {
    const b = await borrower();
    const only = await seedLive(b.id, "Only");
    const result = await archiveRecipient(env.DB, b.id, only.recipient.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only account/i);
  });

  it("refuses another borrower's account", async () => {
    const mine = await borrower();
    const theirs = await borrower();
    await seedLive(mine.id, "Mine");
    await seedLive(mine.id, "Spare");
    const foreign = await seedLive(theirs.id, "Theirs");
    const result = await archiveRecipient(env.DB, mine.id, foreign.recipient.id);
    expect(result.ok).toBe(false);
  });
});

describe("consentBelongsToBorrower", () => {
  it("accepts this borrower's mandate and refuses another's", async () => {
    const mine = await borrower();
    const theirs = await borrower();
    const ours = await seedLive(mine.id, "Mine");
    const foreign = await seedLive(theirs.id, "Theirs");

    expect(await consentBelongsToBorrower(env.DB, mine.id, ours.consentId)).toBe(true);
    expect(await consentBelongsToBorrower(env.DB, mine.id, foreign.consentId)).toBe(false);
  });

  it("accepts an unapproved mandate, unlike the collection check", async () => {
    // Schedules are configured before the setup link goes out, so requiring
    // approval here would make the normal order of work impossible.
    const b = await borrower();
    const recipient = await addRecipient(env.DB, b.id, { name: "New", label: "New" });
    const consent = await createPendingConsent(env.DB, b.id, {
      recipientId: recipient.id,
      maxPaymentAmountMinor: 10_000,
      periodicMaxAmountMinor: 50_000,
      period: "MONTH",
    });
    expect(await consentBelongsToBorrower(env.DB, b.id, consent.id)).toBe(true);
  });
});

describe("getActiveConsent with several mandates", () => {
  /**
   * "The active consent" had to keep one unambiguous meaning for every caller
   * that predates multiple accounts. Anchoring it to the default account is what
   * makes those callers still correct.
   */
  it("returns the default account's mandate, not merely the newest", async () => {
    const b = await borrower();
    const main = await seedLive(b.id, "Main");
    await seedLive(b.id, "Backup");
    const consent = await getActiveConsent(env.DB, b.id);
    expect(consent?.id).toBe(main.consentId);
  });

  it("follows the default when it moves", async () => {
    const b = await borrower();
    await seedLive(b.id, "Main");
    const backup = await seedLive(b.id, "Backup");
    await setDefaultRecipient(env.DB, b.id, backup.recipient.id);
    const consent = await getActiveConsent(env.DB, b.id);
    expect(consent?.id).toBe(backup.consentId);
  });
});
