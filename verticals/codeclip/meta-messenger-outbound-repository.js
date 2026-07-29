const {
  OUTBOUND_STATUSES,
  buildMetaMessengerOutboundIdempotencyKey,
  validateMetaMessengerOutboundIntent,
} = require("./meta-messenger-outbound");

const TABLE_NAME = "codeclip_meta_messenger_outbounds";
const VERTICAL = "codeclip";
const PROVIDER = "meta";
const CHANNEL = "messenger";
const OUTBOUND_TYPE = "reward_link";

const FORBIDDEN_PERSISTENCE_KEYS = new Set([
  "accessToken",
  "access_token",
  "authorization",
  "Authorization",
  "clientSecret",
  "client_secret",
  "appSecret",
  "app_secret",
  "PAGE_ACCESS",
  "ACCESS_TOKEN",
  "Bearer",
  "messaging_type",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function repositoryError(status, reason, details = {}, error = null) {
  return { ok: false, status, reason, details, row: null, error };
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeJsonField(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      const child = value[key];
      if (child !== undefined) acc[key] = canonicalize(child);
      return acc;
    }, {});
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function findForbiddenPersistenceKeys(value, path = []) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findForbiddenPersistenceKeys(child, path.concat(index)));
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const currentPath = path.concat(key);
    const ownMatch = FORBIDDEN_PERSISTENCE_KEYS.has(key) ? [currentPath.join(".")] : [];
    return ownMatch.concat(findForbiddenPersistenceKeys(child, currentPath));
  });
}

function buildValidatedIntent(input = {}) {
  return {
    provider: PROVIDER,
    channel: CHANNEL,
    providerAccountId: normalizeString(input.providerAccountId),
    recipientId: normalizeString(input.recipientId),
    eventCode: normalizeString(input.eventCode),
    bindingId: normalizeOptionalString(input.bindingId),
    inboundDeliveryId: normalizeOptionalString(input.inboundDeliveryId),
    externalInboundMessageId: normalizeString(input.externalInboundMessageId),
    interactionId: normalizeOptionalString(input.interactionId),
    outboundType: OUTBOUND_TYPE,
    deliverable: canonicalize(input.deliverable || {}),
    idempotencyKey: normalizeString(input.idempotencyKey),
    createdAt: normalizeString(input.createdAt),
  };
}

function buildExpectedIdempotencyKey(input = {}) {
  return buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId: normalizeString(input.providerAccountId),
    externalInboundMessageId: normalizeString(input.externalInboundMessageId),
    outboundType: OUTBOUND_TYPE,
  });
}

function buildImmutableSnapshotFromIntent(intent = {}) {
  const validatedIntent = buildValidatedIntent(intent);
  return {
    vertical: VERTICAL,
    provider: PROVIDER,
    channel: CHANNEL,
    outboundType: OUTBOUND_TYPE,
    eventCode: validatedIntent.eventCode,
    bindingId: validatedIntent.bindingId,
    providerAccountId: validatedIntent.providerAccountId,
    recipientId: validatedIntent.recipientId,
    externalInboundMessageId: validatedIntent.externalInboundMessageId,
    idempotencyKey: validatedIntent.idempotencyKey,
    deliverable: canonicalize(validatedIntent.deliverable),
  };
}

function buildImmutableSnapshotFromRecord(record = {}) {
  return {
    vertical: record.vertical,
    provider: record.provider,
    channel: record.channel,
    outboundType: record.outboundType,
    eventCode: record.eventCode,
    bindingId: record.bindingId,
    providerAccountId: record.providerAccountId,
    recipientId: record.recipientId,
    externalInboundMessageId: record.externalInboundMessageId,
    idempotencyKey: record.idempotencyKey,
    deliverable: canonicalize(record.deliverable),
  };
}

function immutableSnapshotsMatch(left, right) {
  return stableJson(left) === stableJson(right);
}

function mapCodeClipMetaMessengerOutboundRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    vertical: row.vertical,
    provider: row.provider,
    channel: row.channel,
    outboundType: row.outbound_type,
    eventCode: row.event_code,
    bindingId: row.binding_id || null,
    providerAccountId: row.provider_account_id,
    recipientId: row.recipient_id,
    externalInboundMessageId: row.external_inbound_message_id,
    inboundDeliveryId: row.inbound_delivery_id || null,
    interactionId: row.interaction_id || null,
    idempotencyKey: row.idempotency_key,
    deliverableType: row.deliverable_type,
    deliverable: normalizeJsonField(row.deliverable, {}),
    intent: normalizeJsonField(row.intent, {}),
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    retryEligible: Boolean(row.retry_eligible),
    terminal: Boolean(row.terminal),
    lastErrorCode: row.last_error_code || null,
    lastErrorMetadata: normalizeJsonField(row.last_error_metadata, null),
    claimedAt: normalizeTimestamp(row.claimed_at),
    sentAt: normalizeTimestamp(row.sent_at),
    failedAt: normalizeTimestamp(row.failed_at),
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

async function ensureCodeClipMetaMessengerOutboundSchema(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") return;
  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      vertical TEXT NOT NULL DEFAULT '${VERTICAL}',
      provider TEXT NOT NULL DEFAULT '${PROVIDER}',
      channel TEXT NOT NULL DEFAULT '${CHANNEL}',
      outbound_type TEXT NOT NULL DEFAULT '${OUTBOUND_TYPE}',
      event_code TEXT NOT NULL,
      binding_id TEXT,
      provider_account_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      external_inbound_message_id TEXT NOT NULL,
      inbound_delivery_id TEXT,
      interaction_id TEXT,
      idempotency_key TEXT NOT NULL,
      deliverable_type TEXT NOT NULL DEFAULT '${OUTBOUND_TYPE}',
      deliverable JSONB NOT NULL,
      intent JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT '${OUTBOUND_STATUSES.PENDING}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      retry_eligible BOOLEAN NOT NULL DEFAULT TRUE,
      terminal BOOLEAN NOT NULL DEFAULT FALSE,
      last_error_code TEXT,
      last_error_metadata JSONB,
      claimed_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (idempotency_key),
      CHECK (vertical = '${VERTICAL}'),
      CHECK (provider = '${PROVIDER}'),
      CHECK (channel = '${CHANNEL}'),
      CHECK (outbound_type = '${OUTBOUND_TYPE}'),
      CHECK (deliverable_type = '${OUTBOUND_TYPE}'),
      CHECK (status IN (
        '${OUTBOUND_STATUSES.PENDING}',
        '${OUTBOUND_STATUSES.CLAIMED}',
        '${OUTBOUND_STATUSES.SENT}',
        '${OUTBOUND_STATUSES.RETRYABLE_FAILED}',
        '${OUTBOUND_STATUSES.TERMINAL_FAILED}'
      )),
      CHECK (attempt_count >= 0),
      CHECK (
        (status = '${OUTBOUND_STATUSES.PENDING}' AND terminal IS FALSE AND retry_eligible IS TRUE)
        OR (status = '${OUTBOUND_STATUSES.CLAIMED}' AND terminal IS FALSE AND retry_eligible IS FALSE)
        OR (status = '${OUTBOUND_STATUSES.RETRYABLE_FAILED}' AND terminal IS FALSE AND retry_eligible IS TRUE)
        OR (status = '${OUTBOUND_STATUSES.SENT}' AND terminal IS TRUE AND retry_eligible IS FALSE)
        OR (status = '${OUTBOUND_STATUSES.TERMINAL_FAILED}' AND terminal IS TRUE AND retry_eligible IS FALSE)
      )
    )
  `);
  await queryClient.query(`CREATE INDEX IF NOT EXISTS codeclip_meta_messenger_outbounds_status_idx ON ${TABLE_NAME} (status)`);
  await queryClient.query(`CREATE INDEX IF NOT EXISTS codeclip_meta_messenger_outbounds_provider_account_idx ON ${TABLE_NAME} (provider_account_id)`);
  await queryClient.query(`CREATE INDEX IF NOT EXISTS codeclip_meta_messenger_outbounds_external_inbound_idx ON ${TABLE_NAME} (external_inbound_message_id)`);
}

function validateIntentForPersistence(input = {}) {
  const validatedIntent = buildValidatedIntent(input);
  const expectedIdempotencyKey = buildExpectedIdempotencyKey(input);
  const validation = validateMetaMessengerOutboundIntent(validatedIntent);
  if (!validation.ok) {
    return repositoryError("invalid_intent", validation.reason, validation.details || {});
  }
  if (validatedIntent.idempotencyKey !== expectedIdempotencyKey) {
    return repositoryError("invalid_intent", "IDEMPOTENCY_KEY_MISMATCH");
  }
  const forbiddenFields = findForbiddenPersistenceKeys({
    deliverable: validatedIntent.deliverable,
    intent: validatedIntent,
  });
  if (forbiddenFields.length > 0) {
    return repositoryError("invalid_intent", "FORBIDDEN_PERSISTENCE_FIELD", { fields: forbiddenFields });
  }
  return { ok: true, intent: validatedIntent };
}

async function getCodeClipMetaMessengerOutboundById(id, queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return repositoryError("failed", "QUERY_CLIENT_REQUIRED");
  }
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return repositoryError("invalid_id", "OUTBOUND_ID_INVALID");
  }
  try {
    const result = await queryClient.query(`SELECT * FROM ${TABLE_NAME} WHERE id = $1 LIMIT 1`, [normalizedId]);
    const row = mapCodeClipMetaMessengerOutboundRow(result.rows?.[0] || null);
    if (!row) return { ok: false, status: "not_found", reason: "OUTBOUND_NOT_FOUND", row: null };
    return { ok: true, status: "found", row };
  } catch (error) {
    return repositoryError("failed", "REPOSITORY_ERROR", {}, error);
  }
}

async function getCodeClipMetaMessengerOutboundByIdempotencyKey(idempotencyKey, queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return repositoryError("failed", "QUERY_CLIENT_REQUIRED");
  }
  const normalizedKey = normalizeString(idempotencyKey);
  if (!normalizedKey) {
    return repositoryError("invalid_idempotency_key", "IDEMPOTENCY_KEY_REQUIRED");
  }
  try {
    const result = await queryClient.query(
      `SELECT * FROM ${TABLE_NAME} WHERE idempotency_key = $1 LIMIT 1`,
      [normalizedKey]
    );
    const row = mapCodeClipMetaMessengerOutboundRow(result.rows?.[0] || null);
    if (!row) return { ok: false, status: "not_found", reason: "OUTBOUND_NOT_FOUND", row: null };
    return { ok: true, status: "found", row };
  } catch (error) {
    return repositoryError("failed", "REPOSITORY_ERROR", {}, error);
  }
}

async function createOrGetCodeClipMetaMessengerOutbound(input = {}, queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return repositoryError("failed", "QUERY_CLIENT_REQUIRED");
  }
  const validationResult = validateIntentForPersistence(input);
  if (!validationResult.ok) return validationResult;
  const validatedIntent = validationResult.intent;

  try {
    const insertResult = await queryClient.query(
      `
        INSERT INTO ${TABLE_NAME} (
          vertical, provider, channel, outbound_type, event_code, binding_id,
          provider_account_id, recipient_id, external_inbound_message_id,
          inbound_delivery_id, interaction_id, idempotency_key, deliverable_type,
          deliverable, intent, status, attempt_count, retry_eligible, terminal
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `,
      [
        VERTICAL,
        PROVIDER,
        CHANNEL,
        OUTBOUND_TYPE,
        validatedIntent.eventCode,
        validatedIntent.bindingId,
        validatedIntent.providerAccountId,
        validatedIntent.recipientId,
        validatedIntent.externalInboundMessageId,
        validatedIntent.inboundDeliveryId,
        validatedIntent.interactionId,
        validatedIntent.idempotencyKey,
        validatedIntent.deliverable.type,
        JSON.stringify(canonicalize(validatedIntent.deliverable)),
        JSON.stringify(canonicalize(validatedIntent)),
        OUTBOUND_STATUSES.PENDING,
        0,
        true,
        false,
      ]
    );
    const createdRow = mapCodeClipMetaMessengerOutboundRow(insertResult.rows?.[0] || null);
    if (createdRow) return { ok: true, status: "created", created: true, existing: false, row: createdRow };

    const existingResult = await getCodeClipMetaMessengerOutboundByIdempotencyKey(
      validatedIntent.idempotencyKey,
      queryClient
    );
    if (!existingResult.ok) {
      if (existingResult.status === "not_found") {
        return repositoryError("failed", "IDEMPOTENCY_CONFLICT_READ_NOT_FOUND", {
          idempotencyKey: validatedIntent.idempotencyKey,
        });
      }
      return repositoryError(
        "failed",
        existingResult.reason || "REPOSITORY_ERROR",
        existingResult.details || {},
        existingResult.error || null
      );
    }

    const expectedSnapshot = buildImmutableSnapshotFromIntent(validatedIntent);
    const actualSnapshot = buildImmutableSnapshotFromRecord(existingResult.row);
    if (!immutableSnapshotsMatch(expectedSnapshot, actualSnapshot)) {
      return {
        ok: false,
        status: "conflict",
        reason: "IDEMPOTENCY_IMMUTABLE_CONFLICT",
        details: { idempotencyKey: validatedIntent.idempotencyKey },
        row: existingResult.row,
      };
    }
    return { ok: true, status: "existing", created: false, existing: true, row: existingResult.row };
  } catch (error) {
    return repositoryError("failed", "REPOSITORY_ERROR", {}, error);
  }
}

module.exports = {
  TABLE_NAME,
  buildExpectedIdempotencyKey,
  buildImmutableSnapshotFromIntent,
  buildValidatedIntent,
  createOrGetCodeClipMetaMessengerOutbound,
  ensureCodeClipMetaMessengerOutboundSchema,
  findForbiddenPersistenceKeys,
  getCodeClipMetaMessengerOutboundById,
  getCodeClipMetaMessengerOutboundByIdempotencyKey,
  mapCodeClipMetaMessengerOutboundRow,
};
