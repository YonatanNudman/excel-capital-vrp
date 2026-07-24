import type { CollectInput, CollectOutcome } from "@/lib/engine/collect";

/** RPC client kept separate so Next's build never imports `cloudflare:workers`. */
export async function collectPaymentCoordinated(
  env: CloudflareEnv,
  input: CollectInput,
): Promise<CollectOutcome> {
  const stub = env.BORROWER_PAYMENT_COORDINATOR.getByName(input.borrowerId);
  return stub.collect(input);
}
