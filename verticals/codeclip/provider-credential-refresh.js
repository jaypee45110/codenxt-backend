/**
 * codeClip provider credential refresh claim foundation (F1C3A).
 *
 * Owns durable multi-instance refresh locking only:
 * - claim / stale reclaim
 * - owner + lease validation
 * - atomic refresh_claimed audit
 *
 * Does not complete refresh, update tokens, call providers, or wire routes.
 * PostgreSQL is the authoritative lock store (no process-local locks).
 */

const database = require("../../db");
const {
  CodeClipProviderCredentialAuditError,
  appendCodeClipProviderCredentialAudit,
} = require("./provider-credential-audit");

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
  refresh_claim_owner,
  refresh_claimed_at,
  refresh_claim_expires_at
`.replace(/\s+/g, " ").trim();

const SYSTEM_REFRESH_ACTOR = Object.freeze({
  type: "system",
  id: "credential_refresh",
});

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
    for (const key of ["fieldName", "reason", "auditCode"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderCredentialRefreshError(code, message, safe);
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

/**
 * Safe audit input: no envelopes, lookup key, metadata, or claim fields.
 * provider_account_id is mask source only (stripped by audit module).
 */
function auditSnapshotFromClaimRow(row) {
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

async function appendRefreshClaimAudit(
  {
    credentialId,
    provider,
    environment,
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
        action: "refresh_claimed",
        actor: SYSTEM_REFRESH_ACTOR,
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

/**
 * Atomically claim (or stale-reclaim) a credential refresh lease.
 *
 * Production clock: PostgreSQL NOW() when `now` is omitted.
 * Tests: inject `now` for deterministic lease math.
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
    const clockResult = await tx.query(
      `
        SELECT COALESCE($1::timestamptz, NOW()) AS operation_now
      `,
      [injectedNow]
    );
    const operationNowRaw = clockResult.rows?.[0]?.operation_now;
    const operationNowIso = toIsoTimestamp(operationNowRaw);
    if (!operationNowIso) {
      throw refreshError("DATABASE_ERROR", "failed to resolve operation clock");
    }
    const operationNowMs = parseTimestampMs(operationNowIso);

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
      row.refresh_claim_owner !== null &&
      row.refresh_claim_owner !== undefined &&
      row.refresh_claim_owner !== "" &&
      existingExpiresMs !== null &&
      existingExpiresMs > operationNowMs;

    if (hasActiveClaim) {
      return { ok: false, reason: "REFRESH_CLAIM_CONTENTION" };
    }

    const reclaimed =
      row.refresh_claim_owner !== null &&
      row.refresh_claim_owner !== undefined &&
      String(row.refresh_claim_owner).trim() !== "";

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

    const snapshot = auditSnapshotFromClaimRow(row);
    await appendRefreshClaimAudit(
      {
        credentialId: row.id,
        provider: row.provider,
        environment: row.environment,
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

module.exports = {
  CodeClipProviderCredentialRefreshError,
  claimCodeClipProviderCredentialRefresh,
};
