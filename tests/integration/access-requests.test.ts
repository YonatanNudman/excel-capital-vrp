import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  requestAccess,
  listPendingRequests,
  getRequestByEmail,
  decideRequest,
  pendingRequestCount,
} from "@/lib/repo/access-requests";
import { createStaff, getStaffByEmail } from "@/lib/repo/staff";

const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@outside.test`;

describe("requesting access", () => {
  it("records a request as pending", async () => {
    const who = email("new");
    const created = await requestAccess(env.DB, who, "I am the new bookkeeper");

    expect(created.status).toBe("pending");
    expect(created.email).toBe(who);
    expect(created.note).toBe("I am the new bookkeeper");
    expect(created.decided_at).toBeNull();
  });

  it("normalises the email so the same person cannot queue twice by casing", async () => {
    const who = email("case");
    await requestAccess(env.DB, who.toUpperCase(), null);
    const found = await getRequestByEmail(env.DB, who);
    expect(found?.email).toBe(who.toLowerCase());
  });

  /** One pending row per email is what stops the queue being flooded. */
  it("is idempotent while a request is still pending", async () => {
    const who = email("dup");
    const first = await requestAccess(env.DB, who, "please");
    const second = await requestAccess(env.DB, who, "please again");

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("pending");
    const pending = await listPendingRequests(env.DB);
    expect(pending.filter((r) => r.email === who)).toHaveLength(1);
  });

  it("does NOT let a denied address request again", async () => {
    const who = email("denied");
    const admin = await createStaff(env.DB, email("admin1"), "admin");
    const req = await requestAccess(env.DB, who, null);
    await decideRequest(env.DB, { id: req.id, approve: false, decidedBy: admin.id });

    const again = await requestAccess(env.DB, who, "let me in");
    expect(again.status).toBe("denied");
    expect(await pendingRequestCount(env.DB)).toBe(
      (await listPendingRequests(env.DB)).length,
    );
    expect((await listPendingRequests(env.DB)).some((r) => r.email === who)).toBe(false);
  });
});

describe("deciding a request", () => {
  it("approving creates the staff user with the chosen role", async () => {
    const who = email("approve");
    const admin = await createStaff(env.DB, email("admin2"), "admin");
    const req = await requestAccess(env.DB, who, null);

    const result = await decideRequest(env.DB, {
      id: req.id,
      approve: true,
      role: "operator",
      decidedBy: admin.id,
    });

    expect(result.status).toBe("approved");
    expect(result.granted_role).toBe("operator");
    expect(result.decided_by).toBe(admin.id);
    expect(result.decided_at).not.toBeNull();

    const staff = await getStaffByEmail(env.DB, who);
    expect(staff?.role).toBe("operator");
    expect(staff?.disabled_at).toBeNull();
  });

  it("approving as viewer grants only viewer", async () => {
    const who = email("viewer");
    const admin = await createStaff(env.DB, email("admin3"), "admin");
    const req = await requestAccess(env.DB, who, null);
    await decideRequest(env.DB, { id: req.id, approve: true, role: "viewer", decidedBy: admin.id });

    expect((await getStaffByEmail(env.DB, who))?.role).toBe("viewer");
  });

  it("denying does NOT create a staff user", async () => {
    const who = email("nope");
    const admin = await createStaff(env.DB, email("admin4"), "admin");
    const req = await requestAccess(env.DB, who, null);

    const result = await decideRequest(env.DB, { id: req.id, approve: false, decidedBy: admin.id });

    expect(result.status).toBe("denied");
    expect(result.granted_role).toBeNull();
    expect(await getStaffByEmail(env.DB, who)).toBeNull();
  });

  it("refuses to approve without a role rather than guessing one", async () => {
    const who = email("norole");
    const admin = await createStaff(env.DB, email("admin5"), "admin");
    const req = await requestAccess(env.DB, who, null);

    await expect(
      decideRequest(env.DB, { id: req.id, approve: true, decidedBy: admin.id }),
    ).rejects.toThrow(/role/i);
    expect(await getStaffByEmail(env.DB, who)).toBeNull();
  });

  it("cannot be decided twice, so two admins clicking cannot double-grant", async () => {
    const who = email("race");
    const admin = await createStaff(env.DB, email("admin6"), "admin");
    const req = await requestAccess(env.DB, who, null);

    await decideRequest(env.DB, { id: req.id, approve: true, role: "viewer", decidedBy: admin.id });
    await expect(
      decideRequest(env.DB, { id: req.id, approve: true, role: "admin", decidedBy: admin.id }),
    ).rejects.toThrow(/already decided|not pending/i);

    // The first decision stands.
    expect((await getStaffByEmail(env.DB, who))?.role).toBe("viewer");
  });

  it("errors clearly for a request that does not exist", async () => {
    const admin = await createStaff(env.DB, email("admin7"), "admin");
    await expect(
      decideRequest(env.DB, { id: "nope", approve: false, decidedBy: admin.id }),
    ).rejects.toThrow(/not found|no request/i);
  });
});

describe("the queue", () => {
  it("lists pending requests oldest first and counts them", async () => {
    const before = await pendingRequestCount(env.DB);
    const a = await requestAccess(env.DB, email("q1"), null);
    const b = await requestAccess(env.DB, email("q2"), null);

    const pending = await listPendingRequests(env.DB);
    const ids = pending.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(await pendingRequestCount(env.DB)).toBe(before + 2);
  });

  it("drops a request off the queue once decided", async () => {
    const admin = await createStaff(env.DB, email("admin8"), "admin");
    const req = await requestAccess(env.DB, email("gone"), null);
    const before = await pendingRequestCount(env.DB);

    await decideRequest(env.DB, { id: req.id, approve: false, decidedBy: admin.id });

    expect(await pendingRequestCount(env.DB)).toBe(before - 1);
  });
});
