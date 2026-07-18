const YOUTUBE_WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LEASE_SECONDS = 60 * 60 * 24 * 30;

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

async function requestSubscription({
  mode,
  callbackUrl,
  topic,
  secret,
  leaseSeconds,
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
      return {
        ok: false,
        code: "hub_request_failed",
        status: response?.status || 0,
        mode: normalizedMode,
      };
    }

    return {
      ok: true,
      code: "hub_request_accepted",
      status: response.status,
      mode: normalizedMode,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        code: "hub_request_timeout",
        status: 0,
        mode: normalizedMode,
      };
    }
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
