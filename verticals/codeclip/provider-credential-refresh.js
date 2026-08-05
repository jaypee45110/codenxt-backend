/**
 * codeClip provider credential refresh foundation (F1C3A + F1C3B2).
 *
 * Owns durable multi-instance refresh locking and lifecycle:
 * - claim / stale reclaim
 * - complete (token write + claim clear + refresh_succeeded)
 * - release / failure outcomes (claim clear + audit)
 *
 * Does not call providers, wire routes/workers, or redesign credential store.
 * PostgreSQL is the authoritative lock store (no process-local locks).
 */

const database = require("../../db");
const {
  CodeClipProviderCredentialAuditError,
  appendCodeClipProviderCredentialAudit,
} = require("./provider-credential-audit");
const {
  CodeClipProviderCredentialTokenMutationError,
  prepareCodeClipProviderCredentialTokenMutation,
} = require("./provider-credential-token-mutation");
const {
  isCodeClipProviderCredentialExpired,
} = require("./provider-credential-validators");

const CODECLIP_VERTICAL = "codeclip";
const MAX_BIGINT_ID = 9223372036854775807n;

const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 300_000;
const OWNER_MAX = 128;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

const CLAIMABLE_STATUSES = Object.freeze([
  "active",
  "reauthorization_required",
]);
const INACTIVE_STATUSES = Object.freeze(["disabled", "revoked"]);
const RELEASE_OUTCOMES = Object.freeze([
  "released",
  "failed_retryable",
  "failed_reauthorization",
]);

const CLAIM_SELECT_COLUMNS = `
  id,
  vertical,
  provider,
  environment,
  status,
  provider_account_id,
  has_access_token,
  has_refresh_token,
  access_token_expires_at,
  encryption_key_version,
  token_type,
  scopes,
  reauthorization_reason,
  disabled_at,
  revoked_at,
  last_refreshed_at,
  updated_at,
  created_at,
  metadata,
  refresh_claim_owner,
  refresh_claimed_at,
  refresh_claim_expires_at
`.replace(/\s+/g, " ").trim();

const MUTATION_LOCK_SELECT_COLUMNS = `
  ${CLAIM_SELECT_COLUMNS},
  access_token_envelope,
  refresh_token_envelope
`.replace(/\s+/g, " ").trim();

const SAFE_RETURNING_COLUMNS = `
  id,
  vertical,
  provider,
  environment,
  provider_account_id,
  status,
  token_type,
  scopes,
  has_access_token,
  has_refresh_token,
  access_token_expires_at,
  encryption_key_version,
  reauthorization_reason,
  metadata,
  created_at,
  updated_at,
  disabled_at,
  revoked_at,
  last_refreshed_at
`.replace(/\s+/g, " ").trim();

const SYSTEM_REFRESH_ACTOR = Object.freeze({
  type: "system",
  id: "credential_refresh",
});

/**
 * Internal allowlist for outcomes that must finish the repository transaction
 * successfully, then surface a public failure from the complete() wrapper.
 *
 * Only the disabled/revoked completion cleanup path may produce this marker.
 * Never put Error objects, SQL, tokens, rows, or free-form payloads here.
 */
const POST_COMMIT_ERROR_CODES = Object.freeze(["REFRESH_NOT_COMPLETABLE"]);

class CodeClipProviderCredentialRefreshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderCredentialRefreshError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function refreshError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "auditCode", "cryptoReason"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderCredentialRefreshError(code, message, safe);
}

/**
 * Build the only allowed internal post-work failure marker.
 * Shape is fixed to a single allowlisted code field.
 */
function createPostCommitFailure(code) {
  if (!POST_COMMIT_ERROR_CODES.includes(code)) {
    throw refreshError(
      "DATABASE_ERROR",
      "invalid internal post-commit error code"
    );
  }
  return Object.freeze({ postCommitErrorCode: code });
}

/**
 * If work returned an internal post-commit failure marker, throw the public error.
 * Otherwise return the success value unchanged.
 *
 * Pool path: withRefreshTransaction has already COMMITTED before this runs.
 * Caller-owned client path: work ran inside the caller's active transaction;
 * repository does not COMMIT. Caller must commit to persist cleanup (Model A).
 * The public error is still REFRESH_NOT_COMPLETABLE either way.
 */
function resolvePostCommitOutcome(outcome) {
  if (
    outcome === null ||
    outcome === undefined ||
    typeof outcome !== "object" ||
    Array.isArray(outcome)
  ) {
    return outcome;
  }
  if (!Object.prototype.hasOwnProperty.call(outcome, "postCommitErrorCode")) {
    return outcome;
  }
  const keys = Object.keys(outcome);
  if (keys.length !== 1 || keys[0] !== "postCommitErrorCode") {
    throw refreshError(
      "DATABASE_ERROR",
      "invalid internal post-commit outcome shape"
    );
  }
  const code = outcome.postCommitErrorCode;
  if (!POST_COMMIT_ERROR_CODES.includes(code)) {
    throw refreshError(
      "DATABASE_ERROR",
      "invalid internal post-commit error code"
    );
  }
  if (code === "REFRESH_NOT_COMPLETABLE") {
    throw refreshError(
      "REFRESH_NOT_COMPLETABLE",
      "credential is not refreshable"
    );
  }
  throw refreshError(
    "DATABASE_ERROR",
    "invalid internal post-commit error code"
  );
}

function requireQueryClient(queryClient) {
  if (!queryClient) {
    throw refreshError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential refresh requires an explicit query client"
    );
  }
  const hasQuery = typeof queryClient.query === "function";
  const hasConnect = typeof queryClient.connect === "function";
  if (!hasQuery && !hasConnect) {
    throw refreshError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential refresh requires an explicit query client"
    );
  }
  return queryClient;
}

async function ensureRefreshSchema(queryClient) {
  if (
    queryClient === database.pool &&
    typeof database.ensureCodeClipProviderCredentialsTable === "function"
  ) {
    await database.ensureCodeClipProviderCredentialsTable(queryClient);
  }
  if (
    queryClient === database.pool &&
    typeof database.ensureCodeClipProviderCredentialAuditTable === "function"
  ) {
    await database.ensureCodeClipProviderCredentialAuditTable(queryClient);
  }
}

/**
 * Alternativ B transaction ownership (same contract as credential mutations).
 */
async function withRefreshTransaction(queryClient, work) {
  if (!queryClient) {
    throw refreshError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential refresh requires an explicit query client"
    );
  }

  if (typeof queryClient.connect === "function") {
    let client = null;
    try {
      client = await queryClient.connect();
    } catch {
      throw refreshError("DATABASE_UNAVAILABLE", "failed to open database client");
    }
    if (!client || typeof client.query !== "function") {
      throw refreshError(
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
    throw refreshError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential refresh requires an explicit query client"
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
      throw refreshError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw refreshError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  return normalized;
}

function normalizeClaimOwner(owner) {
  if (typeof owner !== "string") {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "owner is invalid", {
      fieldName: "owner",
    });
  }
  const normalized = owner.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > OWNER_MAX ||
    !OWNER_PATTERN.test(normalized)
  ) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "owner is invalid", {
      fieldName: "owner",
    });
  }
  return normalized;
}

function normalizeLeaseMs(leaseMs) {
  if (leaseMs === undefined) return DEFAULT_LEASE_MS;
  if (typeof leaseMs !== "number" || !Number.isInteger(leaseMs)) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "leaseMs is invalid", {
      fieldName: "leaseMs",
    });
  }
  if (leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "leaseMs is invalid", {
      fieldName: "leaseMs",
    });
  }
  return leaseMs;
}

/**
 * Explicit test override only. undefined → null (SQL NOW() authoritative).
 */
function normalizeInjectedNow(now) {
  if (now === undefined) return null;
  if (now === null || now === "") {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
      fieldName: "now",
    });
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw refreshError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw refreshError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  throw refreshError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
    fieldName: "now",
  });
}

function requireMutationActor(actor) {
  if (actor === undefined || actor === null) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "actor is required", {
      fieldName: "actor",
    });
  }
  if (typeof actor !== "object" || Array.isArray(actor)) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "actor is invalid", {
      fieldName: "actor",
    });
  }
  return actor;
}

function requireReasonCode(reason, defaultReason = null) {
  if (
    (reason === undefined || reason === null || reason === "") &&
    defaultReason
  ) {
    return defaultReason;
  }
  if (typeof reason !== "string") {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "reason is required", {
      fieldName: "reason",
    });
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "reason is required", {
      fieldName: "reason",
    });
  }
  return trimmed;
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
    throw refreshError("DATABASE_ERROR", "failed to resolve operation clock");
  }
  return {
    operationNowIso,
    operationNowMs: parseTimestampMs(operationNowIso),
  };
}

function maskAccountId(providerAccountId) {
  const value = String(providerAccountId || "").trim();
  if (!value) return "";
  if (value.length <= 2) return "••";
  if (value.length <= 4) {
    return `${"•".repeat(value.length - 1)}${value.slice(-1)}`;
  }
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Safe audit input: no envelopes, lookup key, metadata, or claim fields.
 * provider_account_id is mask source only (stripped by audit module).
 */
function auditSnapshotFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    provider_account_id: row.provider_account_id,
    has_access_token: row.has_access_token,
    has_refresh_token: row.has_refresh_token,
    access_token_expires_at: row.access_token_expires_at,
    encryption_key_version: row.encryption_key_version,
    token_type: row.token_type,
    scopes: row.scopes,
    reauthorization_reason: row.reauthorization_reason,
    disabled_at: row.disabled_at,
    revoked_at: row.revoked_at,
    last_refreshed_at: row.last_refreshed_at,
    updated_at: row.updated_at,
  };
}

function mapSafeCredential(row, { now } = {}) {
  if (!row) return null;
  const accessTokenExpiresAt = toIsoTimestamp(row.access_token_expires_at);
  const status = row.status;
  const expiry = isCodeClipProviderCredentialExpired({
    accessTokenExpiresAt,
    now: now || new Date(),
  });
  const expired = expiry.ok ? expiry.expired : false;
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.map((entry) => String(entry))
    : [];
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? JSON.parse(JSON.stringify(row.metadata))
      : {};

  return {
    id: row.id,
    vertical: row.vertical,
    provider: row.provider,
    environment: row.environment,
    maskedAccountId: maskAccountId(row.provider_account_id),
    status,
    tokenType: row.token_type ?? null,
    scopes,
    hasAccessToken: Boolean(row.has_access_token),
    hasRefreshToken: Boolean(row.has_refresh_token),
    accessTokenExpiresAt,
    expired,
    reauthorizationRequired: status === "reauthorization_required",
    reauthorizationReason: row.reauthorization_reason ?? null,
    encryptionKeyVersion: Number(row.encryption_key_version),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at ?? null,
    revokedAt: row.revoked_at ?? null,
    lastRefreshedAt: row.last_refreshed_at ?? null,
  };
}

function hasClaimTriplet(row) {
  return (
    row.refresh_claim_owner !== null &&
    row.refresh_claim_owner !== undefined &&
    String(row.refresh_claim_owner).trim() !== "" &&
    row.refresh_claimed_at !== null &&
    row.refresh_claimed_at !== undefined &&
    row.refresh_claim_expires_at !== null &&
    row.refresh_claim_expires_at !== undefined
  );
}

function assertActiveClaimOwnership(row, normalizedOwner, operationNowMs) {
  if (!hasClaimTriplet(row)) {
    throw refreshError("REFRESH_CLAIM_MISSING", "refresh claim is missing");
  }
  const owner = String(row.refresh_claim_owner).trim().toLowerCase();
  if (owner !== normalizedOwner) {
    throw refreshError(
      "REFRESH_CLAIM_OWNER_MISMATCH",
      "refresh claim owner does not match"
    );
  }
  const expiresMs = parseTimestampMs(row.refresh_claim_expires_at);
  if (expiresMs === null || expiresMs <= operationNowMs) {
    throw refreshError("REFRESH_CLAIM_STALE", "refresh claim is stale");
  }
}

async function appendRefreshAudit(
  {
    credentialId,
    provider,
    environment,
    action,
    actor,
    reason,
    beforeState,
    afterState,
  },
  queryClient
) {
  try {
    return await appendCodeClipProviderCredentialAudit(
      {
        credentialId,
        provider,
        environment,
        action,
        actor,
        reason,
        beforeState,
        afterState,
      },
      { queryClient }
    );
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialRefreshError) throw error;
    if (error instanceof CodeClipProviderCredentialAuditError) {
      throw refreshError("CREDENTIAL_AUDIT_FAILED", "credential audit failed", {
        auditCode: String(error.code || "").slice(0, 80),
      });
    }
    throw refreshError("CREDENTIAL_AUDIT_FAILED", "credential audit failed");
  }
}

function mapTokenMutationError(error) {
  if (error instanceof CodeClipProviderCredentialRefreshError) throw error;
  if (error instanceof CodeClipProviderCredentialTokenMutationError) {
    throw refreshError(error.code, error.message, error.details || {});
  }
  throw error;
}

async function clearClaimForOwner({
  tx,
  credentialId,
  owner,
  operationNowIso,
  vertical = CODECLIP_VERTICAL,
}) {
  const result = await tx.query(
    `
      UPDATE codeclip_provider_credentials
      SET
        refresh_claim_owner = NULL,
        refresh_claimed_at = NULL,
        refresh_claim_expires_at = NULL
      WHERE id = $1
        AND vertical = $2
        AND refresh_claim_owner = $3
        AND refresh_claim_expires_at > $4::timestamptz
      RETURNING ${SAFE_RETURNING_COLUMNS}
    `,
    [credentialId, vertical, owner, operationNowIso]
  );
  return result.rows?.[0] || null;
}

/**
 * Atomically claim (or stale-reclaim) a credential refresh lease.
 */
async function claimCodeClipProviderCredentialRefresh(
  { credentialId, owner, leaseMs, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureRefreshSchema(client);

  const normalizedCredentialId = normalizePositiveBigIntId(
    credentialId,
    "credentialId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
  const injectedNow = normalizeInjectedNow(now);

  return withRefreshTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${CLAIM_SELECT_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedCredentialId, CODECLIP_VERTICAL]
    );
    const row = locked.rows?.[0] || null;
    if (!row) {
      throw refreshError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }

    if (!CLAIMABLE_STATUSES.includes(row.status) || !row.has_refresh_token) {
      return { ok: false, reason: "REFRESH_NOT_CLAIMABLE" };
    }

    const existingExpiresMs = parseTimestampMs(row.refresh_claim_expires_at);
    const hasActiveClaim =
      hasClaimTriplet(row) &&
      existingExpiresMs !== null &&
      existingExpiresMs > operationNowMs;

    if (hasActiveClaim) {
      return { ok: false, reason: "REFRESH_CLAIM_CONTENTION" };
    }

    const reclaimed = hasClaimTriplet(row);

    const updated = await tx.query(
      `
        UPDATE codeclip_provider_credentials
        SET
          refresh_claim_owner = $2,
          refresh_claimed_at = $3::timestamptz,
          refresh_claim_expires_at =
            $3::timestamptz + ($4::bigint * INTERVAL '1 millisecond')
        WHERE id = $1
          AND vertical = $5
          AND status IN ('active', 'reauthorization_required')
          AND has_refresh_token = TRUE
          AND (
            refresh_claim_expires_at IS NULL
            OR refresh_claim_expires_at <= $3::timestamptz
          )
        RETURNING
          id,
          refresh_claimed_at,
          refresh_claim_expires_at
      `,
      [
        normalizedCredentialId,
        normalizedOwner,
        operationNowIso,
        normalizedLeaseMs,
        CODECLIP_VERTICAL,
      ]
    );

    const claimed = updated.rows?.[0] || null;
    if (!claimed) {
      return { ok: false, reason: "REFRESH_CLAIM_CONTENTION" };
    }

    const claimedAt = toIsoTimestamp(claimed.refresh_claimed_at) || operationNowIso;
    const expiresAt = toIsoTimestamp(claimed.refresh_claim_expires_at);
    if (!expiresAt) {
      throw refreshError("DATABASE_ERROR", "claim returned invalid expiry");
    }

    const snapshot = auditSnapshotFromRow(row);
    await appendRefreshAudit(
      {
        credentialId: row.id,
        provider: row.provider,
        environment: row.environment,
        action: "refresh_claimed",
        actor: SYSTEM_REFRESH_ACTOR,
        reason: reclaimed
          ? "refresh_lease_reclaimed"
          : "refresh_lease_acquired",
        beforeState: snapshot,
        afterState: snapshot,
      },
      tx
    );

    return {
      ok: true,
      claimed: true,
      credentialId: String(claimed.id),
      claimedAt,
      expiresAt,
      reclaimed,
    };
  });
}

/**
 * Complete a refresh claim: token write + claim clear + refresh_succeeded.
 *
 * Disabled/revoked race (pool-owned TX):
 *   clear claim + refresh_released audit → COMMIT → throw REFRESH_NOT_COMPLETABLE.
 *
 * Disabled/revoked race (caller-owned client):
 *   clear claim + audit run on caller's active TX; repository does not COMMIT.
 *   Public API still throws REFRESH_NOT_COMPLETABLE after work returns.
 *   Caller must COMMIT that TX to persist cleanup (must not ROLLBACK it).
 */
async function completeCodeClipProviderCredentialRefresh(
  {
    credentialId,
    owner,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    tokenType,
    scopes,
    metadata,
    actor,
    reason = "refresh_succeeded",
    now,
  } = {},
  { queryClient, env = process.env } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureRefreshSchema(client);

  const normalizedCredentialId = normalizePositiveBigIntId(
    credentialId,
    "credentialId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const mutationActor = requireMutationActor(actor);
  const mutationReason = requireReasonCode(reason, "refresh_succeeded");
  const injectedNow = normalizeInjectedNow(now);

  if (metadata !== undefined) {
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      throw refreshError("INVALID_CREDENTIAL_INPUT", "metadata is invalid", {
        fieldName: "metadata",
      });
    }
  }

  const basePatch = { accessToken };
  if (refreshToken !== undefined) basePatch.refreshToken = refreshToken;
  if (accessTokenExpiresAt !== undefined) {
    basePatch.accessTokenExpiresAt = accessTokenExpiresAt;
  }
  if (tokenType !== undefined) basePatch.tokenType = tokenType;
  if (scopes !== undefined) basePatch.scopes = scopes;

  const outcome = await withRefreshTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${MUTATION_LOCK_SELECT_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedCredentialId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw refreshError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }

    // Disabled/revoked race: clear active owner claim + audit, then return
    // allowlisted post-commit failure marker (only code string; no row/Error/SQL).
    if (INACTIVE_STATUSES.includes(current.status)) {
      assertActiveClaimOwnership(current, normalizedOwner, operationNowMs);
      const before = auditSnapshotFromRow(current);
      const cleared = await clearClaimForOwner({
        tx,
        credentialId: normalizedCredentialId,
        owner: normalizedOwner,
        operationNowIso,
      });
      if (!cleared) {
        throw refreshError(
          "REFRESH_STATUS_RACE",
          "refresh claim changed during inactive cleanup"
        );
      }
      const after = auditSnapshotFromRow(cleared);
      await appendRefreshAudit(
        {
          credentialId: current.id,
          provider: current.provider,
          environment: current.environment,
          action: "refresh_released",
          actor: mutationActor,
          reason: "credential_not_refreshable",
          beforeState: before,
          afterState: after,
        },
        tx
      );
      return createPostCommitFailure("REFRESH_NOT_COMPLETABLE");
    }

    if (!CLAIMABLE_STATUSES.includes(current.status)) {
      throw refreshError(
        "REFRESH_NOT_COMPLETABLE",
        "credential status does not allow refresh completion"
      );
    }

    assertActiveClaimOwnership(current, normalizedOwner, operationNowMs);

    // Optional metadata: shallow-merge onto locked current row (omit = preserve).
    const patch = { ...basePatch };
    if (metadata !== undefined) {
      const currentMeta =
        current.metadata &&
        typeof current.metadata === "object" &&
        !Array.isArray(current.metadata)
          ? JSON.parse(JSON.stringify(current.metadata))
          : {};
      patch.metadata = { ...currentMeta, ...metadata };
    }

    let prepared;
    try {
      prepared = prepareCodeClipProviderCredentialTokenMutation({
        lockedCredential: current,
        patch,
        env,
        requireAccessToken: true,
      });
    } catch (error) {
      mapTokenMutationError(error);
    }

    const before = auditSnapshotFromRow(current);

    const updated = await tx.query(
      `
        UPDATE codeclip_provider_credentials
        SET
          access_token_envelope = $2,
          refresh_token_envelope = $3,
          has_access_token = $4,
          has_refresh_token = $5,
          encryption_key_version = $6,
          access_token_expires_at = $7::timestamptz,
          token_type = $8,
          scopes = $9::text[],
          metadata = $10::jsonb,
          status = $11,
          reauthorization_reason = $12,
          last_refreshed_at = $13::timestamptz,
          updated_at = $13::timestamptz,
          refresh_claim_owner = NULL,
          refresh_claimed_at = NULL,
          refresh_claim_expires_at = NULL
        WHERE id = $1
          AND vertical = $14
          AND status IN ('active', 'reauthorization_required')
          AND refresh_claim_owner = $15
          AND refresh_claim_expires_at > $13::timestamptz
        RETURNING ${SAFE_RETURNING_COLUMNS}
      `,
      [
        normalizedCredentialId,
        prepared.accessTokenEnvelope,
        prepared.refreshTokenEnvelope,
        prepared.hasAccessToken,
        prepared.hasRefreshToken,
        prepared.encryptionKeyVersion,
        prepared.accessTokenExpiresAt,
        prepared.tokenType,
        prepared.scopes,
        JSON.stringify(prepared.metadata),
        prepared.nextStatus,
        prepared.nextReauthorizationReason,
        operationNowIso,
        CODECLIP_VERTICAL,
        normalizedOwner,
      ]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw refreshError(
        "REFRESH_STATUS_RACE",
        "credential claim or status changed during refresh completion"
      );
    }

    const afterRow = {
      ...row,
      updated_at: row.updated_at ?? operationNowIso,
      last_refreshed_at: row.last_refreshed_at ?? operationNowIso,
    };

    await appendRefreshAudit(
      {
        credentialId: row.id,
        provider: row.provider,
        environment: row.environment,
        action: "refresh_succeeded",
        actor: mutationActor,
        reason: mutationReason,
        beforeState: before,
        afterState: auditSnapshotFromRow(afterRow),
      },
      tx
    );

    return {
      status: "completed",
      credential: mapSafeCredential(afterRow, { now: operationNowIso }),
    };
  });

  return resolvePostCommitOutcome(outcome);
}

/**
 * Release or fail a refresh claim without provider HTTP.
 */
async function releaseCodeClipProviderCredentialRefresh(
  { credentialId, owner, outcome, reason, actor, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureRefreshSchema(client);

  const normalizedCredentialId = normalizePositiveBigIntId(
    credentialId,
    "credentialId"
  );
  const normalizedOwner = normalizeClaimOwner(owner);
  const mutationActor = requireMutationActor(actor);
  const mutationReason = requireReasonCode(reason);
  const injectedNow = normalizeInjectedNow(now);

  if (typeof outcome !== "string" || !RELEASE_OUTCOMES.includes(outcome)) {
    throw refreshError("INVALID_CREDENTIAL_INPUT", "outcome is invalid", {
      fieldName: "outcome",
    });
  }

  return withRefreshTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${CLAIM_SELECT_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedCredentialId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw refreshError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }

    assertActiveClaimOwnership(current, normalizedOwner, operationNowMs);
    const before = auditSnapshotFromRow(current);

    let updatedRow = null;
    let auditAction = "refresh_released";
    let auditReason = mutationReason;

    if (outcome === "released") {
      auditAction = "refresh_released";
      updatedRow = await clearClaimForOwner({
        tx,
        credentialId: normalizedCredentialId,
        owner: normalizedOwner,
        operationNowIso,
      });
    } else if (outcome === "failed_retryable") {
      auditAction = "refresh_failed";
      updatedRow = await clearClaimForOwner({
        tx,
        credentialId: normalizedCredentialId,
        owner: normalizedOwner,
        operationNowIso,
      });
    } else if (outcome === "failed_reauthorization") {
      auditAction = "refresh_failed";
      if (INACTIVE_STATUSES.includes(current.status)) {
        // Do not overwrite disabled/revoked; clear claim only.
        auditReason = "credential_not_refreshable";
        updatedRow = await clearClaimForOwner({
          tx,
          credentialId: normalizedCredentialId,
          owner: normalizedOwner,
          operationNowIso,
        });
      } else if (CLAIMABLE_STATUSES.includes(current.status)) {
        const result = await tx.query(
          `
            UPDATE codeclip_provider_credentials
            SET
              status = 'reauthorization_required',
              reauthorization_reason = $3,
              updated_at = $4::timestamptz,
              refresh_claim_owner = NULL,
              refresh_claimed_at = NULL,
              refresh_claim_expires_at = NULL
            WHERE id = $1
              AND vertical = $2
              AND status IN ('active', 'reauthorization_required')
              AND refresh_claim_owner = $5
              AND refresh_claim_expires_at > $4::timestamptz
            RETURNING ${SAFE_RETURNING_COLUMNS}
          `,
          [
            normalizedCredentialId,
            CODECLIP_VERTICAL,
            mutationReason,
            operationNowIso,
            normalizedOwner,
          ]
        );
        updatedRow = result.rows?.[0] || null;
      } else {
        throw refreshError(
          "REFRESH_NOT_RELEASABLE",
          "credential status does not allow refresh failure handling"
        );
      }
    }

    if (!updatedRow) {
      throw refreshError(
        "REFRESH_STATUS_RACE",
        "refresh claim changed during release"
      );
    }

    const afterRow = {
      ...updatedRow,
      updated_at: updatedRow.updated_at ?? operationNowIso,
    };

    await appendRefreshAudit(
      {
        credentialId: current.id,
        provider: current.provider,
        environment: current.environment,
        action: auditAction,
        actor: mutationActor,
        reason: auditReason,
        beforeState: before,
        afterState: auditSnapshotFromRow(afterRow),
      },
      tx
    );

    return {
      status: outcome === "released" ? "released" : "failed",
      outcome,
      credential: mapSafeCredential(afterRow, { now: operationNowIso }),
    };
  });
}

module.exports = {
  CodeClipProviderCredentialRefreshError,
  claimCodeClipProviderCredentialRefresh,
  completeCodeClipProviderCredentialRefresh,
  releaseCodeClipProviderCredentialRefresh,
};
