const DEFAULT_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/youtube.readonly",
]);

class CodeClipYouTubeConnectionPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeConnectionPolicyError";
    this.code = code;
    this.details = details;
  }
}

function policyError(code, message, details = {}) {
  return new CodeClipYouTubeConnectionPolicyError(code, message, details);
}

function normalizeRequiredEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw policyError("youtube_oauth_unavailable", "YouTube OAuth is not configured", {
      envName: name,
    });
  }
  return value.trim();
}

function normalizeHttpsUrl(value, fieldName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw policyError("youtube_oauth_unavailable", "YouTube OAuth URL is invalid", {
      fieldName,
    });
  }
  if (parsed.protocol !== "https:") {
    throw policyError("youtube_oauth_unavailable", "YouTube OAuth URL must be HTTPS", {
      fieldName,
    });
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeReturnUrlAllowlist(env = process.env) {
  const allowlist = String(env.CODECLIP_YOUTUBE_OAUTH_RETURN_URL_ALLOWLIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const single = String(env.CODECLIP_YOUTUBE_OAUTH_RETURN_URL || "").trim();
  const values = allowlist.length ? allowlist : single ? [single] : [];
  return values.map((value) => normalizeHttpsUrl(value, "returnUrl"));
}

function loadCodeClipYouTubeConnectionPolicy({ env = process.env } = {}) {
  const clientId = normalizeRequiredEnv(env, "CODECLIP_YOUTUBE_OAUTH_CLIENT_ID");
  const clientSecret = normalizeRequiredEnv(env, "CODECLIP_YOUTUBE_OAUTH_CLIENT_SECRET");
  const callbackUrl = normalizeHttpsUrl(
    normalizeRequiredEnv(env, "CODECLIP_YOUTUBE_OAUTH_CALLBACK_URL"),
    "callbackUrl"
  );
  const stateSecret = normalizeRequiredEnv(env, "CODECLIP_YOUTUBE_OAUTH_STATE_SECRET");
  const returnUrlAllowlist = normalizeReturnUrlAllowlist(env);
  if (!returnUrlAllowlist.length) {
    throw policyError("youtube_oauth_unavailable", "YouTube OAuth return URL is not configured");
  }

  return {
    vertical: "codeclip",
    provider: "youtube",
    channel: "youtube",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    channelsEndpoint: "https://www.googleapis.com/youtube/v3/channels",
    clientId,
    clientSecret,
    callbackUrl,
    stateSecret,
    scopes: [...DEFAULT_SCOPES],
    returnUrlAllowlist,
  };
}

function assertAllowedReturnUrl(returnUrl, policy) {
  const normalized = normalizeHttpsUrl(returnUrl, "returnUrl");
  if (!policy.returnUrlAllowlist.includes(normalized)) {
    throw policyError("youtube_oauth_return_url_not_allowed", "YouTube OAuth return URL is not allowed");
  }
  return normalized;
}

module.exports = {
  CodeClipYouTubeConnectionPolicyError,
  DEFAULT_SCOPES,
  assertAllowedReturnUrl,
  loadCodeClipYouTubeConnectionPolicy,
};
