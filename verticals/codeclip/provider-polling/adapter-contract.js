/**
 * codeClip provider poll adapter contract (F1D2A).
 *
 * Pure validation/normalization for adapter input, results, detections, and
 * framework-owned polling delivery identity. No DB, HTTP, credentials, or
 * provider-specific semantics.
 */

const {
  getCodeClipProviderDefinition,
  normalizeCodeClipProviderName,
} = require("../provider-registry");
const {
  normalizeCodeClipProviderCredentialAccountRef,
} = require("../provider-credential-validators");
const {
  resolveCodeClipProviderDetectionSource,
  mapCodeClipProviderDetectionSourceToDeliverySource,
} = require("../provider-policy");
const {
  isCodeClipProviderDeliveryInitialSource,
} = require("../provider-delivery-sources");

const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const MAX_DETECTIONS = 50;

/**
 * Ledger column external_message_id is unbounded TEXT (no CHECK length).
 * Framework still fail-closes on composed identity size using platform-aligned
 * component maxima (provider name ≤ 64 elsewhere; object id ≤ 256).
 */
const IDENTITY_PREFIX = "poll:";
const PROVIDER_NAME_MAX_FOR_IDENTITY = 64;
const PROVIDER_OBJECT_ID_MAX = 256;
const EXTERNAL_MESSAGE_ID_MAX =
  IDENTITY_PREFIX.length +
  PROVIDER_NAME_MAX_FOR_IDENTITY +
  1 +
  PROVIDER_OBJECT_ID_MAX; // 326

const RAW_TYPE_MAX = 64;
const CANONICAL_URL_MAX = 2048;
const CODE_MAX = 64;

const CHECKPOINT_MAX_BYTES = 4096;
const CHECKPOINT_MAX_DEPTH = 3;
const CHECKPOINT_MAX_NODES = 50;
const CHECKPOINT_MAX_ARRAY_ELEMENTS = 20;

const RETRY_AFTER_MS_MIN = 1_000;
const RETRY_AFTER_MS_MAX = 86_400_000;

const SUCCESS_CLASSIFICATIONS = Object.freeze([
  "success",
  "empty",
]);

const FAILURE_CLASSIFICATIONS = Object.freeze([
  "retryable",
  "rate_limited",
  "reauthorization_required",
  "credential_unusable",
  "terminal_configuration",
  "provider_malformed_response",
]);

const ALL_CLASSIFICATIONS = Object.freeze([
  ...SUCCESS_CLASSIFICATIONS,
  ...FAILURE_CLASSIFICATIONS,
]);

const CHECKPOINT_DENIED_KEYS = Object.freeze(
  new Set([
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "authorization",
    "bearer",
    "client_secret",
    "password",
    "credential",
    "ciphertext",
    "envelope",
    "auth_tag",
    "iv",
    "page_access_token",
    "accesstoken",
    "refreshtoken",
    "webhook_secret",
    "api_key",
  ])
);

const SUCCESS_ALLOWED_KEYS = Object.freeze(
  new Set(["ok", "detections", "nextCheckpoint", "page", "signals"])
);

const FAILURE_ALLOWED_KEYS = Object.freeze(
  new Set(["ok", "classification", "retryAfterMs", "code"])
);

const DETECTION_ALLOWED_KEYS = Object.freeze(
  new Set([
    "providerObjectId",
    "publishedAt",
    "detectedAt",
    "source",
    "canonicalUrl",
    "rawType",
  ])
);

const SIGNALS_ALLOWED_KEYS = Object.freeze(
  new Set(["classification", "retryAfterMs"])
);

class CodeClipProviderPollAdapterContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollAdapterContractError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function contractError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderPollAdapterContractError(code, message, safe);
}

function assertPollingCapableProvider(provider) {
  const normalized = normalizeCodeClipProviderName(provider);
  if (!normalized) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "provider is required",
      { fieldName: "provider", reason: "PROVIDER_REQUIRED" }
    );
  }
  const definition = getCodeClipProviderDefinition(normalized);
  if (!definition) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "provider is not registered",
      { fieldName: "provider", reason: "INVALID_PROVIDER" }
    );
  }
  if (definition.capabilities.polling !== true) {
    throw contractError(
      "POLLING_NOT_SUPPORTED",
      "provider does not support polling",
      { fieldName: "provider", reason: "POLLING_FALSE" }
    );
  }
  return definition.name;
}

function toIsoTimestamp(
  value,
  fieldName,
  errorCode = "INVALID_ADAPTER_INPUT"
) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw contractError(errorCode, `${fieldName} is invalid`, {
        fieldName,
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw contractError(errorCode, `${fieldName} is invalid`, {
        fieldName,
      });
    }
    return new Date(ms).toISOString();
  }
  throw contractError(errorCode, `${fieldName} is invalid`, {
    fieldName,
  });
}

function isJsonSafePrimitive(value) {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

function isDeniedCheckpointKey(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return CHECKPOINT_DENIED_KEYS.has(normalized);
}

function validateCheckpointValue(value, depth, counters) {
  counters.nodes += 1;
  if (counters.nodes > CHECKPOINT_MAX_NODES) {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }
  if (depth > CHECKPOINT_MAX_DEPTH) {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }

  if (isJsonSafePrimitive(value)) {
    return { ok: true, value };
  }

  if (Array.isArray(value)) {
    if (value.length > CHECKPOINT_MAX_ARRAY_ELEMENTS) {
      return { ok: false, reason: "INVALID_CHECKPOINT" };
    }
    const copy = [];
    for (const entry of value) {
      if (entry === undefined || typeof entry === "function") {
        return { ok: false, reason: "INVALID_CHECKPOINT" };
      }
      const nested = validateCheckpointValue(entry, depth + 1, counters);
      if (!nested.ok) return nested;
      copy.push(nested.value);
    }
    return { ok: true, value: copy };
  }

  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (
      proto !== Object.prototype &&
      proto !== null &&
      value.constructor !== Object
    ) {
      return { ok: false, reason: "INVALID_CHECKPOINT" };
    }
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof key !== "string") {
        return { ok: false, reason: "INVALID_CHECKPOINT" };
      }
      if (isDeniedCheckpointKey(key)) {
        return { ok: false, reason: "INVALID_CHECKPOINT" };
      }
      if (entry === undefined || typeof entry === "function") {
        return { ok: false, reason: "INVALID_CHECKPOINT" };
      }
      const nested = validateCheckpointValue(entry, depth + 1, counters);
      if (!nested.ok) return nested;
      copy[key] = nested.value;
    }
    return { ok: true, value: copy };
  }

  return { ok: false, reason: "INVALID_CHECKPOINT" };
}

function normalizeCheckpoint(
  value,
  fieldName = "checkpoint",
  errorCode = "INVALID_ADAPTER_INPUT"
) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw contractError(errorCode, `${fieldName} is invalid`, {
      fieldName,
      reason: "INVALID_CHECKPOINT",
    });
  }

  const counters = { nodes: 0 };
  const validated = validateCheckpointValue(value, 1, counters);
  if (!validated.ok) {
    throw contractError(errorCode, `${fieldName} is invalid`, {
      fieldName,
      reason: validated.reason || "INVALID_CHECKPOINT",
    });
  }

  let serialized;
  try {
    serialized = JSON.stringify(validated.value);
  } catch {
    throw contractError(errorCode, `${fieldName} is invalid`, {
      fieldName,
      reason: "INVALID_CHECKPOINT",
    });
  }
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > CHECKPOINT_MAX_BYTES
  ) {
    throw contractError(errorCode, `${fieldName} is invalid`, {
      fieldName,
      reason: "INVALID_CHECKPOINT",
    });
  }

  return JSON.parse(serialized);
}

function normalizeLimit(value) {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw contractError("INVALID_ADAPTER_INPUT", "limit is invalid", {
      fieldName: "limit",
    });
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_LIMIT ||
    value > MAX_LIMIT
  ) {
    throw contractError("INVALID_ADAPTER_INPUT", "limit is out of range", {
      fieldName: "limit",
    });
  }
  return value;
}

/**
 * Validate accessToken for in-memory adapter.poll use.
 * Returns the plaintext string so F1D2B can pass normalized input directly.
 * Never place this value in error details, logs, registry, or persistence.
 */
function normalizeAccessToken(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "accessToken is required",
      { fieldName: "accessToken" }
    );
  }
  return value;
}

/**
 * Normalize adapter poll input for direct adapter.poll(...) use.
 * Includes validated plaintext accessToken in memory only.
 */
function normalizeCodeClipProviderPollAdapterInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "adapter input must be an object",
      { fieldName: "input" }
    );
  }

  const provider = assertPollingCapableProvider(input.provider);

  const accountRef = normalizeCodeClipProviderCredentialAccountRef({
    provider,
    providerAccountId: input.providerAccountId ?? input.provider_account_id,
    environment: input.environment,
  });
  if (!accountRef.ok) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "provider account reference is invalid",
      {
        fieldName:
          accountRef.reason === "INVALID_PROVIDER"
            ? "provider"
            : accountRef.reason === "INVALID_ENVIRONMENT"
              ? "environment"
              : "providerAccountId",
        reason: accountRef.reason || null,
      }
    );
  }
  // Re-assert polling after account ref (registry registered but may not poll).
  assertPollingCapableProvider(accountRef.provider);

  const accessToken = normalizeAccessToken(
    input.accessToken ?? input.access_token
  );

  const checkpoint = normalizeCheckpoint(
    input.checkpoint,
    "checkpoint"
  );
  const now = toIsoTimestamp(input.now, "now");
  const limit = normalizeLimit(input.limit);

  return {
    provider: accountRef.provider,
    environment: accountRef.environment,
    providerAccountId: accountRef.providerAccountId,
    accessToken,
    checkpoint,
    now,
    limit,
  };
}

function normalizeRetryAfterMs(value, fieldName = "retryAfterMs") {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  if (
    !Number.isSafeInteger(value) ||
    value < RETRY_AFTER_MS_MIN ||
    value > RETRY_AFTER_MS_MAX
  ) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      `${fieldName} is out of range`,
      { fieldName }
    );
  }
  return value;
}

function normalizeSafeCode(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw contractError("INVALID_ADAPTER_RESULT", "code is invalid", {
      fieldName: "code",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > CODE_MAX ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)
  ) {
    throw contractError("INVALID_ADAPTER_RESULT", "code is invalid", {
      fieldName: "code",
    });
  }
  return normalized;
}

function normalizeClassification(value, { allowSuccess } = {}) {
  if (typeof value !== "string") {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "classification is invalid",
      { fieldName: "classification" }
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!ALL_CLASSIFICATIONS.includes(normalized)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "classification is invalid",
      { fieldName: "classification", reason: "UNKNOWN_CLASSIFICATION" }
    );
  }
  if (!allowSuccess && SUCCESS_CLASSIFICATIONS.includes(normalized)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "classification is invalid for failure result",
      { fieldName: "classification", reason: "SUCCESS_CLASSIFICATION" }
    );
  }
  return normalized;
}

function normalizeProviderObjectId(value) {
  if (typeof value !== "string") {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "providerObjectId is invalid",
      { fieldName: "providerObjectId" }
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "providerObjectId is required",
      { fieldName: "providerObjectId" }
    );
  }
  if (normalized.length > PROVIDER_OBJECT_ID_MAX) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "providerObjectId is too long",
      { fieldName: "providerObjectId" }
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "providerObjectId is invalid",
      { fieldName: "providerObjectId" }
    );
  }
  return normalized;
}

function normalizeRawType(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw contractError("INVALID_ADAPTER_RESULT", "rawType is invalid", {
      fieldName: "rawType",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > RAW_TYPE_MAX ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)
  ) {
    throw contractError("INVALID_ADAPTER_RESULT", "rawType is invalid", {
      fieldName: "rawType",
    });
  }
  return normalized;
}

function normalizeCanonicalUrl(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw contractError("INVALID_ADAPTER_RESULT", "canonicalUrl is invalid", {
      fieldName: "canonicalUrl",
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CANONICAL_URL_MAX) {
    throw contractError("INVALID_ADAPTER_RESULT", "canonicalUrl is invalid", {
      fieldName: "canonicalUrl",
    });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw contractError("INVALID_ADAPTER_RESULT", "canonicalUrl is invalid", {
      fieldName: "canonicalUrl",
    });
  }
  if (parsed.protocol !== "https:") {
    throw contractError("INVALID_ADAPTER_RESULT", "canonicalUrl is invalid", {
      fieldName: "canonicalUrl",
      reason: "HTTPS_REQUIRED",
    });
  }
  return trimmed;
}

function rejectUnknownKeys(object, allowed, fieldName) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw contractError(
        "INVALID_ADAPTER_RESULT",
        `${fieldName} contains unsupported field`,
        { fieldName, reason: "UNKNOWN_FIELD" }
      );
    }
  }
}

function normalizeDetection(entry, provider) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detection is invalid",
      { fieldName: "detections" }
    );
  }
  rejectUnknownKeys(entry, DETECTION_ALLOWED_KEYS, "detection");

  const providerObjectId = normalizeProviderObjectId(entry.providerObjectId);
  const publishedAt = toIsoTimestamp(
    entry.publishedAt,
    "publishedAt",
    "INVALID_ADAPTER_RESULT"
  );
  const detectedAt = toIsoTimestamp(
    entry.detectedAt,
    "detectedAt",
    "INVALID_ADAPTER_RESULT"
  );

  if (entry.source === undefined || entry.source === null || entry.source === "") {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detection source is required",
      { fieldName: "source" }
    );
  }

  const resolvedSource = resolveCodeClipProviderDetectionSource(
    provider,
    entry.source
  );
  if (!resolvedSource.ok) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detection source is invalid",
      { fieldName: "source", reason: resolvedSource.reason || null }
    );
  }

  const mapped = mapCodeClipProviderDetectionSourceToDeliverySource(
    provider,
    resolvedSource.detectionSource
  );
  if (!mapped.ok) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detection source mapping failed",
      { fieldName: "source", reason: mapped.reason || null }
    );
  }
  if (!isCodeClipProviderDeliveryInitialSource(mapped.deliverySource)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "mapped delivery source is invalid",
      { fieldName: "source", reason: "INVALID_DELIVERY_SOURCE" }
    );
  }

  const detection = {
    providerObjectId,
    publishedAt,
    detectedAt,
    source: resolvedSource.detectionSource,
    deliverySource: mapped.deliverySource,
  };

  const canonicalUrl = normalizeCanonicalUrl(entry.canonicalUrl);
  if (canonicalUrl !== undefined) detection.canonicalUrl = canonicalUrl;

  const rawType = normalizeRawType(entry.rawType);
  if (rawType !== undefined) detection.rawType = rawType;

  return detection;
}

/**
 * Dedupe policy:
 * - identical providerObjectId with same source + publishedAt → first wins
 * - same providerObjectId with conflicting source or publishedAt → invalid
 */
function dedupeDetections(detections) {
  const seen = new Map();
  const out = [];
  let duplicateCount = 0;

  for (const detection of detections) {
    const key = detection.providerObjectId;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, detection);
      out.push(detection);
      continue;
    }
    if (
      prior.source !== detection.source ||
      prior.publishedAt !== detection.publishedAt
    ) {
      throw contractError(
        "INVALID_ADAPTER_RESULT",
        "conflicting detections for the same providerObjectId",
        { fieldName: "detections", reason: "CONFLICTING_DUPLICATE" }
      );
    }
    duplicateCount += 1;
  }

  return { detections: out, duplicateCount };
}

function normalizeSignals(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw contractError("INVALID_ADAPTER_RESULT", "signals is invalid", {
      fieldName: "signals",
    });
  }
  rejectUnknownKeys(value, SIGNALS_ALLOWED_KEYS, "signals");

  const signals = {};
  if (value.classification !== undefined) {
    signals.classification = normalizeClassification(value.classification, {
      allowSuccess: true,
    });
  }
  if (value.retryAfterMs !== undefined) {
    const retryAfterMs = normalizeRetryAfterMs(value.retryAfterMs);
    if (retryAfterMs !== undefined) signals.retryAfterMs = retryAfterMs;
  }
  return Object.keys(signals).length > 0 ? signals : undefined;
}

function normalizeSuccessResult(result, provider) {
  rejectUnknownKeys(result, SUCCESS_ALLOWED_KEYS, "result");

  if (!Array.isArray(result.detections)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detections must be an array",
      { fieldName: "detections" }
    );
  }
  if (result.detections.length > MAX_DETECTIONS) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "detections exceed maximum",
      { fieldName: "detections" }
    );
  }

  const normalizedList = result.detections.map((entry) =>
    normalizeDetection(entry, provider)
  );
  const { detections, duplicateCount } = dedupeDetections(normalizedList);

  const nextCheckpoint = normalizeCheckpoint(
    result.nextCheckpoint,
    "nextCheckpoint",
    "INVALID_ADAPTER_RESULT"
  );

  if (
    !result.page ||
    typeof result.page !== "object" ||
    Array.isArray(result.page)
  ) {
    throw contractError("INVALID_ADAPTER_RESULT", "page is invalid", {
      fieldName: "page",
    });
  }
  if (typeof result.page.complete !== "boolean") {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "page.complete is required",
      { fieldName: "page.complete" }
    );
  }
  for (const key of Object.keys(result.page)) {
    if (key !== "complete") {
      throw contractError(
        "INVALID_ADAPTER_RESULT",
        "page contains unsupported field",
        { fieldName: "page", reason: "UNKNOWN_FIELD" }
      );
    }
  }

  const signals = normalizeSignals(result.signals);

  const normalized = {
    ok: true,
    detections,
    nextCheckpoint,
    page: { complete: result.page.complete },
    duplicateCount,
  };
  if (signals) normalized.signals = signals;
  return normalized;
}

function normalizeFailureResult(result) {
  rejectUnknownKeys(result, FAILURE_ALLOWED_KEYS, "result");

  if (result.classification === undefined || result.classification === null) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "classification is required",
      { fieldName: "classification" }
    );
  }

  const classification = normalizeClassification(result.classification, {
    allowSuccess: false,
  });
  const normalized = {
    ok: false,
    classification,
  };

  const retryAfterMs = normalizeRetryAfterMs(result.retryAfterMs);
  if (retryAfterMs !== undefined) normalized.retryAfterMs = retryAfterMs;

  const code = normalizeSafeCode(result.code);
  if (code !== undefined) normalized.code = code;

  return normalized;
}

/**
 * Normalize adapter poll result. Requires provider for detection source policy.
 */
function normalizeCodeClipProviderPollAdapterResult(result, { provider } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "adapter result must be an object",
      { fieldName: "result" }
    );
  }
  if (typeof result.ok !== "boolean") {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "result.ok must be a boolean",
      { fieldName: "ok" }
    );
  }

  const normalizedProvider = assertPollingCapableProvider(provider);

  if (result.ok === true) {
    return normalizeSuccessResult(result, normalizedProvider);
  }
  return normalizeFailureResult(result);
}

/**
 * Framework-owned polling ledger external_message_id.
 * Format: poll:<provider>:<providerObjectId>
 *
 * Ledger column is unbounded TEXT; composition is still fail-closed against
 * EXTERNAL_MESSAGE_ID_MAX and provider-specific remaining budget (no truncate).
 */
function buildCodeClipProviderPollingExternalMessageId({
  provider,
  providerObjectId,
} = {}) {
  const normalizedProvider = assertPollingCapableProvider(provider);
  if (normalizedProvider.length > PROVIDER_NAME_MAX_FOR_IDENTITY) {
    throw contractError(
      "INVALID_ADAPTER_INPUT",
      "provider name exceeds identity budget",
      { fieldName: "provider", reason: "IDENTITY_TOO_LONG" }
    );
  }

  const objectId = normalizeProviderObjectId(providerObjectId);
  const prefixWithProvider = `${IDENTITY_PREFIX}${normalizedProvider}:`;
  const maxObjectIdForProvider =
    EXTERNAL_MESSAGE_ID_MAX - prefixWithProvider.length;
  if (maxObjectIdForProvider < 1 || objectId.length > maxObjectIdForProvider) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "external message id exceeds maximum length",
      { fieldName: "providerObjectId", reason: "IDENTITY_TOO_LONG" }
    );
  }

  const identity = `${prefixWithProvider}${objectId}`;
  if (identity.length > EXTERNAL_MESSAGE_ID_MAX) {
    throw contractError(
      "INVALID_ADAPTER_RESULT",
      "external message id exceeds maximum length",
      { fieldName: "providerObjectId", reason: "IDENTITY_TOO_LONG" }
    );
  }
  return identity;
}

module.exports = {
  CodeClipProviderPollAdapterContractError,
  normalizeCodeClipProviderPollAdapterInput,
  normalizeCodeClipProviderPollAdapterResult,
  buildCodeClipProviderPollingExternalMessageId,
};
