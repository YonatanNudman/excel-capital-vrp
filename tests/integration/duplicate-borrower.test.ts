import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  archiveBorrower,
  createBorrower,
  findBorrowerByCompanyNumber,
} from "@/lib/repo/borrowers";

/**
 * Two identical borrowers appeared on production 2.8 seconds apart, from one
 * operator pressing Create once. The submit button did not disable itself, so a
 * second click ran the action again while the first was still in flight.
 *
 * A duplicate is not cosmetic here: each borrower carries its own mandate and
 * schedule, so the same company can end up being collected from twice.
 */
describe("duplicate borrowers", () => {
  it("finds an existing borrower by company number", async () => {
    const made = await createBorrower(env.DB, {
      legalName: "DUPE CHECK LTD",
      companyNumber: "99000001",
      createdBy: null,
    });
    const found = await findBorrowerByCompanyNumber(env.DB, "99000001");
    expect(found?.id).toBe(made.id);
  });

  it("returns the FIRST one when duplicates already exist", async () => {
    // Production already has a pair. The message must name the original.
    const first = await createBorrower(env.DB, {
      legalName: "DUPE PAIR LTD",
      companyNumber: "99000002",
      createdBy: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    await createBorrower(env.DB, {
      legalName: "DUPE PAIR LTD",
      companyNumber: "99000002",
      createdBy: null,
    });
    expect((await findBorrowerByCompanyNumber(env.DB, "99000002"))?.id).toBe(first.id);
  });

  it("ignores archived borrowers, so a company can be re-onboarded", async () => {
    // Archiving is how staff retire a borrower. If the check counted archived
    // rows, a company could never be taken on again after being retired.
    const old = await createBorrower(env.DB, {
      legalName: "RETIRED LTD",
      companyNumber: "99000003",
      createdBy: null,
    });
    await archiveBorrower(env.DB, old.id);
    expect(await findBorrowerByCompanyNumber(env.DB, "99000003")).toBeNull();
  });

  it("does not match a different company", async () => {
    await createBorrower(env.DB, {
      legalName: "OTHER LTD",
      companyNumber: "99000004",
      createdBy: null,
    });
    expect(await findBorrowerByCompanyNumber(env.DB, "99000005")).toBeNull();
  });
});
