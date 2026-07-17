const crypto = require("node:crypto");

class CodeClipYouTubeWebSubSecretError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubSecretError";
    this.code = code;
    this.details = details;
  }
}

function normalizeSecretInput(value, fieldName) {
  if (typeof value !== "string") {
    throw new CodeClipYouTubeWebSubSecretError(
      "INVALID_YOUTUBE_WEBSUB_SECRET_INPUT",
      `${fieldName} is required`,
      { fieldName }
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new CodeClipYouTubeWebSubSecretError(
      "INVALID_YOUTUBE_WEBSUB_SECRET_INPUT",
      `${fieldName} is required`,
      { fieldName }
    );
  }
  return normalized;
}

function deriveCodeClipYouTubeWebSubSubscriptionSecret({
  rootSecret,
  secretVersion = "v1",
  callbackId,
  providerAccountId,
} = {}) {
  const root = normalizeSecretInput(rootSecret, "rootSecret");
  const version = normalizeSecretInput(secretVersion, "secretVersion");
  const callback = normalizeSecretInput(callbackId, "callbackId");
  const account = normalizeSecretInput(providerAccountId, "providerAccountId");

  return crypto
    .createHmac("sha256", root)
    .update(`codeclip:youtube-websub:${version}:${callback}:${account}`)
    .digest("hex");
}

module.exports = {
  CodeClipYouTubeWebSubSecretError,
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
};
