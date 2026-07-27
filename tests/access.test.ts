import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { getAuthenticatedEmail } from "@/lib/access";

const TEAM = "excel-capital-zt.cloudflareaccess.com";
const AUD = "test-aud-tag";
const SERVICE_CN = "fe2d68d9fa57529df430962a8f984970.access";
const SERVICE_EMAIL = "e2e-bot@excel-capital.invalid";

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;
const KID = "test-kid-1";

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
});

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const encodeJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** Mint a JWT signed by the test key, shaped like a Cloudflare Access assertion. */
async function mintJwt(claims: Record<string, unknown>, opts: { sign?: boolean } = {}) {
  const header = encodeJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encodeJson({
    iss: `https://${TEAM}`,
    aud: AUD,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = opts.sign === false
    ? new Uint8Array(256) // structurally valid, cryptographically wrong
    : new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Serve the test key as the team's JWKS. */
function stubJwks() {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256" }] }), {
      headers: { "content-type": "application/json" },
    }),
  ));
}

const headersWith = (jwt: string) => new Headers({ "cf-access-jwt-assertion": jwt });

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ACCESS_SERVICE_TOKEN_CN: SERVICE_CN,
  ACCESS_SERVICE_ACCOUNT_EMAIL: SERVICE_EMAIL,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAuthenticatedEmail: human identity", () => {
  it("returns the email from a validly signed Access JWT", async () => {
    stubJwks();
    const jwt = await mintJwt({ email: "Nudman.Yonatan@gmail.com" });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBe("nudman.yonatan@gmail.com");
  });

  it("rejects a JWT whose signature does not verify", async () => {
    stubJwks();
    const jwt = await mintJwt({ email: "attacker@evil.example" }, { sign: false });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBeNull();
  });

  it("rejects a JWT minted for a different audience", async () => {
    stubJwks();
    const jwt = await mintJwt({ email: "someone@example.com", aud: "other-app-aud" });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBeNull();
  });
});

describe("getAuthenticatedEmail: service token identity (automated testing)", () => {
  it("maps an allowlisted service token to the designated service account", async () => {
    stubJwks();
    const jwt = await mintJwt({ common_name: SERVICE_CN });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBe(SERVICE_EMAIL);
  });

  it("REFUSES service tokens in production, even when configured", async () => {
    stubJwks();
    const jwt = await mintJwt({ common_name: SERVICE_CN });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "production" }))
      .resolves.toBeNull();
  });

  it("refuses a service token whose common_name is not the allowlisted one", async () => {
    stubJwks();
    const jwt = await mintJwt({ common_name: "someone-elses-token.access" });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBeNull();
  });

  it("refuses service tokens when the mapping env vars are absent", async () => {
    stubJwks();
    const jwt = await mintJwt({ common_name: SERVICE_CN });
    await expect(getAuthenticatedEmail(headersWith(jwt), {
      ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, APP_ENV: "staging",
    })).resolves.toBeNull();
  });

  it("still verifies the signature on a service token JWT", async () => {
    stubJwks();
    const jwt = await mintJwt({ common_name: SERVICE_CN }, { sign: false });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBeNull();
  });

  it("prefers a real email claim over the service mapping", async () => {
    stubJwks();
    const jwt = await mintJwt({ email: "real.person@example.com", common_name: SERVICE_CN });
    await expect(getAuthenticatedEmail(headersWith(jwt), { ...baseEnv, APP_ENV: "staging" }))
      .resolves.toBe("real.person@example.com");
  });
});
