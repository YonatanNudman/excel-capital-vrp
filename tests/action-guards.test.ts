import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

  it("lets an admin do everything", () => {
    expect(hasRole(user("admin"), "operator")).toBe(true);
    expect(hasRole(user("admin"), "viewer")).toBe(true);
  });
});
