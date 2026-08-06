import { describe, it, expect } from "vitest";
import { emailReach } from "@/lib/mailer/reach";

describe("emailReach", () => {
  it("is off when nothing is configured", () => {
    expect(emailReach({})).toBe("off");
  });

  it("is off when only one of the two settings is present", () => {
    expect(emailReach({ RESEND_API_KEY: "re_x" })).toBe("off");
    expect(emailReach({ EMAIL_FROM: "a@b.com" })).toBe("off");
  });

  /**
   * Resend's shared test sender only delivers to the account owner, so claiming
   * borrowers are being emailed would be false. This is the case that matters:
   * it looks configured but reaches nobody except the owner.
   */
  it("is owner-only for the resend.dev test sender", () => {
    expect(
      emailReach({ RESEND_API_KEY: "re_x", EMAIL_FROM: "onboarding@resend.dev" }),
    ).toBe("owner-only");
  });

  it("recognises the test sender inside a display name", () => {
    expect(
      emailReach({
        RESEND_API_KEY: "re_x",
        EMAIL_FROM: "Excel Capital <onboarding@resend.dev>",
      }),
    ).toBe("owner-only");
  });

  it("is not fooled by case or padding", () => {
    expect(
      emailReach({ RESEND_API_KEY: "re_x", EMAIL_FROM: "  Excel <NOREPLY@Resend.DEV>  " }),
    ).toBe("owner-only");
  });

  it("is live for a verified domain", () => {
    expect(
      emailReach({
        RESEND_API_KEY: "re_x",
        EMAIL_FROM: "Excel Capital <noreply@mail.excelcapital.co.uk>",
      }),
    ).toBe("live");
  });

  it("does not treat a lookalike domain as the test sender", () => {
    expect(
      emailReach({ RESEND_API_KEY: "re_x", EMAIL_FROM: "noreply@notresend.dev.example.com" }),
    ).toBe("live");
  });
});
