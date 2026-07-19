const crypto = require("node:crypto");

const STATE_TTL_SECONDS = 10 * 60;

class CodeClipYouTubeOAuthStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeOAuthStateError";
    this.code = code;
    this.details = details;
  }
}

function stateError(code, message, details = {}) {
  return new CodeClipYouTubeOAuthStateError(code, message, details);
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signStatePayload(payloadPart, secret) {
  return crypto.createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

function normalizeStateSecret(secret) {
  if (typeof secret !== "string" || !secret.trim()) {
    throw stateError("youtube_oauth_unavailable", "YouTube OAuth state signing is unavailable");
  }
  return secret.trim();
}

function createCodeClipYouTubeOAuthState({
  eventCode,
  returnUrl,
  secret,
  now = new Date(),
  nonce = crypto.randomBytes(18).toString("base64url"),
} = {}) {
  const stateSecret = normalizeStateSecret(secret);
  const issuedAtMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(issuedAtMs)) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state timestamp is invalid");
  }
  const normalizedEventCode = String(eventCode || "").trim();
  if (!normalizedEventCode || /[\u0000-\u001f\u007f]/.test(normalizedEventCode)) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state eventCode is invalid");
  }
  const normalizedReturnUrl = String(returnUrl || "").trim();
  if (!normalizedReturnUrl) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state returnUrl is invalid");
  }
  const payload = {
    v: 1,
    vertical: "codeclip",
    provider: "youtube",
    eventCode: normalizedEventCode,
    nonce,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + STATE_TTL_SECONDS * 1000).toISOString(),
    returnUrl: normalizedReturnUrl,
  };
  const payloadPart = base64urlJson(payload);
  const signature = signStatePayload(payloadPart, stateSecret);
  return {
    state: `${payloadPart}.${signature}`,
    payload,
  };
}

function verifyCodeClipYouTubeOAuthState(state, { secret, now = new Date() } = {}) {
  const stateSecret = normalizeStateSecret(secret);
  const value = String(state || "").trim();
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state is invalid");
  }
  const expected = signStatePayload(parts[0], stateSecret);
  const provided = parts[1];
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state is invalid");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state is invalid");
  }
  const keys = Object.keys(payload || {}).sort().join(",");
  if (keys !== "eventCode,expiresAt,issuedAt,nonce,provider,returnUrl,v,vertical") {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state shape is invalid");
  }
  if (
    payload.v !== 1 ||
    payload.vertical !== "codeclip" ||
    payload.provider !== "youtube" ||
    typeof payload.eventCode !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.returnUrl !== "string"
  ) {
    throw stateError("youtube_oauth_state_invalid", "YouTube OAuth state fields are invalid");
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || nowMs > expiresAtMs) {
    throw stateError("youtube_oauth_state_expired", "YouTube OAuth state has expired");
  }
  return payload;
}

function decodeCodeClipYouTubeOAuthStatePayloadUnsafe(state) {
  try {
    const [payloadPart] = String(state || "").split(".");
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  CodeClipYouTubeOAuthStateError,
  STATE_TTL_SECONDS,
  createCodeClipYouTubeOAuthState,
  decodeCodeClipYouTubeOAuthStatePayloadUnsafe,
  verifyCodeClipYouTubeOAuthState,
};
