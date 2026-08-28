import { describe, it, expect } from "vitest";
import { setupProgress } from "@/lib/setup-progress";
import type { Destination } from "@/lib/destinations";
import type { Consent, Recipient } from "@/lib/types";

const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  id: "rec1",
  borrower_id: "bor1",
  plaid_recipient_id: null,
  name: "Excel Capital Group Ltd",
  account_number: "12345678",
  sort_code: "123456",
  label: null,
  is_default: 1,
  archived_at: null,
  created_at: "",
  ...over,
});

const consent = (over: Partial<Consent> = {}): Consent =>
  ({
    id: "con1",
    borrower_id: "bor1",
    plaid_consent_id: null,
    plaid_consent_id_hash: null,
    plaid_recipient_id: null,
    recipient_id: "rec1",
    status: "pending",
    currency: "GBP",
    max_payment_amount_minor: 50_000,
    period: "MONTH",
    periodic_alignment: "CALENDAR",
    periodic_max_amount_minor: 200_000,
    valid_from: null,
    valid_to: null,
    authorized_at: null,
    raw_constraints: null,
    created_at: "",
    ...over,
  }) as Consent;

const account = (label: string, over: Partial<Consent> = {}, rec: Partial<Recipient> = {}): Destination => ({
  recipient: recipient({ id: `rec-${label}`, label, ...rec }),
  consent: consent({ id: `con-${label}`, recipient_id: `rec-${label}`, ...over }),
});

describe("setupProgress: has the borrower finished their side", () => {
  it("says nothing is outstanding once every account is approved", () => {
    const p = setupProgress([
      account("Main", { status: "authorized" }),
      account("Backup", { status: "authorized" }),
    ]);
    expect(p.complete).toBe(true);
    expect(p.approved).toBe(2);
    expect(p.label).toBe("All approved");
  });

  /**
   * The gap the status badge cannot show. One approved account makes a borrower
   * active and collectable while a second is still sitting unapproved, so
   * "Active" on its own tells an operator nothing about whether they are waiting
   * on the borrower.
   */
  it("is NOT complete while one of two accounts is still unapproved", () => {
    const p = setupProgress([
      account("Main", { status: "authorized" }),
      account("Backup", { status: "pending" }),
    ]);
    expect(p.complete).toBe(false);
    expect(p.awaitingBorrower).toBe(1);
    expect(p.label).toBe("1 of 2 approved");
    expect(p.detail).toContain("Backup");
  });

  it("names a single outstanding account so staff know what to chase", () => {
    const p = setupProgress([account("Main", { status: "pending" })]);
    expect(p.label).toBe("1 to approve");
    expect(p.detail).toContain("Main");
  });

  /**
   * Chasing the borrower here would waste everyone's time: without bank details
   * or limits, provisioning throws and they meet "Setup is temporarily
   * unavailable" however many times they open the link.
   */
  it("counts an account the borrower cannot yet act on as ours, not theirs", () => {
    const p = setupProgress([
      account("Half filled", { status: "pending" }, { account_number: null, sort_code: null }),
    ]);
    expect(p.awaitingBorrower).toBe(0);
    expect(p.needsStaff).toBe(1);
    expect(p.label).toBe("Needs your input");
  });

  it("treats missing limits the same way", () => {
    const p = setupProgress([
      account("No limits", { status: "pending", max_payment_amount_minor: null }),
    ]);
    expect(p.needsStaff).toBe(1);
  });

  /** A cancelled or expired mandate needs a NEW mandate, which only staff can create. */
  it("does not ask the borrower to re-approve a revoked mandate", () => {
    const p = setupProgress([account("Main", { status: "revoked" })]);
    expect(p.awaitingBorrower).toBe(0);
    expect(p.needsStaff).toBe(1);
  });

  /**
   * A retired account is nobody's outstanding work. Counting it would leave a
   * borrower permanently unfinished over an account that was abandoned.
   */
  it("ignores a retired account entirely", () => {
    const p = setupProgress([
      account("Main", { status: "authorized" }),
      account("Old", { status: "pending" }, { archived_at: "2026-01-01T00:00:00Z" }),
    ]);
    expect(p.complete).toBe(true);
    expect(p.total).toBe(1);
  });

  it("says there is nothing to send when no account has been added", () => {
    const p = setupProgress([]);
    expect(p.complete).toBe(false);
    expect(p.total).toBe(0);
    expect(p.label).toBe("No account yet");
  });

  /**
   * A mandate predating the account model has no recipient row. It still moves
   * money, so it must count as approved rather than as outstanding work.
   */
  it("counts a legacy mandate with no account row of its own", () => {
    const p = setupProgress([{ recipient: null, consent: consent({ status: "authorized" }) }]);
    expect(p.complete).toBe(true);
    expect(p.approved).toBe(1);
  });
});
