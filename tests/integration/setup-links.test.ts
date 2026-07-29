import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  insertSetupLink,
  getSetupLinkByHash,
  markSetupLinkUsed,
  invalidateBorrowerLinks,
} from "@/lib/repo/setup-links";
import { createBorrower } from "@/lib/repo/borrowers";
import { sha256Hex, createSetupToken } from "@/lib/crypto";

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function seedLink(opts: { expiresAt?: string } = {}) {
  const borrower = await createBorrower(env.DB, { legalName: "Setup Ltd", createdBy: null });
  const { token } = await createSetupToken();
  const link = await insertSetupLink(env.DB, {
    borrowerId: borrower.id,
    tokenHash: await sha256Hex(token),
    expiresAt: opts.expiresAt ?? hoursFromNow(72),
    createdBy: null,
  });
  return { borrower, token, link };
}

describe("setup links: token handling", () => {
  it("resolves a live link from its token", async () => {
    const { token, link } = await seedLink();
    const found = await getSetupLinkByHash(env.DB, await sha256Hex(token));
    expect(found?.id).toBe(link.id);
  });

  it("stores only the hash, never the raw token", async () => {
    const { token, link } = await seedLink();
    const row = await env.DB.prepare("SELECT * FROM setup_links WHERE id = ?")
      .bind(link.id)
      .first<Record<string, unknown>>();
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(token);
    expect(row?.token_hash).toBe(await sha256Hex(token));
  });

  it("rejects a tampered token", async () => {
    const { token } = await seedLink();
    // Flip the final character; the hash diverges completely.
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(tampered).not.toBe(token);
    const found = await getSetupLinkByHash(env.DB, await sha256Hex(tampered));
    expect(found).toBeNull();
  });

  it("rejects a token belonging to a different borrower's link", async () => {
    const first = await seedLink();
    const second = await seedLink();
    const found = await getSetupLinkByHash(env.DB, await sha256Hex(second.token));
    expect(found?.borrower_id).toBe(second.borrower.id);
    expect(found?.borrower_id).not.toBe(first.borrower.id);
  });
});

describe("setup links: single use", () => {
  it("stops resolving once the link has been used", async () => {
    const { token, link } = await seedLink();
    expect(await getSetupLinkByHash(env.DB, await sha256Hex(token))).not.toBeNull();

    await markSetupLinkUsed(env.DB, link.id);

    // Replaying the same URL must not resolve a second time.
    expect(await getSetupLinkByHash(env.DB, await sha256Hex(token))).toBeNull();
  });

  it("issuing a new link invalidates the borrower's outstanding links", async () => {
    const { borrower, token } = await seedLink();
    const { token: secondToken } = await createSetupToken();

    await invalidateBorrowerLinks(env.DB, borrower.id);
    await insertSetupLink(env.DB, {
      borrowerId: borrower.id,
      tokenHash: await sha256Hex(secondToken),
      expiresAt: hoursFromNow(72),
      createdBy: null,
    });

    expect(await getSetupLinkByHash(env.DB, await sha256Hex(token))).toBeNull();
    expect(await getSetupLinkByHash(env.DB, await sha256Hex(secondToken))).not.toBeNull();
  });

  it("invalidating twice is harmless and does not resurrect a link", async () => {
    const { borrower, token } = await seedLink();
    await invalidateBorrowerLinks(env.DB, borrower.id);
    await invalidateBorrowerLinks(env.DB, borrower.id);
    expect(await getSetupLinkByHash(env.DB, await sha256Hex(token))).toBeNull();
  });
});

describe("setup links: expiry", () => {
  it("carries an expiry that has already passed for an old link", async () => {
    // Both consumers (the setup page and completeSetupAction) reject a link
    // whose expires_at is in the past; this asserts the stored value they read.
    const { token } = await seedLink({ expiresAt: hoursFromNow(-1) });
    const found = await getSetupLinkByHash(env.DB, await sha256Hex(token));
    expect(found).not.toBeNull();
    expect(new Date(found!.expires_at).getTime()).toBeLessThan(Date.now());
  });

  it("a freshly issued link is not expired", async () => {
    const { token } = await seedLink();
    const found = await getSetupLinkByHash(env.DB, await sha256Hex(token));
    expect(new Date(found!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});
