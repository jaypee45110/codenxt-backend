const {
  DISPATCH_MAX_ATTEMPT_COUNT,
  OUTBOUND_STATUSES,
  buildDispatchOwnershipMetadata,
  buildMetaMessengerOutboundIdempotencyKey,
  normalizeDispatchAttemptId,
  normalizeDispatchAttemptNumber,
  normalizeDispatchNow,
  normalizeDispatchStaleAfterSeconds,
  readDispatchOwnershipAttemptId,
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

function parseAuthoritativeAttemptCount(row = {}) {
  const attemptCount = Number(row.attemptCount);
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    return { ok: false, reason: "DISPATCH_AUTHORITATIVE_STATE_INVALID" };
  }
  if (attemptCount > DISPATCH_MAX_ATTEMPT_COUNT + 1) {
    return { ok: false, reason: "ATTEMPT_NUMBER_OVERFLOW" };
  }
  return { ok: true, attemptCount };
}

function parseAuthoritativeTimestamp(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) return { ok: false, reason: "DISPATCH_AUTHORITATIVE_STATE_INVALID" };
    return { ok: true, value: null, epochMs: null };
  }
  const normalized =
    value instanceof Date ? value.toISOString() : normalizeString(value);
  const epochMs = Date.parse(normalized);
  if (!normalized || !Number.isFinite(epochMs)) {
    return { ok: false, reason: "DISPATCH_AUTHORITATIVE_STATE_INVALID" };
  }
  return { ok: true, value: normalized, epochMs };
}

/**
 * Validates authoritative lifecycle fields only.
 * Ownership token (last_error_metadata.attemptId) is never used to derive or repair state.
 */
function validateAuthoritativeDispatchState(row = {}) {
  const status = normalizeString(row.status);
  const terminal = Boolean(row.terminal);
  const retryEligible = Boolean(row.retryEligible);
  const attemptCountResult = parseAuthoritativeAttemptCount(row);
  if (!attemptCountResult.ok) {
    return repositoryError("conflict", attemptCountResult.reason, {
      invariant: "authoritative_state",
    });
  }

  const claimedAt = parseAuthoritativeTimestamp(row.claimedAt, false);
  if (!claimedAt.ok) {
    return repositoryError("conflict", claimedAt.reason, { field: "claimedAt" });
  }
  const sentAt = parseAuthoritativeTimestamp(row.sentAt, false);
  if (!sentAt.ok) {
    return repositoryError("conflict", sentAt.reason, { field: "sentAt" });
  }
  const failedAt = parseAuthoritativeTimestamp(row.failedAt, false);
  if (!failedAt.ok) {
    return repositoryError("conflict", failedAt.reason, { field: "failedAt" });
  }

  const expected = {
    [OUTBOUND_STATUSES.PENDING]: { terminal: false, retryEligible: true },
    [OUTBOUND_STATUSES.CLAIMED]: { terminal: false, retryEligible: false },
    [OUTBOUND_STATUSES.RETRYABLE_FAILED]: { terminal: false, retryEligible: true },
    [OUTBOUND_STATUSES.SENT]: { terminal: true, retryEligible: false },
    [OUTBOUND_STATUSES.TERMINAL_FAILED]: { terminal: true, retryEligible: false },
  }[status];

  if (!expected) {
    return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
      field: "status",
      status,
    });
  }
  if (terminal !== expected.terminal || retryEligible !== expected.retryEligible) {
    return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
      field: "status_flags",
      status,
      terminal,
      retryEligible,
    });
  }

  if (status === OUTBOUND_STATUSES.CLAIMED) {
    if (!claimedAt.value || attemptCountResult.attemptCount < 1) {
      return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
        field: "claimed",
      });
    }
  }
  if (status === OUTBOUND_STATUSES.PENDING && attemptCountResult.attemptCount !== 0) {
    return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
      field: "pending_attempt_count",
    });
  }
  if (status === OUTBOUND_STATUSES.SENT && !sentAt.value) {
    return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
      field: "sentAt",
    });
  }
  if (
    (status === OUTBOUND_STATUSES.RETRYABLE_FAILED ||
      status === OUTBOUND_STATUSES.TERMINAL_FAILED) &&
    !failedAt.value
  ) {
    return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID", {
      field: "failedAt",
    });
  }

  return {
    ok: true,
    status,
    attemptCount: attemptCountResult.attemptCount,
    terminal,
    retryEligible,
    claimedAt,
    sentAt,
    failedAt,
  };
}

/**
 * Ownership token must agree with caller when present for active ownership checks.
 * Never reconstructs authoritative state from the token. Fail closed on inconsistency.
 */
function requireOwnershipTokenConsistency(row, expectedAttemptId = null) {
  const ownership = readDispatchOwnershipAttemptId(row.lastErrorMetadata);
  if (!ownership.ok) {
    return repositoryError("conflict", ownership.reason || "DISPATCH_OWNERSHIP_METADATA_INVALID", {
      invariant: "ownership_token_not_source_of_truth",
    });
  }

  const authoritative = validateAuthoritativeDispatchState(row);
  if (!authoritative.ok) return authoritative;

  if (authoritative.status === OUTBOUND_STATUSES.PENDING) {
    if (ownership.present) {
      return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
        reason: "pending_with_ownership_token",
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    return { ok: true, ownership, authoritative };
  }

  if (authoritative.status === OUTBOUND_STATUSES.CLAIMED) {
    if (!ownership.present) {
      return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
        reason: "claimed_without_ownership_token",
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    if (expectedAttemptId && ownership.attemptId !== expectedAttemptId) {
      return repositoryError("conflict", "DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH", {
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    return { ok: true, ownership, authoritative };
  }

  if (
    authoritative.status === OUTBOUND_STATUSES.SENT ||
    authoritative.status === OUTBOUND_STATUSES.RETRYABLE_FAILED ||
    authoritative.status === OUTBOUND_STATUSES.TERMINAL_FAILED
  ) {
    if (!ownership.present) {
      return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
        reason: "terminal_or_failed_without_ownership_token",
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    if (expectedAttemptId && ownership.attemptId !== expectedAttemptId) {
      return repositoryError("conflict", "DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH", {
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    return { ok: true, ownership, authoritative };
  }

  return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID");
}

function isClaimStale(claimedAtEpochMs, nowEpochMs, staleAfterSeconds) {
  if (!Number.isFinite(claimedAtEpochMs) || !Number.isFinite(nowEpochMs)) return false;
  return claimedAtEpochMs + staleAfterSeconds * 1000 <= nowEpochMs;
}

async function applyOutboundDispatchUpdate(id, expected, values, queryClient) {
  const result = await queryClient.query(
    `
      UPDATE ${TABLE_NAME}
      SET
        status = $2,
        attempt_count = $3,
        retry_eligible = $4,
        terminal = $5,
        last_error_code = $6,
        last_error_metadata = $7::jsonb,
        claimed_at = $8::timestamptz,
        sent_at = $9::timestamptz,
        failed_at = $10::timestamptz,
        updated_at = $11::timestamptz
      WHERE id = $1
        AND status = $12
        AND attempt_count = $13
        AND terminal IS NOT DISTINCT FROM $14
        AND retry_eligible IS NOT DISTINCT FROM $15
      RETURNING *
    `,
    [
      id,
      values.status,
      values.attemptCount,
      values.retryEligible,
      values.terminal,
      values.lastErrorCode,
      values.lastErrorMetadata === null ? null : JSON.stringify(values.lastErrorMetadata),
      values.claimedAt,
      values.sentAt,
      values.failedAt,
      values.updatedAt,
      expected.status,
      expected.attemptCount,
      expected.terminal,
      expected.retryEligible,
    ]
  );
  return mapCodeClipMetaMessengerOutboundRow(result.rows?.[0] || null);
}

async function claimCodeClipMetaMessengerOutboundDispatch(input = {}, queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return repositoryError("failed", "QUERY_CLIENT_REQUIRED");
  }

  const outboundId = Number(input.outboundId);
  if (!Number.isInteger(outboundId) || outboundId <= 0) {
    return repositoryError("invalid_id", "OUTBOUND_ID_INVALID");
  }
  const attemptIdResult = normalizeDispatchAttemptId(input.attemptId);
  if (!attemptIdResult.ok) {
    return repositoryError("invalid_attempt_id", attemptIdResult.reason, attemptIdResult.details || {});
  }
  const staleResult = normalizeDispatchStaleAfterSeconds(input.staleAfterSeconds);
  if (!staleResult.ok) {
    return repositoryError("invalid_stale_after", staleResult.reason, staleResult.details || {});
  }
  const nowResult = normalizeDispatchNow(input.now);
  if (!nowResult.ok) {
    return repositoryError("invalid_now", nowResult.reason, nowResult.details || {});
  }

  const ownershipMetadata = buildDispatchOwnershipMetadata(attemptIdResult.attemptId);
  if (!ownershipMetadata.ok) {
    return repositoryError("invalid_attempt_id", ownershipMetadata.reason);
  }

  try {
    const current = await getCodeClipMetaMessengerOutboundById(outboundId, queryClient);
    if (!current.ok) return current;

    // Authoritative lifecycle fields are source of truth. Ownership token is never used to
    // derive or repair status/attempt_count/flags/timestamps.
    const authoritativeOnly = validateAuthoritativeDispatchState(current.row);
    if (!authoritativeOnly.ok) return authoritativeOnly;

    const ownership = readDispatchOwnershipAttemptId(current.row.lastErrorMetadata);
    if (!ownership.ok) {
      return repositoryError("conflict", ownership.reason || "DISPATCH_OWNERSHIP_METADATA_INVALID", {
        invariant: "ownership_token_not_source_of_truth",
      });
    }

    if (authoritativeOnly.status === OUTBOUND_STATUSES.PENDING) {
      if (ownership.present) {
        return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
          reason: "pending_with_ownership_token",
          invariant: "ownership_token_not_source_of_truth",
        });
      }
    } else if (authoritativeOnly.status === OUTBOUND_STATUSES.CLAIMED) {
      if (!ownership.present) {
        return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
          reason: "claimed_without_ownership_token",
          invariant: "ownership_token_not_source_of_truth",
        });
      }
      const stale = isClaimStale(
        authoritativeOnly.claimedAt.epochMs,
        nowResult.now.getTime(),
        staleResult.staleAfterSeconds
      );
      if (!stale) {
        if (ownership.attemptId === attemptIdResult.attemptId) {
          return {
            ok: true,
            status: "existing",
            claimed: false,
            existing: true,
            row: current.row,
          };
        }
        return repositoryError("conflict", "ACTIVE_CLAIM_NOT_STALE", {
          invariant: "ownership_token_not_source_of_truth",
        });
      }
      // Stale reclaim is driven only by authoritative claimed_at + cutoff.
    } else if (authoritativeOnly.status === OUTBOUND_STATUSES.RETRYABLE_FAILED) {
      if (!ownership.present) {
        return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
          reason: "retryable_failed_without_ownership_token",
          invariant: "ownership_token_not_source_of_truth",
        });
      }
    } else if (
      authoritativeOnly.status === OUTBOUND_STATUSES.SENT ||
      authoritativeOnly.status === OUTBOUND_STATUSES.TERMINAL_FAILED
    ) {
      return repositoryError("conflict", "DISPATCH_NOT_CLAIMABLE", {
        status: authoritativeOnly.status,
      });
    } else {
      return repositoryError("conflict", "DISPATCH_AUTHORITATIVE_STATE_INVALID");
    }

    const nextAttemptCount = authoritativeOnly.attemptCount + 1;
    if (nextAttemptCount > DISPATCH_MAX_ATTEMPT_COUNT) {
      return repositoryError("conflict", "ATTEMPT_NUMBER_OVERFLOW");
    }

    const updated = await applyOutboundDispatchUpdate(
      outboundId,
      {
        status: authoritativeOnly.status,
        attemptCount: authoritativeOnly.attemptCount,
        terminal: authoritativeOnly.terminal,
        retryEligible: authoritativeOnly.retryEligible,
      },
      {
        status: OUTBOUND_STATUSES.CLAIMED,
        attemptCount: nextAttemptCount,
        retryEligible: false,
        terminal: false,
        lastErrorCode: null,
        lastErrorMetadata: ownershipMetadata.metadata,
        claimedAt: nowResult.nowIso,
        sentAt: current.row.sentAt,
        failedAt: current.row.failedAt,
        updatedAt: nowResult.nowIso,
      },
      queryClient
    );

    if (!updated) {
      return repositoryError("conflict", "DISPATCH_CLAIM_RACE", {
        invariant: "authoritative_optimistic_lock",
      });
    }

    return {
      ok: true,
      status: "claimed",
      claimed: true,
      existing: false,
      row: updated,
    };
  } catch (error) {
    return repositoryError("failed", "REPOSITORY_ERROR", {}, error);
  }
}

function normalizeFailureCode(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length > 120) return null;
  return normalized.toLowerCase().replace(/[^a-z0-9_:-]/g, "_");
}

async function recordCodeClipMetaMessengerOutboundDispatchResult(input = {}, queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return repositoryError("failed", "QUERY_CLIENT_REQUIRED");
  }

  const outboundId = Number(input.outboundId);
  if (!Number.isInteger(outboundId) || outboundId <= 0) {
    return repositoryError("invalid_id", "OUTBOUND_ID_INVALID");
  }
  const attemptIdResult = normalizeDispatchAttemptId(input.attemptId);
  if (!attemptIdResult.ok) {
    return repositoryError("invalid_attempt_id", attemptIdResult.reason, attemptIdResult.details || {});
  }
  const attemptNumberResult = normalizeDispatchAttemptNumber(input.attemptNumber);
  if (!attemptNumberResult.ok) {
    return repositoryError(
      "invalid_attempt_number",
      attemptNumberResult.reason,
      attemptNumberResult.details || {}
    );
  }

  let outcome;
  const rawOutcome = normalizeString(input.outcome).toLowerCase();
  if (rawOutcome === OUTBOUND_STATUSES.SENT || rawOutcome === "accepted") {
    outcome = OUTBOUND_STATUSES.SENT;
  } else if (rawOutcome === OUTBOUND_STATUSES.RETRYABLE_FAILED) {
    outcome = OUTBOUND_STATUSES.RETRYABLE_FAILED;
  } else if (rawOutcome === OUTBOUND_STATUSES.TERMINAL_FAILED) {
    outcome = OUTBOUND_STATUSES.TERMINAL_FAILED;
  } else if (rawOutcome === "failed") {
    outcome =
      input.retryable === true
        ? OUTBOUND_STATUSES.RETRYABLE_FAILED
        : OUTBOUND_STATUSES.TERMINAL_FAILED;
  } else {
    return repositoryError("invalid_outcome", "DISPATCH_OUTCOME_INVALID");
  }

  const nowResult = normalizeDispatchNow(input.now);
  if (!nowResult.ok) {
    return repositoryError("invalid_now", nowResult.reason, nowResult.details || {});
  }

  let lastErrorCode = null;
  let lastErrorMetadata = buildDispatchOwnershipMetadata(attemptIdResult.attemptId);
  if (!lastErrorMetadata.ok) {
    return repositoryError("invalid_attempt_id", lastErrorMetadata.reason);
  }
  lastErrorMetadata = lastErrorMetadata.metadata;

  if (outcome !== OUTBOUND_STATUSES.SENT) {
    lastErrorCode = normalizeFailureCode(input.failureCode || input.reason);
    if (!lastErrorCode) {
      return repositoryError("invalid_failure_code", "FAILURE_CODE_REQUIRED");
    }
    if (input.failureMetadata !== undefined && input.failureMetadata !== null) {
      if (typeof input.failureMetadata !== "object" || Array.isArray(input.failureMetadata)) {
        return repositoryError("invalid_failure_metadata", "FAILURE_METADATA_INVALID");
      }
      const forbidden = findForbiddenPersistenceKeys(input.failureMetadata);
      if (forbidden.length > 0) {
        return repositoryError("invalid_failure_metadata", "FORBIDDEN_PERSISTENCE_FIELD", {
          fields: forbidden,
        });
      }
      lastErrorMetadata = {
        attemptId: attemptIdResult.attemptId,
        details: canonicalize(input.failureMetadata),
      };
    }
  }

  // B11.2C does not persist providerMessageId (transport result deferred to B11.2D).
  if (input.providerMessageId !== undefined && input.providerMessageId !== null && input.providerMessageId !== "") {
    return repositoryError("invalid_result", "PROVIDER_MESSAGE_ID_NOT_SUPPORTED_IN_B11_2C");
  }

  try {
    const current = await getCodeClipMetaMessengerOutboundById(outboundId, queryClient);
    if (!current.ok) return current;

    const authoritativeOnly = validateAuthoritativeDispatchState(current.row);
    if (!authoritativeOnly.ok) return authoritativeOnly;

    const ownership = readDispatchOwnershipAttemptId(current.row.lastErrorMetadata);
    if (!ownership.ok) {
      return repositoryError("conflict", ownership.reason || "DISPATCH_OWNERSHIP_METADATA_INVALID", {
        invariant: "ownership_token_not_source_of_truth",
      });
    }

    // Idempotent terminal/failed result for same authoritative attempt_count + ownership token.
    if (
      authoritativeOnly.status === outcome &&
      authoritativeOnly.attemptCount === attemptNumberResult.attemptNumber
    ) {
      if (!ownership.present || ownership.attemptId !== attemptIdResult.attemptId) {
        return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
          invariant: "ownership_token_not_source_of_truth",
        });
      }
      if (outcome !== OUTBOUND_STATUSES.SENT) {
        const existingCode = normalizeString(current.row.lastErrorCode).toLowerCase();
        if (existingCode && existingCode !== lastErrorCode) {
          return repositoryError("conflict", "DISPATCH_RESULT_MISMATCH");
        }
      }
      return {
        ok: true,
        status: "existing",
        recorded: false,
        existing: true,
        row: current.row,
      };
    }

    if (authoritativeOnly.status === OUTBOUND_STATUSES.SENT) {
      return repositoryError("conflict", "DISPATCH_ALREADY_SENT");
    }
    if (authoritativeOnly.status === OUTBOUND_STATUSES.TERMINAL_FAILED) {
      return repositoryError("conflict", "DISPATCH_ALREADY_TERMINAL_FAILED");
    }

    if (authoritativeOnly.status !== OUTBOUND_STATUSES.CLAIMED) {
      return repositoryError("conflict", "DISPATCH_NOT_CLAIMED");
    }
    if (!ownership.present) {
      return repositoryError("conflict", "DISPATCH_STATE_INCONSISTENT", {
        reason: "claimed_without_ownership_token",
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    if (ownership.attemptId !== attemptIdResult.attemptId) {
      return repositoryError("conflict", "DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH", {
        invariant: "ownership_token_not_source_of_truth",
      });
    }
    // attempt_count is source of truth for attempt number; token never repairs it.
    if (authoritativeOnly.attemptCount !== attemptNumberResult.attemptNumber) {
      return repositoryError("conflict", "DISPATCH_ATTEMPT_NUMBER_MISMATCH", {
        authoritativeAttemptCount: authoritativeOnly.attemptCount,
        providedAttemptNumber: attemptNumberResult.attemptNumber,
      });
    }

    const values = {
      status: outcome,
      attemptCount: authoritativeOnly.attemptCount,
      retryEligible: outcome === OUTBOUND_STATUSES.RETRYABLE_FAILED,
      terminal: outcome !== OUTBOUND_STATUSES.RETRYABLE_FAILED,
      lastErrorCode: outcome === OUTBOUND_STATUSES.SENT ? null : lastErrorCode,
      lastErrorMetadata,
      claimedAt: current.row.claimedAt,
      sentAt: outcome === OUTBOUND_STATUSES.SENT ? nowResult.nowIso : current.row.sentAt,
      failedAt:
        outcome === OUTBOUND_STATUSES.SENT ? current.row.failedAt : nowResult.nowIso,
      updatedAt: nowResult.nowIso,
    };

    const updated = await applyOutboundDispatchUpdate(
      outboundId,
      {
        status: OUTBOUND_STATUSES.CLAIMED,
        attemptCount: authoritativeOnly.attemptCount,
        terminal: false,
        retryEligible: false,
      },
      values,
      queryClient
    );

    if (!updated) {
      return repositoryError("conflict", "DISPATCH_RECORD_RACE", {
        invariant: "authoritative_optimistic_lock",
      });
    }

    return {
      ok: true,
      status: outcome === OUTBOUND_STATUSES.SENT ? "sent" : "failed",
      outcome,
      recorded: true,
      existing: false,
      row: updated,
    };
  } catch (error) {
    return repositoryError("failed", "REPOSITORY_ERROR", {}, error);
  }
}

module.exports = {
  TABLE_NAME,
  applyOutboundDispatchUpdate,
  buildExpectedIdempotencyKey,
  buildImmutableSnapshotFromIntent,
  buildValidatedIntent,
  claimCodeClipMetaMessengerOutboundDispatch,
  createOrGetCodeClipMetaMessengerOutbound,
  ensureCodeClipMetaMessengerOutboundSchema,
  findForbiddenPersistenceKeys,
  getCodeClipMetaMessengerOutboundById,
  getCodeClipMetaMessengerOutboundByIdempotencyKey,
  mapCodeClipMetaMessengerOutboundRow,
  recordCodeClipMetaMessengerOutboundDispatchResult,
  requireOwnershipTokenConsistency,
  validateAuthoritativeDispatchState,
};
