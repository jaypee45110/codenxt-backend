const YOUTUBE_WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LEASE_SECONDS = 60 * 60 * 24 * 30;
const HUB_REQUEST_EVENT_NAME = "codeclip_youtube_websub_hub_request";
const HUB_REQUEST_CONTENT_TYPE = "application/x-www-form-urlencoded";
const HUB_REQUEST_VERIFY_MODE = "async";

class CodeClipYouTubeWebSubHubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubHubError";
    this.code = code;
    this.details = details;
  }
}

function hubError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubHubError(code, message, details);
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!["subscribe", "unsubscribe"].includes(mode)) {
    throw hubError("INVALID_HUB_REQUEST", "YouTube WebSub mode is invalid", {
      fieldName: "mode",
    });
  }
  return mode;
}

function normalizeHttpsUrl(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw hubError("INVALID_HUB_REQUEST", `${fieldName} is required`, { fieldName });
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw hubError("INVALID_HUB_REQUEST", `${fieldName} must be a valid HTTPS URL`, {
      fieldName,
    });
  }
  if (parsed.protocol !== "https:") {
    throw hubError("INVALID_HUB_REQUEST", `${fieldName} must be a valid HTTPS URL`, {
      fieldName,
    });
  }
  return parsed.toString();
}

function normalizeSecret(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw hubError("INVALID_HUB_REQUEST", "hub secret is required", { fieldName: "secret" });
  }
  return value.trim();
}

function normalizeLeaseSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw hubError("INVALID_HUB_REQUEST", "leaseSeconds must be a positive integer", {
      fieldName: "leaseSeconds",
    });
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LEASE_SECONDS) {
    throw hubError("INVALID_HUB_REQUEST", "leaseSeconds must be a positive integer", {
      fieldName: "leaseSeconds",
      max: MAX_LEASE_SECONDS,
    });
  }
  return parsed;
}

function isSuccessfulHubStatus(status) {
  return status >= 200 && status < 300;
}

function isRedirectHubStatus(status) {
  return status >= 300 && status < 400;
}

function isRetryableHubStatus(status) {
  if (status === 0 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}

function maskHubRequestIdentifier(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (normalized.startsWith("attempt_")) return `attempt...${normalized.slice(-4)}`;
  if (normalized.length <= 8) return `${normalized.slice(0, 1)}...${normalized.slice(-1)}`;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function sanitizeCallbackPath(callbackUrl) {
  try {
    const parsed = new URL(callbackUrl);
    const segments = parsed.pathname.split("/");
    const callbackId = segments.pop() || "";
    segments.push(maskHubRequestIdentifier(callbackId));
    return segments.join("/");
  } catch {
    return null;
  }
}

function getCallbackHost(callbackUrl) {
  try {
    return new URL(callbackUrl).host;
  } catch {
    return null;
  }
}

function getHeaderValue(headers, name) {
  try {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      return value === undefined || value === null ? null : String(value);
    }
    const key = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === String(name || "").toLowerCase()
    );
    return key ? String(headers[key]) : null;
  } catch {
    return null;
  }
}

function getLocationHost(headers) {
  const location = getHeaderValue(headers, "location");
  if (!location) return null;
  try {
    return new URL(location).host;
  } catch {
    return null;
  }
}

function normalizeResponseContentLength(headers) {
  const value = getHeaderValue(headers, "content-length");
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeResponseContentType(headers) {
  const value = getHeaderValue(headers, "content-type");
  const normalized = String(value || "").split(";")[0].trim().toLowerCase();
  return normalized || null;
}

function buildHubRequestSnapshot({
  operationMode,
  hubMode,
  callbackUrl,
  topic,
  leaseSeconds,
  hasSecret,
  attemptNumber,
  attemptId,
}) {
  return Object.freeze({
    eventName: HUB_REQUEST_EVENT_NAME,
    timestamp: new Date().toISOString(),
    operationMode: String(operationMode || hubMode || "").trim().toLowerCase() || null,
    hubMode,
    hubEndpoint: YOUTUBE_WEBSUB_HUB_URL,
    method: "POST",
    contentType: HUB_REQUEST_CONTENT_TYPE,
    topic,
    callbackHost: getCallbackHost(callbackUrl),
    callbackPath: sanitizeCallbackPath(callbackUrl),
    verifyMode: HUB_REQUEST_VERIFY_MODE,
    leaseSeconds: Number.isSafeInteger(leaseSeconds) ? leaseSeconds : null,
    hasSecret: Boolean(hasSecret),
    attemptNumber: Number.isSafeInteger(attemptNumber) ? attemptNumber : null,
    attemptId: maskHubRequestIdentifier(attemptId),
  });
}

function logHubRequest(snapshot, phase, fields = {}) {
  try {
    console.log("codeClip YouTube WebSub Hub request", {
      ...snapshot,
      phase,
      ...fields,
    });
  } catch {
    // Observability must never alter Hub request semantics.
  }
}

function getHubRequestDurationMs(startedAt) {
  const duration = Date.now() - startedAt;
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : 0;
}

async function requestSubscription({
  mode,
  operationMode,
  callbackUrl,
  topic,
  secret,
  leaseSeconds,
  attemptNumber,
  attemptId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const normalizedCallbackUrl = normalizeHttpsUrl(callbackUrl, "callbackUrl");
  const normalizedTopic = normalizeHttpsUrl(topic, "topic");
  const normalizedSecret = normalizeSecret(secret);
  const normalizedLeaseSeconds = normalizeLeaseSeconds(leaseSeconds);

  if (normalizedMode === "subscribe" && !normalizedLeaseSeconds) {
    throw hubError("INVALID_HUB_REQUEST", "leaseSeconds is required for subscribe", {
      fieldName: "leaseSeconds",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw hubError("HUB_CLIENT_UNAVAILABLE", "fetch implementation is unavailable");
  }

  const body = new URLSearchParams();
  body.set("hub.callback", normalizedCallbackUrl);
  body.set("hub.mode", normalizedMode);
  body.set("hub.topic", normalizedTopic);
  body.set("hub.verify", "async");
  body.set("hub.secret", normalizedSecret);
  if (normalizedMode === "subscribe") {
    body.set("hub.lease_seconds", String(normalizedLeaseSeconds));
  }

  const snapshot = buildHubRequestSnapshot({
    operationMode,
    hubMode: normalizedMode,
    callbackUrl: normalizedCallbackUrl,
    topic: normalizedTopic,
    leaseSeconds: normalizedLeaseSeconds,
    hasSecret: Boolean(normalizedSecret),
    attemptNumber,
    attemptId,
  });
  const startedAt = Date.now();
  logHubRequest(snapshot, "request_started");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(YOUTUBE_WEBSUB_HUB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (!isSuccessfulHubStatus(response?.status)) {
      const status = response?.status || 0;
      const redirected = isRedirectHubStatus(status);
      logHubRequest(snapshot, "request_completed", {
        completion: "finish",
        statusCode: status,
        outcome: redirected ? "redirected" : "rejected",
        durationMs: getHubRequestDurationMs(startedAt),
        redirected,
        locationHost: getLocationHost(response?.headers),
        responseContentType: normalizeResponseContentType(response?.headers),
        responseContentLength: normalizeResponseContentLength(response?.headers),
        resultCode: "hub_request_failed",
        retryEligible: isRetryableHubStatus(status),
      });
      return {
        ok: false,
        code: "hub_request_failed",
        status,
        mode: normalizedMode,
      };
    }

    logHubRequest(snapshot, "request_completed", {
      completion: "finish",
      statusCode: response.status,
      outcome: "accepted",
      durationMs: getHubRequestDurationMs(startedAt),
      redirected: false,
      locationHost: getLocationHost(response?.headers),
      responseContentType: normalizeResponseContentType(response?.headers),
      responseContentLength: normalizeResponseContentLength(response?.headers),
      resultCode: "hub_request_accepted",
      retryEligible: false,
    });
    return {
      ok: true,
      code: "hub_request_accepted",
      status: response.status,
      mode: normalizedMode,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      logHubRequest(snapshot, "request_failed", {
        outcome: "failed",
        durationMs: getHubRequestDurationMs(startedAt),
        errorClass: "timeout",
        resultCode: "hub_request_timeout",
        retryEligible: true,
      });
      return {
        ok: false,
        code: "hub_request_timeout",
        status: 0,
        mode: normalizedMode,
      };
    }
    logHubRequest(snapshot, "request_failed", {
      outcome: "failed",
      durationMs: getHubRequestDurationMs(startedAt),
      errorClass: "network_error",
      resultCode: "hub_request_failed",
      retryEligible: true,
    });
    return {
      ok: false,
      code: "hub_request_failed",
      status: 0,
      mode: normalizedMode,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CodeClipYouTubeWebSubHubError,
  YOUTUBE_WEBSUB_HUB_URL,
  requestSubscription,
};
