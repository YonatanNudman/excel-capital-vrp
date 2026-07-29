/**
 * Minimal Worker entrypoint for the integration test pool.
 *
 * Durable Objects can only be bound to a class exported from the Worker under
 * test, so this module re-exports the coordinator. Tests still import the
 * engines directly; nothing routes through the fetch handler.
 */
export { BorrowerPaymentCoordinator } from "@/lib/durable/borrower-payment-coordinator";

const handler = {
  async fetch(): Promise<Response> {
    return new Response("test worker", { status: 200 });
  },
};

export default handler;
