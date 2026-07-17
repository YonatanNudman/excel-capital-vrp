/**
 * Cloudflare Access identity resolution.
 *
 * Two modes:
 *  1. Verified (recommended for all deployed envs): when ACCESS_TEAM_DOMAIN and
 *     ACCESS_AUD are configured, we cryptographically verify the
 *     `Cf-Access-Jwt-Assertion` JWT (RS256, issuer + audience + expiry) and take
 *     the email from the verified claims. The plaintext email header is NOT
 *     trusted in this mode.
 *  2. Local development only: when Access is not configured AND APP_ENV is
 *     "development", we accept the `X-Dev-User-Email` (or the plaintext Access
 *     email header) so the app is usable without Access in front.
 *
 * In staging/production without ACCESS_* configured, this returns null (fail
 * closed) — the app must sit behind a verified Access application.
 */

const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";
const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const DEV_EMAIL_HEADER = "x-dev-user-email";

export interface AccessEnv {
  APP_ENV?: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. myteam.cloudflareaccess.com
  ACCESS_AUD?: string; // Access application AUD tag
}

export async function getAuthenticatedEmail(
  headers: Headers,
  env: AccessEnv,
): Promise<string | null> {
  const configured = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

  if (configured) {
    const token = headers.get(ACCESS_JWT_HEADER);
    if (!token) return null;
    const email = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!);
    return email ? email.toLowerCase() : null;
  }

  // Not configured: only trust headers in strictly local development. The
  // dev_user_email cookie (set by /api/dev-login) lets a normal browser session
  // authenticate locally; it is ignored outside development.
  if (env.APP_ENV === "development") {
    const dev = headers.get(DEV_EMAIL_HEADER) ?? headers.get(ACCESS_EMAIL_HEADER);
    if (dev) return dev.toLowerCase();
    const cookieEmail = readCookie(headers.get("cookie"), "dev_user_email");
    return cookieEmail ? decodeURIComponent(cookieEmail).toLowerCase() : null;
  }
  return null;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

// --- Access JWT verification (RS256 via the team's JWKS) ---

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`failed to fetch Access JWKS: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<string | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const header = JSON.parse(b64urlToText(headerB64)) as { kid?: string; alg?: string };
    if (header.alg !== "RS256" || !header.kid) return null;

    const jwks = await getJwks(teamDomain);
    const jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      toArrayBuffer(b64urlToBytes(sigB64)),
      toArrayBuffer(new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
    );
    if (!ok) return null;

    const claims = JSON.parse(b64urlToText(payloadB64)) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      email?: string;
    };
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!auds.includes(aud)) return null;
    if (claims.iss !== `https://${teamDomain}`) return null;
    if (!claims.exp || claims.exp < Date.now() / 1000) return null;

    return claims.email ?? null;
  } catch {
    return null;
  }
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
function b64urlToText(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
