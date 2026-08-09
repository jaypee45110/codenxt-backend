/**
 * codeClip provider poll sources foundation (F1D1).
 *
 * Owns durable poll source rows and fenced claim lifecycle:
 * - create / get / listDue
 * - claim (atomic poll_claim_version++ in SQL under row lock)
 * - completeClaim (single guarded UPDATE: checkpoint + claim clear + next_poll_at)
 * - releaseClaim (owner + expectedVersion + strict not-stale fence)
 *
 * Schema ensure is owned by startup (initializeCodeClipStartup), not by
 * ordinary repository traffic. Missing tables surface as database errors.
 *
 * Does not create deliveries, call adapters, perform HTTP, use YouTube ingest,
 * or implement a scheduler/worker.
 */

const {
  getCodeClipProviderDefinition,
} = require("./provider-registry");
const {
  normalizeCodeClipProviderCredentialAccountRef,
  normalizeCodeClipProviderCredentialEnvironment,
} = require("./provider-credential-validators");

const CODECLIP_VERTICAL = "codeclip";
const MAX_BIGINT_ID = 9223372036854775807n;

/** General minimum; provider-specific shorter intervals require a later policy change. */
const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 86_400_000;

const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 300_000;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

const OWNER_MAX = 128;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

const CHECKPOINT_MAX_BYTES = 4096;
const CHECKPOINT_MAX_DEPTH = 3;
const CHECKPOINT_MAX_NODES = 50;
const CHECKPOINT_MAX_ARRAY_ELEMENTS = 20;

const POLL_SOURCE_STATUSES = Object.freeze(["active", "paused", "disabled"]);
const ERROR_CODE_MAX = 64;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_ATTEMPT_DURATION_MS = 3_600_000;
const MAX_DETECTIONS_COUNT = 10_000;

const SAFE_SELECT_COLUMNS = `
  id,
  vertical,
  provider,
  environment,
  account_lookup_key,
  provider_account_id,
  status,
  poll_interval_ms,
  next_poll_at,
  last_polled_at,
  checkpoint,
  poll_claim_owner,
  poll_claimed_at,
  poll_claim_expires_at,
  poll_claim_version,
  consecutive_failures,
  last_error_code,
  last_success_at,
  last_detection_at,
  last_attempt_duration_ms,
  last_detections_count,
  created_at,
  updated_at,
  disabled_at
`.replace(/\s+/g, " ").trim();

class CodeClipProviderPollSourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollSourceError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function pollSourceError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "provider", "status"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderPollSourceError(code, message, safe);
}

function requireQueryClient(queryClient) {
  if (!queryClient) {
    throw pollSourceError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider poll source repository requires an explicit query client"
    );
  }
  const hasQuery = typeof queryClient.query === "function";
  const hasConnect = typeof queryClient.connect === "function";
  if (!hasQuery && !hasConnect) {
    throw pollSourceError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider poll source repository requires an explicit query client"
    );
  }
  return queryClient;
}

function hasQueryMethod(value) {
  return Boolean(value && typeof value.query === "function");
}

function isCallerOwnedQueryClient(value) {
  if (!hasQueryMethod(value)) return false;
  // pg PoolClient exposes query(), release(), and a connect() method inherited
  // from Client. release() is the stable lifecycle signal that the caller owns
  // an already acquired connection.
  if (typeof value.release === "function") return true;
  return typeof value.connect !== "function";
}

function isPoolLikeQueryClient(value) {
  return Boolean(
    value &&
      typeof value.connect === "function" &&
      hasQueryMethod(value) &&
      typeof value.release !== "function"
  );
}

/**
 * Alternativ B transaction ownership (same contract as credential mutations).
 * Pool owns BEGIN/COMMIT/ROLLBACK; explicit query client is caller-owned.
 */
async function withPollSourceTransaction(queryClient, work) {
  if (!queryClient) {
    throw pollSourceError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider poll source repository requires an explicit query client"
    );
  }

  if (isCallerOwnedQueryClient(queryClient)) {
    return work(queryClient);
  }

  if (isPoolLikeQueryClient(queryClient)) {
    let client = null;
    try {
      client = await queryClient.connect();
    } catch {
      throw pollSourceError(
        "DATABASE_UNAVAILABLE",
        "failed to open database client"
      );
    }
    if (!client || typeof client.query !== "function") {
      throw pollSourceError(
        "DATABASE_UNAVAILABLE",
        "database pool returned an invalid client"
      );
    }
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // preserve original error
      }
      throw error;
    } finally {
      try {
        if (typeof client.release === "function") {
          client.release();
        }
      } catch {
        // ignore release failures
      }
    }
  }

  throw pollSourceError(
    "DATABASE_UNAVAILABLE",
    "codeClip provider poll source repository requires an explicit query client"
  );
}

function hasActivePollClaim(row, operationNowMs) {
  if (!row || operationNowMs === null) return false;
  if (row.poll_claim_owner == null || String(row.poll_claim_owner).trim() === "") {
    return false;
  }
  const expiresMs = parseTimestampMs(row.poll_claim_expires_at);
  return expiresMs !== null && expiresMs > operationNowMs;
}

function normalizePositiveBigIntId(value, fieldName = "id") {
  let normalized;
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  return normalized;
}

function normalizeClaimOwner(owner) {
  if (typeof owner !== "string") {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "owner is invalid", {
      fieldName: "owner",
    });
  }
  const normalized = owner.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > OWNER_MAX ||
    !OWNER_PATTERN.test(normalized)
  ) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "owner is invalid", {
      fieldName: "owner",
    });
  }
  return normalized;
}

function normalizeLeaseMs(leaseMs) {
  if (leaseMs === undefined) return DEFAULT_LEASE_MS;
  if (typeof leaseMs !== "number" || !Number.isInteger(leaseMs)) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "leaseMs is invalid", {
      fieldName: "leaseMs",
    });
  }
  if (leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "leaseMs is invalid", {
      fieldName: "leaseMs",
    });
  }
  return leaseMs;
}

/**
 * Fail-closed poll interval. No clamp. Integers only (no numeric strings).
 * Range: [MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS] = [30000, 86400000].
 */
function normalizePollIntervalMs(value) {
  if (value === undefined || value === null || value === "") {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "pollIntervalMs is required",
      { fieldName: "pollIntervalMs" }
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "pollIntervalMs is invalid",
      { fieldName: "pollIntervalMs" }
    );
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_POLL_INTERVAL_MS ||
    value > MAX_POLL_INTERVAL_MS
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "pollIntervalMs is out of range",
      { fieldName: "pollIntervalMs" }
    );
  }
  return value;
}

function normalizeExpectedVersion(value) {
  if (value === undefined || value === null || value === "") {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "expectedVersion is required",
      { fieldName: "expectedVersion" }
    );
  }
  let normalized;
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw pollSourceError(
        "INVALID_POLL_SOURCE_INPUT",
        "expectedVersion is invalid",
        { fieldName: "expectedVersion" }
      );
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "expectedVersion is invalid",
      { fieldName: "expectedVersion" }
    );
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "expectedVersion is invalid",
      { fieldName: "expectedVersion" }
    );
  }
  const parsed = BigInt(normalized);
  if (parsed < 1n || parsed > MAX_BIGINT_ID) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "expectedVersion is invalid",
      { fieldName: "expectedVersion" }
    );
  }
  return normalized;
}

function normalizeInjectedNow(now) {
  if (now === undefined) return null;
  if (now === null || now === "") {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "now is invalid", {
      fieldName: "now",
    });
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "now is invalid", {
    fieldName: "now",
  });
}

function toIsoTimestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseTimestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function resolveOperationNow(tx, injectedNow) {
  const clockResult = await tx.query(
    `
      SELECT COALESCE($1::timestamptz, NOW()) AS operation_now
    `,
    [injectedNow]
  );
  const operationNowIso = toIsoTimestamp(clockResult.rows?.[0]?.operation_now);
  if (!operationNowIso) {
    throw pollSourceError("DATABASE_ERROR", "failed to resolve operation clock");
  }
  return {
    operationNowIso,
    operationNowMs: parseTimestampMs(operationNowIso),
  };
}

function normalizeOptionalTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    return new Date(ms).toISOString();
  }
  throw pollSourceError("INVALID_POLL_SOURCE_INPUT", `${fieldName} is invalid`, {
    fieldName,
  });
}

function isJsonSafePrimitive(value) {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return false;
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
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      // Allow plain objects only (reject Date, Map, Buffer, etc. as opaque adapter shapes).
      if (!(value.constructor === Object || Object.getPrototypeOf(value) === null)) {
        return { ok: false, reason: "INVALID_CHECKPOINT" };
      }
    }
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof key !== "string") {
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

/**
 * Checkpoint: JSON object, bounded size, fail-closed. No adapter semantics.
 */
function normalizeCodeClipProviderPollCheckpoint(value) {
  if (value === undefined || value === null) {
    return { ok: true, checkpoint: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }

  const counters = { nodes: 0 };
  const validated = validateCheckpointValue(value, 1, counters);
  if (!validated.ok) return validated;

  let serialized;
  try {
    serialized = JSON.stringify(validated.value);
  } catch {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }
  if (typeof serialized !== "string") {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }
  if (Buffer.byteLength(serialized, "utf8") > CHECKPOINT_MAX_BYTES) {
    return { ok: false, reason: "INVALID_CHECKPOINT" };
  }

  return {
    ok: true,
    checkpoint: JSON.parse(serialized),
  };
}

function assertPollingCapableProvider(provider) {
  const definition = getCodeClipProviderDefinition(provider);
  if (!definition) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "provider is not registered",
      { fieldName: "provider", reason: "INVALID_PROVIDER", provider }
    );
  }
  if (definition.capabilities.polling !== true) {
    throw pollSourceError(
      "POLLING_NOT_SUPPORTED",
      "provider does not support polling",
      { fieldName: "provider", provider: definition.name, reason: "POLLING_FALSE" }
    );
  }
  return definition;
}

function normalizeListLimit(limit) {
  if (limit === undefined || limit === null || limit === "") {
    return DEFAULT_LIST_LIMIT;
  }
  let parsed;
  if (typeof limit === "number") {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "limit is invalid", {
        fieldName: "limit",
      });
    }
    parsed = limit;
  } else if (typeof limit === "string") {
    const trimmed = limit.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "limit is invalid", {
        fieldName: "limit",
      });
    }
    parsed = Number.parseInt(trimmed, 10);
    if (!parsed) {
      throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "limit is invalid", {
        fieldName: "limit",
      });
    }
  } else {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "limit is invalid", {
      fieldName: "limit",
    });
  }
  // Fail-closed: no clamp above max.
  if (parsed > MAX_LIST_LIMIT) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "limit exceeds maximum", {
      fieldName: "limit",
    });
  }
  return parsed;
}

function deepCopyJson(value) {
  if (value === undefined || value === null) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function toPublicPollSource(row) {
  if (!row) return null;
  const claimVersionRaw = row.poll_claim_version ?? row.pollClaimVersion ?? 0;
  let claimVersion = 0;
  if (typeof claimVersionRaw === "bigint") {
    claimVersion = Number(claimVersionRaw);
  } else if (typeof claimVersionRaw === "string") {
    claimVersion = Number(claimVersionRaw);
  } else {
    claimVersion = Number(claimVersionRaw);
  }
  if (!Number.isFinite(claimVersion)) claimVersion = 0;

  const pollIntervalRaw = row.poll_interval_ms ?? row.pollIntervalMs;
  let pollIntervalMs =
    typeof pollIntervalRaw === "bigint"
      ? Number(pollIntervalRaw)
      : Number(pollIntervalRaw);

  function asNonNegInt(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "bigint" ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  return {
    id: String(row.id),
    vertical: row.vertical,
    provider: row.provider,
    environment: row.environment,
    providerAccountId: row.provider_account_id ?? row.providerAccountId,
    accountLookupKey: row.account_lookup_key ?? row.accountLookupKey,
    status: row.status,
    pollIntervalMs,
    nextPollAt: toIsoTimestamp(row.next_poll_at ?? row.nextPollAt),
    lastPolledAt: toIsoTimestamp(row.last_polled_at ?? row.lastPolledAt),
    checkpoint: deepCopyJson(row.checkpoint),
    pollClaimOwner: row.poll_claim_owner ?? row.pollClaimOwner ?? null,
    pollClaimedAt: toIsoTimestamp(row.poll_claimed_at ?? row.pollClaimedAt),
    pollClaimExpiresAt: toIsoTimestamp(
      row.poll_claim_expires_at ?? row.pollClaimExpiresAt
    ),
    pollClaimVersion: claimVersion,
    consecutiveFailures: asNonNegInt(
      row.consecutive_failures ?? row.consecutiveFailures
    ) ?? 0,
    lastErrorCode: row.last_error_code ?? row.lastErrorCode ?? null,
    lastSuccessAt: toIsoTimestamp(row.last_success_at ?? row.lastSuccessAt),
    lastDetectionAt: toIsoTimestamp(
      row.last_detection_at ?? row.lastDetectionAt
    ),
    lastAttemptDurationMs: asNonNegInt(
      row.last_attempt_duration_ms ?? row.lastAttemptDurationMs
    ),
    lastDetectionsCount: asNonNegInt(
      row.last_detections_count ?? row.lastDetectionsCount
    ),
    createdAt: toIsoTimestamp(row.created_at ?? row.createdAt),
    updatedAt: toIsoTimestamp(row.updated_at ?? row.updatedAt),
    disabledAt: toIsoTimestamp(row.disabled_at ?? row.disabledAt),
  };
}

function normalizeOptionalErrorCode(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "lastErrorCode is invalid",
      { fieldName: "lastErrorCode" }
    );
  }
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > ERROR_CODE_MAX ||
    !ERROR_CODE_PATTERN.test(normalized)
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "lastErrorCode is invalid",
      { fieldName: "lastErrorCode" }
    );
  }
  return normalized;
}

function normalizeNonNegativeInt(value, fieldName, { allowNull = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (allowNull) return null;
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      `${fieldName} is required`,
      { fieldName }
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  return value;
}

function normalizePollSourceStatus(value, { allowPaused = true } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "status is invalid", {
      fieldName: "status",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!POLL_SOURCE_STATUSES.includes(normalized)) {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "status is invalid", {
      fieldName: "status",
    });
  }
  if (!allowPaused && normalized === "paused") {
    throw pollSourceError("INVALID_POLL_SOURCE_INPUT", "status is invalid", {
      fieldName: "status",
    });
  }
  return normalized;
}

function isUniqueViolation(error) {
  return Boolean(error && (error.code === "23505" || error.constraint));
}

/**
 * Create a poll source. Registry must declare capabilities.polling === true.
 */
async function createCodeClipProviderPollSource(
  input = {},
  { queryClient, now } = {}
) {
  const client = requireQueryClient(queryClient);

  const accountRef = normalizeCodeClipProviderCredentialAccountRef({
    provider: input.provider,
    providerAccountId: input.providerAccountId ?? input.provider_account_id,
    environment: input.environment,
  });
  if (!accountRef.ok) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
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

  assertPollingCapableProvider(accountRef.provider);

  const pollIntervalMs = normalizePollIntervalMs(
    input.pollIntervalMs ?? input.poll_interval_ms
  );

  const checkpointResult = normalizeCodeClipProviderPollCheckpoint(
    input.checkpoint
  );
  if (!checkpointResult.ok) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "checkpoint is invalid",
      { fieldName: "checkpoint", reason: checkpointResult.reason || null }
    );
  }

  const injectedNow = normalizeInjectedNow(now);
  const nextPollAtInput =
    input.nextPollAt !== undefined
      ? input.nextPollAt
      : input.next_poll_at !== undefined
        ? input.next_poll_at
        : undefined;
  const nextPollAtOverride = normalizeOptionalTimestamp(
    nextPollAtInput,
    "nextPollAt"
  );

  return withPollSourceTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(tx, injectedNow);
    const nextPollAt = nextPollAtOverride || operationNowIso;

    let result;
    try {
      result = await tx.query(
        `
          INSERT INTO codeclip_provider_poll_sources (
            vertical,
            provider,
            environment,
            account_lookup_key,
            provider_account_id,
            status,
            poll_interval_ms,
            next_poll_at,
            last_polled_at,
            checkpoint,
            poll_claim_owner,
            poll_claimed_at,
            poll_claim_expires_at,
            poll_claim_version,
            consecutive_failures,
            last_error_code,
            last_success_at,
            last_detection_at,
            last_attempt_duration_ms,
            last_detections_count,
            created_at,
            updated_at,
            disabled_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            'active',
            $6,
            $7::timestamptz,
            NULL,
            $8::jsonb,
            NULL, NULL, NULL,
            0,
            0,
            NULL, NULL, NULL, NULL, NULL,
            $9::timestamptz,
            $9::timestamptz,
            NULL
          )
          RETURNING ${SAFE_SELECT_COLUMNS}
        `,
        [
          CODECLIP_VERTICAL,
          accountRef.provider,
          accountRef.environment,
          accountRef.accountLookupKey,
          accountRef.providerAccountId,
          pollIntervalMs,
          nextPollAt,
          JSON.stringify(checkpointResult.checkpoint),
          operationNowIso,
        ]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw pollSourceError(
          "POLL_SOURCE_ALREADY_EXISTS",
          "poll source already exists for identity"
        );
      }
      throw error;
    }

    const row = result.rows?.[0] || null;
    if (!row) {
      throw pollSourceError("DATABASE_ERROR", "poll source insert returned no row");
    }

    return {
      status: "created",
      pollSource: toPublicPollSource(row),
    };
  });
}

async function getCodeClipProviderPollSourceById(
  id,
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizePositiveBigIntId(id, "id");

  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_poll_sources
      WHERE id = $1
        AND vertical = $2
      LIMIT 1
    `,
    [normalizedId, CODECLIP_VERTICAL]
  );
  const row = result.rows?.[0] || null;
  if (!row) return null;
  return toPublicPollSource(row);
}

async function findCodeClipProviderPollSource(
  { provider, providerAccountId, environment } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const accountRef = normalizeCodeClipProviderCredentialAccountRef({
    provider,
    providerAccountId,
    environment,
  });
  if (!accountRef.ok) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
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

  assertPollingCapableProvider(accountRef.provider);

  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_poll_sources
      WHERE vertical = $1
        AND provider = $2
        AND environment = $3
        AND account_lookup_key = $4
      LIMIT 1
    `,
    [
      CODECLIP_VERTICAL,
      accountRef.provider,
      accountRef.environment,
      accountRef.accountLookupKey,
    ]
  );
  return toPublicPollSource(result.rows?.[0] || null);
}

/**
 * Safe due-source scan stage allowlist (observability only).
 * No separate connection-acquisition phase: listDue uses queryClient.query
 * directly (pool.query or client.query), not pool.connect().
 */
const DUE_SOURCE_SCAN_STAGES = Object.freeze({
  ENTER: "due_source_scan_enter",
  QUERY_START: "due_source_query_start",
  QUERY_FAILED: "due_source_query_failed",
  ROW_MAPPING_FAILED: "due_source_row_mapping_failed",
  SCAN_FAILED: "due_source_scan_failed",
});

function attachDueSourceScanStage(error, stage) {
  if (!error || typeof error !== "object") return error;
  if (error.scanStage !== undefined && error.scanStage !== null) return error;
  try {
    error.scanStage = stage;
  } catch {
    // ignore non-extensible errors
  }
  return error;
}

/**
 * List active sources that are due and not under an active claim.
 *
 * Observability: attaches allowlisted scanStage on thrown errors so worker-core
 * can distinguish enter / query / row-mapping without leaking SQL or messages.
 */
async function listDueCodeClipProviderPollSources(
  { limit, provider, environment, now } = {},
  { queryClient } = {}
) {
  let scanStage = DUE_SOURCE_SCAN_STAGES.ENTER;
  try {
    const client = requireQueryClient(queryClient);

    const normalizedLimit = normalizeListLimit(limit);
    const injectedNow = normalizeInjectedNow(now);

    let normalizedProvider = null;
    if (provider !== undefined && provider !== null && provider !== "") {
      const definition = getCodeClipProviderDefinition(provider);
      if (!definition || definition.capabilities.polling !== true) {
        throw attachDueSourceScanStage(
          pollSourceError(
            "INVALID_POLL_SOURCE_INPUT",
            "provider filter is invalid",
            { fieldName: "provider" }
          ),
          DUE_SOURCE_SCAN_STAGES.ENTER
        );
      }
      normalizedProvider = definition.name;
    }

    let normalizedEnvironment = null;
    if (environment !== undefined && environment !== null && environment !== "") {
      const envResult = normalizeCodeClipProviderCredentialEnvironment(environment);
      if (!envResult.ok) {
        throw attachDueSourceScanStage(
          pollSourceError(
            "INVALID_POLL_SOURCE_INPUT",
            "environment filter is invalid",
            { fieldName: "environment", reason: envResult.reason || null }
          ),
          DUE_SOURCE_SCAN_STAGES.ENTER
        );
      }
      normalizedEnvironment = envResult.environment;
    }

    // Resolve clock once for consistent due comparison.
    scanStage = DUE_SOURCE_SCAN_STAGES.QUERY_START;
    let clockResult;
    try {
      clockResult = await client.query(
        `
      SELECT COALESCE($1::timestamptz, NOW()) AS operation_now
    `,
        [injectedNow]
      );
    } catch (error) {
      throw attachDueSourceScanStage(error, DUE_SOURCE_SCAN_STAGES.QUERY_FAILED);
    }

    let operationNowIso;
    try {
      operationNowIso = toIsoTimestamp(clockResult.rows?.[0]?.operation_now);
    } catch (error) {
      throw attachDueSourceScanStage(
        error,
        DUE_SOURCE_SCAN_STAGES.ROW_MAPPING_FAILED
      );
    }
    if (!operationNowIso) {
      throw attachDueSourceScanStage(
        pollSourceError("DATABASE_ERROR", "failed to resolve operation clock"),
        DUE_SOURCE_SCAN_STAGES.ROW_MAPPING_FAILED
      );
    }

    const params = [CODECLIP_VERTICAL, operationNowIso, normalizedLimit];
    const filters = [
      "vertical = $1",
      "status = 'active'",
      "next_poll_at IS NOT NULL",
      "next_poll_at <= $2::timestamptz",
      `(
      poll_claim_expires_at IS NULL
      OR poll_claim_expires_at <= $2::timestamptz
    )`,
    ];

    if (normalizedProvider) {
      params.push(normalizedProvider);
      filters.push(`provider = $${params.length}`);
    }
    if (normalizedEnvironment) {
      params.push(normalizedEnvironment);
      filters.push(`environment = $${params.length}`);
    }

    scanStage = DUE_SOURCE_SCAN_STAGES.QUERY_START;
    let result;
    try {
      result = await client.query(
        `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_poll_sources
      WHERE ${filters.join("\n        AND ")}
      ORDER BY next_poll_at ASC, id ASC
      LIMIT $3
    `,
        params
      );
    } catch (error) {
      throw attachDueSourceScanStage(error, DUE_SOURCE_SCAN_STAGES.QUERY_FAILED);
    }

    scanStage = DUE_SOURCE_SCAN_STAGES.ROW_MAPPING_FAILED;
    let items;
    try {
      items = (result.rows || []).map((row) => toPublicPollSource(row));
    } catch (error) {
      throw attachDueSourceScanStage(
        error,
        DUE_SOURCE_SCAN_STAGES.ROW_MAPPING_FAILED
      );
    }

    return {
      items,
      limit: normalizedLimit,
      asOf: operationNowIso,
    };
  } catch (error) {
    // Preserve an already-attached allowlisted stage; otherwise fall back.
    const fallbackStage =
      scanStage === DUE_SOURCE_SCAN_STAGES.QUERY_START
        ? DUE_SOURCE_SCAN_STAGES.QUERY_FAILED
        : scanStage || DUE_SOURCE_SCAN_STAGES.SCAN_FAILED;
    throw attachDueSourceScanStage(error, fallbackStage);
  }
}

/**
 * Atomically claim (or stale-reclaim) a poll source lease.
 * poll_claim_version is incremented only in SQL under the row lock.
 */
async function claimCodeClipProviderPollSource(
  { pollSourceId, id, owner, leaseMs, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);

  const normalizedId = normalizePositiveBigIntId(
    pollSourceId ?? id,
    "pollSourceId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
  const injectedNow = normalizeInjectedNow(now);

  return withPollSourceTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT_COLUMNS}
        FROM codeclip_provider_poll_sources
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const row = locked.rows?.[0] || null;
    if (!row) {
      throw pollSourceError("POLL_SOURCE_NOT_FOUND", "poll source was not found");
    }

    if (row.status !== "active") {
      return { ok: false, reason: "POLL_SOURCE_NOT_CLAIMABLE" };
    }

    const existingExpiresMs = parseTimestampMs(row.poll_claim_expires_at);
    const hasActiveClaim =
      row.poll_claim_owner != null &&
      String(row.poll_claim_owner).trim() !== "" &&
      existingExpiresMs !== null &&
      existingExpiresMs > operationNowMs;

    if (hasActiveClaim) {
      return { ok: false, reason: "POLL_CLAIM_CONTENTION" };
    }

    const reclaimed =
      row.poll_claim_owner != null && String(row.poll_claim_owner).trim() !== "";

    // Version is incremented in SQL only — never computed in JavaScript.
    const updated = await tx.query(
      `
        UPDATE codeclip_provider_poll_sources
        SET
          poll_claim_owner = $2,
          poll_claimed_at = $3::timestamptz,
          poll_claim_expires_at =
            $3::timestamptz + ($4::bigint * INTERVAL '1 millisecond'),
          poll_claim_version = poll_claim_version + 1,
          updated_at = $3::timestamptz
        WHERE id = $1
          AND vertical = $5
          AND status = 'active'
          AND (
            poll_claim_expires_at IS NULL
            OR poll_claim_expires_at <= $3::timestamptz
          )
        RETURNING
          id,
          poll_claim_version,
          poll_claimed_at,
          poll_claim_expires_at
      `,
      [
        normalizedId,
        normalizedOwner,
        operationNowIso,
        normalizedLeaseMs,
        CODECLIP_VERTICAL,
      ]
    );

    const claimed = updated.rows?.[0] || null;
    if (!claimed) {
      return { ok: false, reason: "POLL_CLAIM_CONTENTION" };
    }

    const claimedAt = toIsoTimestamp(claimed.poll_claimed_at) || operationNowIso;
    const expiresAt = toIsoTimestamp(claimed.poll_claim_expires_at);
    if (!expiresAt) {
      throw pollSourceError("DATABASE_ERROR", "claim returned invalid expiry");
    }

    let claimVersion = claimed.poll_claim_version;
    if (typeof claimVersion === "bigint") claimVersion = Number(claimVersion);
    else claimVersion = Number(claimVersion);
    if (!Number.isSafeInteger(claimVersion) || claimVersion < 1) {
      throw pollSourceError("DATABASE_ERROR", "claim returned invalid version");
    }

    return {
      ok: true,
      claimed: true,
      pollSourceId: String(claimed.id),
      claimVersion,
      claimedAt,
      expiresAt,
      reclaimed,
    };
  });
}

/**
 * Build a frozen, defensive poll-source snapshot for fenced persistence hooks.
 * Callers must not mutate repository lock state through this object.
 */
function freezePollSourceSnapshot(row) {
  const publicRow = toPublicPollSource(row);
  if (!publicRow) return null;
  const checkpoint = Object.freeze(deepCopyJson(publicRow.checkpoint));
  return Object.freeze({
    ...publicRow,
    checkpoint,
  });
}

/**
 * Fenced short-lived DB persistence hook only (not a general lifecycle API).
 * Production call-site: provider-polling/delivery-ingest.js for ledger inserts.
 * HTTP, adapter calls, credential reads, and core/reward work are forbidden here.
 */
function buildBeforeCompleteContext({ queryClient, pollSource, operationNow }) {
  return Object.freeze({
    queryClient,
    pollSource,
    operationNow,
  });
}

/**
 * Complete a fenced claim in one guarded UPDATE:
 * checkpoint + claim clear + next_poll_at (+ last_polled_at + observability).
 *
 * Optional beforeComplete({ queryClient, pollSource, operationNow }) runs after
 * fence verification and before the complete UPDATE on the same client.
 * This is an internal fenced-persistence hook only (ledger inserts), not a
 * general lifecycle callback. Return value is ignored.
 * Throws roll back pool-owned TX (no complete UPDATE / claim clear / checkpoint).
 */
async function completeCodeClipProviderPollSourceClaim(
  {
    pollSourceId,
    id,
    owner,
    expectedVersion,
    checkpoint,
    nextPollAt,
    next_poll_at,
    now,
    consecutiveFailures,
    lastErrorCode,
    lastSuccessAt,
    lastDetectionAt,
    lastAttemptDurationMs,
    lastDetectionsCount,
    status,
  } = {},
  { queryClient, beforeComplete } = {}
) {
  const client = requireQueryClient(queryClient);

  if (
    beforeComplete !== undefined &&
    beforeComplete !== null &&
    typeof beforeComplete !== "function"
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "beforeComplete must be a function",
      { fieldName: "beforeComplete" }
    );
  }

  const normalizedId = normalizePositiveBigIntId(
    pollSourceId ?? id,
    "pollSourceId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedVersion = normalizeExpectedVersion(expectedVersion);
  const injectedNow = normalizeInjectedNow(now);

  const checkpointResult = normalizeCodeClipProviderPollCheckpoint(checkpoint);
  if (!checkpointResult.ok) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "checkpoint is invalid",
      { fieldName: "checkpoint", reason: checkpointResult.reason || null }
    );
  }

  const nextPollAtInput =
    nextPollAt !== undefined ? nextPollAt : next_poll_at;
  const nextPollAtOverride =
    nextPollAtInput === undefined
      ? null
      : normalizeOptionalTimestamp(nextPollAtInput, "nextPollAt");

  const normalizedFailures =
    consecutiveFailures === undefined
      ? 0
      : normalizeNonNegativeInt(consecutiveFailures, "consecutiveFailures", {
          allowNull: false,
        });
  const normalizedErrorCode =
    lastErrorCode === undefined
      ? null
      : normalizeOptionalErrorCode(lastErrorCode);
  const normalizedDuration =
    lastAttemptDurationMs === undefined
      ? null
      : normalizeNonNegativeInt(
          lastAttemptDurationMs,
          "lastAttemptDurationMs"
        );
  if (
    normalizedDuration !== null &&
    normalizedDuration > MAX_ATTEMPT_DURATION_MS
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "lastAttemptDurationMs is out of range",
      { fieldName: "lastAttemptDurationMs" }
    );
  }
  const normalizedDetectionsCount =
    lastDetectionsCount === undefined
      ? null
      : normalizeNonNegativeInt(lastDetectionsCount, "lastDetectionsCount");
  if (
    normalizedDetectionsCount !== null &&
    normalizedDetectionsCount > MAX_DETECTIONS_COUNT
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "lastDetectionsCount is out of range",
      { fieldName: "lastDetectionsCount" }
    );
  }
  const normalizedStatus =
    status === undefined
      ? "active"
      : normalizePollSourceStatus(status) || "active";

  const lastSuccessAtOverride =
    lastSuccessAt === undefined
      ? undefined
      : lastSuccessAt === null
        ? null
        : normalizeOptionalTimestamp(lastSuccessAt, "lastSuccessAt");
  const lastDetectionAtOverride =
    lastDetectionAt === undefined
      ? undefined
      : lastDetectionAt === null
        ? null
        : normalizeOptionalTimestamp(lastDetectionAt, "lastDetectionAt");

  return withPollSourceTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT_COLUMNS}
        FROM codeclip_provider_poll_sources
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw pollSourceError("POLL_SOURCE_NOT_FOUND", "poll source was not found");
    }

    const ownerMatches =
      current.poll_claim_owner != null &&
      String(current.poll_claim_owner).trim().toLowerCase() === normalizedOwner;
    const versionMatches =
      String(current.poll_claim_version ?? "") === normalizedVersion;
    const expiresMs = parseTimestampMs(current.poll_claim_expires_at);
    const notStale =
      expiresMs !== null && operationNowMs !== null && expiresMs > operationNowMs;

    if (!ownerMatches || !versionMatches || !notStale) {
      throw pollSourceError(
        "POLL_CLAIM_FENCE_MISMATCH",
        "poll claim fence did not match"
      );
    }

    if (typeof beforeComplete === "function") {
      const frozenSource = freezePollSourceSnapshot(current);
      const hookContext = buildBeforeCompleteContext({
        queryClient: tx,
        pollSource: frozenSource,
        operationNow: operationNowIso,
      });
      try {
        // Return value intentionally ignored — not part of the public contract.
        await beforeComplete(hookContext);
      } catch (error) {
        if (error instanceof CodeClipProviderPollSourceError) throw error;
        // Preserve typed ingest errors without leaking raw messages into repo layer.
        if (
          error &&
          error.name === "CodeClipProviderPollingIngestError" &&
          typeof error.code === "string"
        ) {
          throw error;
        }
        throw pollSourceError(
          "FENCED_PERSISTENCE_FAILED",
          "fenced persistence failed before complete"
        );
      }
    }

    let resolvedNextPollAt = nextPollAtOverride;
    if (
      normalizedStatus === "paused" ||
      normalizedStatus === "disabled"
    ) {
      // Scheduler never polls paused/disabled; next_poll_at is non-authoritative.
      resolvedNextPollAt = null;
    } else if (!resolvedNextPollAt) {
      const intervalMs =
        typeof current.poll_interval_ms === "bigint"
          ? Number(current.poll_interval_ms)
          : Number(current.poll_interval_ms);
      if (
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < MIN_POLL_INTERVAL_MS ||
        intervalMs > MAX_POLL_INTERVAL_MS
      ) {
        throw pollSourceError(
          "DATABASE_ERROR",
          "stored poll_interval_ms is invalid"
        );
      }
      resolvedNextPollAt = new Date(
        operationNowMs + intervalMs
      ).toISOString();
    }

    const resolvedLastSuccessAt =
      lastSuccessAtOverride === undefined
        ? operationNowIso
        : lastSuccessAtOverride;
    const resolvedLastDetectionAt =
      lastDetectionAtOverride === undefined
        ? null
        : lastDetectionAtOverride;

    // Single atomic UPDATE — no two-step claim clear + schedule write.
    const updated = await tx.query(
      `
        UPDATE codeclip_provider_poll_sources
        SET
          checkpoint = $2::jsonb,
          next_poll_at = $3::timestamptz,
          last_polled_at = $4::timestamptz,
          poll_claim_owner = NULL,
          poll_claimed_at = NULL,
          poll_claim_expires_at = NULL,
          consecutive_failures = $8,
          last_error_code = $9,
          last_success_at = $10::timestamptz,
          last_detection_at = $11::timestamptz,
          last_attempt_duration_ms = $12,
          last_detections_count = $13,
          status = $14,
          updated_at = $4::timestamptz
        WHERE id = $1
          AND vertical = $5
          AND poll_claim_owner = $6
          AND poll_claim_version = $7::bigint
          AND poll_claim_expires_at > $4::timestamptz
        RETURNING ${SAFE_SELECT_COLUMNS}
      `,
      [
        normalizedId,
        JSON.stringify(checkpointResult.checkpoint),
        resolvedNextPollAt,
        operationNowIso,
        CODECLIP_VERTICAL,
        normalizedOwner,
        normalizedVersion,
        normalizedFailures,
        normalizedErrorCode,
        resolvedLastSuccessAt,
        resolvedLastDetectionAt,
        normalizedDuration,
        normalizedDetectionsCount,
        normalizedStatus,
      ]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw pollSourceError(
        "POLL_CLAIM_FENCE_MISMATCH",
        "poll claim fence changed during complete"
      );
    }

    return {
      status: "completed",
      pollSource: toPublicPollSource(row),
    };
  });
}

async function reactivateCodeClipProviderPollSource(
  {
    pollSourceId,
    id,
    nextPollAt,
    next_poll_at,
    now,
  } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizePositiveBigIntId(
    pollSourceId ?? id,
    "pollSourceId"
  );
  const injectedNow = normalizeInjectedNow(now);
  const nextPollAtInput =
    nextPollAt !== undefined ? nextPollAt : next_poll_at;
  const resolvedNextPollAt = normalizeOptionalTimestamp(
    nextPollAtInput,
    "nextPollAt"
  );
  if (!resolvedNextPollAt) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "nextPollAt is required",
      { fieldName: "nextPollAt" }
    );
  }

  return withPollSourceTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(tx, injectedNow);

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT_COLUMNS}
        FROM codeclip_provider_poll_sources
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw pollSourceError("POLL_SOURCE_NOT_FOUND", "poll source was not found");
    }
    if (current.status !== "paused") {
      throw pollSourceError(
        "POLL_SOURCE_NOT_REACTIVATABLE",
        "poll source is not paused",
        { status: current.status || "unknown" }
      );
    }
    if (hasActivePollClaim(current, operationNowMs)) {
      throw pollSourceError(
        "POLL_SOURCE_NOT_REACTIVATABLE",
        "poll source has an active claim",
        { status: current.status || "unknown" }
      );
    }

    const updated = await tx.query(
      `
        UPDATE codeclip_provider_poll_sources
        SET
          status = 'active',
          next_poll_at = $2::timestamptz,
          last_error_code = NULL,
          poll_claim_owner = NULL,
          poll_claimed_at = NULL,
          poll_claim_expires_at = NULL,
          updated_at = $3::timestamptz
        WHERE id = $1
          AND vertical = $4
          AND status = 'paused'
          AND (
            poll_claim_expires_at IS NULL
            OR poll_claim_expires_at <= $3::timestamptz
          )
        RETURNING ${SAFE_SELECT_COLUMNS}
      `,
      [normalizedId, resolvedNextPollAt, operationNowIso, CODECLIP_VERTICAL]
    );
    const row = updated.rows?.[0] || null;
    if (!row) {
      throw pollSourceError("POLL_SOURCE_RACE", "poll source reactivation raced");
    }
    return {
      status: "reactivated",
      pollSource: toPublicPollSource(row),
    };
  });
}

/**
 * Release a fenced claim. Optionally apply failure scheduling/observability
 * in the same guarded UPDATE (F1D2B). Checkpoint is never advanced.
 * Old workers must not clear a newer claim (owner + version + not-stale).
 */
async function releaseCodeClipProviderPollSourceClaim(
  {
    pollSourceId,
    id,
    owner,
    expectedVersion,
    now,
    nextPollAt,
    consecutiveFailures,
    lastErrorCode,
    lastAttemptDurationMs,
    lastDetectionsCount,
    status,
  } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);

  const normalizedId = normalizePositiveBigIntId(
    pollSourceId ?? id,
    "pollSourceId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedVersion = normalizeExpectedVersion(expectedVersion);
  const injectedNow = normalizeInjectedNow(now);

  const hasScheduling =
    nextPollAt !== undefined ||
    consecutiveFailures !== undefined ||
    lastErrorCode !== undefined ||
    lastAttemptDurationMs !== undefined ||
    lastDetectionsCount !== undefined ||
    status !== undefined;

  // Explicit null clears next_poll_at (paused/disabled). Undefined means default.
  let nextPollAtOverride;
  if (nextPollAt === undefined) {
    nextPollAtOverride = undefined;
  } else if (nextPollAt === null) {
    nextPollAtOverride = null;
  } else {
    nextPollAtOverride = normalizeOptionalTimestamp(nextPollAt, "nextPollAt");
  }
  const normalizedFailures =
    consecutiveFailures === undefined
      ? null
      : normalizeNonNegativeInt(consecutiveFailures, "consecutiveFailures", {
          allowNull: false,
        });
  const normalizedErrorCode =
    lastErrorCode === undefined
      ? undefined
      : normalizeOptionalErrorCode(lastErrorCode);
  const normalizedDuration =
    lastAttemptDurationMs === undefined
      ? undefined
      : normalizeNonNegativeInt(
          lastAttemptDurationMs,
          "lastAttemptDurationMs"
        );
  if (
    normalizedDuration !== undefined &&
    normalizedDuration !== null &&
    normalizedDuration > MAX_ATTEMPT_DURATION_MS
  ) {
    throw pollSourceError(
      "INVALID_POLL_SOURCE_INPUT",
      "lastAttemptDurationMs is out of range",
      { fieldName: "lastAttemptDurationMs" }
    );
  }
  const normalizedDetectionsCount =
    lastDetectionsCount === undefined
      ? undefined
      : normalizeNonNegativeInt(lastDetectionsCount, "lastDetectionsCount");
  const normalizedStatus =
    status === undefined ? null : normalizePollSourceStatus(status);

  return withPollSourceTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT_COLUMNS}
        FROM codeclip_provider_poll_sources
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw pollSourceError("POLL_SOURCE_NOT_FOUND", "poll source was not found");
    }

    const ownerMatches =
      current.poll_claim_owner != null &&
      String(current.poll_claim_owner).trim().toLowerCase() === normalizedOwner;
    const versionMatches =
      String(current.poll_claim_version ?? "") === normalizedVersion;
    const expiresMs = parseTimestampMs(current.poll_claim_expires_at);
    const notStale =
      expiresMs !== null && operationNowMs !== null && expiresMs > operationNowMs;

    if (!ownerMatches || !versionMatches || !notStale) {
      throw pollSourceError(
        "POLL_CLAIM_FENCE_MISMATCH",
        "poll claim fence did not match"
      );
    }

    let updated;
    if (!hasScheduling) {
      updated = await tx.query(
        `
          UPDATE codeclip_provider_poll_sources
          SET
            poll_claim_owner = NULL,
            poll_claimed_at = NULL,
            poll_claim_expires_at = NULL,
            updated_at = $2::timestamptz
          WHERE id = $1
            AND vertical = $3
            AND poll_claim_owner = $4
            AND poll_claim_version = $5::bigint
            AND poll_claim_expires_at > $2::timestamptz
          RETURNING ${SAFE_SELECT_COLUMNS}
        `,
        [
          normalizedId,
          operationNowIso,
          CODECLIP_VERTICAL,
          normalizedOwner,
          normalizedVersion,
        ]
      );
    } else {
      const setStatus = normalizedStatus || current.status || "active";
      let setNextPollAt;
      if (setStatus === "paused" || setStatus === "disabled") {
        // Not scheduled; reactivation must set active + explicit next_poll_at later.
        setNextPollAt = null;
      } else if (nextPollAtOverride !== undefined && nextPollAtOverride !== null) {
        setNextPollAt = nextPollAtOverride;
      } else {
        setNextPollAt = operationNowIso;
      }
      const setFailures =
        normalizedFailures !== null
          ? normalizedFailures
          : Number(current.consecutive_failures || 0) + 1;
      const setErrorCode =
        normalizedErrorCode === undefined
          ? current.last_error_code || null
          : normalizedErrorCode;
      const setDuration =
        normalizedDuration === undefined ? null : normalizedDuration;
      const setDetectionsCount =
        normalizedDetectionsCount === undefined
          ? 0
          : normalizedDetectionsCount;

      updated = await tx.query(
        `
          UPDATE codeclip_provider_poll_sources
          SET
            poll_claim_owner = NULL,
            poll_claimed_at = NULL,
            poll_claim_expires_at = NULL,
            next_poll_at = $6::timestamptz,
            last_polled_at = $2::timestamptz,
            consecutive_failures = $7,
            last_error_code = $8,
            last_attempt_duration_ms = $9,
            last_detections_count = $10,
            status = $11,
            updated_at = $2::timestamptz
          WHERE id = $1
            AND vertical = $3
            AND poll_claim_owner = $4
            AND poll_claim_version = $5::bigint
            AND poll_claim_expires_at > $2::timestamptz
          RETURNING ${SAFE_SELECT_COLUMNS}
        `,
        [
          normalizedId,
          operationNowIso,
          CODECLIP_VERTICAL,
          normalizedOwner,
          normalizedVersion,
          setNextPollAt,
          setFailures,
          setErrorCode,
          setDuration,
          setDetectionsCount,
          setStatus,
        ]
      );
    }

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw pollSourceError(
        "POLL_CLAIM_FENCE_MISMATCH",
        "poll claim fence changed during release"
      );
    }

    return {
      status: "released",
      pollSource: toPublicPollSource(row),
    };
  });
}

module.exports = {
  CodeClipProviderPollSourceError,
  createCodeClipProviderPollSource,
  getCodeClipProviderPollSourceById,
  findCodeClipProviderPollSource,
  listDueCodeClipProviderPollSources,
  claimCodeClipProviderPollSource,
  completeCodeClipProviderPollSourceClaim,
  reactivateCodeClipProviderPollSource,
  releaseCodeClipProviderPollSourceClaim,
};
