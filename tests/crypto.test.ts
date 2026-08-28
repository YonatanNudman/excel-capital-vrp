import { describe, it, expect } from "vitest";
import {
  encryptString,
  decryptString,
  sha256Hex,
  createSetupToken,
} from "@/lib/crypto";

// Real key material, because deriveKey now refuses anything short enough to be
// a placeholder: an unset APP_ENCRYPTION_KEY used to derive a perfectly valid
// key from SHA-256(""), so bank details were protected by a key anyone could
// compute and nothing looked wrong.
const KEY_A = "unit-test-key-material-a";
const KEY_B = "unit-test-key-material-b";

describe("encryptString / decryptString", () => {
  it("round-trips a consent id", async () => {
    const key = KEY_A;
    const secret = "consent-abc-123";
    const ct = await encryptString(secret, key);
    expect(ct).not.toContain(secret); // ciphertext must not leak plaintext
    expect(await decryptString(ct, key)).toBe(secret);
  });

  it("fails to decrypt with the wrong key", async () => {
    const ct = await encryptString("secret", KEY_A);
    await expect(decryptString(ct, KEY_B)).rejects.toBeDefined();
  });

  it("produces distinct ciphertexts for the same input (random IV)", async () => {
    const a = await encryptString("x", KEY_A);
    const b = await encryptString("x", KEY_A);
    expect(a).not.toBe(b);
  });

  it("refuses to encrypt with a missing or placeholder key", async () => {
    // The failure mode worth having: loud, at the first write, rather than
    // silently protecting real bank details with a publicly derivable key.
    await expect(encryptString("secret", "")).rejects.toThrow(/APP_ENCRYPTION_KEY/);
    await expect(encryptString("secret", "short")).rejects.toThrow(/APP_ENCRYPTION_KEY/);
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
