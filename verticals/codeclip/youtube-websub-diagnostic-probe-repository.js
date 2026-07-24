const database = require("../../db");
const {
  DIAGNOSTIC_PROVIDER,
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_PROBE_STATUSES,
  DIAGNOSTIC_PENDING_MODES,
  normalizeDiagnosticProbeId,
  normalizeDiagnosticCallbackId,
  normalizeYouTubeDiagnosticChannelId,
  normalizeYouTubeDiagnosticTopic,
  normalizeDiagnosticProbeRecord,
  applyDiagnosticVerificationTransition,
  applyDiagnosticNotificationObservation,
  applyDiagnosticDispatchFailureTransition,
  applyDiagnosticUnsubscribeTransition,
  buildDiagnosticObservationIdentity,
  serializeDiagnosticProbePublic,
  maskDiagnosticIdentifier,
} = require("./youtube-websub-diagnostic-probe");

const PROBE_ID_CONSTRAINT = "codeclip_youtube_websub_diagnostic_probes_probe_id_key";
const CALLBACK_ID_CONSTRAINT = "codeclip_youtube_websub_diagnostic_probes_callback_id_key";
const OPEN_TOPIC_CONSTRAINT = "codeclip_youtube_websub_diagnostic_open_topic_uidx";
const UNIQUE_VIOLATION = "23505";
const CREATE_SAVEPOINT = "codeclip_youtube_websub_diagnostic_create";
const LIFECYCLE_SAVEPOINT = "codeclip_youtube_websub_diagnostic_lifecycle";
const OBSERVATION_SAVEPOINT = "codeclip_youtube_websub_diagnostic_observation";
const READ_COMMITTED = "read committed";
const CURSOR_VERSION = 1;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

const POSTGRES_INT_MAX = 2147483647;
const DISPATCH_MODES = Object.freeze({
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
});
const DISPATCH_STATUSES = Object.freeze({
  STARTED: "started",
  ACCEPTED: "accepted",
  FAILED: "failed",
});
const DISPATCH_ACTIVE_STATUSES = Object.freeze([DISPATCH_STATUSES.STARTED]);
const DISPATCH_TERMINAL_STATUSES = Object.freeze([DISPATCH_STATUSES.ACCEPTED, DISPATCH_STATUSES.FAILED]);

class CodeClipYouTubeWebSubDiagnosticProbeRepositoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError";
    this.code = code;
    this.details = details;
  }
}

function repositoryError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubDiagnosticProbeRepositoryError(code, message, details);
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw repositoryError(
      "database_unavailable",
      "codeClip YouTube WebSub diagnostic probe repository requires a query client"
    );
  }
  return queryClient;
}

async function withOwnedTransaction(work) {
  if (!database.pool || typeof database.pool.connect !== "function") {
    throw repositoryError("database_unavailable", "database pool is unavailable");
  }
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(client, { owned: true });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertSuppliedTransaction(client) {
  const result = await client.query("SHOW transaction_isolation");
  const isolation = String(result.rows?.[0]?.transaction_isolation || "").trim().toLowerCase();
  if (isolation !== READ_COMMITTED) {
    throw repositoryError("transaction_isolation_unsupported", "diagnostic probe create requires READ COMMITTED", {
      isolation: isolation || null,
    });
  }
}

async function withRepositoryTransaction(queryClient, work) {
  if (queryClient) {
    const client = requireQueryClient(queryClient);
    await assertSuppliedTransaction(client);
    return work(client, { owned: false });
  }
  return withOwnedTransaction(work);
}

async function createSavepoint(client) {
  try {
    await client.query(`SAVEPOINT ${CREATE_SAVEPOINT}`);
  } catch (error) {
    throw repositoryError("transaction_required", "diagnostic probe create requires an active transaction", {
      causeCode: error?.code || null,
    });
  }
}

function normalizeOptionalIsoTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) {
    throw repositoryError("invalid_repository_row", `${fieldName} is invalid`, { fieldName });
  }
  return new Date(timestamp).toISOString();
}

function normalizeRequiredIsoTimestamp(value, fieldName) {
  const normalized = normalizeOptionalIsoTimestamp(value, fieldName);
  if (!normalized) {
    throw repositoryError("invalid_repository_row", `${fieldName} is required`, { fieldName });
  }
  return normalized;
}

function normalizeCanonicalCursorTimestamp(value) {
  if (typeof value !== "string") {
    throw repositoryError("validation_error", "cursor timestamp is invalid", { fieldName: "cursor" });
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw repositoryError("validation_error", "cursor timestamp is invalid", { fieldName: "cursor" });
  }
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== value) {
    throw repositoryError("validation_error", "cursor timestamp is invalid", { fieldName: "cursor" });
  }
  return canonical;
}

function normalizeJsonObject(value, fieldName) {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    try {
      return normalizeJsonObject(JSON.parse(value), fieldName);
    } catch {
      throw repositoryError("invalid_repository_row", `${fieldName} is invalid`, { fieldName });
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw repositoryError("invalid_repository_row", `${fieldName} is invalid`, { fieldName });
  }
  return value;
}

function mapDiagnosticProbeRow(row) {
  if (!row) return null;
  return normalizeDiagnosticProbeRecord({
    probeId: row.probe_id,
    callbackId: row.callback_id,
    provider: row.provider,
    channel: row.channel,
    channelId: row.channel_id,
    topic: row.topic,
    status: row.status,
    pendingMode: row.pending_mode,
    secretVersion: row.secret_version,
    leaseExpiresAt: normalizeOptionalIsoTimestamp(row.lease_expires_at, "leaseExpiresAt"),
    createdAt: normalizeRequiredIsoTimestamp(row.created_at, "createdAt"),
    updatedAt: normalizeRequiredIsoTimestamp(row.updated_at, "updatedAt"),
    verifiedAt: normalizeOptionalIsoTimestamp(row.verified_at, "verifiedAt"),
    firstVerifiedAt: normalizeOptionalIsoTimestamp(row.first_verified_at, "firstVerifiedAt"),
    lastNotificationAt: normalizeOptionalIsoTimestamp(row.last_notification_at, "lastNotificationAt"),
    unsubscribedAt: normalizeOptionalIsoTimestamp(row.unsubscribed_at, "unsubscribedAt"),
    cleanupRequired: row.cleanup_required,
    subscriptionMayExist: row.subscription_may_exist,
    failedOperation: row.failed_operation,
    failedReasonCode: row.failed_reason_code,
    diagnosticMetadata: normalizeJsonObject(row.diagnostic_metadata, "diagnosticMetadata"),
  });
}

function publicProbe(row) {
  return row ? serializeDiagnosticProbePublic(row) : null;
}

function normalizeCreateInput(input = {}) {
  const now = normalizeRequiredIsoTimestamp(input.now || new Date().toISOString(), "now");
  return normalizeDiagnosticProbeRecord({
    probeId: input.probeId,
    callbackId: input.callbackId,
    provider: DIAGNOSTIC_PROVIDER,
    channel: DIAGNOSTIC_CHANNEL,
    channelId: input.channelId,
    topic: input.topic,
    status: DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE,
    pendingMode: DIAGNOSTIC_PENDING_MODES.SUBSCRIBE,
    secretVersion: input.secretVersion || null,
    leaseExpiresAt: null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    verifiedAt: null,
    firstVerifiedAt: null,
    lastNotificationAt: null,
    unsubscribedAt: null,
    cleanupRequired: false,
    subscriptionMayExist: true,
    failedOperation: null,
    failedReasonCode: null,
    diagnosticMetadata: input.diagnosticMetadata || {},
  });
}

function probeInsertParams(record) {
  const normalized = normalizeDiagnosticProbeRecord(record);
  return [
    normalized.probeId,
    normalized.callbackId,
    normalized.provider,
    normalized.channel,
    normalized.channelId,
    normalized.topic,
    normalized.status,
    normalized.pendingMode,
    normalized.secretVersion,
    normalized.leaseExpiresAt,
    normalized.verifiedAt,
    normalized.firstVerifiedAt,
    normalized.lastNotificationAt,
    normalized.unsubscribedAt,
    normalized.cleanupRequired,
    normalized.subscriptionMayExist,
    normalized.failedOperation,
    normalized.failedReasonCode,
    JSON.stringify(normalized.diagnosticMetadata),
    normalized.createdAt,
    normalized.updatedAt,
  ];
}

function sameImmutableIdentity(left, right) {
  if (!left || !right) return false;
  return left.probeId === right.probeId &&
    left.callbackId === right.callbackId &&
    left.provider === right.provider &&
    left.channel === right.channel &&
    left.channelId === right.channelId &&
    left.topic === right.topic;
}

function rowKey(row) {
  if (!row) return null;
  return row.id !== undefined && row.id !== null ? `id:${row.id}` : `${row.probeId}:${row.callbackId}`;
}

function isKnownCreateConflict(error) {
  return error?.code === UNIQUE_VIOLATION && [
    PROBE_ID_CONSTRAINT,
    CALLBACK_ID_CONSTRAINT,
    OPEN_TOPIC_CONSTRAINT,
  ].includes(error.constraint);
}

async function findCreateConflictRows(client, normalized) {
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_probes
      WHERE probe_id = $1
         OR callback_id = $2
         OR (
          provider = $3
          AND channel = $4
          AND channel_id = $5
          AND topic = $6
          AND (
            status IN ('pending_subscribe', 'active', 'pending_unsubscribe')
            OR (
              status = 'failed'
              AND cleanup_required = TRUE
              AND subscription_may_exist = TRUE
            )
          )
        )
      ORDER BY id ASC
    `,
    [
      normalized.probeId,
      normalized.callbackId,
      normalized.provider,
      normalized.channel,
      normalized.channelId,
      normalized.topic,
    ]
  );
  return result.rows || [];
}

function classifyCreateConflict(normalized, rawRows) {
  const rows = rawRows.map(mapDiagnosticProbeRow);
  const rowKeys = new Set(rawRows.map(rowKey).filter(Boolean));
  const exactRows = rows.filter((row) => sameImmutableIdentity(row, normalized));

  if (rows.length === 1 && exactRows.length === 1) {
    return { status: "existing", row: exactRows[0], public: publicProbe(exactRows[0]) };
  }

  if (rowKeys.size === 1 && rows.length > 0 && exactRows.length === rows.length) {
    return { status: "existing", row: exactRows[0], public: publicProbe(exactRows[0]) };
  }

  if (rowKeys.size > 1) {
    throw repositoryError("repository_state_conflict", "diagnostic create matched multiple existing identities");
  }

  const identityConflict = rows.find((row) => (
    row.probeId === normalized.probeId || row.callbackId === normalized.callbackId
  ));
  if (identityConflict) {
    throw repositoryError("identity_conflict", "diagnostic probe identity conflicts with an existing probe", {
      probeId: publicProbe(identityConflict)?.probeId,
      callbackId: publicProbe(identityConflict)?.callbackId,
    });
  }

  const openTopicConflict = rows.find((row) => (
    row.provider === normalized.provider &&
    row.channel === normalized.channel &&
    row.channelId === normalized.channelId &&
    row.topic === normalized.topic
  ));
  if (openTopicConflict) {
    throw repositoryError("open_probe_conflict", "diagnostic topic already has an open probe", {
      probeId: publicProbe(openTopicConflict)?.probeId,
      status: openTopicConflict.status,
    });
  }

  throw repositoryError("create_conflict_unresolved", "unable to classify diagnostic probe create conflict");
}

async function createCodeClipYouTubeWebSubDiagnosticProbe(input = {}, { queryClient } = {}) {
  const normalized = normalizeCreateInput(input);
  return withRepositoryTransaction(queryClient, async (client) => {
    await createSavepoint(client);
    try {
      const result = await client.query(
        `
          INSERT INTO codeclip_youtube_websub_diagnostic_probes (
            probe_id,
            callback_id,
            provider,
            channel,
            channel_id,
            topic,
            status,
            pending_mode,
            secret_version,
            lease_expires_at,
            verified_at,
            first_verified_at,
            last_notification_at,
            unsubscribed_at,
            cleanup_required,
            subscription_may_exist,
            failed_operation,
            failed_reason_code,
            diagnostic_metadata,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21
          )
          RETURNING *
        `,
        probeInsertParams(normalized)
      );
      await client.query(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
      const row = mapDiagnosticProbeRow(result.rows?.[0] || null);
      return { status: "created", row, public: publicProbe(row) };
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${CREATE_SAVEPOINT}`);
      if (isKnownCreateConflict(error)) {
        const rows = await findCreateConflictRows(client, normalized);
        await client.query(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
        return classifyCreateConflict(normalized, rows);
      }
      await client.query(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
      throw error;
    }
  });
}

async function getCodeClipYouTubeWebSubDiagnosticProbeByProbeId(probeId, { queryClient } = {}) {
  const normalizedProbeId = normalizeDiagnosticProbeId(probeId);
  const client = requireQueryClient(queryClient || database.pool);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_probes
      WHERE probe_id = $1
      LIMIT 1
    `,
    [normalizedProbeId]
  );
  const row = mapDiagnosticProbeRow(result.rows?.[0] || null);
  return row ? { row, public: publicProbe(row) } : null;
}

async function getCodeClipYouTubeWebSubDiagnosticProbeByCallbackId(callbackId, { queryClient } = {}) {
  const normalizedCallbackId = normalizeDiagnosticCallbackId(callbackId);
  const client = requireQueryClient(queryClient || database.pool);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_probes
      WHERE callback_id = $1
      LIMIT 1
    `,
    [normalizedCallbackId]
  );
  const row = mapDiagnosticProbeRow(result.rows?.[0] || null);
  return row ? { row, public: publicProbe(row) } : null;
}

async function getCodeClipYouTubeWebSubDiagnosticObservationSummary(probeId, { queryClient, limit = 10 } = {}) {
  const normalizedProbeId = normalizeDiagnosticProbeId(probeId);
  const client = requireQueryClient(queryClient || database.pool);
  const normalizedLimit = Math.min(
    Math.max(Number.parseInt(String(limit || 10), 10) || 10, 0),
    25
  );
  const countResult = await client.query(
    `
      SELECT COUNT(*) AS count
      FROM codeclip_youtube_websub_diagnostic_observations
      WHERE probe_id = $1
    `,
    [normalizedProbeId]
  );
  const rowsResult = normalizedLimit > 0
    ? await client.query(
        `
          SELECT *
          FROM codeclip_youtube_websub_diagnostic_observations
          WHERE probe_id = $1
          ORDER BY last_observed_at DESC, id DESC
          LIMIT $2
        `,
        [normalizedProbeId, normalizedLimit]
      )
    : { rows: [] };
  return {
    count: Number.parseInt(String(countResult.rows?.[0]?.count || 0), 10) || 0,
    items: (rowsResult.rows || []).map(serializeDiagnosticObservationPublic),
  };
}

function encodeDiagnosticProbeCursor(row) {
  if (!row) return null;
  const createdAt = normalizeRequiredIsoTimestamp(row.created_at, "createdAt");
  const id = String(row.id || "").trim();
  normalizeCursorId(id);
  const json = JSON.stringify({ v: CURSOR_VERSION, createdAt, id });
  return Buffer.from(json, "utf8").toString("base64url");
}

function normalizeCursorId(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw repositoryError("validation_error", "cursor id is invalid", { fieldName: "cursor" });
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > POSTGRES_BIGINT_MAX) {
    throw repositoryError("validation_error", "cursor id is invalid", { fieldName: "cursor" });
  }
  return value;
}

function decodeDiagnosticProbeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw repositoryError("validation_error", "cursor is invalid", { fieldName: "cursor" });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw repositoryError("validation_error", "cursor is invalid", { fieldName: "cursor" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== CURSOR_VERSION) {
    throw repositoryError("validation_error", "cursor version is unsupported", { fieldName: "cursor" });
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "createdAt,id,v") {
    throw repositoryError("validation_error", "cursor is invalid", { fieldName: "cursor" });
  }
  return {
    createdAt: normalizeCanonicalCursorTimestamp(parsed.createdAt),
    id: normalizeCursorId(parsed.id),
  };
}

function normalizeListLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LIST_LIMIT;
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw repositoryError("validation_error", "limit is invalid", { fieldName: "limit" });
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw repositoryError("validation_error", "limit is invalid", { fieldName: "limit" });
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}

async function listCodeClipYouTubeWebSubDiagnosticProbes(filters = {}, { queryClient } = {}) {
  const client = requireQueryClient(queryClient || database.pool);
  const limit = normalizeListLimit(filters.limit);
  const cursor = decodeDiagnosticProbeCursor(filters.cursor);
  const values = [];
  const clauses = [];

  if (filters.status !== undefined && filters.status !== null && filters.status !== "") {
    values.push(String(filters.status));
    clauses.push(`status = $${values.length}`);
  }
  if (filters.channelId !== undefined && filters.channelId !== null && filters.channelId !== "") {
    values.push(normalizeYouTubeDiagnosticChannelId(filters.channelId));
    clauses.push(`channel_id = $${values.length}`);
  }
  if (filters.topic !== undefined && filters.topic !== null && filters.topic !== "") {
    if (!filters.channelId) {
      throw repositoryError("validation_error", "channelId is required when filtering by topic", {
        fieldName: "channelId",
      });
    }
    values.push(normalizeYouTubeDiagnosticTopic(filters.topic, filters.channelId));
    clauses.push(`topic = $${values.length}`);
  }
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
  }

  values.push(limit + 1);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_probes
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `,
    values
  );
  const rawRows = result.rows || [];
  const pageRows = rawRows.slice(0, limit);
  const rows = pageRows.map(mapDiagnosticProbeRow);
  return {
    probes: rows.map(publicProbe),
    nextCursor: rawRows.length > limit ? encodeDiagnosticProbeCursor(pageRows[pageRows.length - 1]) : null,
  };
}


const OBSERVATION_STATUS = Object.freeze({
  RECORDED: "recorded",
  DUPLICATE: "duplicate",
  UPDATED: "updated",
});

function normalizeOptionalText(value, fieldName, maxLength = 256) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw repositoryError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  const normalized = value.trim();
  if (normalized !== value || !normalized || normalized.length > maxLength) {
    throw repositoryError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeOptionalHash(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = normalizeOptionalText(value, fieldName, 128);
  if (!/^[A-Fa-f0-9]{8,128}$/.test(normalized)) {
    throw repositoryError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return normalized.toLowerCase();
}

function normalizeVideoId(value) {
  const normalized = normalizeOptionalText(value, "videoId", 64);
  if (!normalized || !/^[A-Za-z0-9_-]{6,64}$/.test(normalized)) {
    throw repositoryError("validation_error", "videoId is invalid", { fieldName: "videoId" });
  }
  return normalized;
}

function normalizeObservationMetadata(value) {
  const metadata = normalizeJsonObject(value, "diagnosticMetadata");
  const allowed = new Set(["latest", "replay"]);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key)) {
      throw repositoryError("invalid_repository_row", "observation metadata contains unsupported field", {
        fieldName: "diagnosticMetadata",
      });
    }
  }
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw repositoryError("invalid_repository_row", "observation metadata is too large", {
      fieldName: "diagnosticMetadata",
    });
  }
  return JSON.parse(serialized);
}

function normalizeDiagnosticObservationInput(input = {}, probe) {
  const channelId = normalizeYouTubeDiagnosticChannelId(input.channelId);
  if (channelId !== probe.channelId) {
    throw repositoryError("state_conflict", "observation channel does not match diagnostic probe");
  }
  let topic = probe.topic;
  if (input.topic) {
    try {
      topic = normalizeYouTubeDiagnosticTopic(input.topic, channelId);
    } catch (error) {
      if (error?.name !== "CodeClipYouTubeWebSubDiagnosticProbeError" || error?.code !== "validation_error") {
        throw error;
      }
      throw repositoryError("state_conflict", "observation topic does not match diagnostic probe", {
        causeCode: error.code,
      });
    }
  }
  if (topic !== probe.topic) {
    throw repositoryError("state_conflict", "observation topic does not match diagnostic probe");
  }
  const videoId = normalizeVideoId(input.videoId);
  const publishedAt = normalizeRequiredIsoTimestamp(input.publishedAt, "publishedAt");
  const entryUpdatedAt = normalizeRequiredIsoTimestamp(input.updatedAt || input.entryUpdatedAt, "updatedAt");
  const observedAt = normalizeRequiredIsoTimestamp(input.observedAt, "observedAt");
  const observationIdentity = buildDiagnosticObservationIdentity({ channelId, videoId, publishedAt });
  return {
    probeId: probe.probeId,
    observedCallbackId: input.observedCallbackId ? normalizeDiagnosticCallbackId(input.observedCallbackId) : (input.callbackId ? normalizeDiagnosticCallbackId(input.callbackId) : null),
    provider: DIAGNOSTIC_PROVIDER,
    channel: DIAGNOSTIC_CHANNEL,
    channelId,
    topic,
    observationIdentity,
    entryId: normalizeOptionalText(input.entryId, "entryId", 256),
    videoId,
    publishedAt,
    entryUpdatedAt,
    observedAt,
    notificationHash: normalizeOptionalHash(input.notificationHash, "notificationHash"),
    titleHash: normalizeOptionalHash(input.titleHash, "titleHash"),
    contentType: normalizeOptionalText(input.contentType, "contentType", 128),
  };
}

function buildDiagnosticObservationMetadata(input, { duplicate = false } = {}) {
  return {
    latest: {
      observationIdentity: input.observationIdentity,
      channelId: input.channelId,
      videoId: input.videoId,
      publishedAt: input.publishedAt,
      updatedAt: input.entryUpdatedAt,
      observedAt: input.observedAt,
      titleHash: input.titleHash,
      duplicate,
    },
  };
}

function mapDiagnosticObservationRow(row) {
  if (!row) return null;
  const metadata = normalizeObservationMetadata(row.diagnostic_metadata);
  const probeId = normalizeDiagnosticProbeId(row.probe_id);
  const observedCallbackId = row.observed_callback_id ? normalizeDiagnosticCallbackId(row.observed_callback_id) : null;
  const provider = String(row.provider || "");
  const channel = String(row.channel || "");
  if (provider !== DIAGNOSTIC_PROVIDER || channel !== DIAGNOSTIC_CHANNEL) {
    throw repositoryError("invalid_repository_row", "observation provider/channel is invalid");
  }
  const channelId = normalizeYouTubeDiagnosticChannelId(row.channel_id);
  const topic = normalizeYouTubeDiagnosticTopic(row.topic, channelId);
  const videoId = normalizeVideoId(row.video_id);
  const publishedAt = normalizeRequiredIsoTimestamp(row.published_at, "publishedAt");
  const identity = buildDiagnosticObservationIdentity({ channelId, videoId, publishedAt });
  if (row.observation_identity !== identity) {
    throw repositoryError("invalid_repository_row", "observation identity is invalid", { fieldName: "observationIdentity" });
  }
  const firstObservedAt = normalizeRequiredIsoTimestamp(row.first_observed_at, "firstObservedAt");
  const lastObservedAt = normalizeRequiredIsoTimestamp(row.last_observed_at, "lastObservedAt");
  const entryUpdatedAt = normalizeRequiredIsoTimestamp(row.entry_updated_at, "entryUpdatedAt");
  const createdAt = normalizeRequiredIsoTimestamp(row.created_at, "createdAt");
  const updatedAt = normalizeRequiredIsoTimestamp(row.updated_at, "updatedAt");
  const seenCount = Number.parseInt(String(row.seen_count), 10);
  if (!Number.isSafeInteger(seenCount) || seenCount < 1) {
    throw repositoryError("invalid_repository_row", "seenCount is invalid", { fieldName: "seenCount" });
  }
  if (Date.parse(lastObservedAt) < Date.parse(firstObservedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw repositoryError("invalid_repository_row", "observation timestamps are invalid");
  }
  return {
    id: row.id === undefined || row.id === null ? null : String(row.id),
    probeId,
    observedCallbackId,
    provider,
    channel,
    channelId,
    topic,
    observationIdentity: identity,
    entryId: row.entry_id ? normalizeOptionalText(row.entry_id, "entryId", 256) : null,
    videoId,
    publishedAt,
    entryUpdatedAt,
    firstObservedAt,
    lastObservedAt,
    seenCount,
    notificationHash: row.notification_hash ? normalizeOptionalHash(row.notification_hash, "notificationHash") : null,
    titleHash: row.title_hash ? normalizeOptionalHash(row.title_hash, "titleHash") : null,
    contentType: row.content_type ? normalizeOptionalText(row.content_type, "contentType", 128) : null,
    diagnosticMetadata: metadata,
    createdAt,
    updatedAt,
  };
}

function serializeDiagnosticObservationPublic(row) {
  const observation = mapDiagnosticObservationRow({
    id: row.id,
    probe_id: row.probeId || row.probe_id,
    observed_callback_id: row.observedCallbackId || row.observed_callback_id,
    provider: row.provider,
    channel: row.channel,
    channel_id: row.channelId || row.channel_id,
    topic: row.topic,
    observation_identity: row.observationIdentity || row.observation_identity,
    entry_id: row.entryId || row.entry_id,
    video_id: row.videoId || row.video_id,
    published_at: row.publishedAt || row.published_at,
    entry_updated_at: row.entryUpdatedAt || row.entry_updated_at,
    first_observed_at: row.firstObservedAt || row.first_observed_at,
    last_observed_at: row.lastObservedAt || row.last_observed_at,
    seen_count: row.seenCount || row.seen_count,
    notification_hash: row.notificationHash || row.notification_hash,
    title_hash: row.titleHash || row.title_hash,
    content_type: row.contentType || row.content_type,
    diagnostic_metadata: row.diagnosticMetadata || row.diagnostic_metadata || {},
    created_at: row.createdAt || row.created_at,
    updated_at: row.updatedAt || row.updated_at,
  });
  return {
    observationId: observation.id,
    probeId: maskDiagnosticIdentifier(observation.probeId),
    observedCallbackId: observation.observedCallbackId ? maskDiagnosticIdentifier(observation.observedCallbackId) : null,
    provider: observation.provider,
    channel: observation.channel,
    channelId: observation.channelId,
    topic: observation.topic,
    observationIdentity: maskDiagnosticIdentifier(observation.observationIdentity),
    videoId: maskDiagnosticIdentifier(observation.videoId),
    publishedAt: observation.publishedAt,
    entryUpdatedAt: observation.entryUpdatedAt,
    firstObservedAt: observation.firstObservedAt,
    lastObservedAt: observation.lastObservedAt,
    seenCount: observation.seenCount,
    duplicate: observation.seenCount > 1,
    contentType: observation.contentType,
    titleHash: observation.titleHash,
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
  };
}

function observationInsertParams(input, now) {
  const metadata = buildDiagnosticObservationMetadata(input);
  return [
    input.probeId,
    input.observedCallbackId,
    input.provider,
    input.channel,
    input.channelId,
    input.topic,
    input.observationIdentity,
    input.entryId,
    input.videoId,
    input.publishedAt,
    input.entryUpdatedAt,
    input.observedAt,
    input.observedAt,
    1,
    input.notificationHash,
    input.titleHash,
    input.contentType,
    JSON.stringify(metadata),
    now,
    now,
  ];
}

async function findDiagnosticObservationForUpdate(client, probeId, observationIdentity) {
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_observations
      WHERE probe_id = $1 AND observation_identity = $2
      FOR UPDATE
    `,
    [probeId, observationIdentity]
  );
  if ((result.rows || []).length > 1) {
    throw repositoryError("repository_state_conflict", "diagnostic observation identity matched multiple rows");
  }
  return result.rows?.[0] ? mapDiagnosticObservationRow(result.rows[0]) : null;
}

function validateExistingObservation(existing, input) {
  if (existing.provider !== input.provider || existing.channel !== input.channel || existing.channelId !== input.channelId || existing.topic !== input.topic || existing.videoId !== input.videoId || existing.publishedAt !== input.publishedAt) {
    throw repositoryError("repository_state_conflict", "diagnostic observation immutable identity mismatch");
  }
  if (existing.entryId && input.entryId && existing.entryId !== input.entryId) {
    throw repositoryError("state_conflict", "diagnostic observation entry identity conflicts");
  }
  if (existing.notificationHash && input.notificationHash && existing.notificationHash !== input.notificationHash) {
    throw repositoryError("state_conflict", "diagnostic observation notification hash conflicts");
  }
}

function classifyExistingObservation(existing, input) {
  const observedCompare = Date.parse(input.observedAt) - Date.parse(existing.lastObservedAt);
  const entryCompare = Date.parse(input.entryUpdatedAt) - Date.parse(existing.entryUpdatedAt);
  if (observedCompare > 0 || entryCompare > 0) return OBSERVATION_STATUS.UPDATED;
  if (observedCompare === 0 && entryCompare === 0) {
    const titleMatches = (existing.titleHash || null) === (input.titleHash || null);
    const contentTypeMatches = (existing.contentType || null) === (input.contentType || null);
    const entryMatches = (existing.entryId || null) === (input.entryId || null);
    if (titleMatches && contentTypeMatches && entryMatches) return OBSERVATION_STATUS.DUPLICATE;
    throw repositoryError("state_conflict", "diagnostic observation conflicts at the same timestamp");
  }
  return OBSERVATION_STATUS.DUPLICATE;
}

async function insertDiagnosticObservation(client, input, now) {
  const result = await client.query(
    `
      INSERT INTO codeclip_youtube_websub_diagnostic_observations (
        probe_id,
        observed_callback_id,
        provider,
        channel,
        channel_id,
        topic,
        observation_identity,
        entry_id,
        video_id,
        published_at,
        entry_updated_at,
        first_observed_at,
        last_observed_at,
        seen_count,
        notification_hash,
        title_hash,
        content_type,
        diagnostic_metadata,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20
      )
      RETURNING *
    `,
    observationInsertParams(input, now)
  );
  if ((result.rows || []).length !== 1) {
    throw repositoryError("repository_state_conflict", "diagnostic observation insert did not return exactly one row");
  }
  return mapDiagnosticObservationRow(result.rows[0]);
}

async function updateDiagnosticObservationReplay(client, existing, input, status, now) {
  const isUpdated = status === OBSERVATION_STATUS.UPDATED;
  const nextLastObservedAt = Date.parse(input.observedAt) > Date.parse(existing.lastObservedAt) ? input.observedAt : existing.lastObservedAt;
  const nextEntryUpdatedAt = Date.parse(input.entryUpdatedAt) > Date.parse(existing.entryUpdatedAt) ? input.entryUpdatedAt : existing.entryUpdatedAt;
  const metadata = isUpdated
    ? buildDiagnosticObservationMetadata({ ...input, observedAt: nextLastObservedAt, entryUpdatedAt: nextEntryUpdatedAt }, { duplicate: false })
    : existing.diagnosticMetadata;
  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_diagnostic_observations
      SET
        observed_callback_id = COALESCE(observed_callback_id, $2),
        entry_id = COALESCE(entry_id, $3),
        entry_updated_at = $4,
        last_observed_at = $5,
        seen_count = seen_count + 1,
        notification_hash = COALESCE(notification_hash, $6),
        title_hash = CASE WHEN $10::boolean THEN $7 ELSE title_hash END,
        content_type = CASE WHEN $10::boolean THEN $8 ELSE content_type END,
        diagnostic_metadata = $9::jsonb,
        updated_at = GREATEST(updated_at, $11)
      WHERE id = $1
      RETURNING *
    `,
    [
      existing.id,
      input.observedCallbackId,
      input.entryId,
      nextEntryUpdatedAt,
      nextLastObservedAt,
      input.notificationHash,
      input.titleHash,
      input.contentType,
      JSON.stringify(metadata),
      isUpdated,
      now,
    ]
  );
  if ((result.rows || []).length !== 1) {
    throw repositoryError("repository_state_conflict", "diagnostic observation update did not return exactly one row");
  }
  return mapDiagnosticObservationRow(result.rows[0]);
}

function probeSummaryObservation(input) {
  return {
    observationIdentity: input.observationIdentity,
    channelId: input.channelId,
    videoId: input.videoId,
    publishedAt: input.publishedAt,
    updatedAt: input.entryUpdatedAt,
    observedAt: input.observedAt,
    titleHash: input.titleHash,
  };
}

function applyProbeObservationSummary(record, input, status) {
  if (status === OBSERVATION_STATUS.DUPLICATE) return record;
  const existingObservedAt = record.lastNotificationAt;
  if (existingObservedAt && Date.parse(input.observedAt) < Date.parse(existingObservedAt)) return record;
  if (existingObservedAt && Date.parse(input.observedAt) === Date.parse(existingObservedAt)) {
    const previous = record.diagnosticMetadata?.lastNotification || null;
    if (!previous || isSameNotificationObservation(previous, probeSummaryObservation(input))) return record;
    throw repositoryError("state_conflict", "diagnostic notification summary conflicts at the same timestamp");
  }
  return applyDiagnosticNotificationObservation(record, {
    channelId: input.channelId,
    videoId: input.videoId,
    publishedAt: input.publishedAt,
    updatedAt: input.entryUpdatedAt,
    observedAt: input.observedAt,
    titleHash: input.titleHash,
  });
}

async function createObservationSavepoint(client) {
  try {
    await client.query(`SAVEPOINT ${OBSERVATION_SAVEPOINT}`);
  } catch (error) {
    throw repositoryError("transaction_required", "diagnostic observation persistence requires an active transaction", {
      causeCode: error?.code || null,
    });
  }
}

async function releaseObservationSavepoint(client) {
  await client.query(`RELEASE SAVEPOINT ${OBSERVATION_SAVEPOINT}`);
}

async function rollbackObservationSavepoint(client) {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${OBSERVATION_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${OBSERVATION_SAVEPOINT}`);
  } catch {
    // The outer owned transaction will roll back. Supplied transactions keep repository-owned savepoint isolation.
  }
}

async function recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(input = {}, { queryClient } = {}) {
  return withRepositoryTransaction(queryClient, async (client) => {
    await createObservationSavepoint(client);
    try {
      const locked = await lockDiagnosticProbe(client, input);
      requireStatus(locked.row, [DIAGNOSTIC_PROBE_STATUSES.ACTIVE]);
      const observationInput = normalizeDiagnosticObservationInput(input, locked.row);
      const now = normalizeRequiredIsoTimestamp(input.now || input.observedAt, "now");
      const existing = await findDiagnosticObservationForUpdate(client, observationInput.probeId, observationInput.observationIdentity);
      let status = OBSERVATION_STATUS.RECORDED;
      let observation;
      if (!existing) {
        observation = await insertDiagnosticObservation(client, observationInput, now);
      } else {
        validateExistingObservation(existing, observationInput);
        status = classifyExistingObservation(existing, observationInput);
        observation = await updateDiagnosticObservationReplay(client, existing, observationInput, status, now);
      }
      const nextProbe = normalizeDiagnosticProbeRecord(applyProbeObservationSummary(locked.row, observationInput, status));
      const probe = await updateLockedProbe(client, locked.id, nextProbe);
      await releaseObservationSavepoint(client);
      return {
        status,
        probe,
        publicProbe: publicProbe(probe),
        observation,
        publicObservation: serializeDiagnosticObservationPublic(observation),
      };
    } catch (error) {
      await rollbackObservationSavepoint(client);
      throw error;
    }
  });
}


function normalizeOperationTimestamp(value, fieldName) {
  return normalizeRequiredIsoTimestamp(value, fieldName);
}

function maxIsoTimestamp(...values) {
  const normalized = values.filter(Boolean).map((value) => normalizeRequiredIsoTimestamp(value, "timestamp"));
  if (!normalized.length) return null;
  return normalized.reduce((max, value) => (Date.parse(value) > Date.parse(max) ? value : max));
}

function normalizeAttemptId(value) {
  if (typeof value !== "string") {
    throw repositoryError("validation_error", "attemptId is invalid", { fieldName: "attemptId" });
  }
  const normalized = value.trim();
  if (normalized !== value || !/^[A-Za-z0-9_-]{6,128}$/.test(normalized)) {
    throw repositoryError("validation_error", "attemptId is invalid", { fieldName: "attemptId" });
  }
  return normalized;
}

function normalizeAttemptNumber(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw repositoryError("validation_error", "attemptNumber is invalid", { fieldName: "attemptNumber" });
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > POSTGRES_INT_MAX) {
    throw repositoryError("validation_error", "attemptNumber is invalid", { fieldName: "attemptNumber" });
  }
  return parsed;
}

function normalizeRetryEligible(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw repositoryError("validation_error", "retryEligible is invalid", { fieldName: "retryEligible" });
  }
  return value;
}

function normalizeDispatchMode(mode) {
  if (![DISPATCH_MODES.SUBSCRIBE, DISPATCH_MODES.UNSUBSCRIBE].includes(mode)) {
    throw repositoryError("validation_error", "dispatch mode is invalid", { fieldName: "mode" });
  }
  return mode;
}

function normalizeDispatchMetadata(dispatch) {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return null;
  const mode = normalizeDispatchMode(dispatch.mode);
  const status = String(dispatch.status || "").trim();
  if (!Object.values(DISPATCH_STATUSES).includes(status)) {
    throw repositoryError("invalid_repository_row", "dispatch status is invalid", { fieldName: "diagnosticMetadata.lastDispatch.status" });
  }
  return {
    mode,
    status,
    attemptId: normalizeAttemptId(dispatch.attemptId),
    attemptNumber: normalizeAttemptNumber(dispatch.attemptNumber),
    retryEligible: normalizeRetryEligible(dispatch.retryEligible),
    staleAfterAt: dispatch.staleAfterAt ? normalizeRequiredIsoTimestamp(dispatch.staleAfterAt, "staleAfterAt") : null,
    dispatchedAt: dispatch.dispatchedAt ? normalizeRequiredIsoTimestamp(dispatch.dispatchedAt, "dispatchedAt") : null,
    acceptedAt: dispatch.acceptedAt ? normalizeRequiredIsoTimestamp(dispatch.acceptedAt, "acceptedAt") : null,
    failedAt: dispatch.failedAt ? normalizeRequiredIsoTimestamp(dispatch.failedAt, "failedAt") : null,
    resultCode: dispatch.resultCode ? String(dispatch.resultCode).trim() : null,
  };
}

function getLastDispatch(record) {
  try {
    return normalizeDispatchMetadata(record.diagnosticMetadata?.lastDispatch || null);
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubDiagnosticProbeRepositoryError) {
      throw repositoryError("invalid_repository_row", "persisted dispatch metadata is invalid");
    }
    throw error;
  }
}

function isDispatchActive(dispatch, now) {
  if (!dispatch || !DISPATCH_ACTIVE_STATUSES.includes(dispatch.status)) return false;
  if (!dispatch.staleAfterAt) return true;
  return Date.parse(dispatch.staleAfterAt) > Date.parse(now);
}

function isDispatchReplaceable(dispatch, incoming, now) {
  if (!dispatch) return true;
  if (dispatch.mode !== incoming.mode) {
    if (isDispatchActive(dispatch, now)) {
      throw repositoryError("state_conflict", "active dispatch cannot be replaced");
    }
    return true;
  }
  if (incoming.attemptNumber < dispatch.attemptNumber) {
    throw repositoryError("state_conflict", "dispatch attempt is stale");
  }
  if (incoming.attemptNumber === dispatch.attemptNumber && incoming.attemptId !== dispatch.attemptId) {
    throw repositoryError("state_conflict", "dispatch attempt identity conflicts");
  }
  if (incoming.attemptNumber === dispatch.attemptNumber && incoming.attemptId === dispatch.attemptId) {
    return false;
  }
  if (isDispatchActive(dispatch, now)) {
    throw repositoryError("state_conflict", "active dispatch cannot be replaced");
  }
  if (DISPATCH_TERMINAL_STATUSES.includes(dispatch.status)) return true;
  if (dispatch.status === DISPATCH_STATUSES.FAILED && dispatch.retryEligible === true) return true;
  throw repositoryError("state_conflict", "dispatch cannot be replaced");
}

function buildDispatch({ mode, attemptId, attemptNumber, status, at, staleAfterAt = null, leaseSeconds = null, retryEligible = false, resultCode = null }) {
  const dispatch = {
    mode: normalizeDispatchMode(mode),
    status,
    attemptId: normalizeAttemptId(attemptId),
    attemptNumber: normalizeAttemptNumber(attemptNumber),
    retryEligible: normalizeRetryEligible(retryEligible),
  };
  if (status === DISPATCH_STATUSES.STARTED) dispatch.dispatchedAt = normalizeOperationTimestamp(at, "dispatchedAt");
  if (status === DISPATCH_STATUSES.ACCEPTED) dispatch.acceptedAt = normalizeOperationTimestamp(at, "acceptedAt");
  if (status === DISPATCH_STATUSES.FAILED) dispatch.failedAt = normalizeOperationTimestamp(at, "failedAt");
  if (staleAfterAt) dispatch.staleAfterAt = normalizeOperationTimestamp(staleAfterAt, "staleAfterAt");
  if (leaseSeconds !== null && leaseSeconds !== undefined) dispatch.leaseSeconds = Number.parseInt(String(leaseSeconds), 10);
  if (resultCode) dispatch.resultCode = String(resultCode).trim();
  return dispatch;
}

function replaceMetadata(record, updates = {}) {
  const next = {};
  for (const key of ["lastVerification", "lastDispatch", "lastFailure", "lastNotification", "cleanup"]) {
    if (record.diagnosticMetadata && Object.hasOwn(record.diagnosticMetadata, key)) {
      next[key] = record.diagnosticMetadata[key];
    }
  }
  return { ...next, ...updates };
}

function applyDispatchMetadata(record, input, mode) {
  const at = normalizeOperationTimestamp(input.dispatchedAt, "dispatchedAt");
  const incoming = {
    mode,
    attemptId: normalizeAttemptId(input.attemptId),
    attemptNumber: normalizeAttemptNumber(input.attemptNumber),
  };
  const existing = getLastDispatch(record);
  const replace = isDispatchReplaceable(existing && existing.mode === mode ? existing : existing, incoming, at);
  if (!replace && existing.status === DISPATCH_STATUSES.STARTED) return { row: record, idempotent: true };
  const dispatch = buildDispatch({
    mode,
    attemptId: incoming.attemptId,
    attemptNumber: incoming.attemptNumber,
    status: DISPATCH_STATUSES.STARTED,
    at,
    staleAfterAt: input.staleAfterAt || null,
    leaseSeconds: input.leaseSeconds,
  });
  return {
    row: {
      ...record,
      updatedAt: maxIsoTimestamp(record.updatedAt, at),
      diagnosticMetadata: replaceMetadata(record, { lastDispatch: dispatch }),
    },
    idempotent: false,
  };
}

function applyAcceptedMetadata(record, input, mode) {
  const at = normalizeOperationTimestamp(input.acceptedAt, "acceptedAt");
  const dispatch = getLastDispatch(record);
  if (!dispatch || dispatch.mode !== mode) {
    throw repositoryError("state_conflict", "accepted dispatch mode does not match current dispatch");
  }
  const attemptId = normalizeAttemptId(input.attemptId);
  const attemptNumber = normalizeAttemptNumber(input.attemptNumber);
  if (dispatch.attemptId !== attemptId || dispatch.attemptNumber !== attemptNumber) {
    throw repositoryError("state_conflict", "accepted dispatch attempt does not match current dispatch");
  }
  if (dispatch.status === DISPATCH_STATUSES.ACCEPTED) {
    return { row: record, idempotent: true };
  }
  if (dispatch.status !== DISPATCH_STATUSES.STARTED) {
    throw repositoryError("state_conflict", "dispatch cannot be accepted");
  }
  const nextDispatch = {
    ...dispatch,
    status: DISPATCH_STATUSES.ACCEPTED,
    acceptedAt: at,
    retryEligible: false,
    resultCode: input.resultCode ? String(input.resultCode).trim() : "hub_request_accepted",
  };
  return {
    row: {
      ...record,
      updatedAt: maxIsoTimestamp(record.updatedAt, at),
      diagnosticMetadata: replaceMetadata(record, { lastDispatch: nextDispatch }),
    },
    idempotent: false,
  };
}

function applyFailureMetadata(record, input, operation) {
  const failedAt = normalizeOperationTimestamp(input.failedAt || input.requiredAt, "failedAt");
  const reasonCode = String(input.reasonCode || input.failedReasonCode || "diagnostic_cleanup_required").trim();
  if (!/^[a-z0-9_]{2,80}$/.test(reasonCode)) {
    throw repositoryError("validation_error", "reasonCode is invalid", { fieldName: "reasonCode" });
  }
  const cleanupRequired = input.cleanupRequired === undefined ? false : Boolean(input.cleanupRequired);
  const subscriptionMayExist = input.subscriptionMayExist === undefined ? false : Boolean(input.subscriptionMayExist);
  if (cleanupRequired && !subscriptionMayExist) {
    throw repositoryError("validation_error", "cleanupRequired requires subscriptionMayExist", { fieldName: "subscriptionMayExist" });
  }
  const failed = applyDiagnosticDispatchFailureTransition(record, {
    failedAt,
    failedOperation: operation,
    failedReasonCode: reasonCode,
    cleanupRequired,
    subscriptionMayExist,
  });
  return {
    ...failed,
    updatedAt: maxIsoTimestamp(record.updatedAt, failedAt),
    diagnosticMetadata: replaceMetadata(failed, {
      lastFailure: {
        operation,
        reasonCode,
        failedAt,
        cleanupRequired,
        subscriptionMayExist,
      },
      cleanup: cleanupRequired
        ? { ...(record.diagnosticMetadata.cleanup || {}), requiredAt: failedAt, reasonCode }
        : record.diagnosticMetadata.cleanup,
    }),
  };
}

async function createLifecycleSavepoint(client) {
  try {
    await client.query(`SAVEPOINT ${LIFECYCLE_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${LIFECYCLE_SAVEPOINT}`);
  } catch (error) {
    throw repositoryError("transaction_required", "diagnostic probe lifecycle requires an active transaction", {
      causeCode: error?.code || null,
    });
  }
}

function normalizeIdentity(input = {}) {
  const probeId = input.probeId ? normalizeDiagnosticProbeId(input.probeId) : null;
  const callbackId = input.callbackId ? normalizeDiagnosticCallbackId(input.callbackId) : null;
  if (!probeId && !callbackId) {
    throw repositoryError("validation_error", "probeId or callbackId is required", { fieldName: "probeId" });
  }
  return { probeId, callbackId };
}

async function lockDiagnosticProbe(client, input = {}) {
  const identity = normalizeIdentity(input);
  const values = [];
  const clauses = [];
  if (identity.probeId) {
    values.push(identity.probeId);
    clauses.push(`probe_id = $${values.length}`);
  }
  if (identity.callbackId) {
    values.push(identity.callbackId);
    clauses.push(`callback_id = $${values.length}`);
  }
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_youtube_websub_diagnostic_probes
      WHERE ${clauses.join(" OR ")}
      FOR UPDATE
    `,
    values
  );
  const rawRows = result.rows || [];
  if (!rawRows.length) throw repositoryError("probe_not_found", "diagnostic probe was not found");
  if (rawRows.length !== 1) throw repositoryError("repository_state_conflict", "diagnostic identity matched multiple rows");
  const row = mapDiagnosticProbeRow(rawRows[0]);
  if ((identity.probeId && row.probeId !== identity.probeId) || (identity.callbackId && row.callbackId !== identity.callbackId)) {
    throw repositoryError("repository_state_conflict", "diagnostic identity mismatch");
  }
  return { id: rawRows[0].id, row };
}

function probeUpdateParams(id, record) {
  return [id, ...probeInsertParams(record)];
}

async function updateLockedProbe(client, id, record) {
  const result = await client.query(
    `
      UPDATE codeclip_youtube_websub_diagnostic_probes
      SET
        probe_id = $2,
        callback_id = $3,
        provider = $4,
        channel = $5,
        channel_id = $6,
        topic = $7,
        status = $8,
        pending_mode = $9,
        secret_version = $10,
        lease_expires_at = $11,
        verified_at = $12,
        first_verified_at = $13,
        last_notification_at = $14,
        unsubscribed_at = $15,
        cleanup_required = $16,
        subscription_may_exist = $17,
        failed_operation = $18,
        failed_reason_code = $19,
        diagnostic_metadata = $20::jsonb,
        created_at = $21,
        updated_at = $22
      WHERE id = $1
      RETURNING *
    `,
    probeUpdateParams(id, record)
  );
  if ((result.rows || []).length !== 1) {
    throw repositoryError("repository_state_conflict", "diagnostic lifecycle update did not update exactly one row");
  }
  return mapDiagnosticProbeRow(result.rows[0]);
}

async function runLifecycleOperation(input, transition, { queryClient } = {}) {
  return withRepositoryTransaction(queryClient, async (client) => {
    await createLifecycleSavepoint(client);
    const locked = await lockDiagnosticProbe(client, input);
    const result = transition(locked.row);
    const next = normalizeDiagnosticProbeRecord(result.row);
    if (result.idempotent) return { status: "idempotent", row: locked.row, public: publicProbe(locked.row) };
    const row = await updateLockedProbe(client, locked.id, next);
    return { status: "updated", row, public: publicProbe(row) };
  });
}

function requireStatus(record, statuses) {
  if (!statuses.includes(record.status)) {
    throw repositoryError("state_conflict", "diagnostic probe state does not allow this operation", {
      status: record.status,
    });
  }
}

function markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE]);
    return applyDispatchMetadata(record, input, DISPATCH_MODES.SUBSCRIBE);
  }, options);
}

function requireActiveSubscribeVerificationRace(record) {
  if (record.status !== DIAGNOSTIC_PROBE_STATUSES.ACTIVE || record.pendingMode !== null) {
    throw repositoryError("state_conflict", "active subscribe verification race is not correlated");
  }
  const verification = record.diagnosticMetadata?.lastVerification || null;
  if (
    !verification ||
    verification.mode !== DIAGNOSTIC_PENDING_MODES.SUBSCRIBE ||
    !record.verifiedAt ||
    !record.firstVerifiedAt ||
    !record.leaseExpiresAt
  ) {
    throw repositoryError("state_conflict", "active subscribe verification race is not correlated");
  }
}

function markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (record.status === DIAGNOSTIC_PROBE_STATUSES.ACTIVE) {
      requireActiveSubscribeVerificationRace(record);
      return applyAcceptedMetadata(record, input, DISPATCH_MODES.SUBSCRIBE);
    }
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE]);
    return applyAcceptedMetadata(record, input, DISPATCH_MODES.SUBSCRIBE);
  }, options);
}

function hasVerificationStateChanged(record, next) {
  return next.status !== record.status ||
    next.pendingMode !== record.pendingMode ||
    next.verifiedAt !== record.verifiedAt ||
    next.firstVerifiedAt !== record.firstVerifiedAt ||
    next.leaseExpiresAt !== record.leaseExpiresAt ||
    next.updatedAt !== record.updatedAt ||
    next.subscriptionMayExist !== record.subscriptionMayExist;
}

function markCodeClipYouTubeWebSubDiagnosticVerificationReceived(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (![DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE, DIAGNOSTIC_PROBE_STATUSES.ACTIVE].includes(record.status)) {
      throw repositoryError("state_conflict", "verification is not allowed for current diagnostic state");
    }
    if (input.topic && input.topic !== record.topic) throw repositoryError("state_conflict", "verification topic mismatch");
    if (input.channelId && input.channelId !== record.channelId) throw repositoryError("state_conflict", "verification channel mismatch");
    const next = applyDiagnosticVerificationTransition(record, {
      verifiedAt: input.verifiedAt,
      leaseSeconds: input.leaseSeconds,
    });
    if (!hasVerificationStateChanged(record, next)) return { row: record, idempotent: true };
    return { row: next, idempotent: false };
  }, options);
}

function isSameNotificationObservation(previous, incoming) {
  if (!previous || !incoming) return false;
  return previous.observationIdentity === incoming.observationIdentity &&
    previous.channelId === incoming.channelId &&
    previous.videoId === incoming.videoId &&
    previous.publishedAt === incoming.publishedAt &&
    previous.updatedAt === incoming.updatedAt &&
    (previous.titleHash || null) === (incoming.titleHash || null);
}

function markCodeClipYouTubeWebSubDiagnosticNotificationObserved(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.ACTIVE]);
    const next = applyDiagnosticNotificationObservation(record, input);
    const incomingObservedAt = normalizeOperationTimestamp(input.observedAt, "observedAt");
    const existingObservedAt = record.lastNotificationAt;
    if (existingObservedAt && Date.parse(incomingObservedAt) < Date.parse(existingObservedAt)) {
      return { row: record, idempotent: true };
    }
    if (existingObservedAt && Date.parse(incomingObservedAt) === Date.parse(existingObservedAt)) {
      const previous = record.diagnosticMetadata?.lastNotification || null;
      const incoming = next.diagnosticMetadata?.lastNotification || null;
      if (!previous || isSameNotificationObservation(previous, incoming)) {
        return { row: previous ? record : next, idempotent: true };
      }
      throw repositoryError("state_conflict", "notification observation conflicts at the same timestamp");
    }
    return { row: next, idempotent: JSON.stringify(next) === JSON.stringify(record) };
  }, options);
}

function markCodeClipYouTubeWebSubDiagnosticSubscribeFailed(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (record.status === DIAGNOSTIC_PROBE_STATUSES.FAILED) {
      const existing = record.diagnosticMetadata.lastFailure || {};
      const same = existing.operation === "subscribe" && existing.reasonCode === input.reasonCode;
      if (same) return { row: record, idempotent: true };
      throw repositoryError("state_conflict", "diagnostic failure already recorded");
    }
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE]);
    return { row: applyFailureMetadata(record, { ...input, failedAt: input.failedAt, cleanupRequired: Boolean(input.cleanupRequired), subscriptionMayExist: Boolean(input.subscriptionMayExist) }, "subscribe"), idempotent: false };
  }, options);
}

function markCodeClipYouTubeWebSubDiagnosticUnsubscribeDispatched(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (![DIAGNOSTIC_PROBE_STATUSES.ACTIVE, DIAGNOSTIC_PROBE_STATUSES.FAILED, DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE].includes(record.status)) {
      throw repositoryError("state_conflict", "unsubscribe dispatch is not allowed for current diagnostic state");
    }
    if (record.status === DIAGNOSTIC_PROBE_STATUSES.FAILED && !(record.cleanupRequired && record.subscriptionMayExist)) {
      throw repositoryError("state_conflict", "failed diagnostic probe is not cleanup eligible");
    }
    const prepared = record.status === DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE
      ? record
      : applyDiagnosticUnsubscribeTransition(record, { requestedAt: input.dispatchedAt });
    return applyDispatchMetadata(prepared, input, DISPATCH_MODES.UNSUBSCRIBE);
  }, options);
}

function markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE]);
    return applyAcceptedMetadata(record, input, DISPATCH_MODES.UNSUBSCRIBE);
  }, options);
}

function markCodeClipYouTubeWebSubDiagnosticCleanupRequired(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (![DIAGNOSTIC_PROBE_STATUSES.PENDING_SUBSCRIBE, DIAGNOSTIC_PROBE_STATUSES.ACTIVE, DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE, DIAGNOSTIC_PROBE_STATUSES.FAILED].includes(record.status)) {
      throw repositoryError("state_conflict", "cleanup required is not allowed for current diagnostic state");
    }
    if (input.subscriptionMayExist === false) {
      throw repositoryError("validation_error", "cleanup required implies subscription may exist", { fieldName: "subscriptionMayExist" });
    }
    const reasonCode = input.reasonCode || "diagnostic_cleanup_required";
    if (record.status === DIAGNOSTIC_PROBE_STATUSES.FAILED && record.cleanupRequired && record.subscriptionMayExist && record.failedReasonCode === reasonCode) {
      return { row: record, idempotent: true };
    }
    return { row: applyFailureMetadata(record, { ...input, failedAt: input.requiredAt, reasonCode, cleanupRequired: true, subscriptionMayExist: true }, "unsubscribe"), idempotent: false };
  }, options);
}

function markCodeClipYouTubeWebSubDiagnosticCleanupCompleted(input = {}, options = {}) {
  return runLifecycleOperation(input, (record) => {
    if (record.status === DIAGNOSTIC_PROBE_STATUSES.UNSUBSCRIBED) return { row: record, idempotent: true };
    requireStatus(record, [DIAGNOSTIC_PROBE_STATUSES.PENDING_UNSUBSCRIBE]);
    const next = applyDiagnosticUnsubscribeTransition(record, { confirmedAt: input.completedAt });
    return {
      row: {
        ...next,
        failedOperation: record.failedOperation,
        failedReasonCode: record.failedReasonCode,
        diagnosticMetadata: replaceMetadata(next, {
          ...next.diagnosticMetadata,
          lastFailure: record.diagnosticMetadata.lastFailure,
          cleanup: next.diagnosticMetadata.cleanup,
        }),
      },
      idempotent: false,
    };
  }, options);
}

module.exports = {
  CodeClipYouTubeWebSubDiagnosticProbeRepositoryError,
  PROBE_ID_CONSTRAINT,
  CALLBACK_ID_CONSTRAINT,
  OPEN_TOPIC_CONSTRAINT,
  CREATE_SAVEPOINT,
  CURSOR_VERSION,
  createCodeClipYouTubeWebSubDiagnosticProbe,
  getCodeClipYouTubeWebSubDiagnosticProbeByProbeId,
  getCodeClipYouTubeWebSubDiagnosticProbeByCallbackId,
  getCodeClipYouTubeWebSubDiagnosticObservationSummary,
  listCodeClipYouTubeWebSubDiagnosticProbes,
  encodeDiagnosticProbeCursor,
  decodeDiagnosticProbeCursor,
  markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched,
  markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted,
  markCodeClipYouTubeWebSubDiagnosticVerificationReceived,
  recordCodeClipYouTubeWebSubDiagnosticNotificationObservation,
  serializeDiagnosticObservationPublic,
  buildDiagnosticObservationIdentity,
  markCodeClipYouTubeWebSubDiagnosticSubscribeFailed,
  markCodeClipYouTubeWebSubDiagnosticUnsubscribeDispatched,
  markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted,
  markCodeClipYouTubeWebSubDiagnosticCleanupRequired,
  markCodeClipYouTubeWebSubDiagnosticCleanupCompleted,
};
