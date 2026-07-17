import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import {
  countActiveAdmins,
  createStaff,
  getStaffByEmail,
  setStaffDisabled,
  setStaffRole,
  staffChangeGuard,
} from "@/lib/repo/staff";

// The Workers pool shares one D1 across the tests in this file, so start each
// test from an empty staff table to keep the global active-admin count exact.
beforeEach(async () => {
  await env.DB.exec("DELETE FROM staff_users");
});

describe("staffChangeGuard", () => {
  it("blocks a change to a staff member that does not exist", async () => {
    const reason = await staffChangeGuard(env.DB, "actor", "missing-id", {
      role: "operator",
    });
    expect(reason).toBe("Staff member not found");
  });

  it("blocks demoting the last active admin", async () => {
    const admin = await createStaff(env.DB, "guard-demote@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, "someone-else", admin.id, {
      role: "operator",
    });
    expect(reason).toBe("At least one active admin is required");
  });

  it("blocks disabling the last active admin", async () => {
    const admin = await createStaff(env.DB, "guard-disable@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, "someone-else", admin.id, {
      disable: true,
    });
    expect(reason).toBe("At least one active admin is required");
  });

  it("blocks an admin from demoting themselves", async () => {
    const self = await createStaff(env.DB, "guard-self@x.com", "admin");
    // A second active admin exists, so this is the self rule, not the last-admin rule.
    await createStaff(env.DB, "guard-self-other@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, self.id, self.id, {
      role: "viewer",
    });
    expect(reason).toBe("You cannot remove your own admin access");
  });

  it("blocks an admin from disabling themselves", async () => {
    const self = await createStaff(env.DB, "guard-selfd@x.com", "admin");
    await createStaff(env.DB, "guard-selfd-other@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, self.id, self.id, {
      disable: true,
    });
    expect(reason).toBe("You cannot remove your own admin access");
  });

  it("allows demoting an admin when another active admin exists", async () => {
    const keep = await createStaff(env.DB, "guard-keep@x.com", "admin");
    const drop = await createStaff(env.DB, "guard-drop@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, keep.id, drop.id, {
      role: "operator",
    });
    expect(reason).toBeNull();
  });

  it("allows disabling an admin when another active admin exists", async () => {
    const keep = await createStaff(env.DB, "guard-keep2@x.com", "admin");
    const drop = await createStaff(env.DB, "guard-drop2@x.com", "admin");
    const reason = await staffChangeGuard(env.DB, keep.id, drop.id, {
      disable: true,
    });
    expect(reason).toBeNull();
  });
});

describe("setStaffDisabled + countActiveAdmins", () => {
  it("toggles disabled_at and updates the active-admin count", async () => {
    const a = await createStaff(env.DB, "count-a@x.com", "admin");
    const b = await createStaff(env.DB, "count-b@x.com", "admin");
    expect(await countActiveAdmins(env.DB)).toBe(2);

    await setStaffDisabled(env.DB, b.id, true);
    expect(await countActiveAdmins(env.DB)).toBe(1);
    const disabledRow = await getStaffByEmail(env.DB, "count-b@x.com");
    expect(disabledRow?.disabled_at).not.toBeNull();

    await setStaffDisabled(env.DB, b.id, false);
    expect(await countActiveAdmins(env.DB)).toBe(2);
    const enabledRow = await getStaffByEmail(env.DB, "count-b@x.com");
    expect(enabledRow?.disabled_at).toBeNull();

    // sanity: the untouched admin is unaffected.
    expect((await getStaffByEmail(env.DB, "count-a@x.com"))?.id).toBe(a.id);
  });

  it("counts only active admins, ignoring other roles", async () => {
    await createStaff(env.DB, "role-admin@x.com", "admin");
    const op = await createStaff(env.DB, "role-op@x.com", "operator");
    expect(await countActiveAdmins(env.DB)).toBe(1);

    await setStaffRole(env.DB, op.id, "admin");
    expect(await countActiveAdmins(env.DB)).toBe(2);
  });
});

describe("disabled staff auth-path detection", () => {
  it("keeps returning a disabled row so auth can reject without re-creating it", async () => {
    const s = await createStaff(env.DB, "auth-disabled@x.com", "operator");
    await setStaffDisabled(env.DB, s.id, true);

    // getStaffByEmail must still find the row (it is not filtered out), so the
    // bootstrap path never tries to re-create an existing-but-disabled user.
    const row = await getStaffByEmail(env.DB, "auth-disabled@x.com");
    expect(row).not.toBeNull();
    expect(row?.disabled_at).not.toBeNull();

    // This mirrors the getCurrentUser rule: a set disabled_at means not authorised.
    const authorised = row != null && row.disabled_at == null;
    expect(authorised).toBe(false);
  });
});
