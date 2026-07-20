const {
  CODECLIP_VERTICAL,
  CodeClipProviderAccountBindingError,
  normalizeCodeClipProviderAccountId,
} = require("./provider-account-bindings");

const YOUTUBE_PROVIDER = "youtube";
const YOUTUBE_CHANNEL = "youtube";
const DEFAULT_SECRET_VERSION = "v1";

const SUBSCRIPTION_STATUSES = Object.freeze({
  PENDING_SUBSCRIBE: "pending_subscribe",
  ACTIVE: "active",
  PENDING_RENEWAL: "pending_renewal",
  EXPIRED: "expired",
  PENDING_UNSUBSCRIBE: "pending_unsubscribe",
  UNSUBSCRIBED: "unsubscribed",
  DISABLED: "disabled",
});

const PENDING_MODES = Object.freeze({
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
});

const VALID_STATUSES = new Set(Object.values(SUBSCRIPTION_STATUSES));
const VALID_PENDING_MODES = new Set(Object.values(PENDING_MODES));
const VALID_AUDIT_ACTIONS = new Set([
  "subscription_requested",
  "renewal_requested",
  "unsubscribe_requested",
  "subscribe_dispatch_started",
  "subscribe_dispatch_accepted",
  "subscribe_dispatch_failed",
  "hub_request_accepted",
  "hub_request_failed",
]);
const CALLBACK_ID_MAX_LENGTH = 160;
const DISPATCH_ATTEMPT_ID_MAX_LENGTH = 120;
const SECRET_VERSION_MAX_LENGTH = 40;
const VIDEO_ID_MAX_LENGTH = 80;
const RESULT_CODE_MAX_LENGTH = 80;
const DEFAULT_DISPATCH_STALE_AFTER_SECONDS = 5 * 60;
const MAX_DISPATCH_STALE_AFTER_SECONDS = 60 * 60;

class CodeClipYouTubeWebSubSubscriptionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubSubscriptionError";
    this.code = code;
    this.details = details;
  }
}

function subscriptionInputError(message, details = {}) {
  return new CodeClipYouTubeWebSubSubscriptionError(
    "INVALID_YOUTUBE_WEBSUB_SUBSCRIPTION",
    message,
    details
  );
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw new CodeClipYouTubeWebSubSubscriptionError(
      "DATABASE_UNAVAILABLE",
      "codeClip YouTube WebSub subscription repository requires an explicit query client"
    );
  }
  return queryClient;
}

function assertNoControlCharacters(value, fieldName) {
  if (/[\u0000-\u001f\u007f]/.test(String(value || ""))) {
    throw subscriptionInputError(`${fieldName} contains invalid characters`, { fieldName });
  }
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw subscriptionInputError(`${fieldName} must be a non-empty string`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw subscriptionInputError(`${fieldName} must be a non-empty string`, { fieldName });
  }
  assertNoControlCharacters(normalized, fieldName);
  if (normalized.length > maxLength) {
    throw subscriptionInputError(`${fieldName} is too long`, { fieldName, maxLength });
  }
  return normalized;
}

function normalizeOptionalTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw subscriptionInputError(`${fieldName} is invalid`, { fieldName });
    }
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw subscriptionInputError(`${fieldName} must be an ISO timestamp`, { fieldName });
  }
  const normalized = value.trim();
  if (!Number.isFinite(Date.parse(normalized))) {
    throw subscriptionInputError(`${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeCallbackId(value) {
  const normalized = normalizeRequiredString(value, "callbackId", CALLBACK_ID_MAX_LENGTH);
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw subscriptionInputError("callbackId must be a URL path segment", {
      fieldName: "callbackId",
    });
  }
  return normalized;
}

function normalizeDispatchAttemptId(value) {
  const normalized = normalizeRequiredString(
    value,
    "attemptId",
    DISPATCH_ATTEMPT_ID_MAX_LENGTH
  );
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw subscriptionInputError("attemptId must be opaque URL-safe text", {
      fieldName: "attemptId",
    });
  }
  return normalized;
}

function normalizeStatus(value) {
  const normalized = normalizeRequiredString(value, "status", 40).toLowerCase();
  if (!VALID_STATUSES.has(normalized)) {
    throw subscriptionInputError("status is not valid", { fieldName: "status" });
  }
  return normalized;
}

function normalizePendingMode(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, "pendingMode", 40).toLowerCase();
  if (!VALID_PENDING_MODES.has(normalized)) {
    throw subscriptionInputError("pendingMode is not valid", { fieldName: "pendingMode" });
  }
  return normalized;
}

function normalizeAuditAction(value) {
  const normalized = normalizeRequiredString(value, "action", 80).toLowerCase();
  if (!VALID_AUDIT_ACTIONS.has(normalized)) {
    throw subscriptionInputError("action is not valid", { fieldName: "action" });
  }
  return normalized;
}

function normalizeEventCode(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeRequiredString(value, "eventCode", 120);
}

function normalizeResultCode(value) {
  return normalizeRequiredString(value, "resultCode", RESULT_CODE_MAX_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
}

function normalizeHubHttpStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    throw subscriptionInputError("hubHttpStatus is invalid", { fieldName: "hubHttpStatus" });
  }
  return parsed;
}

function normalizeDispatchStaleAfterSeconds(
  value = DEFAULT_DISPATCH_STALE_AFTER_SECONDS
) {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_DISPATCH_STALE_AFTER_SECONDS
  ) {
    throw subscriptionInputError("dispatch stale timeout is invalid", {
      fieldName: "staleAfterSeconds",
      max: MAX_DISPATCH_STALE_AFTER_SECONDS,
    });
  }
  return parsed;
}

function normalizeSecretVersion(value) {
  return normalizeRequiredString(
    value || DEFAULT_SECRET_VERSION,
    "secretVersion",
    SECRET_VERSION_MAX_LENGTH
  );
}

function normalizeVertical(value) {
  const normalized = String(value || CODECLIP_VERTICAL).trim().toLowerCase();
  if (normalized !== CODECLIP_VERTICAL) {
    throw subscriptionInputError("vertical must be codeclip", { fieldName: "vertical" });
  }
  return CODECLIP_VERTICAL;
}

function normalizeProvider(value) {
  const normalized = String(value || YOUTUBE_PROVIDER).trim().toLowerCase();
  if (normalized !== YOUTUBE_PROVIDER) {
    throw subscriptionInputError("provider must be youtube", { fieldName: "provider" });
  }
  return YOUTUBE_PROVIDER;
}

function normalizeYouTubeProviderAccountId(value) {
  try {
    return normalizeCodeClipProviderAccountId(YOUTUBE_PROVIDER, value);
  } catch (error) {
    if (error instanceof CodeClipProviderAccountBindingError) {
      throw subscriptionInputError("providerAccountId must be a YouTube channel ID", {
        fieldName: "providerAccountId",
        sourceCode: error.code,
      });
    }
    throw error;
  }
}

function normalizeChannel(value) {
  const normalized = String(value || YOUTUBE_CHANNEL).trim().toLowerCase();
  if (normalized !== YOUTUBE_CHANNEL) {
    throw subscriptionInputError("channel must be youtube", { fieldName: "channel" });
  }
  return YOUTUBE_CHANNEL;
}

function normalizeTopic(value, providerAccountId) {
  const normalized = normalizeRequiredString(value, "topic", 500);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw subscriptionInputError("topic must be a valid HTTPS URL", { fieldName: "topic" });
  }

  if (parsed.protocol !== "https:") {
    throw subscriptionInputError("topic must be a valid HTTPS URL", { fieldName: "topic" });
  }

  const topicChannelId = parsed.searchParams.get("channel_id") || "";
  if (topicChannelId !== providerAccountId) {
    throw subscriptionInputError("topic channel_id must match providerAccountId", {
      fieldName: "topic",
    });
  }

  return parsed.toString();
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw subscriptionInputError("metadata must be an object", { fieldName: "metadata" });
  }
  return value;
}

function sanitizeAuditMetadata(value) {
  const metadata = normalizeMetadata(value);
  const sanitized = {};

  if (Number.isSafeInteger(metadata.requestedLeaseSeconds) && metadata.requestedLeaseSeconds > 0) {
    sanitized.requestedLeaseSeconds = metadata.requestedLeaseSeconds;
  }
  if (metadata.operationSource === "operator_key") {
    sanitized.operationSource = "operator_key";
  }
  if (["started", "accepted", "failed"].includes(metadata.dispatchStatus)) {
    sanitized.dispatchStatus = metadata.dispatchStatus;
  }
  if (typeof metadata.previousStatus === "string" && VALID_STATUSES.has(metadata.previousStatus)) {
    sanitized.previousStatus = metadata.previousStatus;
  }
  if (typeof metadata.resultingStatus === "string" && VALID_STATUSES.has(metadata.resultingStatus)) {
    sanitized.resultingStatus = metadata.resultingStatus;
  }

  return sanitized;
}

function normalizeOptionalVideoId(value, fieldName = "videoId") {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeRequiredString(value, fieldName, VIDEO_ID_MAX_LENGTH);
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw subscriptionInputError(`${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeSubscriptionInput(input = {}) {
  const vertical = normalizeVertical(input.vertical);
  const provider = normalizeProvider(input.provider);
  const channel = normalizeChannel(input.channel);
  const providerAccountId = normalizeYouTubeProviderAccountId(
    input.providerAccountId || input.provider_account_id
  );
  const topic = normalizeTopic(input.topic, providerAccountId);

  return {
    vertical,
    callbackId: normalizeCallbackId(input.callbackId || input.callback_id),
    provider,
    channel,
    providerAccountId,
    topic,
    status: normalizeStatus(input.status || SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE),
    pendingMode: normalizePendingMode(input.pendingMode || input.pending_mode || PENDING_MODES.SUBSCRIBE),
    secretVersion: normalizeSecretVersion(input.secretVersion || input.secret_version),
    activationBoundaryAt: normalizeOptionalTimestamp(
      input.activationBoundaryAt || input.activation_boundary_at,
      "activationBoundaryAt"
    ),
    activationBoundaryVideoId: normalizeOptionalVideoId(
      input.activationBoundaryVideoId || input.activation_boundary_video_id,
      "activationBoundaryVideoId"
    ),
    activatedAt: normalizeOptionalTimestamp(input.activatedAt || input.activated_at, "activatedAt"),
    firstActivatedVideoId: normalizeOptionalVideoId(
      input.firstActivatedVideoId || input.first_activated_video_id,
      "firstActivatedVideoId"
    ),
    firstActivatedAt: normalizeOptionalTimestamp(
      input.firstActivatedAt || input.first_activated_at,
      "firstActivatedAt"
    ),
    leaseStartedAt: normalizeOptionalTimestamp(
      input.leaseStartedAt || input.lease_started_at,
      "leaseStartedAt"
    ),
    leaseExpiresAt: normalizeOptionalTimestamp(
      input.leaseExpiresAt || input.lease_expires_at,
      "leaseExpiresAt"
    ),
    lastVerifiedAt: normalizeOptionalTimestamp(
      input.lastVerifiedAt || input.last_verified_at,
      "lastVerifiedAt"
    ),
    metadata: normalizeMetadata(input.metadata),
  };
}

function mapSubscriptionRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    vertical: row.vertical,
    callbackId: row.callback_id,
    provider: row.provider,
    channel: row.channel,
    providerAccountId: row.provider_account_id,
    topic: row.topic,
    status: row.status,
    pendingMode: row.pending_mode || null,
    secretVersion: row.secret_version,
    activationBoundaryAt: row.activation_boundary_at || null,
    activationBoundaryVideoId: row.activation_boundary_video_id || null,
    activatedAt: row.activated_at || null,
    firstActivatedVideoId: row.first_activated_video_id || null,
    firstActivatedAt: row.first_activated_at || null,
    leaseStartedAt: row.lease_started_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubscriptionAuditRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    vertical: row.vertical,
    provider: row.provider,
    callbackId: row.callback_id,
    providerAccountId: row.provider_account_id,
    eventCode: row.event_code || null,
    action: row.action,
    mode: row.mode || null,
    resultCode: row.result_code,
    hubHttpStatus: row.hub_http_status ?? null,
    retryable: Boolean(row.retryable),
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function toInternalCodeClipYouTubeWebSubSubscription(subscription = null) {
  const mapped = subscription?.callback_id ? mapSubscriptionRow(subscription) : subscription;
  if (!mapped) return null;
  return {
    id: mapped.id,
    vertical: mapped.vertical,
    callbackId: mapped.callbackId,
    provider: mapped.provider,
    channel: mapped.channel,
    providerAccountId: mapped.providerAccountId,
    topic: mapped.topic,
    status: mapped.status,
    pendingMode: mapped.pendingMode,
    secretVersion: mapped.secretVersion,
    activationBoundaryAt: mapped.activationBoundaryAt,
    activationBoundaryVideoId: mapped.activationBoundaryVideoId,
    activatedAt: mapped.activatedAt,
    firstActivatedVideoId: mapped.firstActivatedVideoId,
    firstActivatedAt: mapped.firstActivatedAt,
    leaseStartedAt: mapped.leaseStartedAt,
    leaseExpiresAt: mapped.leaseExpiresAt,
    lastVerifiedAt: mapped.lastVerifiedAt,
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
  };
}

async function createPendingCodeClipYouTubeWebSubSubscription(input = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const normalized = normalizeSubscriptionInput({
    ...input,
    status: input.status || SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
    pendingMode: input.pendingMode || input.pending_mode || PENDING_MODES.SUBSCRIBE,
  });

  const result = await client.query(
    `
      INSERT INTO codeclip_youtube_websub_subscriptions (
        vertical,
        callback_id,
        provider,
        channel,
        provider_account_id,
        topic,
        status,
        pending_mode,
        secret_version,
        activation_boundary_at,
        activation_boundary_video_id,
        activated_at,
        first_activated_video_id,
        first_activated_at,
        lease_started_at,
        lease_expires_at,
        last_verified_at,
        metadata,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::timestamptz,$13,$14::timestamptz,$15::timestamptz,$16::timestamptz,$17::timestamptz,$18::jsonb,NOW())
      RETURNING *
    `,
    [
      normalized.vertical,
      normalized.callbackId,
      normalized.provider,
      normalized.channel,
      normalized.providerAccountId,
      normalized.topic,
      normalized.status,
      normalized.pendingMode,
      normalized.secretVersion,
      normalized.activationBoundaryAt,
      normalized.activationBoundaryVideoId,
      normalized.activatedAt,
      normalized.firstActivatedVideoId,
      normalized.firstActivatedAt,
      normalized.leaseStartedAt,
      normalized.leaseExpiresAt,
      normalized.lastVerifiedAt,
      JSON.stringify(normalized.metadata),
    ]
  );

  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function recordCodeClipYouTubeWebSubSubscriptionAudit(input = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const providerAccountId = normalizeYouTubeProviderAccountId(
    input.providerAccountId || input.provider_account_id
  );
  const result = await client.query(
    `
      INSERT INTO codeclip_youtube_websub_subscription_audit (
        vertical,
        provider,
        callback_id,
        provider_account_id,
        event_code,
        action,
        mode,
        result_code,
        hub_http_status,
        retryable,
        metadata
      )
      VALUES ('codeclip', 'youtube', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
    `,
    [
      normalizeCallbackId(input.callbackId || input.callback_id),
      providerAccountId,
      normalizeEventCode(input.eventCode || input.event_code),
      normalizeAuditAction(input.action),
      normalizePendingMode(input.mode),
      normalizeResultCode(input.resultCode || input.result_code),
      normalizeHubHttpStatus(input.hubHttpStatus || input.hub_http_status),
      Boolean(input.retryable),
      JSON.stringify(sanitizeAuditMetadata(input.metadata)),
    ]
  );
  return mapSubscriptionAuditRow(result.rows?.[0] || null);
}

async function getCodeClipYouTubeWebSubSubscriptionByCallbackId(callbackId, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_subscriptions
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
      LIMIT 1
    `,
    [normalizedCallbackId]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function getCodeClipYouTubeWebSubSubscriptionByProviderAccountId(
  providerAccountId,
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedProviderAccountId = normalizeYouTubeProviderAccountId(providerAccountId);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_subscriptions
      WHERE provider_account_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedProviderAccountId]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

const DISPATCH_MODE_CONTRACTS = Object.freeze({
  subscribe: Object.freeze({
    status: SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
    pendingMode: PENDING_MODES.SUBSCRIBE,
    resultStates: Object.freeze([
      Object.freeze({ status: SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE, pendingMode: PENDING_MODES.SUBSCRIBE }),
      Object.freeze({ status: SUBSCRIPTION_STATUSES.ACTIVE, pendingMode: null }),
    ]),
  }),
  renew: Object.freeze({
    status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
    pendingMode: PENDING_MODES.SUBSCRIBE,
    resultStates: Object.freeze([
      Object.freeze({ status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL, pendingMode: PENDING_MODES.SUBSCRIBE }),
      Object.freeze({ status: SUBSCRIPTION_STATUSES.ACTIVE, pendingMode: null }),
    ]),
  }),
  unsubscribe: Object.freeze({
    status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
    pendingMode: PENDING_MODES.UNSUBSCRIBE,
    resultStates: Object.freeze([
      Object.freeze({ status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE, pendingMode: PENDING_MODES.UNSUBSCRIBE }),
      Object.freeze({ status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED, pendingMode: null }),
      Object.freeze({ status: SUBSCRIPTION_STATUSES.DISABLED, pendingMode: null }),
    ]),
  }),
});

function getDispatchModeContract(mode) {
  const contract = DISPATCH_MODE_CONTRACTS[mode];
  if (!contract) {
    throw subscriptionInputError("dispatch mode is invalid", { fieldName: "mode" });
  }
  return contract;
}

async function claimCodeClipYouTubeWebSubDispatch(
  mode,
  callbackId,
  { attemptId, leaseSeconds, staleAfterSeconds, nowEpochMs, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const contract = getDispatchModeContract(mode);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const normalizedAttemptId = normalizeDispatchAttemptId(attemptId);
  const normalizedStaleAfterSeconds = normalizeDispatchStaleAfterSeconds(staleAfterSeconds);
  const requestedLeaseSeconds =
    Number.isSafeInteger(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : null;
  const comparisonEpochMs =
    nowEpochMs === undefined || nowEpochMs === null || nowEpochMs === ""
      ? null
      : Number(nowEpochMs);
  if (
    comparisonEpochMs !== null &&
    (!Number.isSafeInteger(comparisonEpochMs) || comparisonEpochMs < 0)
  ) {
    throw subscriptionInputError("nowEpochMs is invalid", { fieldName: "nowEpochMs" });
  }

  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        metadata = jsonb_set(
          metadata,
          '{dispatch}',
          jsonb_build_object(
            'attemptId', $2::text,
            'attemptNumber',
              CASE
                WHEN metadata ? 'dispatch'
                  AND jsonb_typeof(metadata->'dispatch') = 'object'
                  AND jsonb_typeof(metadata->'dispatch'->'attemptNumber') = 'number'
                  AND (metadata->'dispatch'->>'attemptNumber') ~ '^[0-9]{1,9}$'
                  AND (metadata->'dispatch'->>'attemptNumber')::bigint < 2147483647
                  THEN (metadata->'dispatch'->>'attemptNumber')::integer + 1
                ELSE 1
              END,
            'previousAttemptCount',
              CASE
                WHEN metadata ? 'dispatch'
                  AND jsonb_typeof(metadata->'dispatch') = 'object'
                  AND jsonb_typeof(metadata->'dispatch'->'attemptNumber') = 'number'
                  AND (metadata->'dispatch'->>'attemptNumber') ~ '^[0-9]{1,9}$'
                  AND (metadata->'dispatch'->>'attemptNumber')::bigint < 2147483647
                  THEN (metadata->'dispatch'->>'attemptNumber')::integer
                ELSE 0
              END,
            'status', 'started',
            'mode', $6::text,
            'startedAt', NOW(),
            'staleAfterEpochMs',
            FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint + ($4::integer * 1000),
            'requestedLeaseSeconds', $3::integer,
            'retryEligible', false
          ),
          true
        ),
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
        AND status = $7
        AND pending_mode = $8
        AND (
          NOT (metadata ? 'dispatch')
          OR metadata->'dispatch' = 'null'::jsonb
          OR (
            jsonb_typeof(metadata->'dispatch') = 'object'
            AND metadata->'dispatch'->>'status' = 'failed'
            AND metadata->'dispatch'->>'mode' = $6
            AND metadata->'dispatch'->>'retryEligible' = 'true'
            AND jsonb_typeof(metadata->'dispatch'->'attemptNumber') = 'number'
            AND (metadata->'dispatch'->>'attemptNumber') ~ '^[0-9]{1,9}$'
            AND (metadata->'dispatch'->>'attemptNumber')::bigint < 2147483647
          )
          OR (
            jsonb_typeof(metadata->'dispatch') = 'object'
            AND metadata->'dispatch'->>'status' = 'started'
            AND metadata->'dispatch'->>'mode' = $6
            AND jsonb_typeof(metadata->'dispatch'->'attemptNumber') = 'number'
            AND (metadata->'dispatch'->>'attemptNumber') ~ '^[0-9]{1,9}$'
            AND (metadata->'dispatch'->>'attemptNumber')::bigint < 2147483647
            AND jsonb_typeof(metadata->'dispatch'->'staleAfterEpochMs') = 'number'
            AND (metadata->'dispatch'->>'staleAfterEpochMs') ~ '^[0-9]{1,16}$'
            AND (metadata->'dispatch'->>'staleAfterEpochMs')::numeric <=
              COALESCE($5::numeric, FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::numeric)
          )
        )
      RETURNING *
    `,
    [
      normalizedCallbackId,
      normalizedAttemptId,
      requestedLeaseSeconds,
      normalizedStaleAfterSeconds,
      comparisonEpochMs,
      mode,
      contract.status,
      contract.pendingMode,
    ]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function recordCodeClipYouTubeWebSubDispatchResult(
  mode,
  callbackId,
  { attemptId, resultCode, hubHttpStatus, retryable, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const contract = getDispatchModeContract(mode);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const normalizedAttemptId = normalizeDispatchAttemptId(attemptId);
  const normalizedResultCode = normalizeResultCode(resultCode || "hub_request_failed");
  const normalizedHubHttpStatus = normalizeHubHttpStatus(hubHttpStatus);
  const accepted = normalizedResultCode === "hub_request_accepted";
  const dispatchStatus = accepted ? "accepted" : "failed";
  const retryEligible = accepted ? false : Boolean(retryable);

  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        metadata = jsonb_set(
          metadata,
          '{dispatch}',
          COALESCE(metadata->'dispatch', '{}'::jsonb) ||
          jsonb_build_object(
            'attemptId', $2::text,
            'status', $3::text,
            'mode', $7::text,
            'resultCode', $4::text,
            'hubHttpStatus', $5::integer,
            'retryEligible', $6::boolean,
            'completedAt', NOW()
          ),
          true
        ),
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
        AND metadata ? 'dispatch'
        AND jsonb_typeof(metadata->'dispatch') = 'object'
        AND metadata->'dispatch'->>'attemptId' = $2
        AND metadata->'dispatch'->>'status' = 'started'
        AND metadata->'dispatch'->>'mode' = $7
        AND (
          (status = $8 AND pending_mode = $9)
          OR (status = $10 AND pending_mode IS NOT DISTINCT FROM $11)
          OR (status = $12 AND pending_mode IS NOT DISTINCT FROM $13)
        )
      RETURNING *
    `,
    [
      normalizedCallbackId,
      normalizedAttemptId,
      dispatchStatus,
      normalizedResultCode,
      normalizedHubHttpStatus,
      retryEligible,
      mode,
      contract.resultStates[0].status,
      contract.resultStates[0].pendingMode,
      contract.resultStates[1]?.status || "__never__",
      contract.resultStates[1]?.pendingMode ?? null,
      contract.resultStates[2]?.status || "__never__",
      contract.resultStates[2]?.pendingMode ?? null,
    ]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function claimCodeClipYouTubeWebSubSubscribeDispatch(callbackId, options = {}) {
  return claimCodeClipYouTubeWebSubDispatch("subscribe", callbackId, options);
}

async function recordCodeClipYouTubeWebSubSubscribeDispatchResult(callbackId, options = {}) {
  return recordCodeClipYouTubeWebSubDispatchResult("subscribe", callbackId, options);
}

async function claimCodeClipYouTubeWebSubRenewDispatch(callbackId, options = {}) {
  return claimCodeClipYouTubeWebSubDispatch("renew", callbackId, options);
}

async function recordCodeClipYouTubeWebSubRenewDispatchResult(callbackId, options = {}) {
  return recordCodeClipYouTubeWebSubDispatchResult("renew", callbackId, options);
}

async function claimCodeClipYouTubeWebSubUnsubscribeDispatch(callbackId, options = {}) {
  return claimCodeClipYouTubeWebSubDispatch("unsubscribe", callbackId, options);
}

async function recordCodeClipYouTubeWebSubUnsubscribeDispatchResult(callbackId, options = {}) {
  return recordCodeClipYouTubeWebSubDispatchResult("unsubscribe", callbackId, options);
}

async function getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId(
  providerAccountId,
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedProviderAccountId = normalizeYouTubeProviderAccountId(providerAccountId);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_subscriptions
      WHERE provider_account_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
        AND status IN (
          'pending_subscribe',
          'active',
          'pending_renewal',
          'pending_unsubscribe'
        )
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedProviderAccountId]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function listCodeClipYouTubeWebSubSubscriptions(filters = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const predicates = [
    "vertical = 'codeclip'",
    "provider = 'youtube'",
    "channel = 'youtube'",
  ];
  const params = [];

  if (filters.providerAccountId || filters.provider_account_id) {
    params.push(normalizeYouTubeProviderAccountId(
      filters.providerAccountId || filters.provider_account_id
    ));
    predicates.push(`provider_account_id = $${params.length}`);
  }

  if (filters.status) {
    params.push(normalizeStatus(filters.status));
    predicates.push(`status = $${params.length}`);
  }

  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_subscriptions
      WHERE ${predicates.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT 100
    `,
    params
  );
  return (result.rows || []).map(mapSubscriptionRow);
}

async function listCodeClipYouTubeWebSubSubscriptionAudit(filters = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const predicates = [
    "vertical = 'codeclip'",
    "provider = 'youtube'",
  ];
  const params = [];

  if (filters.callbackId || filters.callback_id) {
    params.push(normalizeCallbackId(filters.callbackId || filters.callback_id));
    predicates.push(`callback_id = $${params.length}`);
  }

  if (filters.providerAccountId || filters.provider_account_id) {
    params.push(normalizeYouTubeProviderAccountId(
      filters.providerAccountId || filters.provider_account_id
    ));
    predicates.push(`provider_account_id = $${params.length}`);
  }

  const limit = Number.parseInt(String(filters.limit || 100), 10);
  const normalizedLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 200 ? limit : 100;
  params.push(normalizedLimit);

  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_subscription_audit
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );
  return (result.rows || []).map(mapSubscriptionAuditRow);
}

async function updateStatusByCallbackId(callbackId, fields = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const status = normalizeStatus(fields.status);
  const pendingMode = normalizePendingMode(fields.pendingMode);
  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        status = $2,
        pending_mode = $3,
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
      RETURNING *
    `,
    [normalizedCallbackId, status, pendingMode]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function markCodeClipYouTubeWebSubSubscriptionVerified(
  callbackId,
  { verifiedAt, leaseStartedAt, leaseExpiresAt, activationBoundaryAt, activationBoundaryVideoId, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const normalizedVerifiedAt = normalizeOptionalTimestamp(verifiedAt, "verifiedAt") || new Date().toISOString();
  const normalizedLeaseStartedAt =
    normalizeOptionalTimestamp(leaseStartedAt, "leaseStartedAt") || normalizedVerifiedAt;
  const normalizedLeaseExpiresAt = normalizeOptionalTimestamp(leaseExpiresAt, "leaseExpiresAt");
  const normalizedBoundaryAt =
    normalizeOptionalTimestamp(activationBoundaryAt, "activationBoundaryAt") || normalizedVerifiedAt;
  const normalizedBoundaryVideoId = normalizeOptionalVideoId(
    activationBoundaryVideoId,
    "activationBoundaryVideoId"
  );

  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        status = 'active',
        pending_mode = NULL,
        activation_boundary_at = COALESCE(activation_boundary_at, $2::timestamptz),
        activation_boundary_video_id = COALESCE(activation_boundary_video_id, $3),
        activated_at = COALESCE(activated_at, $4::timestamptz),
        lease_started_at = $5::timestamptz,
        lease_expires_at = $6::timestamptz,
        last_verified_at = $4::timestamptz,
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
      RETURNING *
    `,
    [
      normalizedCallbackId,
      normalizedBoundaryAt,
      normalizedBoundaryVideoId,
      normalizedVerifiedAt,
      normalizedLeaseStartedAt,
      normalizedLeaseExpiresAt,
    ]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function markCodeClipYouTubeWebSubSubscriptionRenewalPending(callbackId, options = {}) {
  return updateStatusByCallbackId(
    callbackId,
    { status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL, pendingMode: PENDING_MODES.SUBSCRIBE },
    options
  );
}

async function markCodeClipYouTubeWebSubSubscriptionUnsubscribePending(callbackId, options = {}) {
  return updateStatusByCallbackId(
    callbackId,
    { status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE, pendingMode: PENDING_MODES.UNSUBSCRIBE },
    options
  );
}

async function markCodeClipYouTubeWebSubSubscriptionExpired(callbackId, options = {}) {
  return updateStatusByCallbackId(
    callbackId,
    { status: SUBSCRIPTION_STATUSES.EXPIRED, pendingMode: null },
    options
  );
}

async function markCodeClipYouTubeWebSubSubscriptionUnsubscribed(callbackId, options = {}) {
  return updateStatusByCallbackId(
    callbackId,
    { status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED, pendingMode: null },
    options
  );
}

async function disableCodeClipYouTubeWebSubSubscription(callbackId, options = {}) {
  return updateStatusByCallbackId(
    callbackId,
    { status: SUBSCRIPTION_STATUSES.DISABLED, pendingMode: null },
    options
  );
}

async function updateCodeClipYouTubeWebSubSubscriptionLease(
  callbackId,
  { leaseStartedAt, leaseExpiresAt, lastVerifiedAt, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const normalizedLeaseStartedAt = normalizeOptionalTimestamp(leaseStartedAt, "leaseStartedAt");
  const normalizedLeaseExpiresAt = normalizeOptionalTimestamp(leaseExpiresAt, "leaseExpiresAt");
  const normalizedLastVerifiedAt = normalizeOptionalTimestamp(lastVerifiedAt, "lastVerifiedAt");
  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        lease_started_at = COALESCE($2::timestamptz, lease_started_at),
        lease_expires_at = COALESCE($3::timestamptz, lease_expires_at),
        last_verified_at = COALESCE($4::timestamptz, last_verified_at),
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
      RETURNING *
    `,
    [
      normalizedCallbackId,
      normalizedLeaseStartedAt,
      normalizedLeaseExpiresAt,
      normalizedLastVerifiedAt,
    ]
  );
  return mapSubscriptionRow(result.rows?.[0] || null);
}

async function recordCodeClipYouTubeWebSubFirstActivatedVideo(
  callbackId,
  { videoId, activatedAt, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const normalizedVideoId = normalizeOptionalVideoId(videoId, "videoId");
  if (!normalizedVideoId) {
    throw subscriptionInputError("videoId is required", { fieldName: "videoId" });
  }
  const normalizedActivatedAt =
    normalizeOptionalTimestamp(activatedAt, "activatedAt") || new Date().toISOString();
  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_subscriptions
      SET
        first_activated_video_id = $2,
        first_activated_at = $3::timestamptz,
        updated_at = NOW()
      WHERE callback_id = $1
        AND vertical = 'codeclip'
        AND provider = 'youtube'
        AND channel = 'youtube'
        AND first_activated_video_id IS NULL
      RETURNING *
    `,
    [normalizedCallbackId, normalizedVideoId, normalizedActivatedAt]
  );

  if (result.rows?.[0]) return mapSubscriptionRow(result.rows[0]);
  return getCodeClipYouTubeWebSubSubscriptionByCallbackId(normalizedCallbackId, {
    queryClient: client,
  });
}

module.exports = {
  CodeClipYouTubeWebSubSubscriptionError,
  PENDING_MODES,
  SUBSCRIPTION_STATUSES,
  claimCodeClipYouTubeWebSubRenewDispatch,
  claimCodeClipYouTubeWebSubSubscribeDispatch,
  claimCodeClipYouTubeWebSubUnsubscribeDispatch,
  createPendingCodeClipYouTubeWebSubSubscription,
  disableCodeClipYouTubeWebSubSubscription,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  getCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  listCodeClipYouTubeWebSubSubscriptionAudit,
  listCodeClipYouTubeWebSubSubscriptions,
  markCodeClipYouTubeWebSubSubscriptionExpired,
  markCodeClipYouTubeWebSubSubscriptionRenewalPending,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribePending,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribed,
  markCodeClipYouTubeWebSubSubscriptionVerified,
  normalizeCallbackId,
  normalizeSubscriptionInput,
  recordCodeClipYouTubeWebSubRenewDispatchResult,
  recordCodeClipYouTubeWebSubSubscribeDispatchResult,
  recordCodeClipYouTubeWebSubUnsubscribeDispatchResult,
  recordCodeClipYouTubeWebSubSubscriptionAudit,
  recordCodeClipYouTubeWebSubFirstActivatedVideo,
  toInternalCodeClipYouTubeWebSubSubscription,
  updateCodeClipYouTubeWebSubSubscriptionLease,
};
