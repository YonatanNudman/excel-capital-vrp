/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures destructured to OMIT a field on purpose */
import { describe, it, expect } from "vitest";
import { autoProvisionRole } from "@/lib/auth";

const DOMAIN = "excelcapital.co.uk";

const staging = {
  APP_ENV: "staging",
  STAFF_BOOTSTRAP_ADMINS: "nudman.yonatan@gmail.com",
  STAFF_AUTO_PROVISION_DOMAIN: DOMAIN,
};

describe("autoProvisionRole: bootstrap admins", () => {
  it("provisions a listed bootstrap address as admin", () => {
    expect(autoProvisionRole("nudman.yonatan@gmail.com", staging)).toBe("admin");
  });

  it("is case insensitive", () => {
    expect(autoProvisionRole("Nudman.Yonatan@Gmail.com", staging)).toBe("admin");
  });

  it("provisions bootstrap admins even in production", () => {
    expect(
      autoProvisionRole("nudman.yonatan@gmail.com", { ...staging, APP_ENV: "production" }),
    ).toBe("admin");
  });
});

describe("autoProvisionRole: domain testers", () => {
  it("provisions a domain address as operator, never admin", () => {
    expect(autoProvisionRole("accounting@excelcapital.co.uk", staging)).toBe("operator");
    expect(autoProvisionRole("someone.else@excelcapital.co.uk", staging)).toBe("operator");
  });

  it("REFUSES domain auto-provisioning in production", () => {
    // Production staff must be added deliberately. Anyone able to receive mail
    // at the domain would otherwise gain access to real money movement.
    expect(
      autoProvisionRole("accounting@excelcapital.co.uk", { ...staging, APP_ENV: "production" }),
    ).toBeNull();
  });

  it("refuses an address outside the configured domain", () => {
    expect(autoProvisionRole("attacker@evil.example", staging)).toBeNull();
  });

  it("refuses a lookalike domain suffix", () => {
    // "notexcelcapital.co.uk" must not satisfy a naive endsWith check.
    expect(autoProvisionRole("someone@notexcelcapital.co.uk", staging)).toBeNull();
  });

  it("refuses an address that merely contains the domain", () => {
    expect(autoProvisionRole("excelcapital.co.uk@evil.example", staging)).toBeNull();
  });

  it("refuses everyone when no domain is configured", () => {
    const { STAFF_AUTO_PROVISION_DOMAIN: _omitted, ...noDomain } = staging;
    expect(autoProvisionRole("accounting@excelcapital.co.uk", noDomain)).toBeNull();
  });

  it("refuses a malformed address with no domain part", () => {
    expect(autoProvisionRole("not-an-email", staging)).toBeNull();
  });
});

describe("autoProvisionRole: no configuration at all", () => {
  it("provisions nobody", () => {
    expect(autoProvisionRole("anyone@anywhere.test", { APP_ENV: "staging" })).toBeNull();
  });
});
