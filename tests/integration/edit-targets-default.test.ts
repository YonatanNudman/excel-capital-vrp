import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createBorrower } from "@/lib/repo/borrowers";
import {
  addRecipient,
  listDestinations,
  updateRecipient,
} from "@/lib/repo/destinations";
import { createPendingConsent } from "@/lib/repo/consents";
import { upsertRecipient } from "@/lib/repo/recipients";

let n = 0;
const borrower = () =>
  createBorrower(env.DB, { legalName: `Edit ${n++} Ltd`, createdBy: null });

/**
 * The bank details form and the limits form live on one page and must describe
 * the SAME account.
 *
 * They did not. upsertRecipient edits the NEWEST recipient row while
 * getActiveConsent returns the DEFAULT account's mandate, and once a borrower has
 * two accounts those are different rows: the page showed the backup account's
 * sort code beside the main account's limits, and saving overwrote the backup's
 * real bank details.
 */
describe("editing a borrower targets one account, not two", () => {
  it("upsertRecipient really does edit the newest, not the default", async () => {
    // Pinning the behaviour that caused the bug, so the trap stays documented
    // for anyone who reaches for this helper again.
    const b = await borrower();
    const main = await addRecipient(env.DB, b.id, { name: "Main", label: "Main" });
    const backup = await addRecipient(env.DB, b.id, { name: "Backup", label: "Backup" });

    await upsertRecipient(env.DB, b.id, { name: "CHANGED" });

    const dests = await listDestinations(env.DB, b.id);
    const mainRow = dests.find((d) => d.recipient?.id === main.id)!;
    const backupRow = dests.find((d) => d.recipient?.id === backup.id)!;
    expect(mainRow.recipient!.is_default).toBe(1);
    expect(backupRow.recipient!.name).toBe("CHANGED"); // the newest, NOT the default
    expect(mainRow.recipient!.name).toBe("Main");
  });

  it("the default account and its own mandate are one pair", async () => {
    const b = await borrower();
    const main = await addRecipient(env.DB, b.id, { name: "Main", label: "Main" });
    const mainConsent = await createPendingConsent(env.DB, b.id, {
      recipientId: main.id,
      maxPaymentAmountMinor: 10_000,
      periodicMaxAmountMinor: 50_000,
      period: "MONTH",
    });
    const backup = await addRecipient(env.DB, b.id, { name: "Backup", label: "Backup" });
    await createPendingConsent(env.DB, b.id, {
      recipientId: backup.id,
      maxPaymentAmountMinor: 99_000,
      periodicMaxAmountMinor: 99_000,
      period: "MONTH",
    });

    // What the edit page and its action now both do.
    const dests = (await listDestinations(env.DB, b.id)).filter(
      (d) => d.recipient && d.recipient.archived_at == null,
    );
    const target = dests.find((d) => d.recipient!.is_default) ?? dests[0];

    expect(target.recipient!.id).toBe(main.id);
    expect(target.consent!.id).toBe(mainConsent.id);
    // The pair belongs together: the consent points at the recipient shown.
    expect(target.consent!.recipient_id).toBe(target.recipient!.id);
  });

  it("editing by id leaves the other account's details untouched", async () => {
    const b = await borrower();
    const main = await addRecipient(env.DB, b.id, {
      name: "Main",
      label: "Main",
      accountNumber: "11111111",
      sortCode: "111111",
    });
    const backup = await addRecipient(env.DB, b.id, {
      name: "Backup",
      label: "Backup",
      accountNumber: "22222222",
      sortCode: "222222",
    });

    await updateRecipient(env.DB, main.id, {
      name: "Main renamed",
      label: "Main",
      accountNumber: "33333333",
      sortCode: "333333",
    });

    const dests = await listDestinations(env.DB, b.id);
    const backupRow = dests.find((d) => d.recipient?.id === backup.id)!;
    expect(backupRow.recipient!.account_number).toBe("22222222");
    expect(backupRow.recipient!.sort_code).toBe("222222");
    expect(backupRow.recipient!.name).toBe("Backup");
  });
});
