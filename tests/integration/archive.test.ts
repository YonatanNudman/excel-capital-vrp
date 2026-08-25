import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  archiveBlockers,
  archiveBorrower,
  createBorrower,
  getBorrower,
  getBorrowerIncludingArchived,
  listArchivedBorrowers,
  listBorrowers,
  restoreBorrower,
} from "@/lib/repo/borrowers";
import { upsertSchedule } from "@/lib/repo/schedules";
import { createPendingConsent, setConsentStatus } from "@/lib/repo/consents";

let n = 0;
const borrower = () =>
  createBorrower(env.DB, { legalName: `Archive ${n++} Ltd`, createdBy: null });

describe("archiving a borrower", () => {
  it("hides them from the list but keeps the record", async () => {
    const b = await borrower();
    await archiveBorrower(env.DB, b.id);

    expect((await listBorrowers(env.DB)).map((x) => x.id)).not.toContain(b.id);
    // The record itself must survive: payments and audit rows point at it.
    expect(await getBorrowerIncludingArchived(env.DB, b.id)).not.toBeNull();
  });

  it("is invisible to getBorrower, so no page can act on an archived borrower", async () => {
    const b = await borrower();
    await archiveBorrower(env.DB, b.id);
    expect(await getBorrower(env.DB, b.id)).toBeNull();
  });

  it("shows up on the archived list, which is the way back", async () => {
    const b = await borrower();
    await archiveBorrower(env.DB, b.id);
    expect((await listArchivedBorrowers(env.DB)).map((x) => x.id)).toContain(b.id);
  });

  it("can be restored, so a mis-click is not permanent", async () => {
    const b = await borrower();
    await archiveBorrower(env.DB, b.id);
    await restoreBorrower(env.DB, b.id);
    expect((await listBorrowers(env.DB)).map((x) => x.id)).toContain(b.id);
    expect((await listArchivedBorrowers(env.DB)).map((x) => x.id)).not.toContain(b.id);
  });

  it("does not overwrite the original archive date when archived twice", async () => {
    // That date is the only record of when it happened.
    const b = await borrower();
    await archiveBorrower(env.DB, b.id);
    const first = (await getBorrowerIncludingArchived(env.DB, b.id))!.deleted_at;
    await archiveBorrower(env.DB, b.id);
    expect((await getBorrowerIncludingArchived(env.DB, b.id))!.deleted_at).toBe(first);
  });
});

describe("archiveBlockers: archiving must not hide live money", () => {
  /**
   * The dangerous misunderstanding this exists to prevent. Archiving hides a
   * borrower from the list; it does NOT stop collecting from them, because the
   * nightly sweep works from schedules. Archiving someone with a live mandate and
   * an active schedule would keep taking their money with nobody watching.
   */
  it("reports nothing for a borrower who was never set up", async () => {
    const b = await borrower();
    expect(await archiveBlockers(env.DB, b.id)).toEqual({
      activeSchedule: false,
      liveMandate: false,
    });
  });

  it("reports an active schedule", async () => {
    const b = await borrower();
    await upsertSchedule(env.DB, b.id, {
      amountMinor: 50_000,
      frequency: "weekly",
      startDate: "2026-09-01",
      endMode: "count",
      endCount: 4,
    });
    expect((await archiveBlockers(env.DB, b.id)).activeSchedule).toBe(true);
  });

  it("reports a live bank mandate", async () => {
    const b = await borrower();
    const consent = await createPendingConsent(env.DB, b.id, {
      maxPaymentAmountMinor: 10_000,
      periodicMaxAmountMinor: 50_000,
      period: "MONTH",
    });
    expect((await archiveBlockers(env.DB, b.id)).liveMandate).toBe(false);
    await setConsentStatus(env.DB, consent.id, "authorized");
    expect((await archiveBlockers(env.DB, b.id)).liveMandate).toBe(true);
  });

  it("stops reporting a mandate once it is revoked", async () => {
    const b = await borrower();
    const consent = await createPendingConsent(env.DB, b.id, {
      maxPaymentAmountMinor: 10_000,
      periodicMaxAmountMinor: 50_000,
      period: "MONTH",
    });
    await setConsentStatus(env.DB, consent.id, "authorized");
    await setConsentStatus(env.DB, consent.id, "revoked");
    expect((await archiveBlockers(env.DB, b.id)).liveMandate).toBe(false);
  });
});
