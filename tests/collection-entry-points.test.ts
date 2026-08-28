import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

const rel = (file: string) => path.relative(path.join(__dirname, ".."), file).replace(/\\/g, "/");

/**
 * COLLECTIONS_ENABLED is the last stop control: the switch an operator throws
 * when something is wrong and no money must move at all.
 *
 * It was enforced in exactly one place on the automatic path — inside the
 * Durable Object — and that was sufficient only because every caller happened to
 * route through the coordinator. That is a property of today's call graph, not
 * of the switch. A new caller reaching collectPayment directly would collect
 * with the switch off and nothing would notice.
 *
 * So the call graph itself is pinned here. A file that wants to move money must
 * either go through the coordinator (which checks) or be listed below with a
 * reason, which forces the question to be asked out loud in review.
 */
const MAY_COLLECT_DIRECTLY: Record<string, string> = {
  "src/lib/engine/collect.ts": "defines it",
  "src/lib/durable/borrower-payment-coordinator.ts":
    "the coordinator itself, which checks COLLECTIONS_ENABLED before calling and " +
    "holds the per-borrower lease that serialises collections",
  "src/lib/engine/cron.ts":
    "fallback used only when no collector is injected, which is the test harness; " +
    "runDueCollectionsFromEnv always injects the coordinator and checks the switch",
  "src/lib/engine/auto-retry.ts":
    "same injected-collector fallback as cron.ts, and runDueCollectionsFromEnv " +
    "skips retries entirely when the switch is off",
};

describe("every path that moves money", () => {
  it("finds the source tree (guards against a silently empty scan)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
  });

  it("goes through the coordinator, or is listed with a reason", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = rel(file);
      if (name in MAY_COLLECT_DIRECTLY) continue;
      // Comments discuss collectPayment all over this codebase, and a comment
      // moves no money. Strip them and look for a real call.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/\bcollectPayment\s*\(/.test(source)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  it("checks the switch in the coordinator and at the nightly entry point", () => {
    const coordinator = readFileSync(
      path.join(SRC, "lib", "durable", "borrower-payment-coordinator.ts"),
      "utf8",
    );
    const cron = readFileSync(path.join(SRC, "lib", "engine", "cron.ts"), "utf8");
    const actions = readFileSync(path.join(SRC, "lib", "actions", "payments.ts"), "utf8");

    for (const [where, source] of [
      ["coordinator", coordinator],
      ["cron", cron],
      ["payment actions", actions],
    ] as const) {
      expect(source, `${where} must check COLLECTIONS_ENABLED`).toContain("COLLECTIONS_ENABLED");
    }
  });
});
