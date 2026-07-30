/**
 * B11.2D Meta Messenger Graph Transport
 *
 * Isolated transport for inbound-triggered codeClip Meta Messenger reward_link
 * responses only (live Messenger, PSID recipient from inbound, durable snapshot).
 *
 * Not a general-purpose / proactive Messenger send client.
 * No claim, record, DB, Redis, worker, or retry loop.
 */

const PROVIDER = "meta";
const CHANNEL = "messenger";
const DEFAULT_GRAPH_API_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 256;
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 3_600;
const GRAPH_API_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;
const FORBIDDEN_BUILDER_INPUT_KEYS = new Set([
  "messaging_type",
  "messagingType",
  "messageTag",
  "tag",
  "endpoint",
  "Authorization",
  "authorization",
  "access_token",
  "accessToken",
  "pageAccessToken",
  "page_access_token",
  "Bearer",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function transportError(reason, details = {}) {
  return { ok: false, reason, details };
}

function isDeliverableHttpsUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function maskIdentifier(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
}

function normalizeTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    return null;
  }
  return parsed;
}

function normalizeGraphApiVersion(value) {
  const normalized = normalizeString(value);
  if (!normalized) return transportError("GRAPH_API_VERSION_REQUIRED");
  if (!GRAPH_API_VERSION_PATTERN.test(normalized)) {
    return transportError("GRAPH_API_VERSION_INVALID");
  }
  return { ok: true, graphApiVersion: normalized };
}

function normalizeGraphApiBaseUrl(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, baseUrl: DEFAULT_GRAPH_API_BASE_URL };
  }
  const normalized = normalizeString(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") {
      return transportError("GRAPH_API_BASE_URL_INVALID");
    }
    if (parsed.username || parsed.password) {
      return transportError("GRAPH_API_BASE_URL_INVALID");
    }
    // strip trailing slash
    const href = parsed.toString().replace(/\/+$/, "");
    return { ok: true, baseUrl: href };
  } catch {
    return transportError("GRAPH_API_BASE_URL_INVALID");
  }
}

function rejectForbiddenBuilderFields(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return transportError("TRANSPORT_INPUT_INVALID");
  }
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_BUILDER_INPUT_KEYS.has(key)) {
      if (key === "messaging_type" || key === "messagingType") {
        return transportError("MESSAGING_TYPE_OVERRIDE_FORBIDDEN", { field: key });
      }
      return transportError("FORBIDDEN_TRANSPORT_FIELD", { field: key });
    }
  }
  return { ok: true };
}

function buildRewardLinkMessageText(deliverable = {}) {
  const metadata =
    deliverable.metadata && typeof deliverable.metadata === "object" && !Array.isArray(deliverable.metadata)
      ? deliverable.metadata
      : {};
  const title = normalizeString(metadata.title);
  const displayTier = normalizeString(metadata.displayTier);
  const rewardTier = normalizeString(deliverable.rewardTier);
  const label = title || displayTier || rewardTier || "Reward";
  const url = normalizeString(deliverable.url);
  return `${label}\n${url}`;
}

/**
 * Pure request builder for inbound-triggered Meta Messenger reward_link responses.
 * Does not accept or embed page access tokens.
 */
function buildMetaMessengerGraphSendRequest(input = {}) {
  const forbidden = rejectForbiddenBuilderFields(input);
  if (!forbidden.ok) return forbidden;

  const providerAccountId = normalizeString(input.providerAccountId);
  const recipientId = normalizeString(input.recipientId);
  const deliverable = input.deliverable;

  if (!providerAccountId || providerAccountId.length > MAX_IDENTIFIER_LENGTH) {
    return transportError("PROVIDER_ACCOUNT_ID_REQUIRED");
  }
  if (!recipientId || recipientId.length > MAX_IDENTIFIER_LENGTH) {
    return transportError("RECIPIENT_ID_REQUIRED");
  }
  if (!deliverable || typeof deliverable !== "object" || Array.isArray(deliverable)) {
    return transportError("DELIVERABLE_REQUIRED");
  }

  const deliverableType = normalizeString(deliverable.type).toLowerCase();
  if (deliverableType !== "reward_link") {
    return transportError("DELIVERABLE_TYPE_UNSUPPORTED");
  }
  if (!normalizeString(deliverable.rewardTier)) {
    return transportError("REWARD_TIER_REQUIRED");
  }
  if (!isDeliverableHttpsUrl(deliverable.url)) {
    return transportError("REWARD_URL_INVALID");
  }

  const version = normalizeGraphApiVersion(input.graphApiVersion);
  if (!version.ok) return version;

  const base = normalizeGraphApiBaseUrl(input.graphApiBaseUrl);
  if (!base.ok) return base;

  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return transportError("TIMEOUT_MS_INVALID");
  }

  const pageIdEncoded = encodeURIComponent(providerAccountId);
  const url = `${base.baseUrl}/${version.graphApiVersion}/${pageIdEncoded}/messages`;

  return {
    ok: true,
    request: {
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        recipient: {
          id: recipientId,
        },
        // Fixed for inbound-triggered Messenger RESPONSE only — not caller-overridable.
        messaging_type: "RESPONSE",
        message: {
          text: buildRewardLinkMessageText(deliverable),
        },
      },
      timeoutMs,
      safeMeta: {
        provider: PROVIDER,
        channel: CHANNEL,
        graphApiVersion: version.graphApiVersion,
        providerAccountIdMasked: maskIdentifier(providerAccountId),
        recipientIdMasked: maskIdentifier(recipientId),
        deliverableType: "reward_link",
        messagingType: "RESPONSE",
        timeoutMs,
      },
    },
  };
}

function failureResult({
  outcome,
  httpStatus = 0,
  failureCode,
  retryable,
  safeMetadata = {},
}) {
  return {
    ok: false,
    outcome,
    provider: PROVIDER,
    channel: CHANNEL,
    httpStatus,
    providerMessageId: null,
    retryable: Boolean(retryable),
    terminal: !retryable,
    failureCode,
    safeMetadata: {
      ...safeMetadata,
    },
  };
}

function successResult({ httpStatus, providerMessageId, safeMetadata = {} }) {
  return {
    ok: true,
    outcome: "sent",
    provider: PROVIDER,
    channel: CHANNEL,
    httpStatus,
    providerMessageId,
    retryable: false,
    terminal: true,
    failureCode: null,
    safeMetadata: {
      ...safeMetadata,
    },
  };
}

function parseRetryAfterSeconds(headerValue, nowMs = Date.now()) {
  const raw = normalizeString(headerValue);
  if (!raw) return null;

  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds || RETRY_AFTER_MIN_SECONDS));
  }

  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  const deltaSeconds = Math.ceil((dateMs - nowMs) / 1000);
  if (!Number.isFinite(deltaSeconds)) return null;
  if (deltaSeconds <= 0) return RETRY_AFTER_MIN_SECONDS;
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, deltaSeconds));
}

function extractSafeMetaErrorFields(errorObject) {
  if (!errorObject || typeof errorObject !== "object" || Array.isArray(errorObject)) {
    return {};
  }
  const safe = {};
  if (Number.isFinite(Number(errorObject.code))) {
    safe.metaErrorCode = Number(errorObject.code);
  }
  if (Number.isFinite(Number(errorObject.error_subcode))) {
    safe.metaErrorSubcode = Number(errorObject.error_subcode);
  }
  const type = normalizeString(errorObject.type);
  if (type) safe.metaErrorType = type;
  if (typeof errorObject.is_transient === "boolean") {
    safe.metaIsTransient = errorObject.is_transient;
  }
  const fbtraceId = normalizeString(errorObject.fbtrace_id);
  if (fbtraceId) safe.fbtraceId = fbtraceId;
  return safe;
}

function normalizeProviderMessageId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

async function readJsonBody(response) {
  if (!response || typeof response.json !== "function") {
    return { ok: false, reason: "RESPONSE_JSON_UNAVAILABLE", body: null };
  }
  try {
    const body = await response.json();
    return { ok: true, body };
  } catch {
    return { ok: false, reason: "RESPONSE_JSON_MALFORMED", body: null };
  }
}

function classifyHttpFailure(status, body, headers, durationMs) {
  const safeMetadata = { durationMs };
  const errorObject =
    body && typeof body === "object" && !Array.isArray(body) && body.error && typeof body.error === "object"
      ? body.error
      : null;
  Object.assign(safeMetadata, extractSafeMetaErrorFields(errorObject));

  const retryAfter = headers?.get?.("retry-after") || headers?.get?.("Retry-After");
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
  if (retryAfterSeconds !== null) {
    safeMetadata.retryAfterSeconds = retryAfterSeconds;
  }

  if (status >= 300 && status < 400) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: status,
      failureCode: "graph_unexpected_redirect",
      retryable: false,
      safeMetadata,
    });
  }

  if (errorObject && errorObject.is_transient === true) {
    return failureResult({
      outcome: "retryable_failed",
      httpStatus: status,
      failureCode: "graph_transient",
      retryable: true,
      safeMetadata,
    });
  }

  if (status === 408) {
    return failureResult({
      outcome: "retryable_failed",
      httpStatus: status,
      failureCode: "graph_timeout",
      retryable: true,
      safeMetadata,
    });
  }
  if (status === 429) {
    return failureResult({
      outcome: "retryable_failed",
      httpStatus: status,
      failureCode: "graph_rate_limited",
      retryable: true,
      safeMetadata,
    });
  }
  if (status >= 500 && status <= 599) {
    return failureResult({
      outcome: "retryable_failed",
      httpStatus: status,
      failureCode: "graph_server_error",
      retryable: true,
      safeMetadata,
    });
  }
  if (status === 401) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: status,
      failureCode: "graph_unauthorized",
      retryable: false,
      safeMetadata,
    });
  }
  if (status === 403) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: status,
      failureCode: "graph_forbidden",
      retryable: false,
      safeMetadata,
    });
  }
  if (status === 400) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: status,
      failureCode: "graph_bad_request",
      retryable: false,
      safeMetadata,
    });
  }

  // Other 4xx: terminal by default
  if (status >= 400 && status < 500) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: status,
      failureCode: "graph_client_error",
      retryable: false,
      safeMetadata,
    });
  }

  return failureResult({
    outcome: "terminal_failed",
    httpStatus: status,
    failureCode: "graph_http_error",
    retryable: false,
    safeMetadata,
  });
}

/**
 * Executes a single Graph send attempt for an inbound-triggered Messenger reward response.
 * pageAccessToken is accepted only here and is never returned.
 */
async function executeMetaMessengerGraphSend({
  request,
  pageAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  const token = typeof pageAccessToken === "string" ? pageAccessToken.trim() : "";
  if (!token) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "PAGE_ACCESS_TOKEN_REQUIRED",
      retryable: false,
      safeMetadata: {},
    });
  }

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "TRANSPORT_REQUEST_INVALID",
      retryable: false,
      safeMetadata: {},
    });
  }
  if (request.method !== "POST" || typeof request.url !== "string" || !request.url) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "TRANSPORT_REQUEST_INVALID",
      retryable: false,
      safeMetadata: {},
    });
  }
  if (!request.body || typeof request.body !== "object") {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "TRANSPORT_REQUEST_INVALID",
      retryable: false,
      safeMetadata: {},
    });
  }
  if (typeof fetchImpl !== "function") {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "FETCH_UNAVAILABLE",
      retryable: false,
      safeMetadata: {},
    });
  }

  const effectiveTimeout = normalizeTimeoutMs(
    timeoutMs !== undefined ? timeoutMs : request.timeoutMs,
    DEFAULT_TIMEOUT_MS
  );
  if (effectiveTimeout === null) {
    return failureResult({
      outcome: "terminal_failed",
      httpStatus: 0,
      failureCode: "TIMEOUT_MS_INVALID",
      retryable: false,
      safeMetadata: {},
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request.body),
      redirect: "manual",
      signal: controller.signal,
    });

    const durationMs = Math.max(0, Date.now() - startedAt);
    const status = Number(response?.status || 0);

    if (status >= 300 && status < 400) {
      return classifyHttpFailure(status, null, response?.headers, durationMs);
    }

    const parsed = await readJsonBody(response);

    if (status >= 200 && status < 300) {
      if (!parsed.ok || parsed.body === null || parsed.body === undefined) {
        return failureResult({
          outcome: "terminal_failed",
          httpStatus: status,
          failureCode: "graph_success_unconfirmed",
          retryable: false,
          safeMetadata: { durationMs },
        });
      }
      if (typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return failureResult({
          outcome: "terminal_failed",
          httpStatus: status,
          failureCode: "graph_success_unconfirmed",
          retryable: false,
          safeMetadata: { durationMs },
        });
      }
      const providerMessageId = normalizeProviderMessageId(parsed.body.message_id);
      if (!providerMessageId) {
        return failureResult({
          outcome: "terminal_failed",
          httpStatus: status,
          failureCode: "graph_success_unconfirmed",
          retryable: false,
          safeMetadata: { durationMs },
        });
      }
      return successResult({
        httpStatus: status,
        providerMessageId,
        safeMetadata: { durationMs },
      });
    }

    return classifyHttpFailure(
      status,
      parsed.ok ? parsed.body : null,
      response?.headers,
      durationMs
    );
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (error?.name === "AbortError") {
      return failureResult({
        outcome: "retryable_failed",
        httpStatus: 0,
        failureCode: "graph_timeout",
        retryable: true,
        safeMetadata: { durationMs },
      });
    }
    return failureResult({
      outcome: "retryable_failed",
      httpStatus: 0,
      failureCode: "graph_network_error",
      retryable: true,
      safeMetadata: { durationMs },
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CHANNEL,
  DEFAULT_GRAPH_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  PROVIDER,
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  buildMetaMessengerGraphSendRequest,
  executeMetaMessengerGraphSend,
};
