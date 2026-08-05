/**
 * TikTok Display API List Videos client (COAS35 F2C1).
 *
 * Isolated HTTP client for fetching one page of public TikTok videos.
 * No polling, checkpoints, credentials persistence, bindings, routes, or DB.
 */

const DISPLAY_LIST_ENDPOINT = "https://open.tiktokapis.com/v2/video/list/";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

const ACCESS_TOKEN_MAX = 4096;
const VIDEO_ID_MAX = 256;
const TITLE_MAX = 150;
const URL_MAX = 2048;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

const DEFAULT_FIELDS = Object.freeze([
  "id",
  "create_time",
  "share_url",
  "title",
  "duration",
]);
const FIELD_ALLOWLIST = new Set(DEFAULT_FIELDS);
const REQUIRED_FIELDS = new Set(["id", "create_time"]);
const SAFE_DETAIL_KEYS = new Set(["fieldName", "reason"]);

class CodeClipTikTokDisplayClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokDisplayClientError";
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
  return new CodeClipTikTokDisplayClientError(code, message, details);
}

function normalizeAccessToken(accessToken) {
  if (typeof accessToken !== "string") {
    throw clientError("ACCESS_TOKEN_REQUIRED", "TikTok access token is required", {
      fieldName: "accessToken",
    });
  }
  const trimmed = accessToken.trim();
  if (!trimmed || trimmed.length > ACCESS_TOKEN_MAX) {
    throw clientError("ACCESS_TOKEN_REQUIRED", "TikTok access token is required", {
      fieldName: "accessToken",
    });
  }
  return trimmed;
}

function normalizeTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) {
    throw clientError("INVALID_DISPLAY_REQUEST", "timeoutMs is invalid", {
      fieldName: "timeoutMs",
    });
  }
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw clientError("INVALID_DISPLAY_REQUEST", "timeoutMs is invalid", {
      fieldName: "timeoutMs",
    });
  }
  return timeoutMs;
}

function normalizeMaxCount(maxCount) {
  if (maxCount === undefined) return 20;
  if (
    typeof maxCount !== "number" ||
    !Number.isInteger(maxCount) ||
    !Number.isSafeInteger(maxCount)
  ) {
    throw clientError("INVALID_DISPLAY_REQUEST", "maxCount is invalid", {
      fieldName: "maxCount",
    });
  }
  if (maxCount < 1 || maxCount > 20) {
    throw clientError("INVALID_DISPLAY_REQUEST", "maxCount is invalid", {
      fieldName: "maxCount",
    });
  }
  return maxCount;
}

function normalizeCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "number" ||
    !Number.isInteger(cursor) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  ) {
    throw clientError("INVALID_DISPLAY_REQUEST", "cursor is invalid", {
      fieldName: "cursor",
    });
  }
  return cursor;
}

function normalizeFields(fields) {
  if (fields === undefined) return DEFAULT_FIELDS.slice();
  if (!Array.isArray(fields)) {
    throw clientError("INVALID_DISPLAY_REQUEST", "fields are invalid", {
      fieldName: "fields",
    });
  }
  const seen = new Set();
  for (const value of fields) {
    if (typeof value !== "string") {
      throw clientError("INVALID_DISPLAY_REQUEST", "fields are invalid", {
        fieldName: "fields",
      });
    }
    const field = value.trim();
    if (!field || !FIELD_ALLOWLIST.has(field)) {
      throw clientError("INVALID_DISPLAY_REQUEST", "fields are invalid", {
        fieldName: "fields",
      });
    }
    seen.add(field);
  }
  if (!seen.size) {
    throw clientError("INVALID_DISPLAY_REQUEST", "fields are invalid", {
      fieldName: "fields",
    });
  }
  for (const required of REQUIRED_FIELDS) {
    if (!seen.has(required)) {
      throw clientError("INVALID_DISPLAY_REQUEST", "fields are invalid", {
        fieldName: "fields",
      });
    }
  }
  return DEFAULT_FIELDS.filter((field) => seen.has(field));
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

async function readBoundedText(response) {
  const contentLengthHeader = getHeader(response?.headers, "content-length");
  if (contentLengthHeader != null && contentLengthHeader !== "") {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw clientError(
        "INVALID_TIKTOK_DISPLAY_RESPONSE",
        "TikTok Display response exceeds size limit"
      );
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
        if (total > MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel failure
          }
          throw clientError(
            "INVALID_TIKTOK_DISPLAY_RESPONSE",
            "TikTok Display response exceeds size limit"
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
    if (!chunks.length) return "";
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8"
    );
  }

  if (typeof response?.text !== "function") {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response body is unavailable"
    );
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response body is unreadable"
    );
  }
  if (typeof text !== "string") {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response body is unreadable"
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response exceeds size limit"
    );
  }
  return text;
}

function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response body is empty"
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response is not valid JSON"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response is invalid"
    );
  }
  return parsed;
}

function normalizeTikTokErrorCode(value) {
  if (typeof value !== "string") return "";
  const code = value.trim().toLowerCase();
  if (!code || code.length > 80 || !/^[a-z0-9_.-]+$/.test(code)) return "";
  return code;
}

function mapTikTokDisplayError(code, status) {
  if (status === 429) return "TIKTOK_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "TIKTOK_SERVICE_UNAVAILABLE";
  if (status === 401 || code === "access_token_invalid") {
    return "ACCESS_TOKEN_INVALID";
  }
  if (code === "scope_not_authorized" || code === "scope_permission_missed") {
    return "TIKTOK_SCOPE_NOT_AUTHORIZED";
  }
  if (code === "rate_limit_exceeded") return "TIKTOK_RATE_LIMITED";
  if (code === "invalid_params") return "INVALID_DISPLAY_REQUEST";
  if (code === "internal_error") return "TIKTOK_SERVICE_UNAVAILABLE";
  return "TIKTOK_DISPLAY_REQUEST_FAILED";
}

function throwForTikTokFailure(status, body) {
  const tiktokCode = normalizeTikTokErrorCode(body?.error?.code);
  const code = mapTikTokDisplayError(tiktokCode, status);
  throw clientError(code, "TikTok Display request failed", {
    reason: tiktokCode || `http_${status || 0}`,
  });
}

function normalizeRequiredString(value, fieldName, maxLen) {
  if (typeof value !== "string") {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response is invalid",
      { fieldName }
    );
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response is invalid",
      { fieldName }
    );
  }
  return trimmed;
}

function normalizeNonNegativeSafeInteger(value, fieldName) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response is invalid",
      { fieldName }
    );
  }
  return value;
}

function normalizeShareUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > URL_MAX) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeTitle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, TITLE_MAX);
}

function normalizeDuration(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DURATION_SECONDS
  ) {
    return null;
  }
  return value;
}

function normalizeVideo(video) {
  if (!video || typeof video !== "object" || Array.isArray(video)) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display video is invalid"
    );
  }
  return {
    id: normalizeRequiredString(video.id, "id", VIDEO_ID_MAX),
    createTimeSec: normalizeNonNegativeSafeInteger(
      video.create_time,
      "create_time"
    ),
    shareUrl: normalizeShareUrl(video.share_url),
    title: normalizeTitle(video.title),
    duration: normalizeDuration(video.duration),
  };
}

function normalizeSuccessPage(body) {
  if (normalizeTikTokErrorCode(body?.error?.code) !== "ok") {
    throwForTikTokFailure(200, body);
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response data is invalid",
      { fieldName: "data" }
    );
  }
  if (!Array.isArray(data.videos)) {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display videos are invalid",
      { fieldName: "videos" }
    );
  }
  if (typeof data.has_more !== "boolean") {
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display pagination is invalid",
      { fieldName: "has_more" }
    );
  }
  const cursor = normalizeNonNegativeSafeInteger(data.cursor, "cursor");

  const seen = new Map();
  const videos = [];
  for (const rawVideo of data.videos) {
    const video = normalizeVideo(rawVideo);
    const existing = seen.get(video.id);
    if (existing) {
      if (existing.createTimeSec !== video.createTimeSec) {
        throw clientError(
          "INVALID_TIKTOK_DISPLAY_RESPONSE",
          "TikTok Display duplicate video is conflicting",
          { reason: "conflicting_duplicate" }
        );
      }
      continue;
    }
    seen.set(video.id, video);
    videos.push(video);
  }

  return {
    videos,
    cursor,
    hasMore: data.has_more,
  };
}

async function listCodeClipTikTokVideos(
  { accessToken, cursor, maxCount, fields, now } = {},
  { fetchImpl = global.fetch, timeoutMs } = {}
) {
  void now;
  if (typeof fetchImpl !== "function") {
    throw clientError(
      "TIKTOK_DISPLAY_REQUEST_FAILED",
      "TikTok Display request is unavailable"
    );
  }

  const normalizedAccessToken = normalizeAccessToken(accessToken);
  const normalizedMaxCount = normalizeMaxCount(maxCount);
  const normalizedCursor = normalizeCursor(cursor);
  const normalizedFields = normalizeFields(fields);
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);

  const url = new URL(DISPLAY_LIST_ENDPOINT);
  url.searchParams.set("fields", normalizedFields.join(","));

  const requestBody = { max_count: normalizedMaxCount };
  if (normalizedCursor !== undefined) requestBody.cursor = normalizedCursor;

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
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      /aborted|abort|timeout/i.test(String(error?.message || ""))
    ) {
      throw clientError(
        "TIKTOK_DISPLAY_REQUEST_FAILED",
        "TikTok Display request timed out"
      );
    }
    throw clientError(
      "TIKTOK_DISPLAY_REQUEST_FAILED",
      "TikTok Display request unavailable"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response !== "object") {
    throw clientError(
      "TIKTOK_DISPLAY_REQUEST_FAILED",
      "TikTok Display request failed"
    );
  }

  const status = Number(response.status || 0);
  if (status >= 300 && status < 400) {
    throw clientError(
      "TIKTOK_DISPLAY_REQUEST_FAILED",
      "TikTok Display request failed",
      { reason: "unexpected_redirect" }
    );
  }

  const contentType = getHeader(response.headers, "content-type");
  if (!isJsonContentType(contentType)) {
    try {
      await readBoundedText(response);
    } catch (error) {
      if (error instanceof CodeClipTikTokDisplayClientError) throw error;
    }
    throw clientError(
      "INVALID_TIKTOK_DISPLAY_RESPONSE",
      "TikTok Display response content type is invalid"
    );
  }

  const text = await readBoundedText(response);
  let parsedBody;
  try {
    parsedBody = parseJsonObject(text);
  } catch (error) {
    if (status < 200 || status >= 300) {
      throw clientError(
        mapTikTokDisplayError("", status),
        "TikTok Display request failed",
        { reason: `http_${status || 0}` }
      );
    }
    throw error;
  }

  if (status < 200 || status >= 300) {
    throwForTikTokFailure(status, parsedBody);
  }

  return normalizeSuccessPage(parsedBody);
}

module.exports = {
  CodeClipTikTokDisplayClientError,
  listCodeClipTikTokVideos,
};
