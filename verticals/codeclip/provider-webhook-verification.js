const crypto = require("node:crypto");

const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");

function normalizeMode(value) {
  return String(value || "disabled").trim().toLowerCase();
}

function headerValue(headers = {}, name) {
  const normalizedName = normalizeCodeClipProviderName(name);

  for (const [key, value] of Object.entries(headers || {})) {
    if (normalizeCodeClipProviderName(key) === normalizedName) return String(value || "").trim();
  }

  return "";
}

function success(provider, mode, method) {
  return {
    ok: true,
    provider,
    verification: {
      provider,
      mode,
      method,
    },
  };
}

function signatureForProvider(provider, headers) {
  if (provider === "meta") {
    return headerValue(headers, "x-hub-signature-256");
  }
  if (provider === "sms") {
    return headerValue(headers, "x-provider-signature");
  }
  return "";
}

function normalizeSignature(value) {
  const signature = String(value || "").trim();
  return signature.toLowerCase().startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
}

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody);
  return null;
}

function timingSafeEqualHex(left, right) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyHmacSha256({ provider, headers, rawBody, secret, mode }) {
  if (!secret) return { ok: false, reason: "SECRET_REQUIRED" };

  const signature = signatureForProvider(provider, headers);
  if (!signature) return { ok: false, reason: "SIGNATURE_REQUIRED" };

  const bodyBuffer = rawBodyBuffer(rawBody);
  if (!bodyBuffer) return { ok: false, reason: "RAW_BODY_REQUIRED" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("hex");
  const actual = normalizeSignature(signature);

  if (!/^[a-f0-9]+$/i.test(actual) || !timingSafeEqualHex(expected, actual)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }

  return success(provider, mode, "hmac-sha256");
}

function verifyTestProvider({ provider, headers, mode }) {
  if (provider !== "test") return { ok: false, reason: "UNSUPPORTED_PROVIDER" };

  const signature = headerValue(headers, "x-codeclip-test-signature");
  if (!signature) return { ok: false, reason: "SIGNATURE_REQUIRED" };
  if (signature !== "valid") return { ok: false, reason: "SIGNATURE_MISMATCH" };

  return success(provider, mode, "test-header");
}

function verifyCodeClipProviderWebhook({
  provider,
  headers = {},
  rawBody,
  secret,
  mode = "disabled",
} = {}) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);
  const normalizedMode = normalizeMode(mode);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };
  if (!isCodeClipProviderRegistered(normalizedProvider)) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  if (normalizedMode === "disabled") {
    return success(normalizedProvider, normalizedMode, "disabled");
  }

  if (normalizedMode === "test") {
    return verifyTestProvider({
      provider: normalizedProvider,
      headers,
      mode: normalizedMode,
    });
  }

  if (normalizedMode === "hmac-sha256") {
    if (!["meta", "sms"].includes(normalizedProvider)) {
      return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
    }

    return verifyHmacSha256({
      provider: normalizedProvider,
      headers,
      rawBody,
      secret,
      mode: normalizedMode,
    });
  }

  return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
}

module.exports = {
  verifyCodeClipProviderWebhook,
};
