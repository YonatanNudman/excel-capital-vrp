import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createBorrower } from "@/lib/repo/borrowers";
import { insertSetupLink, borrowerIdForSetupToken, markSetupLinkUsed } from "@/lib/repo/setup-links";
import { latestAuditEntry, writeAudit } from "@/lib/repo/audit";
import { createSetupToken } from "@/lib/crypto";

let n = 0;

async function seedLink() {
  const b = await createBorrower(env.DB, { legalName: `Failing ${n++} Ltd`, createdBy: null });
  const { token, hash } = await createSetupToken();
  const link = await insertSetupLink(env.DB, {
    borrowerId: b.id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdBy: null,
  });
  return { borrowerId: b.id, token, hash, linkId: link.id };
}

/**
 * A borrower failed on a real bank and the only evidence anyone had was a
 * screenshot of an error box on their phone. Plaid had already said exactly what
 * went wrong; the message went to console.error in the borrower's browser and
 * nowhere else, so a morning went on theorising instead of reading it.
 */
describe("recording why a borrower could not connect their bank", () => {
  it("resolves the borrower from their setup token", async () => {
    const { borrowerId, hash } = await seedLink();
    expect(await borrowerIdForSetupToken(env.DB, hash)).toBe(borrowerId);
  });

  it("still resolves the borrower after the link has been marked used", async () => {
    // A failure on the second account of a multi-account setup arrives after the
    // link is spent. Losing the borrower at that point would drop exactly the
    // failures that are hardest to reproduce.
    const { borrowerId, hash, linkId } = await seedLink();
    await markSetupLinkUsed(env.DB, linkId);
    expect(await borrowerIdForSetupToken(env.DB, hash)).toBe(borrowerId);
  });

  it("resolves nothing for a token that was never issued", async () => {
    // An unrecognised token must record nothing, rather than leaving an entry an
    // operator would have to interpret.
    const { hash } = await createSetupToken();
    expect(await borrowerIdForSetupToken(env.DB, hash)).toBeNull();
  });

  it("reads back the provider's own account of the failure", async () => {
    const { borrowerId } = await seedLink();
    await writeAudit(env.DB, {
      actorStaffId: null,
      action: "setup.link_failed",
      entityType: "borrower",
      entityId: borrowerId,
      metadata: {
        errorCode: "INSTITUTION_ERROR",
        displayMessage: "Something went wrong",
        institutionName: "HSBC Business",
        linkSessionId: "link-session-abc",
      },
    });

    const entry = await latestAuditEntry(env.DB, "setup.link_failed", "borrower", borrowerId);
    const metadata = JSON.parse(entry!.metadata!);
    expect(metadata.errorCode).toBe("INSTITUTION_ERROR");
    expect(metadata.institutionName).toBe("HSBC Business");
    expect(metadata.linkSessionId).toBe("link-session-abc");
  });

  it("returns the most recent failure, not the first", async () => {
    const { borrowerId } = await seedLink();
    for (const code of ["FIRST_ATTEMPT", "SECOND_ATTEMPT"]) {
      await writeAudit(env.DB, {
        actorStaffId: null,
        action: "setup.link_failed",
        entityType: "borrower",
        entityId: borrowerId,
        metadata: { errorCode: code },
      });
      // created_at has second resolution, so order the two explicitly.
      await env.DB.prepare(
        "UPDATE audit_log SET created_at = ? WHERE entity_id = ? AND metadata LIKE ?",
      )
        .bind(code === "FIRST_ATTEMPT" ? "2026-08-28T09:00:00Z" : "2026-08-28T10:00:00Z", borrowerId, `%${code}%`)
        .run();
    }

    const entry = await latestAuditEntry(env.DB, "setup.link_failed", "borrower", borrowerId);
    expect(JSON.parse(entry!.metadata!).errorCode).toBe("SECOND_ATTEMPT");
  });

  it("does not confuse one borrower's failure with another's", async () => {
    const a = await seedLink();
    const b = await seedLink();
    await writeAudit(env.DB, {
      actorStaffId: null,
      action: "setup.link_failed",
      entityType: "borrower",
      entityId: a.borrowerId,
      metadata: { errorCode: "ONLY_A" },
    });

    expect(await latestAuditEntry(env.DB, "setup.link_failed", "borrower", b.borrowerId)).toBeNull();
  });
});
