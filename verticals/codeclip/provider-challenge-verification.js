const { normalizeCodeClipProviderName } = require("./provider-registry");

function firstQueryValue(value) {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return String(value || "").trim();
}

function verifyCodeClipProviderChallenge({ provider, query = {}, verifyToken } = {}) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);

  if (normalizedProvider !== "meta") {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  const configuredToken = String(verifyToken || "").trim();
  if (!configuredToken) {
    return { ok: false, reason: "VERIFY_TOKEN_REQUIRED" };
  }

  const mode = firstQueryValue(query["hub.mode"]);
  if (mode !== "subscribe") {
    return { ok: false, reason: "MODE_MISMATCH" };
  }

  const queryToken = firstQueryValue(query["hub.verify_token"]);
  if (!queryToken) {
    return { ok: false, reason: "QUERY_VERIFY_TOKEN_REQUIRED" };
  }

  const challenge = firstQueryValue(query["hub.challenge"]);
  if (!challenge) {
    return { ok: false, reason: "CHALLENGE_REQUIRED" };
  }

  if (queryToken !== configuredToken) {
    return { ok: false, reason: "VERIFY_TOKEN_MISMATCH" };
  }

  return { ok: true, challenge };
}

module.exports = {
  verifyCodeClipProviderChallenge,
};
