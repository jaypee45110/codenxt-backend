/**
 * Short-lived HttpOnly creator capability cookie for OAuth round-trips.
 *
 * Cookie is issued by the API origin after dashboardAccessKey auth and is
 * sent only to the API (credentials: include). It is not readable by JS and
 * never holds the dashboardAccessKey itself.
 */

const crypto = require("node:crypto");

const COOKIE_NAME = "codeclip_creator_cap";
const DEFAULT_TTL_SECONDS = 1800;
const MAX_EVENT_CODE = 120;

function getSigningSecret(env = process.env) {
  const fromEnv = String(
    env.CODECLIP_CREATOR_SESSION_SECRET || env.JWT_SECRET || ""
  ).trim();
  if (fromEnv) return fromEnv;
  // Fallback matches existing server JWT default for non-prod safety nets only.
  return "codenxt-dev-secret-change-later";
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signPayload(payload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeClipCreatorSessionToken(
  { eventCode, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() } = {},
  env = process.env
) {
  const code = String(eventCode || "").trim();
  if (!code || code.length > MAX_EVENT_CODE) {
    throw new Error("invalid_event_code");
  }
  const exp = Math.floor(Number(now) / 1000) + Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS);
  const body = `${code}.${exp}`;
  const sig = signPayload(body, getSigningSecret(env));
  return `${base64url(body)}.${sig}`;
}

function verifyCodeClipCreatorSessionToken(
  token,
  { eventCode, now = Date.now() } = {},
  env = process.env
) {
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "missing" };
  const parts = token.trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "shape" };
  const [bodyB64, sig] = parts;
  let body;
  try {
    body = Buffer.from(bodyB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8"
    );
  } catch {
    return { ok: false, reason: "decode" };
  }
  const expected = signPayload(body, getSigningSecret(env));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "sig" };
  }
  const [code, expRaw] = body.split(".");
  const exp = Number(expRaw);
  if (!code || !Number.isFinite(exp)) return { ok: false, reason: "payload" };
  if (Math.floor(Number(now) / 1000) > exp) return { ok: false, reason: "expired" };
  if (eventCode && String(eventCode).trim() !== code) {
    return { ok: false, reason: "event_mismatch" };
  }
  return { ok: true, eventCode: code, exp };
}

function parseCookieHeader(headerValue) {
  const out = Object.create(null);
  const raw = String(headerValue || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function readCodeClipCreatorSessionFromRequest(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie);
  return cookies[COOKIE_NAME] || "";
}

function buildCodeClipCreatorSessionSetCookie(
  token,
  { ttlSeconds = DEFAULT_TTL_SECONDS, secure = true } = {}
) {
  const maxAge = Math.max(60, Number(ttlSeconds) || DEFAULT_TTL_SECONDS);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    // Cross-site SPA (codeclip.codenxt.global) → API host requires None.
    "SameSite=None",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function buildCodeClipCreatorSessionClearCookie({ secure = true } = {}) {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=None",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

module.exports = {
  COOKIE_NAME,
  buildCodeClipCreatorSessionClearCookie,
  buildCodeClipCreatorSessionSetCookie,
  createCodeClipCreatorSessionToken,
  parseCookieHeader,
  readCodeClipCreatorSessionFromRequest,
  verifyCodeClipCreatorSessionToken,
};
