import { describe, it, expect } from "vitest";
import {
  encryptString,
  decryptString,
  sha256Hex,
  createSetupToken,
} from "@/lib/crypto";

describe("encryptString / decryptString", () => {
  it("round-trips a consent id", async () => {
    const key = "unit-test-key";
    const secret = "consent-abc-123";
    const ct = await encryptString(secret, key);
    expect(ct).not.toContain(secret); // ciphertext must not leak plaintext
    expect(await decryptString(ct, key)).toBe(secret);
  });

  it("fails to decrypt with the wrong key", async () => {
    const ct = await encryptString("secret", "key-a");
    await expect(decryptString(ct, "key-b")).rejects.toBeDefined();
  });

  it("produces distinct ciphertexts for the same input (random IV)", async () => {
    const a = await encryptString("x", "k");
    const b = await encryptString("x", "k");
    expect(a).not.toBe(b);
  });
});

describe("setup token", () => {
  it("hash is stable and matches sha256 of the token", async () => {
    const { token, hash } = await createSetupToken();
    expect(hash).toBe(await sha256Hex(token));
    expect(token.length).toBeGreaterThan(30);
  });

  it("generates unique tokens", async () => {
    const a = await createSetupToken();
    const b = await createSetupToken();
    expect(a.token).not.toBe(b.token);
  });
});
