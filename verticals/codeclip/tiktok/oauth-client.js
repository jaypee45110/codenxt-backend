/**
 * TikTok OAuth token HTTP client (F2A2A + F2B1).
 *
 * Isolated HTTP client for:
 * - authorization-code → token exchange
 * - refresh_token → token refresh
 *
 * No routes, credentials persistence, bindings, orchestrator, or DB.
 */

const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

const CLIENT_KEY_MAX = 256;
const CLIENT_SECRET_MAX = 512;
const REDIRECT_URI_MAX = 512;
const AUTHORIZATION_CODE_MAX = 2048;
const OPEN_ID_MAX = 256;
const TOKEN_MAX = 4096;
const SCOPE_RAW_MAX = 512;
const SCOPE_ENTRY_MAX = 128;
const SCOPES_MAX_COUNT = 16;
const MAX_EXPIRES_IN_SECONDS = 31_536_000; // 365 days
const MAX_REFRESH_EXPIRES_IN_SECONDS = 63_072_000; // 730 days

const REQUIRED_SCOPE = "user.info.basic";
const SAFE_DETAIL_KEYS = new Set(["fieldName", "reason"]);

class CodeClipTikTokOAuthClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokOAuthClientError";
    this.code = code;
    this.details = sanitizeDetails(details);
  }
}

function sanitizeDetails(details) {
  const safe = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return safe;
  }
  for (const key of SAFE_DETAIL_KEYS) {
    if (details[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 80);
    }
  }
  return safe;
}

function clientError(code, message, details = {}) {
  return new CodeClipTikTokOAuthClientError(code, message, details);
}

function normalizeTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null || timeoutMs === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) {
    throw clientError("INVALID_OAUTH_REQUEST", "timeoutMs is invalid", {
      fieldName: "timeoutMs",
    });
  }
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw clientError("INVALID_OAUTH_REQUEST", "timeoutMs is invalid", {
      fieldName: "timeoutMs",
    });
  }
  return timeoutMs;
}

function normalizeInjectedNow(now) {
  if (now === undefined) {
    return new Date().toISOString();
  }
  if (now === null || now === "") {
    throw clientError("INVALID_OAUTH_REQUEST", "now is invalid", {
      fieldName: "now",
    });
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw clientError("INVALID_OAUTH_REQUEST", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw clientError("INVALID_OAUTH_REQUEST", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  throw clientError("INVALID_OAUTH_REQUEST", "now is invalid", {
    fieldName: "now",
  });
}

function readRequiredEnvString(env, name, maxLen) {
  const value = env?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth is not configured",
      { fieldName: name }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth is not configured",
      { fieldName: name }
    );
  }
  return trimmed;
}

function normalizeConfigEnvironment(environment) {
  if (environment === undefined || environment === null || environment === "") {
    return "production";
  }
  if (typeof environment !== "string") {
    throw clientError("INVALID_OAUTH_REQUEST", "environment is invalid", {
      fieldName: "environment",
    });
  }
  const normalized = environment.trim().toLowerCase();
  if (normalized !== "production" && normalized !== "sandbox") {
    throw clientError("INVALID_OAUTH_REQUEST", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return normalized;
}

function getTikTokClientEnvNames(environment) {
  if (environment === "sandbox") {
    return {
      clientKey: "CODECLIP_TIKTOK_SANDBOX_CLIENT_KEY",
      clientSecret: "CODECLIP_TIKTOK_SANDBOX_CLIENT_SECRET",
    };
  }
  return {
    clientKey: "CODECLIP_TIKTOK_CLIENT_KEY",
    clientSecret: "CODECLIP_TIKTOK_CLIENT_SECRET",
  };
}

function normalizeConfiguredRedirectUri(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > REDIRECT_URI_MAX) {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) {
    throw clientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "TikTok OAuth redirect URI is not configured"
    );
  }
  return trimmed;
}

function loadTokenExchangeConfig(env = process.env, environment) {
  const normalizedEnvironment = normalizeConfigEnvironment(environment);
  const names = getTikTokClientEnvNames(normalizedEnvironment);
  const clientKey = readRequiredEnvString(
    env,
    names.clientKey,
    CLIENT_KEY_MAX
  );
  const clientSecret = readRequiredEnvString(
    env,
    names.clientSecret,
    CLIENT_SECRET_MAX
  );
  const redirectUri = normalizeConfiguredRedirectUri(
    env.CODECLIP_TIKTOK_REDIRECT_URI
  );
  return { clientKey, clientSecret, redirectUri };
}

/** Refresh needs client key/secret only — not redirect URI. */
function loadTokenRefreshConfig(env = process.env, environment) {
  const normalizedEnvironment = normalizeConfigEnvironment(environment);
  const names = getTikTokClientEnvNames(normalizedEnvironment);
  const clientKey = readRequiredEnvString(
    env,
    names.clientKey,
    CLIENT_KEY_MAX
  );
  const clientSecret = readRequiredEnvString(
    env,
    names.clientSecret,
    CLIENT_SECRET_MAX
  );
  return { clientKey, clientSecret };
}

function normalizeAuthorizationCode(code) {
  if (typeof code !== "string") {
    throw clientError(
      "AUTHORIZATION_CODE_REQUIRED",
      "authorization code is required",
      { fieldName: "code" }
    );
  }
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > AUTHORIZATION_CODE_MAX) {
    throw clientError(
      "AUTHORIZATION_CODE_REQUIRED",
      "authorization code is required",
      { fieldName: "code" }
    );
  }
  return trimmed;
}

function normalizeRefreshTokenInput(refreshToken) {
  if (typeof refreshToken !== "string") {
    throw clientError(
      "REFRESH_TOKEN_REQUIRED",
      "refresh token is required",
      { fieldName: "refreshToken" }
    );
  }
  const trimmed = refreshToken.trim();
  if (!trimmed || trimmed.length > TOKEN_MAX) {
    throw clientError(
      "REFRESH_TOKEN_REQUIRED",
      "refresh token is required",
      { fieldName: "refreshToken" }
    );
  }
  return trimmed;
}

function normalizeCallerRedirectUri(redirectUri, configuredRedirectUri) {
  if (typeof redirectUri !== "string" || !redirectUri.trim()) {
    throw clientError("INVALID_REDIRECT_URI", "redirectUri is invalid", {
      fieldName: "redirectUri",
    });
  }
  const trimmed = redirectUri.trim();
  if (trimmed !== configuredRedirectUri) {
    throw clientError("INVALID_REDIRECT_URI", "redirectUri does not match configuration", {
      fieldName: "redirectUri",
    });
  }
  return trimmed;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? null : String(value);
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lower) {
      return headers[key] == null ? null : String(headers[key]);
    }
  }
  return null;
}

function isJsonContentType(contentType) {
  if (typeof contentType !== "string" || !contentType.trim()) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

async function readBoundedText(
  response,
  maxBytes,
  invalidCode = "INVALID_TIKTOK_RESPONSE"
) {
  const contentLengthHeader = getHeader(response?.headers, "content-length");
  if (contentLengthHeader != null && contentLengthHeader !== "") {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw clientError(invalidCode, "TikTok token response exceeds size limit");
    }
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel failure
          }
          throw clientError(
            invalidCode,
            "TikTok token response exceeds size limit"
          );
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // ignore
      }
    }
    if (chunks.length === 0) return "";
    const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return merged.toString("utf8");
  }

  if (typeof response?.text !== "function") {
    throw clientError(invalidCode, "TikTok token response body is unavailable");
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw clientError(invalidCode, "TikTok token response body is unreadable");
  }
  if (typeof text !== "string") {
    throw clientError(invalidCode, "TikTok token response body is unreadable");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw clientError(invalidCode, "TikTok token response exceeds size limit");
  }
  return text;
}

function parseJsonObject(text, invalidCode = "INVALID_TIKTOK_RESPONSE") {
  if (typeof text !== "string" || !text.trim()) {
    throw clientError(invalidCode, "TikTok token response body is empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw clientError(invalidCode, "TikTok token response is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw clientError(invalidCode, "TikTok token response is not a JSON object");
  }
  return parsed;
}

function mapTikTokErrorSlug(errorSlug, status) {
  const slug =
    typeof errorSlug === "string" ? errorSlug.trim().toLowerCase() : "";

  if (status === 429) return "TIKTOK_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "TIKTOK_SERVICE_UNAVAILABLE";

  if (slug === "invalid_grant") return "AUTHORIZATION_CODE_INVALID";
  if (slug === "access_denied") return "AUTHORIZATION_CODE_INVALID";
  if (slug === "invalid_request" && status === 400) {
    // TikTok may use invalid_request for expired/used codes; keep generic fallback
    // unless slug is more specific. Prefer stable generic classification.
    return "TOKEN_EXCHANGE_FAILED";
  }
  if (slug.includes("redirect_uri") || slug === "redirect_uri_mismatch") {
    return "INVALID_REDIRECT_URI";
  }
  if (slug.includes("expired")) return "AUTHORIZATION_CODE_EXPIRED";

  return "TOKEN_EXCHANGE_FAILED";
}

/** Refresh-path mapping: invalid grants mean reauthorization, not code errors. */
function mapTikTokRefreshErrorSlug(errorSlug, status) {
  const slug =
    typeof errorSlug === "string" ? errorSlug.trim().toLowerCase() : "";

  if (status === 429) return "TIKTOK_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "TIKTOK_SERVICE_UNAVAILABLE";

  if (
    slug === "invalid_grant" ||
    slug === "access_denied" ||
    slug === "invalid_token" ||
    slug === "unauthorized_client"
  ) {
    return "TIKTOK_REAUTHORIZATION_REQUIRED";
  }
  if (slug.includes("expired") || slug.includes("revoked")) {
    return "TIKTOK_REAUTHORIZATION_REQUIRED";
  }

  return "TIKTOK_REFRESH_FAILED";
}

function extractSafeErrorSlug(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = body.error;
  if (typeof error !== "string") return null;
  const slug = error.trim();
  if (!slug || slug.length > 64) return null;
  if (!/^[a-z0-9_.-]+$/i.test(slug)) return null;
  return slug;
}

function throwForNonSuccess(status, body) {
  const slug = extractSafeErrorSlug(body);
  const code = mapTikTokErrorSlug(slug, status);
  throw clientError(code, "TikTok token exchange failed", {
    reason: slug || `http_${status || 0}`,
  });
}

function throwForRefreshNonSuccess(status, body) {
  const slug = extractSafeErrorSlug(body);
  const code = mapTikTokRefreshErrorSlug(slug, status);
  throw clientError(code, "TikTok token refresh failed", {
    reason: slug || `http_${status || 0}`,
  });
}

function requireNonEmptyString(
  value,
  fieldName,
  maxLen,
  invalidCode = "INVALID_TIKTOK_RESPONSE"
) {
  if (typeof value !== "string") {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName,
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName,
    });
  }
  return trimmed;
}

function normalizeTokenType(value, invalidCode = "INVALID_TIKTOK_RESPONSE") {
  if (typeof value !== "string" || !value.trim()) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName: "token_type",
    });
  }
  if (value.trim().toLowerCase() !== "bearer") {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName: "token_type",
    });
  }
  return "Bearer";
}

function normalizePositiveDurationSeconds(
  value,
  fieldName,
  maxSeconds,
  invalidCode = "INVALID_TIKTOK_RESPONSE"
) {
  if (typeof value === "string" && value.trim() !== "") {
    if (!/^[0-9]+$/.test(value.trim())) {
      throw clientError(invalidCode, "TikTok token response is invalid", {
        fieldName,
      });
    }
    value = Number(value.trim());
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName,
    });
  }
  if (value < 1 || value > maxSeconds) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName,
    });
  }
  return value;
}

function normalizeGrantedScopes(
  scopeValue,
  invalidCode = "INVALID_TIKTOK_RESPONSE"
) {
  if (typeof scopeValue !== "string" || !scopeValue.trim()) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName: "scope",
    });
  }
  if (scopeValue.length > SCOPE_RAW_MAX) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName: "scope",
    });
  }
  const parts = scopeValue.split(",");
  const seen = new Set();
  const scopes = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const scope = part.trim();
    if (!scope) continue;
    if (scope.length > SCOPE_ENTRY_MAX) {
      throw clientError(invalidCode, "TikTok token response is invalid", {
        fieldName: "scope",
      });
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  scopes.sort();
  if (scopes.length === 0 || scopes.length > SCOPES_MAX_COUNT) {
    throw clientError(invalidCode, "TikTok token response is invalid", {
      fieldName: "scope",
    });
  }
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw clientError(
      invalidCode,
      "TikTok token response is missing required scope",
      { fieldName: "scope" }
    );
  }
  return scopes;
}

function normalizeSuccessTokenPayload(
  body,
  nowIso,
  invalidCode = "INVALID_TIKTOK_RESPONSE"
) {
  const openId = requireNonEmptyString(
    body.open_id,
    "open_id",
    OPEN_ID_MAX,
    invalidCode
  );
  // Preserve opaque open_id without lowercasing (only outer trim).
  const accessToken = requireNonEmptyString(
    body.access_token,
    "access_token",
    TOKEN_MAX,
    invalidCode
  );
  const refreshToken = requireNonEmptyString(
    body.refresh_token,
    "refresh_token",
    TOKEN_MAX,
    invalidCode
  );
  const tokenType = normalizeTokenType(body.token_type, invalidCode);
  const expiresIn = normalizePositiveDurationSeconds(
    body.expires_in,
    "expires_in",
    MAX_EXPIRES_IN_SECONDS,
    invalidCode
  );
  const refreshExpiresIn = normalizePositiveDurationSeconds(
    body.refresh_expires_in,
    "refresh_expires_in",
    MAX_REFRESH_EXPIRES_IN_SECONDS,
    invalidCode
  );
  const scopes = normalizeGrantedScopes(body.scope, invalidCode);

  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw clientError("INVALID_OAUTH_REQUEST", "now is invalid", {
      fieldName: "now",
    });
  }

  return {
    openId,
    accessToken,
    refreshToken,
    tokenType,
    scopes,
    accessTokenExpiresAt: new Date(nowMs + expiresIn * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      nowMs + refreshExpiresIn * 1000
    ).toISOString(),
    expiresIn,
    refreshExpiresIn,
  };
}

/**
 * Exchange a TikTok authorization code for tokens (memory-only result).
 */
async function exchangeCodeClipTikTokAuthorizationCode(
  { code, redirectUri, environment, now } = {},
  { env = process.env, fetchImpl = global.fetch, timeoutMs } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw clientError(
      "TOKEN_EXCHANGE_FAILED",
      "TikTok token exchange is unavailable"
    );
  }

  const config = loadTokenExchangeConfig(env, environment);
  const authorizationCode = normalizeAuthorizationCode(code);
  const matchedRedirectUri = normalizeCallerRedirectUri(
    redirectUri,
    config.redirectUri
  );
  const operationNowIso = normalizeInjectedNow(now);
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);

  const body = new URLSearchParams({
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code: authorizationCode,
    grant_type: "authorization_code",
    redirect_uri: matchedRedirectUri,
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, effectiveTimeoutMs);

  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      /aborted|abort/i.test(String(error?.message || ""))
    ) {
      throw clientError(
        "TOKEN_EXCHANGE_FAILED",
        "TikTok token exchange timed out"
      );
    }
    throw clientError(
      "TOKEN_EXCHANGE_FAILED",
      "TikTok token exchange unavailable"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response !== "object") {
    throw clientError(
      "TOKEN_EXCHANGE_FAILED",
      "TikTok token exchange failed"
    );
  }

  const status = Number(response.status || 0);
  if (status >= 300 && status < 400) {
    throw clientError(
      "TOKEN_EXCHANGE_FAILED",
      "TikTok token exchange failed",
      { reason: "unexpected_redirect" }
    );
  }

  const contentType = getHeader(response.headers, "content-type");
  if (!isJsonContentType(contentType)) {
    // Still drain body boundedly when possible, then fail closed.
    try {
      await readBoundedText(response, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof CodeClipTikTokOAuthClientError) throw error;
    }
    throw clientError(
      "INVALID_TIKTOK_RESPONSE",
      "TikTok token response content type is invalid"
    );
  }

  const text = await readBoundedText(response, MAX_BODY_BYTES);

  let parsedBody = null;
  try {
    parsedBody = parseJsonObject(text);
  } catch (error) {
    if (status < 200 || status >= 300) {
      throw clientError(
        mapTikTokErrorSlug(null, status),
        "TikTok token exchange failed",
        { reason: `http_${status || 0}` }
      );
    }
    throw error;
  }

  if (status < 200 || status >= 300) {
    throwForNonSuccess(status, parsedBody);
  }

  return normalizeSuccessTokenPayload(parsedBody, operationNowIso);
}

/**
 * Refresh TikTok access (and rotated refresh) tokens (memory-only result).
 * Does not require redirect URI. Does not compare open_id to credentials.
 */
async function refreshCodeClipTikTokAccessToken(
  { refreshToken, environment, now } = {},
  { env = process.env, fetchImpl = global.fetch, timeoutMs } = {}
) {
  const invalidCode = "INVALID_TIKTOK_REFRESH_RESPONSE";

  if (typeof fetchImpl !== "function") {
    throw clientError(
      "TIKTOK_REFRESH_FAILED",
      "TikTok token refresh is unavailable"
    );
  }

  const config = loadTokenRefreshConfig(env, environment);
  const normalizedRefreshToken = normalizeRefreshTokenInput(refreshToken);
  const operationNowIso = normalizeInjectedNow(now);
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);

  const body = new URLSearchParams({
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: normalizedRefreshToken,
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, effectiveTimeoutMs);

  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      /aborted|abort/i.test(String(error?.message || ""))
    ) {
      throw clientError(
        "TIKTOK_REFRESH_FAILED",
        "TikTok token refresh timed out"
      );
    }
    throw clientError(
      "TIKTOK_REFRESH_FAILED",
      "TikTok token refresh unavailable"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response !== "object") {
    throw clientError("TIKTOK_REFRESH_FAILED", "TikTok token refresh failed");
  }

  const status = Number(response.status || 0);
  if (status >= 300 && status < 400) {
    throw clientError("TIKTOK_REFRESH_FAILED", "TikTok token refresh failed", {
      reason: "unexpected_redirect",
    });
  }

  const contentType = getHeader(response.headers, "content-type");
  if (!isJsonContentType(contentType)) {
    try {
      await readBoundedText(response, MAX_BODY_BYTES, invalidCode);
    } catch (error) {
      if (error instanceof CodeClipTikTokOAuthClientError) throw error;
    }
    throw clientError(
      invalidCode,
      "TikTok token response content type is invalid"
    );
  }

  const text = await readBoundedText(response, MAX_BODY_BYTES, invalidCode);

  let parsedBody = null;
  try {
    parsedBody = parseJsonObject(text, invalidCode);
  } catch (error) {
    if (status < 200 || status >= 300) {
      throw clientError(
        mapTikTokRefreshErrorSlug(null, status),
        "TikTok token refresh failed",
        { reason: `http_${status || 0}` }
      );
    }
    throw error;
  }

  if (status < 200 || status >= 300) {
    throwForRefreshNonSuccess(status, parsedBody);
  }

  // Response refresh_token is required (rotation contract); never fall back to input.
  return normalizeSuccessTokenPayload(parsedBody, operationNowIso, invalidCode);
}

module.exports = {
  CodeClipTikTokOAuthClientError,
  exchangeCodeClipTikTokAuthorizationCode,
  refreshCodeClipTikTokAccessToken,
};
