/**
 * TikTok OAuth authorization URL + creation service (F2A1).
 *
 * Builds official Login Kit web authorization URLs and creates durable OAuth state.
 * No TikTok HTTP, token exchange, credentials, or bindings.
 */

const { getCampaignByCode } = require("../../../db");
const {
  CodeClipTikTokOAuthError,
  createCodeClipTikTokOAuthState,
} = require("./oauth-state");

const AUTHORIZE_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
const REDIRECT_URI_MAX = 512;
const RETURN_URL_MAX = 2048;

function oauthError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipTikTokOAuthError(code, message, safe);
}

function readRequiredEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth is not configured",
      { fieldName: name }
    );
  }
  return value.trim();
}

function normalizeConfiguredRedirectUri(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > REDIRECT_URI_MAX) {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  return trimmed;
}

function loadReturnUrlAllowlist(env = process.env) {
  const allowlist = String(env.CODECLIP_TIKTOK_RETURN_URL_ALLOWLIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowlist.length) {
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth return URL allowlist is not configured"
    );
  }
  return allowlist.map((entry) => {
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw oauthError(
        "TIKTOK_CONFIG_NOT_AVAILABLE",
        "TikTok OAuth return URL allowlist is not configured"
      );
    }
    if (parsed.protocol !== "https:" || parsed.hash || parsed.username || parsed.password) {
      throw oauthError(
        "TIKTOK_CONFIG_NOT_AVAILABLE",
        "TikTok OAuth return URL allowlist is not configured"
      );
    }
    parsed.hash = "";
    return parsed.toString();
  });
}

function assertReturnUrlAllowed(returnUrl, allowlist) {
  if (typeof returnUrl !== "string" || !returnUrl.trim()) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  const trimmed = returnUrl.trim();
  if (trimmed.length > RETURN_URL_MAX) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  if (parsed.protocol !== "https:" || parsed.hash || parsed.username || parsed.password) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  parsed.hash = "";
  const normalized = parsed.toString();
  if (!allowlist.includes(normalized)) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is not allowed", {
      fieldName: "returnUrl",
    });
  }
  return normalized;
}

function loadTikTokAuthorizationConfig(env = process.env) {
  const clientKey = readRequiredEnv(env, "CODECLIP_TIKTOK_CLIENT_KEY");
  const redirectUri = normalizeConfiguredRedirectUri(
    env.CODECLIP_TIKTOK_REDIRECT_URI
  );
  const returnUrlAllowlist = loadReturnUrlAllowlist(env);
  let stateTtlSeconds = 600;
  if (
    env.CODECLIP_TIKTOK_STATE_TTL_SECONDS !== undefined &&
    env.CODECLIP_TIKTOK_STATE_TTL_SECONDS !== null &&
    String(env.CODECLIP_TIKTOK_STATE_TTL_SECONDS).trim() !== ""
  ) {
    const parsed = Number(String(env.CODECLIP_TIKTOK_STATE_TTL_SECONDS).trim());
    if (!Number.isInteger(parsed) || parsed < 60 || parsed > 3600) {
      throw oauthError(
        "TIKTOK_CONFIG_NOT_AVAILABLE",
        "TikTok OAuth is not configured"
      );
    }
    stateTtlSeconds = parsed;
  }
  return {
    clientKey,
    redirectUri,
    returnUrlAllowlist,
    stateTtlSeconds,
  };
}

/**
 * Pure builder for TikTok Login Kit web authorization URL.
 */
function buildCodeClipTikTokAuthorizationUrl({
  clientKey,
  redirectUri,
  state,
  scopes,
  disableAutoAuth,
} = {}) {
  if (typeof clientKey !== "string" || !clientKey.trim()) {
    throw oauthError("INVALID_OAUTH_REQUEST", "clientKey is invalid", {
      fieldName: "clientKey",
    });
  }
  if (typeof redirectUri !== "string" || !redirectUri.trim()) {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri is invalid", {
      fieldName: "redirectUri",
    });
  }
  if (typeof state !== "string" || !state.trim()) {
    throw oauthError("INVALID_OAUTH_REQUEST", "state is invalid", {
      fieldName: "state",
    });
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw oauthError("INVALID_SCOPES", "scopes is invalid", {
      fieldName: "scopes",
    });
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || !scope.trim()) {
      throw oauthError("INVALID_SCOPES", "scopes is invalid", {
        fieldName: "scopes",
      });
    }
  }

  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_key", clientKey.trim());
  url.searchParams.set("scope", scopes.map((s) => s.trim()).join(","));
  url.searchParams.set("redirect_uri", redirectUri.trim());
  url.searchParams.set("state", state.trim());
  url.searchParams.set("response_type", "code");

  if (disableAutoAuth !== undefined && disableAutoAuth !== null) {
    if (disableAutoAuth !== 0 && disableAutoAuth !== 1) {
      throw oauthError("INVALID_OAUTH_REQUEST", "disableAutoAuth is invalid", {
        fieldName: "disableAutoAuth",
      });
    }
    url.searchParams.set("disable_auto_auth", String(disableAutoAuth));
  }

  // Reject accidental secret leakage into URL shape.
  if (url.searchParams.has("client_secret") || url.searchParams.has("code_verifier")) {
    throw oauthError("INVALID_OAUTH_REQUEST", "authorization URL is invalid");
  }

  return url.toString();
}

function isCodeClipEvent(event) {
  return (
    String(event?.vertical || event?.raw_event?.vertical || "")
      .trim()
      .toLowerCase() === "codeclip"
  );
}

/**
 * Create durable OAuth state and return TikTok authorization URL.
 * No TikTok HTTP.
 */
async function createCodeClipTikTokOAuthAuthorization(
  {
    eventCode,
    environment,
    redirectUri,
    returnUrl,
    requestedScopes,
    actor,
    disableAutoAuth,
    now,
  } = {},
  {
    queryClient,
    env = process.env,
    getEventByCode = getCampaignByCode,
  } = {}
) {
  if (!queryClient) {
    throw oauthError(
      "DATABASE_UNAVAILABLE",
      "TikTok OAuth requires an explicit query client"
    );
  }

  let config;
  try {
    config = loadTikTokAuthorizationConfig(env);
  } catch (error) {
    if (error instanceof CodeClipTikTokOAuthError) throw error;
    throw oauthError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth is not configured"
    );
  }

  const normalizedEventCode = String(eventCode || "").trim();
  if (!normalizedEventCode) {
    throw oauthError("INVALID_EVENT", "eventCode is required", {
      fieldName: "eventCode",
    });
  }

  if (typeof getEventByCode !== "function") {
    throw oauthError("DATABASE_UNAVAILABLE", "event lookup is unavailable");
  }
  let event;
  try {
    event = await getEventByCode(normalizedEventCode);
  } catch {
    throw oauthError("DATABASE_ERROR", "event lookup failed");
  }
  if (!event) {
    throw oauthError("EVENT_NOT_FOUND", "event was not found", {
      fieldName: "eventCode",
    });
  }
  if (!isCodeClipEvent(event)) {
    throw oauthError("INVALID_EVENT", "event is not a codeClip episode", {
      fieldName: "eventCode",
    });
  }

  if (typeof redirectUri !== "string" || redirectUri.trim() !== config.redirectUri) {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri does not match configuration", {
      fieldName: "redirectUri",
    });
  }

  const normalizedReturnUrl = assertReturnUrlAllowed(
    returnUrl,
    config.returnUrlAllowlist
  );

  const created = await createCodeClipTikTokOAuthState(
    {
      eventCode: normalizedEventCode,
      environment,
      redirectUri: config.redirectUri,
      returnUrl: normalizedReturnUrl,
      requestedScopes,
      actor,
      now,
      ttlSeconds: config.stateTtlSeconds,
    },
    { queryClient }
  );

  const authorizationUrl = buildCodeClipTikTokAuthorizationUrl({
    clientKey: config.clientKey,
    redirectUri: config.redirectUri,
    state: created.rawState,
    scopes: created.oauthState.requestedScopes,
    disableAutoAuth,
  });

  return {
    authorizationUrl,
    expiresAt: created.expiresAt,
  };
}

module.exports = {
  buildCodeClipTikTokAuthorizationUrl,
  createCodeClipTikTokOAuthAuthorization,
};
