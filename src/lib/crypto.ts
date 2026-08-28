/**
 * Crypto helpers using the Web Crypto API (available in the Workers runtime).
 *
 * - Setup-link tokens: a high-entropy random token is shown once in the URL;
 *   only its SHA-256 hash is stored, so a DB leak does not reveal usable links.
 * - Consent IDs: encrypted at rest with AES-GCM using a key derived from the
 *   APP_ENCRYPTION_KEY secret.
 *
 * Key material is passed in (not read from global env) so these stay unit-testable.
 */

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Copy a view into a fresh ArrayBuffer. Web Crypto args are typed BufferSource
 * (ArrayBuffer-backed); TextEncoder/Uint8Array are ArrayBufferLike, which the
 * strict Workers types reject. This normalises them.
 */
function ab(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ab(new TextEncoder().encode(input)));
  return toHex(digest);
}

/** Generate a one-time setup token and its storable hash. */
export async function createSetupToken(): Promise<{ token: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = b64urlEncode(raw);
  const hash = await sha256Hex(token);
  return { token, hash };
}

/**
 * Shortest key material we will derive an AES key from.
 *
 * deriveKey hashes whatever string it is handed, so an unset APP_ENCRYPTION_KEY
 * used to produce a perfectly valid key from SHA-256(""): bank details were
 * written to the database "encrypted" under a key anyone can compute, and
 * nothing failed, warned, or looked any different. Refusing is the only safe
 * behaviour, because the alternative is discovering it years later.
 */
const MIN_KEY_MATERIAL_LENGTH = 16;

async function deriveKey(keyMaterial: string): Promise<CryptoKey> {
  if (!keyMaterial || keyMaterial.trim().length < MIN_KEY_MATERIAL_LENGTH) {
    throw new Error(
      "APP_ENCRYPTION_KEY is missing or too short: bank details cannot be protected",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", ab(new TextEncoder().encode(keyMaterial)));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-GCM encrypt; output is `iv.ciphertext` in base64url. */
export async function encryptString(plaintext: string, keyMaterial: string): Promise<string> {
  const key = await deriveKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ab(iv) },
    key,
    ab(new TextEncoder().encode(plaintext)),
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(payload: string, keyMaterial: string): Promise<string> {
  const [ivPart, ctPart] = payload.split(".");
  if (!ivPart || !ctPart) throw new Error("malformed ciphertext");
  const key = await deriveKey(keyMaterial);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(b64urlDecode(ivPart)) },
    key,
    ab(b64urlDecode(ctPart)),
  );
  return new TextDecoder().decode(pt);
}

const PROTECTED_PREFIX = "enc1:";

export async function protectString(
  plaintext: string | null | undefined,
  keyMaterial: string,
): Promise<string | null> {
  if (!plaintext) return null;
  if (plaintext.startsWith(PROTECTED_PREFIX)) return plaintext;
  return `${PROTECTED_PREFIX}${await encryptString(plaintext, keyMaterial)}`;
}

export async function unprotectString(
  stored: string | null | undefined,
  keyMaterial: string,
): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(PROTECTED_PREFIX)) return stored;
  return decryptString(stored.slice(PROTECTED_PREFIX.length), keyMaterial);
}
