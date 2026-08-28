import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { hasRole } from "@/lib/auth";
import type { Role, StaffUser } from "@/lib/types";

const ACTIONS_DIR = path.join(__dirname, "..", "src", "lib", "actions");

/**
 * Server actions are the only way the UI mutates state, so an action without a
 * role guard is a hole in the whole authorisation model. Anything genuinely
 * public must be listed here deliberately, with a reason.
 */
const PUBLIC_ACTIONS: Record<string, string> = {
  completeSetupAction:
    "borrower-facing; authenticated by the single-use setup token, not by staff role",
  recordSetupErrorAction:
    "borrower-facing, like completeSetupAction: the caller is the borrower, who has " +
    "no staff login. Authenticated by the setup token, grants nothing, and writes one " +
    "audit row with bounded fields; an unrecognised token records nothing at all.",
  requestAccessAction:
    "must be callable by someone Cloudflare has authenticated who is NOT yet staff, " +
    "so requireRole would defeat its purpose. It still takes the email from the " +
    "verified Access token and never from the form, and it grants nothing.",
};

function actionFiles(): string[] {
  return readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"));
}

describe("server action authorisation", () => {
  it("finds the action files (guards against a silently empty scan)", () => {
    expect(actionFiles().length).toBeGreaterThan(3);
  });

  it("guards every exported server action with a role check", () => {
    const unguarded: string[] = [];

    for (const file of actionFiles()) {
      const source = readFileSync(path.join(ACTIONS_DIR, file), "utf8");
      const names = [...source.matchAll(/export async function (\w*Action)\b/g)].map((m) => m[1]);

      for (const name of names) {
        if (name in PUBLIC_ACTIONS) continue;
        // Take the body from this action to the next top-level export.
        const start = source.indexOf(`export async function ${name}`);
        const rest = source.slice(start + 1);
        const nextExport = rest.indexOf("\nexport ");
        const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

        if (!/requireRole\(|requireUser\(/.test(body)) {
          unguarded.push(`${file}:${name}`);
        }
      }
    }

    expect(unguarded).toEqual([]);
  });

  it("keeps money-moving actions at operator or above", () => {
    const payments = readFileSync(path.join(ACTIONS_DIR, "payments.ts"), "utf8");
    // Neither execute nor retry may be downgraded to viewer.
    expect(payments).not.toMatch(/requireRole\("viewer"\)/);
    expect([...payments.matchAll(/requireRole\("(\w+)"\)/g)].map((m) => m[1])).toEqual([
      "operator",
      "operator",
    ]);
  });

  it("keeps staff and settings administration at admin", () => {
    for (const file of ["staff.ts", "settings.ts"]) {
      const source = readFileSync(path.join(ACTIONS_DIR, file), "utf8");
      const roles = [...source.matchAll(/requireRole\("(\w+)"\)/g)].map((m) => m[1]);
      expect(roles.length).toBeGreaterThan(0);
      expect(new Set(roles)).toEqual(new Set(["admin"]));
    }
  });
});

const user = (role: Role): StaffUser =>
  ({ id: "s1", email: "x@y.z", role, created_at: "", last_login_at: null }) as StaffUser;

describe("hasRole ranking", () => {
  it("lets each role do its own job", () => {
    expect(hasRole(user("viewer"), "viewer")).toBe(true);
    expect(hasRole(user("operator"), "operator")).toBe(true);
    expect(hasRole(user("admin"), "admin")).toBe(true);
  });

  it("stops a viewer from operating or administering", () => {
    expect(hasRole(user("viewer"), "operator")).toBe(false);
    expect(hasRole(user("viewer"), "admin")).toBe(false);
  });

  it("stops an operator from administering", () => {
    expect(hasRole(user("operator"), "admin")).toBe(false);
  });

  it("lets an operator do a viewer's job", () => {
    expect(hasRole(user("operator"), "viewer")).toBe(true);
  });

  it("lets an admin do everything", () => {
    expect(hasRole(user("admin"), "operator")).toBe(true);
    expect(hasRole(user("admin"), "viewer")).toBe(true);
  });
});

describe("Companies House enforcement cannot be enforced without a key", () => {
  /**
   * Production sets COMPANIES_HOUSE_ENFORCE=true. Every verification branch in
   * createBorrowerAction sits inside `if (chClient && companyNumber)`, so with no
   * API key the client is null, the whole block is skipped, and a typed company
   * number is accepted unverified while the config claims otherwise.
   *
   * Found when production was configured to enforce and the key had been skipped.
   * Asserted on the source because the action needs a full request context to
   * run, and the property worth protecting is that the guard exists at all.
   */
  const source = readFileSync(
    new URL("../src/lib/actions/borrowers.ts", import.meta.url),
    "utf8",
  );

  it("refuses to proceed when enforcement is on and no client exists", () => {
    expect(source).toMatch(/if\s*\(\s*enforce\s*&&\s*!chClient\s*\)/);
  });

  it("names both switches, so whoever hits it knows which one to change", () => {
    expect(source).toMatch(/COMPANIES_HOUSE_API_KEY/);
    expect(source).toMatch(/COMPANIES_HOUSE_ENFORCE/);
  });
});

/**
 * Pages are the other half of the authorisation model, and they were the half
 * with a hole: the dashboard layout proves you are STAFF, which includes
 * read-only viewers, and the borrower edit page decrypted the destination
 * account number and sort code and rendered them in full. Every other surface
 * masks them behind an operator check. The forms were guarded, so nothing could
 * be saved; the leak was the reading.
 */
const PAGES_DIR = path.join(__dirname, "..", "src", "app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

describe("pages that decrypt bank details", () => {
  it("finds the pages (guards against a silently empty scan)", () => {
    expect(pageFiles(PAGES_DIR).length).toBeGreaterThan(5);
  });

  it("check the operator role before rendering them", () => {
    const unguarded: string[] = [];

    for (const file of pageFiles(PAGES_DIR)) {
      const source = readFileSync(file, "utf8");
      if (!/\bunprotectString\s*\(/.test(source)) continue;
      // Either it proves the role itself, or it only hands the value to a
      // component that does (the borrower page masks and gates on canOperate).
      const guarded = /hasRole\(\s*user\s*,\s*"(operator|admin)"\)/.test(source);
      if (!guarded) unguarded.push(path.relative(path.join(__dirname, ".."), file));
    }

    expect(unguarded).toEqual([]);
  });
});
