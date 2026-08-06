"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb, getEnv } from "@/lib/db";
import { getAuthenticatedEmail } from "@/lib/access";
import { requireRole } from "@/lib/auth";
import { writeAudit } from "@/lib/repo/audit";
import {
  requestAccess,
  decideRequest,
  getRequest,
} from "@/lib/repo/access-requests";
import { getMailer, type MailerEnv } from "@/lib/mailer";
import { accessRequestEmail } from "@/lib/mailer/templates";
import type { Role } from "@/lib/types";

export type RequestAccessState = { submitted?: boolean; error?: string } | null;

/**
 * Ask an admin for access.
 *
 * Callable by someone who is authenticated by Cloudflare Access but is NOT yet
 * staff, so it cannot use requireRole. The email is taken from the verified
 * Access token and never from the form, so nobody can request access on behalf
 * of an address they do not control.
 */
export async function requestAccessAction(
  _prev: RequestAccessState,
  fd: FormData,
): Promise<RequestAccessState> {
  const env = getEnv();
  const db = getDb();
  const email = await getAuthenticatedEmail(await headers(), env);
  if (!email) return { error: "Please sign in again." };

  const note = String(fd.get("note") ?? "").slice(0, 500);
  const request = await requestAccess(db, email, note);

  // Tell the admins. Silently no-ops until a sending domain is configured, which
  // is why the pending count is also shown in the app.
  if (request.status === "pending") {
    const recipients = (env.STAFF_BOOTSTRAP_ADMINS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (recipients.length > 0) {
      const mailer = getMailer(env as MailerEnv);
      const { subject, text } = accessRequestEmail({
        requesterEmail: email,
        note: request.note,
        reviewUrl: `${env.APP_BASE_URL ?? ""}/staff`,
      });
      for (const to of recipients) {
        await mailer.send({ to, subject, text });
      }
    }
  }

  await writeAudit(db, {
    actorStaffId: null,
    action: "access_request.create",
    entityType: "access_request",
    entityId: request.id,
    metadata: { email, status: request.status },
  });

  return { submitted: true };
}

export type DecideState = { message?: string; error?: string } | null;

/** Approve (with a role) or deny a pending request. Admins only. */
export async function decideRequestAction(
  _prev: DecideState,
  fd: FormData,
): Promise<DecideState> {
  const actor = await requireRole("admin");
  const db = getDb();

  const id = String(fd.get("requestId") ?? "");
  const approve = String(fd.get("decision") ?? "") === "approve";
  const role = String(fd.get("role") ?? "") as Role;
  if (!id) return { error: "No request was selected." };

  const before = await getRequest(db, id);
  try {
    const decided = await decideRequest(db, {
      id,
      approve,
      role: approve ? role : undefined,
      decidedBy: actor.id,
    });
    await writeAudit(db, {
      actorStaffId: actor.id,
      action: approve ? "access_request.approve" : "access_request.deny",
      entityType: "access_request",
      entityId: id,
      metadata: { email: decided.email, role: decided.granted_role },
    });
    revalidatePath("/staff");
    return {
      message: approve
        ? `${decided.email} can now sign in as ${decided.granted_role}.`
        : `${decided.email} was denied and cannot ask again.`,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : `Could not update the request for ${before?.email ?? "that person"}.`,
    };
  }
}
