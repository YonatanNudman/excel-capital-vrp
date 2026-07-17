import { describe, it, expect } from "vitest";
import { getMailer } from "@/lib/mailer";
import {
  setupLinkEmail,
  receiptEmail,
  failureEmail,
  reconsentEmail,
} from "@/lib/mailer/templates";
import { formatMinor } from "@/lib/money";

const EM_DASH = String.fromCharCode(0x2014); // U+2014 em dash; templates must never contain this character

describe("email templates", () => {
  it("setupLinkEmail includes the borrower name and the url", () => {
    const { subject, text } = setupLinkEmail({
      borrowerName: "Acme Ltd",
      url: "https://excel.example/setup/abc123",
      expiresHours: 72,
    });
    expect(text).toContain("Acme Ltd");
    expect(text).toContain("https://excel.example/setup/abc123");
    expect(text).toContain("72");
    expect(subject.length).toBeGreaterThan(0);
  });

  it("receiptEmail includes the formatted amount and the borrower name", () => {
    const { subject, text } = receiptEmail({
      borrowerName: "Acme Ltd",
      amountMinor: 12345,
      currency: "GBP",
      reference: "EXCEL-ACME-3",
      date: "2026-07-17",
    });
    const amount = formatMinor(12345, "GBP");
    expect(amount).toBe("£123.45");
    expect(text).toContain(amount);
    expect(subject).toContain(amount);
    expect(text).toContain("Acme Ltd");
    expect(text).toContain("EXCEL-ACME-3");
  });

  it("failureEmail includes the amount but never a raw internal error", () => {
    const { text } = failureEmail({
      borrowerName: "Acme Ltd",
      amountMinor: 5000,
      currency: "GBP",
      reference: "EXCEL-ACME-4",
    });
    expect(text).toContain(formatMinor(5000, "GBP"));
    expect(text).toContain("Acme Ltd");
    // No internal error surface leaks to the borrower.
    expect(text).not.toMatch(/error|exception|stack|PlaidApiError|INSUFFICIENT_FUNDS/i);
  });

  it("reconsentEmail includes the borrower name and the expiry date", () => {
    const { text } = reconsentEmail({
      borrowerName: "Acme Ltd",
      validTo: "2026-08-01T00:00:00Z",
    });
    expect(text).toContain("Acme Ltd");
    expect(text).toContain("2026-08-01T00:00:00Z");
  });

  it("no template output contains an em dash", () => {
    const outputs = [
      setupLinkEmail({ borrowerName: "Acme Ltd", url: "https://x/y", expiresHours: 72 }),
      receiptEmail({ borrowerName: "Acme Ltd", amountMinor: 12345, currency: "GBP", reference: "R", date: "2026-07-17" }),
      failureEmail({ borrowerName: "Acme Ltd", amountMinor: 5000, currency: "GBP", reference: "R" }),
      reconsentEmail({ borrowerName: "Acme Ltd", validTo: "2026-08-01" }),
    ];
    for (const { subject, text } of outputs) {
      expect(subject.includes(EM_DASH)).toBe(false);
      expect(text.includes(EM_DASH)).toBe(false);
    }
  });
});

describe("getMailer", () => {
  it("returns a log-mode mailer when config is absent", () => {
    expect(getMailer({}).mode).toBe("log");
    expect(getMailer({ RESEND_API_KEY: "only-key" }).mode).toBe("log");
    expect(getMailer({ EMAIL_FROM: "only-from@x" }).mode).toBe("log");
  });

  it("returns a resend-mode mailer when both vars are set", () => {
    const mailer = getMailer({ RESEND_API_KEY: "re_123", EMAIL_FROM: "no-reply@excel.example" });
    expect(mailer.mode).toBe("resend");
  });
});
