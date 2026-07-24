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
  serializeDiagnosticProbePublic,
} = require("./youtube-websub-diagnostic-probe");

const PROBE_ID_CONSTRAINT = "codeclip_youtube_websub_diagnostic_probes_probe_id_key";
const CALLBACK_ID_CONSTRAINT = "codeclip_youtube_websub_diagnostic_probes_callback_id_key";
const OPEN_TOPIC_CONSTRAINT = "codeclip_youtube_websub_diagnostic_open_topic_uidx";
const UNIQUE_VIOLATION = "23505";
const CREATE_SAVEPOINT = "codeclip_youtube_websub_diagnostic_create";
const READ_COMMITTED = "read committed";
const CURSOR_VERSION = 1;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

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
  listCodeClipYouTubeWebSubDiagnosticProbes,
  encodeDiagnosticProbeCursor,
  decodeDiagnosticProbeCursor,
};
