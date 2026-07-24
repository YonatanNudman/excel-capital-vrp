import { DurableObject } from "cloudflare:workers";
import { collectPayment, type CollectInput, type CollectOutcome } from "@/lib/engine/collect";
import { getMailer, type MailerEnv } from "@/lib/mailer";
import { getPlaidClient } from "@/lib/plaid";

interface Lease {
  token: string;
  expiresAt: number;
}

const LEASE_KEY = "collection-lease";
const LEASE_MS = 60_000;

/** Serializes every money-moving request for one borrower across Worker isolates. */
export class BorrowerPaymentCoordinator extends DurableObject<CloudflareEnv> {
  async collect(input: CollectInput): Promise<CollectOutcome> {
    if (String(this.env.COLLECTIONS_ENABLED) !== "true") {
      return { kind: "skipped", reason: "collections are disabled" };
    }

    const now = Date.now();
    const current = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (current && current.expiresAt > now) {
      return { kind: "skipped", reason: "another collection is already in progress" };
    }

    const lease: Lease = { token: crypto.randomUUID(), expiresAt: now + LEASE_MS };
    await this.ctx.storage.put(LEASE_KEY, lease);
    try {
      return await collectPayment(
        this.env.DB,
        getPlaidClient(this.env),
        this.env.APP_ENCRYPTION_KEY,
        input,
        getMailer(this.env as MailerEnv),
      );
    } finally {
      const active = await this.ctx.storage.get<Lease>(LEASE_KEY);
      if (active?.token === lease.token) await this.ctx.storage.delete(LEASE_KEY);
    }
  }
}
