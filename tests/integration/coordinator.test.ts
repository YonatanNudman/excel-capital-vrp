import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { collectPaymentCoordinated } from "@/lib/durable/coordinated-collect";
import { createBorrower, setBorrowerStatus } from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import { createPendingConsent, attachPlaidConsent, setConsentStatus } from "@/lib/repo/consents";
import { encryptString, sha256Hex } from "@/lib/crypto";
import { manualKey } from "@/lib/idempotency";
import { newId } from "@/lib/ids";

const KEY = "test-encryption-key";

async function countPaymentsFor(borrowerId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE borrower_id = ?")
    .bind(borrowerId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function seedCollectableBorrower(name: string) {
  const b = await createBorrower(env.DB, { legalName: name, createdBy: null });
  await setBorrowerStatus(env.DB, b.id, "active");
  await upsertRecipient(env.DB, b.id, {
    name: "Excel Capital",
    accountNumber: "12345678",
    sortCode: "12-34-56",
  });
  const consent = await createPendingConsent(env.DB, b.id, {
    currency: "GBP",
    maxPaymentAmountMinor: 100000,
  });
  const plaidConsentId = `mock-consent-${b.id}`;
  await attachPlaidConsent(env.DB, consent.id, {
    plaidConsentIdEncrypted: await encryptString(plaidConsentId, KEY),
    plaidConsentIdHash: await sha256Hex(plaidConsentId),
    plaidRecipientId: "mock-recipient-1",
  });
  await setConsentStatus(env.DB, consent.id, "authorized");
  return b;
}

describe("BorrowerPaymentCoordinator (per-borrower lock)", () => {
  it("never creates more payments than it reports collecting, under a concurrent burst", async () => {
    const b = await seedCollectableBorrower("Race Ltd");

    // Distinct idempotency keys, so ONLY the lock can stop a double charge.
    // Whether the calls actually overlap is up to the runtime, so assert the
    // invariant that must hold either way: the ledger matches the outcomes and
    // no phantom or duplicate rows appear.
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        collectPaymentCoordinated(env, {
          borrowerId: b.id,
          amountMinor: 5000,
          reference: `RACE${i}`,
          idempotencyKey: manualKey(b.id, newId()),
          actorStaffId: null,
        }),
      ),
    );

    const collected = outcomes.filter((o) => o.kind === "collected").length;
    const skipped = outcomes.filter((o) => o.kind === "skipped");

    expect(collected).toBeGreaterThanOrEqual(1);
    expect(await countPaymentsFor(b.id)).toBe(collected);
    for (const s of skipped) {
      expect(s.kind === "skipped" && s.reason).toMatch(/already in progress/i);
    }

    // Every row must carry a distinct idempotency key.
    const keys = await env.DB.prepare(
      "SELECT COUNT(DISTINCT idempotency_key) AS distinct_keys, COUNT(*) AS total FROM payments WHERE borrower_id = ?",
    )
      .bind(b.id)
      .first<{ distinct_keys: number; total: number }>();
    expect(keys?.distinct_keys).toBe(keys?.total);
  });

  it("KNOWN GAP: two collections seconds apart both succeed (the lock only covers overlap)", async () => {
    const b = await seedCollectableBorrower("Sequential Risk Ltd");

    // This documents current behaviour, it is not an endorsement of it. A cron
    // sweep and a staff "execute now" that do not overlap in time both go
    // through, because the lease is released as soon as the first finishes and
    // manualKey() is randomised so it never collides with the cron key.
    const first = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 5000,
      reference: "GAPA",
      idempotencyKey: manualKey(b.id, newId()),
      actorStaffId: null,
    });
    const second = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 5000,
      reference: "GAPB",
      idempotencyKey: manualKey(b.id, newId()),
      actorStaffId: null,
    });

    expect(first.kind).toBe("collected");
    expect(second.kind).toBe("collected");
    expect(await countPaymentsFor(b.id)).toBe(2);
  });

  it("releases the lock so a later collection still succeeds", async () => {
    const b = await seedCollectableBorrower("Sequential Ltd");

    const first = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 1000,
      reference: "SEQ1",
      idempotencyKey: manualKey(b.id, newId()),
      actorStaffId: null,
    });
    expect(first.kind).toBe("collected");

    // If the lease leaked, this second call would be refused forever.
    const second = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 1000,
      reference: "SEQ2",
      idempotencyKey: manualKey(b.id, newId()),
      actorStaffId: null,
    });
    expect(second.kind).toBe("collected");
    expect(await countPaymentsFor(b.id)).toBe(2);
  });

  it("does not let one borrower's lock block a different borrower", async () => {
    const one = await seedCollectableBorrower("Alpha Ltd");
    const two = await seedCollectableBorrower("Beta Ltd");

    const [a, b] = await Promise.all([
      collectPaymentCoordinated(env, {
        borrowerId: one.id,
        amountMinor: 2500,
        reference: "ALPHA",
        idempotencyKey: manualKey(one.id, newId()),
        actorStaffId: null,
      }),
      collectPaymentCoordinated(env, {
        borrowerId: two.id,
        amountMinor: 2500,
        reference: "BETA",
        idempotencyKey: manualKey(two.id, newId()),
        actorStaffId: null,
      }),
    ]);

    expect(a.kind).toBe("collected");
    expect(b.kind).toBe("collected");
  });

  it("still honours the idempotency key through the coordinator", async () => {
    const b = await seedCollectableBorrower("Idem Ltd");
    const key = manualKey(b.id, newId());

    const first = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 4200,
      reference: "IDEM",
      idempotencyKey: key,
      actorStaffId: null,
    });
    const second = await collectPaymentCoordinated(env, {
      borrowerId: b.id,
      amountMinor: 4200,
      reference: "IDEM",
      idempotencyKey: key,
      actorStaffId: null,
    });

    expect(first.kind).toBe("collected");
    expect(second.kind).toBe("duplicate");
    expect(await countPaymentsFor(b.id)).toBe(1);
  });
});
