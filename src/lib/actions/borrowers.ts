"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, getEnv } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import {
  getCompaniesHouseClient,
  isLendableStatus,
} from "@/lib/companies-house";
import {
  createBorrower,
  setBorrowerStatus,
  updateBorrower,
} from "@/lib/repo/borrowers";
import { upsertRecipient } from "@/lib/repo/recipients";
import { upsertSchedule } from "@/lib/repo/schedules";
import { createPendingConsent } from "@/lib/repo/consents";
import { toMinorUnits } from "@/lib/money";
import type { BorrowerStatus, EndMode, Frequency } from "@/lib/types";
import { protectString } from "@/lib/crypto";

function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function money(fd: FormData, key: string): number | null {
  const n = num(fd, key);
  return n == null ? null : toMinorUnits(n);
}

/** Full borrower onboarding: borrower + recipient + schedule + pending consent limits. */
/** Checked weekday boxes arrive as repeated form values. */
function days(fd: FormData): number[] | null {
  const raw = fd.getAll("daysOfWeek").map((v) => Number(String(v)));
  const valid = raw.filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return valid.length > 0 ? valid : null;
}

export async function createBorrowerAction(fd: FormData): Promise<void> {
  const user = await requireRole("operator");
  const db = getDb();
  const env = getEnv();

  const legalName = str(fd, "legalName");
  if (!legalName) throw new Error("Legal name is required");
  if (legalName.length > 200) throw new Error("Legal name is too long");
  const contactEmail = str(fd, "contactEmail");
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error("Contact email is invalid");
  }
  const recipientName = str(fd, "recipientName");
  const account = str(fd, "recipientAccount");
  const sort = str(fd, "recipientSort");
  if (recipientName && Boolean(account) !== Boolean(sort)) {
    throw new Error("Account number and sort code are both required");
  }
  if (account && !/^\d{8}$/.test(account.replace(/\s/g, ""))) {
    throw new Error("Account number must contain 8 digits");
  }
  if (sort && !/^\d{6}$/.test(sort.replace(/\D/g, ""))) {
    throw new Error("Sort code must contain 6 digits");
  }

  // Verify the company against Companies House and use the official name, so a
  // borrower record can never disagree with the register. Enforcement is a
  // separate switch: staging testers work with invented companies, production
  // should not. Verified is always preferred over typed, either way.
  let companyNumber = str(fd, "companyNumber");
  let verifiedName: string | null = null;
  const enforce = String(env.COMPANIES_HOUSE_ENFORCE) === "true";
  const chClient = getCompaniesHouseClient(env);

  if (chClient && companyNumber) {
    const company = await chClient.getCompany(companyNumber).catch((error: unknown) => {
      // A Companies House outage must not block onboarding unless we are
      // enforcing, in which case failing closed is the safer default.
      console.error("companies house verification failed", error);
      if (enforce) {
        throw new Error(
          "Could not check this company against Companies House. Try again shortly.",
        );
      }
      return null;
    });

    if (company) {
      companyNumber = company.companyNumber;
      verifiedName = company.name;
      if (enforce && !isLendableStatus(company.status)) {
        throw new Error(
          `${company.name} is ${company.status ?? "not active"} on Companies House, not active. It cannot be onboarded.`,
        );
      }
    } else if (enforce) {
      throw new Error(
        `Company number ${companyNumber} is not on the Companies House register. Use the search to pick the company.`,
      );
    }
  } else if (enforce && !companyNumber) {
    throw new Error("A company number is required. Use the search to pick the company.");
  }

  const borrower = await createBorrower(db, {
    legalName: verifiedName ?? legalName,
    companyNumber,
    contactEmail,
    contactPhone: str(fd, "contactPhone"),
    createdBy: user.id,
  });

  if (recipientName) {
    await upsertRecipient(db, borrower.id, {
      name: recipientName,
      accountNumber: await protectString(account?.replace(/\s/g, ""), env.APP_ENCRYPTION_KEY),
      sortCode: await protectString(sort?.replace(/\D/g, ""), env.APP_ENCRYPTION_KEY),
    });
  }

  const amountMinor = money(fd, "amount");
  const frequency = str(fd, "frequency") as Frequency | null;
  const startDate = str(fd, "startDate");
  const endMode = (str(fd, "endMode") as EndMode | null) ?? "count";
  if (amountMinor && frequency && startDate) {
    await upsertSchedule(db, borrower.id, {
      amountMinor,
      frequency,
      intervalDays: num(fd, "intervalDays"),
      daysOfWeek: days(fd),
      startDate,
      endMode,
      endDate: str(fd, "endDate"),
      endCount: num(fd, "endCount"),
      endTotalMinor: money(fd, "endTotal"),
    });
  }

  // Intended VRP consent limits (used when the Plaid consent is created at setup).
  await createPendingConsent(db, borrower.id, {
    currency: "GBP",
    maxPaymentAmountMinor: money(fd, "maxPaymentAmount"),
    period: str(fd, "consentPeriod"),
    periodicAlignment: str(fd, "consentAlignment"),
    periodicMaxAmountMinor: money(fd, "periodicMaxAmount"),
    validFrom: str(fd, "consentValidFrom"),
    validTo: str(fd, "consentValidTo"),
  });

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "borrower.create",
    entityType: "borrower",
    entityId: borrower.id,
    metadata: { legalName },
  });

  revalidatePath("/borrowers");
  redirect(`/borrowers/${borrower.id}`);
}

export async function updateScheduleAction(fd: FormData): Promise<void> {
  const user = await requireRole("operator");
  const db = getDb();
  const borrowerId = str(fd, "borrowerId");
  if (!borrowerId) throw new Error("borrowerId required");

  const amountMinor = money(fd, "amount");
  const frequency = str(fd, "frequency") as Frequency | null;
  const startDate = str(fd, "startDate");
  const endMode = (str(fd, "endMode") as EndMode | null) ?? "count";
  if (!amountMinor || !frequency || !startDate) {
    throw new Error("amount, frequency and start date are required");
  }

  await upsertSchedule(db, borrowerId, {
    amountMinor,
    frequency,
    intervalDays: num(fd, "intervalDays"),
    daysOfWeek: days(fd),
    startDate,
    endMode,
    endDate: str(fd, "endDate"),
    endCount: num(fd, "endCount"),
    endTotalMinor: money(fd, "endTotal"),
  });

  await writeAudit(db, {
    actorStaffId: user.id,
    action: "schedule.update",
    entityType: "borrower",
    entityId: borrowerId,
    metadata: { amountMinor, frequency },
  });

  revalidatePath(`/borrowers/${borrowerId}`);
}

export async function updateBorrowerDetailsAction(fd: FormData): Promise<void> {
  const user = await requireRole("operator");
  const db = getDb();
  const borrowerId = str(fd, "borrowerId");
  if (!borrowerId) throw new Error("borrowerId required");

  await updateBorrower(db, borrowerId, {
    legalName: str(fd, "legalName") ?? undefined,
    companyNumber: str(fd, "companyNumber"),
    contactEmail: str(fd, "contactEmail"),
    contactPhone: str(fd, "contactPhone"),
  });
  await writeAudit(db, {
    actorStaffId: user.id,
    action: "borrower.update",
    entityType: "borrower",
    entityId: borrowerId,
  });
  revalidatePath(`/borrowers/${borrowerId}`);
  redirect(`/borrowers/${borrowerId}`);
}

/** Pause or resume collections for a borrower. */
export async function setBorrowerStatusAction(fd: FormData): Promise<void> {
  const user = await requireRole("operator");
  const db = getDb();
  const borrowerId = str(fd, "borrowerId");
  const status = str(fd, "status") as BorrowerStatus | null;
  if (!borrowerId || !status) throw new Error("borrowerId and status required");

  await setBorrowerStatus(db, borrowerId, status);
  await writeAudit(db, {
    actorStaffId: user.id,
    action: `borrower.status.${status}`,
    entityType: "borrower",
    entityId: borrowerId,
  });
  revalidatePath(`/borrowers/${borrowerId}`);
  revalidatePath("/borrowers");
}
