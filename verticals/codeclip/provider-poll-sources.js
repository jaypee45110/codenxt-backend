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

const POLL_SOURCE_STATUSES = Object.freeze(["active", "disabled"]);

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

  if (typeof queryClient.connect === "function") {
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

  if (typeof queryClient.query !== "function") {
    throw pollSourceError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider poll source repository requires an explicit query client"
    );
  }
  return work(queryClient);
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
    createdAt: toIsoTimestamp(row.created_at ?? row.createdAt),
    updatedAt: toIsoTimestamp(row.updated_at ?? row.updatedAt),
    disabledAt: toIsoTimestamp(row.disabled_at ?? row.disabledAt),
  };
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
    const { operationNowIso } = await resolveOperationNow(tx, injectedNow);
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

/**
 * List active sources that are due and not under an active claim.
 */
async function listDueCodeClipProviderPollSources(
  { limit, provider, environment, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);

  const normalizedLimit = normalizeListLimit(limit);
  const injectedNow = normalizeInjectedNow(now);

  let normalizedProvider = null;
  if (provider !== undefined && provider !== null && provider !== "") {
    const definition = getCodeClipProviderDefinition(provider);
    if (!definition || definition.capabilities.polling !== true) {
      throw pollSourceError(
        "INVALID_POLL_SOURCE_INPUT",
        "provider filter is invalid",
        { fieldName: "provider" }
      );
    }
    normalizedProvider = definition.name;
  }

  let normalizedEnvironment = null;
  if (environment !== undefined && environment !== null && environment !== "") {
    const envResult = normalizeCodeClipProviderCredentialEnvironment(environment);
    if (!envResult.ok) {
      throw pollSourceError(
        "INVALID_POLL_SOURCE_INPUT",
        "environment filter is invalid",
        { fieldName: "environment", reason: envResult.reason || null }
      );
    }
    normalizedEnvironment = envResult.environment;
  }

  // Resolve clock once for consistent due comparison.
  const clockResult = await client.query(
    `
      SELECT COALESCE($1::timestamptz, NOW()) AS operation_now
    `,
    [injectedNow]
  );
  const operationNowIso = toIsoTimestamp(clockResult.rows?.[0]?.operation_now);
  if (!operationNowIso) {
    throw pollSourceError("DATABASE_ERROR", "failed to resolve operation clock");
  }

  const params = [CODECLIP_VERTICAL, operationNowIso, normalizedLimit];
  const filters = [
    "vertical = $1",
    "status = 'active'",
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

  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_poll_sources
      WHERE ${filters.join("\n        AND ")}
      ORDER BY next_poll_at ASC, id ASC
      LIMIT $3
    `,
    params
  );

  return {
    items: (result.rows || []).map((row) => toPublicPollSource(row)),
    limit: normalizedLimit,
    asOf: operationNowIso,
  };
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
 * Complete a fenced claim in one guarded UPDATE:
 * checkpoint + claim clear + next_poll_at (+ last_polled_at).
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

    let resolvedNextPollAt = nextPollAtOverride;
    if (!resolvedNextPollAt) {
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

/**
 * Release a fenced claim without advancing checkpoint / next_poll_at.
 * Old workers must not clear a newer claim (owner + version + not-stale).
 */
async function releaseCodeClipProviderPollSourceClaim(
  { pollSourceId, id, owner, expectedVersion, now } = {},
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

    const updated = await tx.query(
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
  listDueCodeClipProviderPollSources,
  claimCodeClipProviderPollSource,
  completeCodeClipProviderPollSourceClaim,
  releaseCodeClipProviderPollSourceClaim,
};
