const DIAGNOSTIC_PROVIDER = "youtube";
const DIAGNOSTIC_CHANNEL = "youtube";
const DIAGNOSTIC_CALLBACK_PREFIX = "diag_yt_";
const DIAGNOSTIC_PROBE_PREFIX = "diag_";
const DIAGNOSTIC_CALLBACK_ROUTE = "/api/codeclip/diagnostics/youtube/websub/:callbackId";
const DIAGNOSTIC_CALLBACK_PATH_PREFIX = "/api/codeclip/diagnostics/youtube/websub/";
const YOUTUBE_FEED_HOST = "www.youtube.com";
const YOUTUBE_FEED_PATH = "/feeds/videos.xml";

const DIAGNOSTIC_PROBE_STATUSES = Object.freeze({
  PENDING_SUBSCRIBE: "pending_subscribe",
  ACTIVE: "active",
  PENDING_UNSUBSCRIBE: "pending_unsubscribe",
  UNSUBSCRIBED: "unsubscribed",
  FAILED: "failed",
});

const DIAGNOSTIC_PENDING_MODES = Object.freeze({
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
});

const DIAGNOSTIC_FAILURE_OPERATIONS = Object.freeze([
  "subscribe",
  "unsubscribe",
  "verification",
  "notification",
]);

const DIAGNOSTIC_METADATA_ALLOWED_KEYS = Object.freeze([
  "lastVerification",
  "lastDispatch",
  "lastFailure",
  "lastNotification",
  "cleanup",
]);

const DIAGNOSTIC_METADATA_FORBIDDEN_KEYS = Object.freeze([
  "secret",
  "hubSecret",
  "rootSecret",
  "verifyToken",
  "authorization",
  "authorizationHeader",
  "cookie",
  "headers",
  "rawHeaders",
  "requestBody",
  "rawBody",
  "payload",
  "adminKey",
  "callbackCredential",
]);

const MAX_DIAGNOSTIC_METADATA_BYTES = 16 * 1024;

class CodeClipYouTubeWebSubDiagnosticProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubDiagnosticProbeError";
    this.code = code;
    this.details = details;
  }
}

function diagnosticProbeError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubDiagnosticProbeError(code, message, details);
}

function normalizeRequiredString(value, fieldName, maxLength = 160) {
  if (typeof value !== "string") {
    throw diagnosticProbeError("validation_error", `${fieldName} is required`, { fieldName });
  }
  const normalized = value.trim();
  if (
    normalized !== value ||
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw diagnosticProbeError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeDiagnosticProbeId(value) {
  const normalized = normalizeRequiredString(value, "probeId", 96);
  if (!new RegExp(`^${DIAGNOSTIC_PROBE_PREFIX}[A-Za-z0-9_-]{8,90}$`).test(normalized)) {
    throw diagnosticProbeError("validation_error", "probeId is invalid", { fieldName: "probeId" });
  }
  return normalized;
}

function normalizeDiagnosticCallbackId(value) {
  const normalized = normalizeRequiredString(value, "callbackId", 96);
  if (!new RegExp(`^${DIAGNOSTIC_CALLBACK_PREFIX}[A-Za-z0-9_-]{16,80}$`).test(normalized)) {
    throw diagnosticProbeError("invalid_callback_id", "callbackId is invalid", { fieldName: "callbackId" });
  }
  return normalized;
}

function normalizeYouTubeDiagnosticChannelId(value) {
  const normalized = normalizeRequiredString(value, "channelId", 128);
  if (!/^UC[A-Za-z0-9_-]{20,40}$/.test(normalized)) {
    throw diagnosticProbeError("validation_error", "channelId is invalid", { fieldName: "channelId" });
  }
  return normalized;
}

function normalizeYouTubeDiagnosticTopic(value, channelId) {
  const normalizedChannelId = normalizeYouTubeDiagnosticChannelId(channelId);
  const raw = normalizeRequiredString(value, "topic", 240);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw diagnosticProbeError("validation_error", "topic is invalid", { fieldName: "topic" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw diagnosticProbeError("validation_error", "topic scheme is invalid", { fieldName: "topic" });
  }
  if (parsed.hostname !== YOUTUBE_FEED_HOST || parsed.pathname !== YOUTUBE_FEED_PATH) {
    throw diagnosticProbeError("validation_error", "topic is not a YouTube feed", { fieldName: "topic" });
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw diagnosticProbeError("validation_error", "topic is invalid", { fieldName: "topic" });
  }

  const params = Array.from(parsed.searchParams.entries());
  if (params.length !== 1 || params[0][0] !== "channel_id" || params[0][1] !== normalizedChannelId) {
    throw diagnosticProbeError("validation_error", "topic channel_id mismatch", { fieldName: "topic" });
  }

  return `${parsed.protocol}//${YOUTUBE_FEED_HOST}${YOUTUBE_FEED_PATH}?channel_id=${normalizedChannelId}`;
}

function maskDiagnosticIdentifier(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}...`;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function buildDiagnosticCallbackPath(callbackId) {
  const normalizedCallbackId = normalizeDiagnosticCallbackId(callbackId);
  return `${DIAGNOSTIC_CALLBACK_PATH_PREFIX}${normalizedCallbackId}`;
}


const DIAGNOSTIC_TERMINAL_STATUSES = Object.freeze([
  DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED,
]);

const DIAGNOSTIC_ALLOWED_PENDING_BY_STATUS = Object.freeze({
  [DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE]: DIAGNOSTIC_PENDING_MODES.SUBSCRIBE,
  [DIAGNOSTIC_PROBE_STATUSES.ACTIVE]: null,
  [DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE]: DIAGNOSTIC_PENDING_MODES.UNSUBSCRIBE,
  [DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED]: null,
  [DIAGNOSTIC_PROBE_STATUSES.FAILED]: null,
});

function normalizeDiagnosticStatus(value) {
  const normalized = normalizeRequiredString(value, "status", 64);
  if (!Object.values(DIAGNOSTIC_PROBE_STATUSES).includes(normalized)) {
    throw diagnosticProbeError("invalid_probe_state", "status is invalid", { fieldName: "status" });
  }
  return normalized;
}

function normalizeDiagnosticPendingMode(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, "pendingMode", 64);
  if (!Object.values(DIAGNOSTIC_PENDING_MODES).includes(normalized)) {
    throw diagnosticProbeError("invalid_probe_state", "pendingMode is invalid", { fieldName: "pendingMode" });
  }
  return normalized;
}

function normalizeOptionalTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw diagnosticProbeError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw diagnosticProbeError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return new Date(timestamp).toISOString();
}

function normalizeRequiredTimestamp(value, fieldName) {
  const normalized = normalizeOptionalTimestamp(value, fieldName);
  if (!normalized) {
    throw diagnosticProbeError("validation_error", `${fieldName} is required`, { fieldName });
  }
  return normalized;
}

function assertDiagnosticStatusPendingMode(status, pendingMode) {
  const expected = DIAGNOSTIC_ALLOWED_PENDING_BY_STATUS[status];
  if (pendingMode !== expected) {
    throw diagnosticProbeError("invalid_probe_state", "status and pendingMode are inconsistent", {
      fieldName: "pendingMode",
    });
  }
}

function normalizeBoolean(value, fieldName) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw diagnosticProbeError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return value;
}

function normalizeFailureOperation(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, "failedOperation", 32);
  if (!DIAGNOSTIC_FAILURE_OPERATIONS.includes(normalized)) {
    throw diagnosticProbeError("validation_error", "failedOperation is invalid", { fieldName: "failedOperation" });
  }
  return normalized;
}

function normalizeFailureReasonCode(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, "failedReasonCode", 80);
  if (!/^[a-z0-9_]{2,80}$/.test(normalized)) {
    throw diagnosticProbeError("validation_error", "failedReasonCode is invalid", {
      fieldName: "failedReasonCode",
    });
  }
  return normalized;
}

function rejectForbiddenDiagnosticKey(key) {
  if (DIAGNOSTIC_METADATA_FORBIDDEN_KEYS.includes(String(key || ""))) {
    throw diagnosticProbeError("validation_error", "secret material is not allowed", { fieldName: key });
  }
}

function rejectOperationalSecrets(record = {}) {
  for (const key of Object.keys(record || {})) rejectForbiddenDiagnosticKey(key);
}

function assertNoForbiddenMetadataKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    rejectForbiddenDiagnosticKey(key);
    if (nested && typeof nested === "object") assertNoForbiddenMetadataKeys(nested);
  }
}

function normalizeDiagnosticMetadata(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw diagnosticProbeError("validation_error", "diagnosticMetadata is invalid", {
      fieldName: "diagnosticMetadata",
    });
  }
  for (const key of Object.keys(value)) {
    if (!DIAGNOSTIC_METADATA_ALLOWED_KEYS.includes(key)) {
      throw diagnosticProbeError("validation_error", "diagnosticMetadata contains unsupported field", {
        fieldName: "diagnosticMetadata",
      });
    }
  }
  assertNoForbiddenMetadataKeys(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_METADATA_BYTES) {
    throw diagnosticProbeError("validation_error", "diagnosticMetadata is too large", {
      fieldName: "diagnosticMetadata",
    });
  }
  return JSON.parse(serialized);
}

function assertProbeStateInvariants(record) {
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw diagnosticProbeError("invalid_probe_state", "updatedAt is before createdAt", {
      fieldName: "updatedAt",
    });
  }
  if (record.status === DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE) {
    if (record.verifiedAt || record.firstVerifiedAt || record.unsubscribedAt) {
      throw diagnosticProbeError("invalid_probe_state", "pending subscribe timestamps are invalid");
    }
  }
  if (record.status === DIAGNOSTIC_PROBE_STATUSES.ACTIVE) {
    if (!record.verifiedAt || !record.firstVerifiedAt || !record.leaseExpiresAt) {
      throw diagnosticProbeError("invalid_probe_state", "active probe requires verification and lease");
    }
    if (Date.parse(record.leaseExpiresAt) <= Date.parse(record.verifiedAt)) {
      throw diagnosticProbeError("invalid_probe_state", "active lease is invalid");
    }
  }
  if (record.status === DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE) {
    if (!record.verifiedAt && !(record.cleanupRequired && record.subscriptionMayExist)) {
      throw diagnosticProbeError("invalid_probe_state", "pending unsubscribe requires verification or cleanup risk");
    }
  }
  if (record.status === DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED && !record.unsubscribedAt) {
    throw diagnosticProbeError("invalid_probe_state", "unsubscribed probe requires unsubscribedAt");
  }
  if (record.status !== DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED && record.unsubscribedAt) {
    throw diagnosticProbeError("invalid_probe_state", "unsubscribedAt is not allowed", {
      fieldName: "unsubscribedAt",
    });
  }
  if (record.cleanupRequired && ![
    DIAGNOSTIC_PROBE_STATUSES.FAILED,
    DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE,
  ].includes(record.status)) {
    throw diagnosticProbeError("invalid_probe_state", "cleanupRequired is invalid", {
      fieldName: "cleanupRequired",
    });
  }
  if (record.subscriptionMayExist && ![
    DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE,
    DIAGNOSTIC_PROBE_STATUSES.ACTIVE,
    DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE,
    DIAGNOSTIC_PROBE_STATUSES.FAILED,
  ].includes(record.status)) {
    throw diagnosticProbeError("invalid_probe_state", "subscriptionMayExist is invalid", {
      fieldName: "subscriptionMayExist",
    });
  }
  if (record.status === DIAGNOSTIC_PROBE_STATUSES.FAILED && (!record.failedOperation || !record.failedReasonCode)) {
    throw diagnosticProbeError("invalid_probe_state", "failed probe requires failure context");
  }
}

function normalizeDiagnosticProbeRecord(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw diagnosticProbeError("validation_error", "probe record is required", { fieldName: "probe" });
  }
  rejectOperationalSecrets(record);

  const provider = normalizeRequiredString(record.provider, "provider", 32);
  const channel = normalizeRequiredString(record.channel, "channel", 32);
  if (provider !== DIAGNOSTIC_PROVIDER || channel !== DIAGNOSTIC_CHANNEL) {
    throw diagnosticProbeError("validation_error", "provider/channel is invalid", { fieldName: "provider" });
  }

  const channelId = normalizeYouTubeDiagnosticChannelId(record.channelId);
  const status = normalizeDiagnosticStatus(record.status);
  const pendingMode = normalizeDiagnosticPendingMode(record.pendingMode);
  assertDiagnosticStatusPendingMode(status, pendingMode);

  const normalized = {
    probeId: normalizeDiagnosticProbeId(record.probeId),
    callbackId: normalizeDiagnosticCallbackId(record.callbackId),
    provider,
    channel,
    channelId,
    topic: normalizeYouTubeDiagnosticTopic(record.topic, channelId),
    status,
    pendingMode,
    secretVersion: record.secretVersion === undefined || record.secretVersion === null || record.secretVersion === ""
      ? null
      : normalizeRequiredString(record.secretVersion, "secretVersion", 32),
    leaseExpiresAt: normalizeOptionalTimestamp(record.leaseExpiresAt, "leaseExpiresAt"),
    createdAt: normalizeRequiredTimestamp(record.createdAt, "createdAt"),
    updatedAt: normalizeRequiredTimestamp(record.updatedAt, "updatedAt"),
    verifiedAt: normalizeOptionalTimestamp(record.verifiedAt, "verifiedAt"),
    firstVerifiedAt: normalizeOptionalTimestamp(record.firstVerifiedAt, "firstVerifiedAt"),
    lastNotificationAt: normalizeOptionalTimestamp(record.lastNotificationAt, "lastNotificationAt"),
    unsubscribedAt: normalizeOptionalTimestamp(record.unsubscribedAt, "unsubscribedAt"),
    cleanupRequired: normalizeBoolean(record.cleanupRequired, "cleanupRequired"),
    subscriptionMayExist: normalizeBoolean(record.subscriptionMayExist, "subscriptionMayExist"),
    failedOperation: normalizeFailureOperation(record.failedOperation),
    failedReasonCode: normalizeFailureReasonCode(record.failedReasonCode),
    diagnosticMetadata: normalizeDiagnosticMetadata(record.diagnosticMetadata),
  };
  assertProbeStateInvariants(normalized);
  return normalized;
}

function isDiagnosticProbeTerminal(record) {
  const normalized = normalizeDiagnosticProbeRecord(record);
  return DIAGNOSTIC_TERMINAL_STATUSES.includes(normalized.status) || (
    normalized.status === DIAGNOSTIC_PROBE_STATUSES.FAILED && normalized.cleanupRequired !== true
  );
}

function canFailedProbeEnterCleanup(record) {
  return record.status === DIAGNOSTIC_PROBE_STATUSES.FAILED &&
    record.cleanupRequired === true &&
    record.subscriptionMayExist === true;
}

function assertDiagnosticProbeTransition(record, nextStatus) {
  const current = normalizeDiagnosticProbeRecord(record);
  const target = normalizeDiagnosticStatus(nextStatus);
  const allowed = {
    [DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE]: [
      DIAGNOSTIC_PROBE_STATUSES.ACTIVE,
      DIAGNOSTIC_PROBE_STATUSES.FAILED,
    ],
    [DIAGNOSTIC_PROBE_STATUSES.ACTIVE]: [
      DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE,
      DIAGNOSTIC_PROBE_STATUSES.FAILED,
    ],
    [DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE]: [
      DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED,
      DIAGNOSTIC_PROBE_STATUSES.FAILED,
    ],
    [DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED]: [
      DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED,
    ],
    [DIAGNOSTIC_PROBE_STATUSES.FAILED]: canFailedProbeEnterCleanup(current)
      ? [DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE, DIAGNOSTIC_PROBE_STATUSES.FAILED]
      : [DIAGNOSTIC_PROBE_STATUSES.FAILED],
  };
  if (!allowed[current.status].includes(target)) {
    throw diagnosticProbeError("invalid_probe_transition", "diagnostic probe transition is not allowed", {
      fromStatus: current.status,
      toStatus: target,
    });
  }
  return true;
}

function addSeconds(timestamp, seconds) {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
}

function normalizeLeaseSeconds(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw diagnosticProbeError("validation_error", "leaseSeconds is invalid", { fieldName: "leaseSeconds" });
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 60 * 60 * 24 * 30) {
    throw diagnosticProbeError("validation_error", "leaseSeconds is invalid", { fieldName: "leaseSeconds" });
  }
  return parsed;
}

function applyDiagnosticVerificationTransition(record, { verifiedAt, leaseSeconds } = {}) {
  const current = normalizeDiagnosticProbeRecord(record);
  const normalizedVerifiedAt = normalizeRequiredTimestamp(verifiedAt, "verifiedAt");
  const normalizedLeaseSeconds = normalizeLeaseSeconds(leaseSeconds);
  const leaseExpiresAt = addSeconds(normalizedVerifiedAt, normalizedLeaseSeconds);

  if (current.status === DIAGNOSTIC_PROBE_STATUSES.ACTIVE) {
    const nextVerifiedAt = Date.parse(normalizedVerifiedAt) > Date.parse(current.verifiedAt)
      ? normalizedVerifiedAt
      : current.verifiedAt;
    const nextLeaseExpiresAt = Date.parse(leaseExpiresAt) > Date.parse(current.leaseExpiresAt)
      ? leaseExpiresAt
      : current.leaseExpiresAt;
    const nextUpdatedAt = Date.parse(nextVerifiedAt) > Date.parse(current.updatedAt)
      ? nextVerifiedAt
      : current.updatedAt;
    return {
      ...current,
      verifiedAt: nextVerifiedAt,
      leaseExpiresAt: nextLeaseExpiresAt,
      updatedAt: nextUpdatedAt,
      diagnosticMetadata: {
        ...current.diagnosticMetadata,
        lastVerification: {
          mode: DIAGNOSTIC_PENDING_MODES.SUBSCRIBE,
          leaseSeconds: normalizedLeaseSeconds,
          verifiedAt: nextVerifiedAt,
        },
      },
    };
  }

  assertDiagnosticProbeTransition(current, DIAGNOSTIC_PROBE_STATUSES.ACTIVE);
  if (current.status !== DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE) {
    throw diagnosticProbeError("invalid_probe_transition", "verification requires pending subscribe", {
      fromStatus: current.status,
    });
  }
  return {
    ...current,
    status: DIAGNOSTIC_PROBE_STATUSES.ACTIVE,
    pendingMode: null,
    leaseExpiresAt,
    verifiedAt: normalizedVerifiedAt,
    firstVerifiedAt: current.firstVerifiedAt || normalizedVerifiedAt,
    subscriptionMayExist: true,
    updatedAt: normalizedVerifiedAt,
    diagnosticMetadata: {
      ...current.diagnosticMetadata,
      lastVerification: {
        mode: DIAGNOSTIC_PENDING_MODES.SUBSCRIBE,
        leaseSeconds: normalizedLeaseSeconds,
        verifiedAt: normalizedVerifiedAt,
      },
    },
  };
}

function applyDiagnosticUnsubscribeTransition(record, { requestedAt, confirmedAt } = {}) {
  const current = normalizeDiagnosticProbeRecord(record);
  if (current.status === DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED) return current;

  if (confirmedAt !== undefined && confirmedAt !== null) {
    assertDiagnosticProbeTransition(current, DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED);
    if (current.status !== DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE) {
      throw diagnosticProbeError("invalid_probe_transition", "unsubscribe confirmation requires pending unsubscribe", {
        fromStatus: current.status,
      });
    }
    const normalizedConfirmedAt = normalizeRequiredTimestamp(confirmedAt, "confirmedAt");
    return {
      ...current,
      status: DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED,
      pendingMode: null,
      leaseExpiresAt: null,
      cleanupRequired: false,
      subscriptionMayExist: false,
      unsubscribedAt: current.unsubscribedAt || normalizedConfirmedAt,
      updatedAt: normalizedConfirmedAt,
      diagnosticMetadata: {
        ...current.diagnosticMetadata,
        cleanup: {
          ...(current.diagnosticMetadata.cleanup || {}),
          confirmedAt: normalizedConfirmedAt,
        },
      },
    };
  }

  assertDiagnosticProbeTransition(current, DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE);
  if (current.status === DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE) return current;
  const normalizedRequestedAt = normalizeRequiredTimestamp(requestedAt, "requestedAt");
  return {
    ...current,
    status: DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE,
    pendingMode: DIAGNOSTIC_PENDING_MODES.UNSUBSCRIBE,
    updatedAt: normalizedRequestedAt,
    diagnosticMetadata: {
      ...current.diagnosticMetadata,
      cleanup: {
        ...(current.diagnosticMetadata.cleanup || {}),
        requestedAt: normalizedRequestedAt,
        fromFailedState: current.status === DIAGNOSTIC_PROBE_STATUSES.FAILED,
      },
    },
  };
}


function applyDiagnosticDispatchFailureTransition(record, {
  failedAt,
  failedOperation = "subscribe",
  failedReasonCode = "hub_request_failed",
  subscriptionMayExist = false,
  cleanupRequired = false,
} = {}) {
  const current = normalizeDiagnosticProbeRecord(record);
  assertDiagnosticProbeTransition(current, DIAGNOSTIC_PROBE_STATUSES.FAILED);
  const normalizedFailedAt = normalizeRequiredTimestamp(failedAt, "failedAt");
  const normalizedOperation = normalizeFailureOperation(failedOperation);
  const normalizedReason = normalizeFailureReasonCode(failedReasonCode);
  const normalizedSubscriptionMayExist = Boolean(subscriptionMayExist);
  const normalizedCleanupRequired = Boolean(cleanupRequired);
  if (normalizedCleanupRequired && !normalizedSubscriptionMayExist) {
    throw diagnosticProbeError("invalid_probe_state", "cleanup requires external subscription risk");
  }
  return {
    ...current,
    status: DIAGNOSTIC_PROBE_STATUSES.FAILED,
    pendingMode: null,
    cleanupRequired: normalizedCleanupRequired,
    subscriptionMayExist: normalizedSubscriptionMayExist,
    failedOperation: normalizedOperation,
    failedReasonCode: normalizedReason,
    updatedAt: normalizedFailedAt,
    diagnosticMetadata: {
      ...current.diagnosticMetadata,
      lastFailure: {
        operation: normalizedOperation,
        reasonCode: normalizedReason,
        failedAt: normalizedFailedAt,
        cleanupRequired: normalizedCleanupRequired,
        subscriptionMayExist: normalizedSubscriptionMayExist,
      },
    },
  };
}


function normalizeVideoId(value) {
  const normalized = normalizeRequiredString(value, "videoId", 64);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(normalized)) {
    throw diagnosticProbeError("validation_error", "videoId is invalid", { fieldName: "videoId" });
  }
  return normalized;
}

function normalizeOptionalTitleHash(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, "titleHash", 128);
  if (!/^[A-Fa-f0-9]{8,128}$/.test(normalized)) {
    throw diagnosticProbeError("validation_error", "titleHash is invalid", { fieldName: "titleHash" });
  }
  return normalized.toLowerCase();
}

function buildDiagnosticObservationIdentity({ channelId, videoId, publishedAt } = {}) {
  const normalizedChannelId = normalizeYouTubeDiagnosticChannelId(channelId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const normalizedPublishedAt = normalizeRequiredTimestamp(publishedAt, "publishedAt");
  return `youtube:${normalizedChannelId}:${normalizedVideoId}:published:${normalizedPublishedAt}`;
}

function applyDiagnosticNotificationObservation(record, observation = {}) {
  const current = normalizeDiagnosticProbeRecord(record);
  if (current.status !== DIAGNOSTIC_PROBE_STATUSES.ACTIVE) {
    throw diagnosticProbeError("invalid_probe_transition", "notification requires active probe", {
      fromStatus: current.status,
    });
  }
  const channelId = normalizeYouTubeDiagnosticChannelId(observation.channelId);
  if (channelId !== current.channelId) {
    throw diagnosticProbeError("validation_error", "notification channel mismatch", { fieldName: "channelId" });
  }
  const videoId = normalizeVideoId(observation.videoId);
  const observedAt = normalizeRequiredTimestamp(observation.observedAt, "observedAt");
  const publishedAt = normalizeRequiredTimestamp(observation.publishedAt, "publishedAt");
  const updatedAt = normalizeRequiredTimestamp(observation.updatedAt, "updatedAt");
  const titleHash = normalizeOptionalTitleHash(observation.titleHash);
  const observationIdentity = buildDiagnosticObservationIdentity({ channelId, videoId, publishedAt });
  const previous = current.diagnosticMetadata?.lastNotification || null;
  const duplicate = previous?.observationIdentity === observationIdentity;
  const nextObservedAt = !current.lastNotificationAt || Date.parse(observedAt) > Date.parse(current.lastNotificationAt)
    ? observedAt
    : current.lastNotificationAt;

  return {
    ...current,
    lastNotificationAt: nextObservedAt,
    updatedAt: Date.parse(nextObservedAt) > Date.parse(current.updatedAt) ? nextObservedAt : current.updatedAt,
    diagnosticMetadata: {
      ...current.diagnosticMetadata,
      lastNotification: {
        observationIdentity,
        channelId,
        videoId,
        publishedAt,
        updatedAt,
        observedAt: nextObservedAt,
        titleHash,
        duplicate,
      },
    },
  };
}


function serializeDiagnosticProbePublic(record) {
  const current = normalizeDiagnosticProbeRecord(record);
  const lastNotification = current.diagnosticMetadata?.lastNotification || null;
  return {
    probeId: maskDiagnosticIdentifier(current.probeId),
    callbackId: maskDiagnosticIdentifier(current.callbackId),
    provider: current.provider,
    channel: current.channel,
    channelId: current.channelId,
    topic: current.topic,
    status: current.status,
    pendingMode: current.pendingMode,
    cleanupRequired: current.cleanupRequired,
    subscriptionMayExist: current.subscriptionMayExist,
    failedOperation: current.failedOperation,
    failedReasonCode: current.failedReasonCode,
    leaseExpiresAt: current.leaseExpiresAt,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    verifiedAt: current.verifiedAt,
    firstVerifiedAt: current.firstVerifiedAt,
    lastNotificationAt: current.lastNotificationAt,
    unsubscribedAt: current.unsubscribedAt,
    notification: lastNotification
      ? {
          observationIdentity: maskDiagnosticIdentifier(lastNotification.observationIdentity),
          videoId: maskDiagnosticIdentifier(lastNotification.videoId),
          publishedAt: lastNotification.publishedAt,
          updatedAt: lastNotification.updatedAt,
          observedAt: lastNotification.observedAt,
          duplicate: lastNotification.duplicate === true,
        }
      : null,
  };
}


// TODO Gate 1.2: add isolated PostgreSQL state storage for diagnostic probes.
// TODO Gate 1.3: add admin-protected create/status/cleanup operator routes.
// TODO Gate 1.4: add diagnostic-only GET/POST callback handlers that never call provider delivery or business processing.
// TODO Gate 1.5: add a diagnostic Hub request wrapper that allows HTTP YouTube feed topics only in this module.
// TODO Gate 1.6: add lifecycle, isolation, topic, verification, notification, and cleanup tests before enabling production use.

module.exports = {
  CodeClipYouTubeWebSubDiagnosticProbeError,
  DIAGNOSTIC_PROVIDER,
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_CALLBACK_PREFIX,
  DIAGNOSTIC_PROBE_PREFIX,
  DIAGNOSTIC_CALLBACK_ROUTE,
  DIAGNOSTIC_CALLBACK_PATH_PREFIX,
  DIAGNOSTIC_PROBE_STATUSES,
  DIAGNOSTIC_PENDING_MODES,
  YOUTUBE_FEED_HOST,
  YOUTUBE_FEED_PATH,
  normalizeDiagnosticProbeId,
  normalizeDiagnosticCallbackId,
  normalizeYouTubeDiagnosticChannelId,
  normalizeYouTubeDiagnosticTopic,
  normalizeDiagnosticProbeRecord,
  assertDiagnosticProbeTransition,
  applyDiagnosticVerificationTransition,
  applyDiagnosticNotificationObservation,
  applyDiagnosticUnsubscribeTransition,
  applyDiagnosticDispatchFailureTransition,
  buildDiagnosticObservationIdentity,
  isDiagnosticProbeTerminal,
  serializeDiagnosticProbePublic,
  maskDiagnosticIdentifier,
  buildDiagnosticCallbackPath,
};
