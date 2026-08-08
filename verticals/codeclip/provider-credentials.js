/**
 * codeClip provider credential repository (F1C2B1 + F1C2B2A + F1C2B2B + F1C2C2).
 *
 * Public surface:
 * - create + safe get/find/list (B1)
 * - updateCodeClipProviderCredentialTokens (B2A token lifecycle)
 * - getCodeClipProviderCredentialSecretsForUse (B2B secret-read)
 * - inspectCodeClipProviderCredentialUsability (B2B safe inspect)
 * - setCodeClipProviderCredentialStatus (C2 status lifecycle)
 *
 * Encryption invariant:
 * - Access and refresh tokens for a credential are always stored with the same
 *   active encryption key version from the F1C1 keyring at write time.
 * - encryption_key_version represents the key version used for the last stored
 *   credential token set. Any token update re-encrypts the full resulting set
 *   with the active key so both envelopes stay aligned.
 *
 * Mutation + audit invariant (F1C2C2):
 * - Every credential mutation writes an audit event on the same transaction client.
 * - Actor is required on all mutations. Full actor/reason validation is owned by
 *   the C1 audit module; this repository only requires actor presence.
 * - Pool (connect): repository owns BEGIN/COMMIT/ROLLBACK.
 * - Explicit query client: caller owns the transaction; repository will not
 *   BEGIN/COMMIT/ROLLBACK.
 *
 * No token clearing, refresh claims, secret-read audit, routes, or consumers.
 */

const database = require("../../db");
const {
  getCodeClipProviderDefinition,
} = require("./provider-registry");
const {
  normalizeCodeClipProviderCredentialAccountRef,
  normalizeCodeClipProviderCredentialEnvironment,
  normalizeCodeClipProviderCredentialStatus,
  normalizeCodeClipProviderCredentialScopes,
  normalizeCodeClipProviderCredentialMetadata,
  normalizeCodeClipProviderCredentialPurpose,
  isCodeClipProviderCredentialExpired,
  validateCodeClipProviderCredentialStatusTransition,
} = require("./provider-credential-validators");
const {
  decryptCodeClipProviderCredentialSecret,
} = require("./provider-credential-crypto");
const {
  CodeClipProviderCredentialTokenMutationError,
  prepareCodeClipProviderCredentialTokenMutation,
  encryptCodeClipProviderCredentialTokenPair,
} = require("./provider-credential-token-mutation");
const {
  CodeClipProviderCredentialAuditError,
  appendCodeClipProviderCredentialAudit,
} = require("./provider-credential-audit");

const CODECLIP_VERTICAL = "codeclip";
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const LIST_CURSOR_VERSION = 1;
const MAX_BIGINT_ID = 9223372036854775807n;
const TOKEN_TYPE_MAX_LENGTH = 64;

/**
 * Explicit safe-path projection: includes provider_account_id only for masking.
 * Never includes access_token_envelope, refresh_token_envelope, or account_lookup_key.
 */
const SAFE_SELECT_COLUMNS = `
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

/** FOR UPDATE load: safe columns + both envelopes (never returned to callers). */
const TOKEN_UPDATE_SELECT_COLUMNS = `
  ${SAFE_SELECT_COLUMNS},
  access_token_envelope,
  refresh_token_envelope
`.replace(/\s+/g, " ").trim();

/** Secret-read: provider_api — access envelope only. */
const SECRET_PROVIDER_API_COLUMNS = `
  id,
  provider,
  environment,
  status,
  token_type,
  access_token_expires_at,
  has_access_token,
  access_token_envelope
`.replace(/\s+/g, " ").trim();

/** Secret-read: refresh — refresh envelope + authoritative account identity. */
const SECRET_REFRESH_COLUMNS = `
  id,
  provider,
  environment,
  status,
  provider_account_id,
  has_access_token,
  access_token_expires_at,
  has_refresh_token,
  refresh_token_envelope
`.replace(/\s+/g, " ").trim();

/** Inspect usability — no envelopes, no operator fields. */
const INSPECT_SELECT_COLUMNS = `
  id,
  provider,
  environment,
  status,
  has_access_token,
  has_refresh_token,
  access_token_expires_at
`.replace(/\s+/g, " ").trim();

const TOKEN_UPDATE_ALLOWED_STATUSES = Object.freeze([
  "active",
  "reauthorization_required",
]);

const SECRET_READ_PURPOSES = Object.freeze(["provider_api", "refresh"]);

/** Status-setter subset: reauth→active is token-update only; revoked is terminal. */
const STATUS_SETTER_ALLOWED_TRANSITIONS = Object.freeze({
  active: Object.freeze(
    new Set(["disabled", "reauthorization_required", "revoked"])
  ),
  disabled: Object.freeze(new Set(["active", "revoked"])),
  reauthorization_required: Object.freeze(new Set(["disabled", "revoked"])),
  revoked: Object.freeze(new Set()),
});

const DEFAULT_CREATE_AUDIT_REASON = "credential_created";
const DEFAULT_TOKEN_UPDATE_AUDIT_REASON = "credential_tokens_updated";

class CodeClipProviderCredentialError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderCredentialError";
    this.code = code;
    this.details = details;
  }
}

function credentialError(code, message, details = {}) {
  return new CodeClipProviderCredentialError(code, message, details);
}

/**
 * Accept either:
 * - a query client ({ query })
 * - a pool ({ connect }) for repository-owned transactions on mutations
 */
function requireQueryClient(queryClient) {
  if (!queryClient) {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential repository requires an explicit query client"
    );
  }
  const hasQuery = typeof queryClient.query === "function";
  const hasConnect = typeof queryClient.connect === "function";
  if (!hasQuery && !hasConnect) {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential repository requires an explicit query client"
    );
  }
  return queryClient;
}

async function ensureCredentialsSchema(queryClient) {
  if (queryClient === database.pool && typeof database.ensureCodeClipProviderCredentialsTable === "function") {
    await database.ensureCodeClipProviderCredentialsTable(queryClient);
  }
}

function hasQueryMethod(value) {
  return Boolean(value && typeof value.query === "function");
}

function isCallerOwnedQueryClient(value) {
  if (!hasQueryMethod(value)) return false;
  // pg PoolClient exposes query(), release(), and a connect() method inherited
  // from Client. release() is the stable signal that this is an already
  // acquired caller-owned connection.
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
 * Transaction contract for multi-statement credential mutations (FOR UPDATE + UPDATE):
 *
 * - Pool (has connect/query and no release): repository owns the transaction.
 *   connect → BEGIN → work(client) → COMMIT|ROLLBACK → release.
 *   Matches db.withCodeClipCorePersistenceTransaction ownership model.
 *
 * - Explicit client (query only, or acquired PoolClient with release): caller owns the transaction.
 *   Repository does NOT BEGIN/COMMIT/ROLLBACK.
 *   Caller must already be inside an active transaction so FOR UPDATE
 *   holds until UPDATE (autocommit clients are not safe for this path).
 *
 * Nested BEGIN on a caller-supplied client is intentionally not performed —
 * that would commit/rollback a caller-owned transaction incorrectly.
 */
async function withCredentialTransaction(queryClient, work) {
  if (!queryClient) {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential repository requires an explicit query client"
    );
  }

  if (isCallerOwnedQueryClient(queryClient)) {
    return work(queryClient);
  }

  // Pool path: repository-owned transaction (same model as withCodeClipCorePersistenceTransaction).
  if (isPoolLikeQueryClient(queryClient)) {
    let client = null;
    try {
      client = await queryClient.connect();
    } catch {
      throw credentialError("DATABASE_UNAVAILABLE", "failed to open database client");
    }
    if (!client || typeof client.query !== "function") {
      throw credentialError("DATABASE_UNAVAILABLE", "database pool returned an invalid client");
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
        // ignore release failures after commit/rollback
      }
    }
  }

  throw credentialError(
    "DATABASE_UNAVAILABLE",
    "codeClip provider credential repository requires an explicit query client"
  );
}

/**
 * One normalized ISO timestamp per public mutation.
 * Used for all explicit operation-time fields in that mutation.
 */
function normalizeOperationNow(now = new Date()) {
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  throw credentialError("INVALID_CREDENTIAL_INPUT", "now is invalid", {
    fieldName: "now",
  });
}

/** Structural actor presence only — full actor rules live in the audit module. */
function requireMutationActor(actor) {
  if (actor === undefined || actor === null) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "actor is required", {
      fieldName: "actor",
    });
  }
  if (typeof actor !== "object" || Array.isArray(actor)) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "actor is invalid", {
      fieldName: "actor",
    });
  }
  return actor;
}

function requireMutationReason(reason, { required = true, defaultReason = null } = {}) {
  if ((reason === undefined || reason === null || reason === "") && defaultReason) {
    return defaultReason;
  }
  if (typeof reason !== "string") {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "reason is required", {
      fieldName: "reason",
    });
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "reason is required", {
      fieldName: "reason",
    });
  }
  if (required === false && !trimmed) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "reason is required", {
      fieldName: "reason",
    });
  }
  return trimmed;
}

/**
 * Build audit input from a DB safe/locked row.
 * Never includes envelopes, lookup key, metadata, or other forbidden fields.
 * provider_account_id is retained only so the audit module can mask it.
 */
function dbRowForAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    provider_account_id:
      row.provider_account_id !== undefined
        ? row.provider_account_id
        : row.providerAccountId,
    has_access_token:
      row.has_access_token !== undefined
        ? row.has_access_token
        : row.hasAccessToken,
    has_refresh_token:
      row.has_refresh_token !== undefined
        ? row.has_refresh_token
        : row.hasRefreshToken,
    access_token_expires_at:
      row.access_token_expires_at !== undefined
        ? row.access_token_expires_at
        : row.accessTokenExpiresAt,
    encryption_key_version:
      row.encryption_key_version !== undefined
        ? row.encryption_key_version
        : row.encryptionKeyVersion,
    token_type: row.token_type !== undefined ? row.token_type : row.tokenType,
    scopes: row.scopes,
    reauthorization_reason:
      row.reauthorization_reason !== undefined
        ? row.reauthorization_reason
        : row.reauthorizationReason,
    disabled_at: row.disabled_at !== undefined ? row.disabled_at : row.disabledAt,
    revoked_at: row.revoked_at !== undefined ? row.revoked_at : row.revokedAt,
    last_refreshed_at:
      row.last_refreshed_at !== undefined
        ? row.last_refreshed_at
        : row.lastRefreshedAt,
    updated_at: row.updated_at !== undefined ? row.updated_at : row.updatedAt,
  };
}

async function appendMutationAudit(
  {
    credentialId,
    provider,
    environment,
    action,
    actor,
    reason,
    beforeState = null,
    afterState = null,
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
        beforeState: beforeState === null ? null : dbRowForAudit(beforeState),
        afterState: afterState === null ? null : dbRowForAudit(afterState),
      },
      { queryClient }
    );
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialError) throw error;
    if (error instanceof CodeClipProviderCredentialAuditError) {
      throw credentialError("CREDENTIAL_AUDIT_FAILED", "credential audit failed", {
        auditCode: String(error.code || "").slice(0, 80),
      });
    }
    throw credentialError("CREDENTIAL_AUDIT_FAILED", "credential audit failed");
  }
}

function validateStatusSetterTransition(fromStatus, toStatus) {
  const base = validateCodeClipProviderCredentialStatusTransition(fromStatus, toStatus);
  if (!base.ok) {
    throw credentialError(
      "INVALID_STATUS_TRANSITION",
      "status transition is not allowed",
      {
        fromStatus: fromStatus ?? null,
        toStatus: toStatus ?? null,
        reason: base.reason || null,
      }
    );
  }
  const allowed = STATUS_SETTER_ALLOWED_TRANSITIONS[base.fromStatus];
  if (!allowed || !allowed.has(base.toStatus)) {
    throw credentialError(
      "INVALID_STATUS_TRANSITION",
      "status transition is not allowed via status setter",
      {
        fromStatus: base.fromStatus,
        toStatus: base.toStatus,
      }
    );
  }
  return base;
}

function mapStatusSetterAuditAction(fromStatus, toStatus) {
  if (toStatus === "revoked") return "revoked";
  if (fromStatus === "active" && toStatus === "disabled") return "disabled";
  if (fromStatus === "disabled" && toStatus === "active") return "reactivated";
  if (fromStatus === "active" && toStatus === "reauthorization_required") {
    return "reauthorization_required";
  }
  if (fromStatus === "reauthorization_required" && toStatus === "disabled") {
    return "disabled";
  }
  throw credentialError(
    "INVALID_STATUS_TRANSITION",
    "status transition has no audit action mapping",
    { fromStatus, toStatus }
  );
}

/**
 * Build status UPDATE field values for entydig live state.
 * Returns { status, disabledAt, revokedAt, reauthorizationReason, touchRevoked, touchDisabled, touchReauth }.
 */
function buildStatusLiveState(fromStatus, toStatus, reason, operationNow) {
  if (toStatus === "revoked") {
    return {
      status: "revoked",
      disabledAt: null,
      revokedAt: operationNow,
      reauthorizationReason: null,
      setDisabled: true,
      setRevoked: true,
      setReauth: true,
    };
  }
  if (fromStatus === "active" && toStatus === "disabled") {
    return {
      status: "disabled",
      disabledAt: operationNow,
      revokedAt: undefined,
      reauthorizationReason: undefined,
      setDisabled: true,
      setRevoked: false,
      setReauth: false,
    };
  }
  if (fromStatus === "disabled" && toStatus === "active") {
    return {
      status: "active",
      disabledAt: null,
      revokedAt: undefined,
      reauthorizationReason: undefined,
      setDisabled: true,
      setRevoked: false,
      setReauth: false,
    };
  }
  if (fromStatus === "active" && toStatus === "reauthorization_required") {
    return {
      status: "reauthorization_required",
      disabledAt: undefined,
      revokedAt: undefined,
      reauthorizationReason: reason,
      setDisabled: false,
      setRevoked: false,
      setReauth: true,
    };
  }
  if (fromStatus === "reauthorization_required" && toStatus === "disabled") {
    return {
      status: "disabled",
      disabledAt: operationNow,
      revokedAt: undefined,
      reauthorizationReason: null,
      setDisabled: true,
      setRevoked: false,
      setReauth: true,
    };
  }
  throw credentialError(
    "INVALID_STATUS_TRANSITION",
    "status transition is not allowed via status setter",
    { fromStatus, toStatus }
  );
}

function mapTokenMutationError(error) {
  if (error instanceof CodeClipProviderCredentialTokenMutationError) {
    throw credentialError(error.code, error.message, error.details || {});
  }
  throw error;
}

/** Secret-read decrypt: result-object, never throws for crypto failure. */
function tryDecryptForSecretRead(envelope, env) {
  if (!envelope || typeof envelope !== "string") {
    return { ok: false, reason: "TOKEN_NOT_PRESENT" };
  }
  const result = decryptCodeClipProviderCredentialSecret({ envelope, env });
  if (!result.ok) {
    return { ok: false, reason: "CREDENTIAL_DECRYPTION_FAILED" };
  }
  return { ok: true, plaintext: result.plaintext };
}

function secretReadFailure(reason) {
  return { ok: false, reason };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function maskCodeClipProviderAccountId(providerAccountId) {
  const value = String(providerAccountId || "").trim();
  if (!value) return "";
  if (value.length <= 2) return "••";
  if (value.length <= 4) return `${"•".repeat(value.length - 1)}${value.slice(-1)}`;
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function normalizePositiveBigIntId(value, fieldName = "id") {
  let normalized;
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  return normalized;
}

function normalizeOptionalTokenType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "tokenType must be a string", {
      fieldName: "tokenType",
    });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > TOKEN_TYPE_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "tokenType is invalid", {
      fieldName: "tokenType",
    });
  }
  return normalized;
}

function normalizeOptionalExpiresAt(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "accessTokenExpiresAt is invalid", {
        fieldName: "accessTokenExpiresAt",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "accessTokenExpiresAt is invalid", {
        fieldName: "accessTokenExpiresAt",
      });
    }
    return new Date(ms).toISOString();
  }
  throw credentialError("INVALID_CREDENTIAL_INPUT", "accessTokenExpiresAt is invalid", {
    fieldName: "accessTokenExpiresAt",
  });
}

function normalizeOptionalTokenString(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} must be a string`, {
      fieldName,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", `${fieldName} must be a non-empty string`, {
      fieldName,
    });
  }
  return normalized;
}

function assertCredentialCapableProvider(provider) {
  const definition = getCodeClipProviderDefinition(provider);
  if (!definition) {
    throw credentialError(
      "UNSUPPORTED_CREDENTIAL_PROVIDER",
      "provider is not supported for credentials",
      { fieldName: "provider" }
    );
  }
  if (definition.capabilities?.credentials !== true) {
    throw credentialError(
      "UNSUPPORTED_CREDENTIAL_PROVIDER",
      "provider does not support durable credentials",
      { fieldName: "provider", provider: definition.name }
    );
  }
  return definition.name;
}

function mapValidatorFailure(result, fallbackCode = "INVALID_CREDENTIAL_INPUT") {
  if (result.ok) return;
  const reason = result.reason || fallbackCode;
  if (reason === "INVALID_PROVIDER") {
    throw credentialError(
      "UNSUPPORTED_CREDENTIAL_PROVIDER",
      "provider is not supported for credentials",
      { reason }
    );
  }
  throw credentialError(fallbackCode, "credential input is invalid", { reason });
}

function deepCopyJson(value) {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value));
}

function copyScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((entry) => String(entry));
}

function readField(row, camel, snake) {
  if (row?.[camel] !== undefined) return row[camel];
  if (row?.[snake] !== undefined) return row[snake];
  return undefined;
}

function normalizeExpiresForSafeRow(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

/**
 * Map a DB row to a safe public credential shape.
 * Never includes raw account id, lookup key, or envelopes.
 */
function toSafeCredential(row, { now = new Date() } = {}) {
  if (!row) return null;

  const accessTokenExpiresAt = normalizeExpiresForSafeRow(
    readField(row, "accessTokenExpiresAt", "access_token_expires_at")
  );
  const status = row.status;
  const providerAccountId = readField(row, "providerAccountId", "provider_account_id");
  // Preserve maskedAccountId when re-serializing an already-safe row (no raw id).
  const existingMask =
    typeof row.maskedAccountId === "string" && row.maskedAccountId
      ? row.maskedAccountId
      : null;
  const maskedAccountId =
    existingMask || maskCodeClipProviderAccountId(providerAccountId);
  const expiry = isCodeClipProviderCredentialExpired({
    accessTokenExpiresAt,
    now,
  });
  const expired = expiry.ok ? expiry.expired : false;
  const metadataValue = readField(row, "metadata", "metadata");
  const scopesValue = readField(row, "scopes", "scopes");

  return {
    id: row.id,
    vertical: row.vertical,
    provider: row.provider,
    environment: row.environment,
    maskedAccountId,
    status,
    tokenType: readField(row, "tokenType", "token_type") ?? null,
    scopes: copyScopes(scopesValue || []),
    hasAccessToken: Boolean(readField(row, "hasAccessToken", "has_access_token")),
    hasRefreshToken: Boolean(readField(row, "hasRefreshToken", "has_refresh_token")),
    accessTokenExpiresAt,
    expired,
    reauthorizationRequired: status === "reauthorization_required",
    reauthorizationReason:
      readField(row, "reauthorizationReason", "reauthorization_reason") ?? null,
    encryptionKeyVersion: Number(
      readField(row, "encryptionKeyVersion", "encryption_key_version")
    ),
    metadata: deepCopyJson(metadataValue && typeof metadataValue === "object" ? metadataValue : {}),
    createdAt: readField(row, "createdAt", "created_at"),
    updatedAt: readField(row, "updatedAt", "updated_at"),
    disabledAt: readField(row, "disabledAt", "disabled_at") ?? null,
    revokedAt: readField(row, "revokedAt", "revoked_at") ?? null,
    lastRefreshedAt: readField(row, "lastRefreshedAt", "last_refreshed_at") ?? null,
  };
}

function encodeCredentialCursor(credential) {
  if (!credential) return null;
  return Buffer.from(
    JSON.stringify({
      v: LIST_CURSOR_VERSION,
      updatedAt:
        credential.updatedAt instanceof Date
          ? credential.updatedAt.toISOString()
          : String(credential.updatedAt),
      id: String(credential.id),
    })
  ).toString("base64url");
}

function decodeCredentialCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > 512) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "cursor is invalid", {
      fieldName: "cursor",
    });
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const keys = Object.keys(decoded || {}).sort().join(",");
    if (!decoded || decoded.v !== LIST_CURSOR_VERSION || keys !== "id,updatedAt,v") {
      throw new Error("invalid cursor shape");
    }
    const updatedAt = String(decoded.updatedAt || "").trim();
    if (!Number.isFinite(Date.parse(updatedAt))) {
      throw new Error("invalid cursor timestamp");
    }
    return {
      updatedAt,
      id: normalizePositiveBigIntId(decoded.id, "cursor.id"),
    };
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialError) throw error;
    throw credentialError("INVALID_CREDENTIAL_INPUT", "cursor is invalid", {
      fieldName: "cursor",
    });
  }
}

function normalizeListFilters(filters = {}) {
  const vertical = CODECLIP_VERTICAL;
  let provider = null;
  if (filters.provider !== undefined && filters.provider !== null && filters.provider !== "") {
    const definition = getCodeClipProviderDefinition(filters.provider);
    if (!definition) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "provider filter is invalid", {
        fieldName: "provider",
      });
    }
    provider = definition.name;
  }

  let environment = null;
  if (
    filters.environment !== undefined &&
    filters.environment !== null &&
    filters.environment !== ""
  ) {
    const envResult = normalizeCodeClipProviderCredentialEnvironment(filters.environment);
    mapValidatorFailure(envResult);
    environment = envResult.environment;
  }

  let status = null;
  if (filters.status !== undefined && filters.status !== null && filters.status !== "") {
    const statusResult = normalizeCodeClipProviderCredentialStatus(filters.status);
    mapValidatorFailure(statusResult);
    status = statusResult.status;
  }

  let limit = DEFAULT_LIST_LIMIT;
  if (filters.limit !== undefined && filters.limit !== null && filters.limit !== "") {
    if (typeof filters.limit === "number") {
      if (!Number.isInteger(filters.limit) || filters.limit <= 0) {
        throw credentialError("INVALID_CREDENTIAL_INPUT", "limit is invalid", {
          fieldName: "limit",
        });
      }
      limit = filters.limit;
    } else if (typeof filters.limit === "string") {
      if (!/^[0-9]+$/.test(filters.limit.trim())) {
        throw credentialError("INVALID_CREDENTIAL_INPUT", "limit is invalid", {
          fieldName: "limit",
        });
      }
      limit = Number.parseInt(filters.limit.trim(), 10);
      if (!limit) {
        throw credentialError("INVALID_CREDENTIAL_INPUT", "limit is invalid", {
          fieldName: "limit",
        });
      }
    } else {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "limit is invalid", {
        fieldName: "limit",
      });
    }
  }
  limit = Math.min(limit, MAX_LIST_LIMIT);

  const cursor = decodeCredentialCursor(filters.cursor);

  return { vertical, provider, environment, status, limit, cursor };
}

/**
 * Create a durable provider credential. Encrypts tokens before insert.
 * Writes a created audit event on the same transaction client (F1C2C2).
 * Returns only a safe row (no envelopes / raw account id).
 */
async function createCodeClipProviderCredential(
  input = {},
  {
    queryClient,
    env = process.env,
    now = new Date(),
    actor,
    reason = DEFAULT_CREATE_AUDIT_REASON,
  } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const operationNow = normalizeOperationNow(now);
  const mutationActor = requireMutationActor(actor);
  const mutationReason = requireMutationReason(reason, {
    defaultReason: DEFAULT_CREATE_AUDIT_REASON,
  });

  const accountRef = normalizeCodeClipProviderCredentialAccountRef({
    provider: input.provider,
    providerAccountId: input.providerAccountId ?? input.provider_account_id,
    environment: input.environment,
  });
  mapValidatorFailure(accountRef);
  assertCredentialCapableProvider(accountRef.provider);

  const accessToken = normalizeOptionalTokenString(input.accessToken, "accessToken");
  const refreshToken = normalizeOptionalTokenString(input.refreshToken, "refreshToken");
  if (!accessToken && !refreshToken) {
    throw credentialError(
      "INVALID_CREDENTIAL_INPUT",
      "at least one of accessToken or refreshToken is required",
      { fieldName: "accessToken" }
    );
  }

  const scopesResult = normalizeCodeClipProviderCredentialScopes(input.scopes);
  mapValidatorFailure(scopesResult);
  const metadataResult = normalizeCodeClipProviderCredentialMetadata(input.metadata);
  mapValidatorFailure(metadataResult);
  const tokenType = normalizeOptionalTokenType(input.tokenType ?? input.token_type);
  const accessTokenExpiresAt = normalizeOptionalExpiresAt(
    input.accessTokenExpiresAt ?? input.access_token_expires_at
  );

  // Encrypt before SQL. Access and refresh use the same active key version (F1C1).
  // Failure here starts no transaction and writes no audit.
  let accessEnvelope;
  let refreshEnvelope;
  let keyVersion;
  try {
    ({ accessEnvelope, refreshEnvelope, keyVersion } =
      encryptCodeClipProviderCredentialTokenPair({
        accessToken,
        refreshToken,
        env,
      }));
  } catch (error) {
    mapTokenMutationError(error);
  }

  return withCredentialTransaction(client, async (tx) => {
    let row;
    try {
      const result = await tx.query(
        `
          INSERT INTO codeclip_provider_credentials (
            vertical,
            provider,
            environment,
            account_lookup_key,
            provider_account_id,
            status,
            access_token_envelope,
            refresh_token_envelope,
            access_token_expires_at,
            token_type,
            scopes,
            encryption_key_version,
            has_access_token,
            has_refresh_token,
            reauthorization_reason,
            metadata,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,'active',
            $6,$7,$8::timestamptz,$9,$10::text[],
            $11,$12,$13,NULL,$14::jsonb,$15::timestamptz
          )
          RETURNING ${SAFE_SELECT_COLUMNS}
        `,
        [
          CODECLIP_VERTICAL,
          accountRef.provider,
          accountRef.environment,
          accountRef.accountLookupKey,
          accountRef.providerAccountId,
          accessEnvelope,
          refreshEnvelope,
          accessTokenExpiresAt,
          tokenType,
          scopesResult.scopes,
          keyVersion,
          Boolean(accessEnvelope),
          Boolean(refreshEnvelope),
          JSON.stringify(metadataResult.metadata),
          operationNow,
        ]
      );
      row = result.rows?.[0] || null;
    } catch (error) {
      if (error instanceof CodeClipProviderCredentialError) throw error;
      if (error?.code === "23505") {
        throw credentialError(
          "CREDENTIAL_CONFLICT",
          "a credential already exists for this provider account and environment",
          {
            provider: accountRef.provider,
            environment: accountRef.environment,
          }
        );
      }
      throw credentialError("DATABASE_ERROR", "credential create failed");
    }

    if (!row) {
      throw credentialError("DATABASE_ERROR", "credential create returned no row");
    }

    // Ensure audit snapshot sees the same operation time as the insert.
    const afterRow = {
      ...row,
      updated_at: row.updated_at ?? operationNow,
    };

    await appendMutationAudit(
      {
        credentialId: row.id,
        provider: accountRef.provider,
        environment: accountRef.environment,
        action: "created",
        actor: mutationActor,
        reason: mutationReason,
        beforeState: null,
        afterState: afterRow,
      },
      tx
    );

    return {
      status: "created",
      created: true,
      credential: toSafeCredential(afterRow, { now: operationNow }),
    };
  });
}

async function getCodeClipProviderCredentialById(
  id,
  { queryClient, now = new Date() } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const normalizedId = normalizePositiveBigIntId(id, "id");

  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_credentials
      WHERE id = $1
        AND vertical = $2
      LIMIT 1
    `,
    [normalizedId, CODECLIP_VERTICAL]
  );

  return toSafeCredential(result.rows?.[0] || null, { now });
}

async function findCodeClipProviderCredential(
  { provider, providerAccountId, environment } = {},
  { queryClient, now = new Date() } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);

  const accountRef = normalizeCodeClipProviderCredentialAccountRef({
    provider,
    providerAccountId,
    environment,
  });
  mapValidatorFailure(accountRef);

  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_credentials
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

  return toSafeCredential(result.rows?.[0] || null, { now });
}

async function listCodeClipProviderCredentials(
  filters = {},
  { queryClient, now = new Date() } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const normalized = normalizeListFilters(filters);

  const predicates = ["vertical = $1"];
  const params = [normalized.vertical];

  if (normalized.provider) {
    params.push(normalized.provider);
    predicates.push(`provider = $${params.length}`);
  }
  if (normalized.environment) {
    params.push(normalized.environment);
    predicates.push(`environment = $${params.length}`);
  }
  if (normalized.status) {
    params.push(normalized.status);
    predicates.push(`status = $${params.length}`);
  }
  if (normalized.cursor) {
    params.push(normalized.cursor.updatedAt);
    const updatedAtParam = params.length;
    params.push(normalized.cursor.id);
    const idParam = params.length;
    predicates.push(`(
      updated_at < $${updatedAtParam}::timestamptz
      OR (updated_at = $${updatedAtParam}::timestamptz AND id < $${idParam}::bigint)
    )`);
  }

  params.push(normalized.limit + 1);
  const result = await client.query(
    `
      SELECT ${SAFE_SELECT_COLUMNS}
      FROM codeclip_provider_credentials
      WHERE ${predicates.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );

  const rows = (result.rows || []).map((row) => toSafeCredential(row, { now }));
  const hasMore = rows.length > normalized.limit;
  const items = hasMore ? rows.slice(0, normalized.limit) : rows;

  return {
    items,
    page: {
      limit: normalized.limit,
      nextCursor: hasMore ? encodeCredentialCursor(items[items.length - 1]) : null,
      hasMore,
    },
    filters: {
      vertical: normalized.vertical,
      provider: normalized.provider,
      environment: normalized.environment,
      status: normalized.status,
    },
  };
}

/**
 * Operator serializer: defensive copy of an already-safe credential row.
 */
function serializeCodeClipProviderCredentialForOperator(row, { now = new Date() } = {}) {
  if (row === undefined || row === null) return null;
  if (typeof row !== "object" || Array.isArray(row)) {
    throw credentialError(
      "INVALID_CREDENTIAL_INPUT",
      "credential row must be an object",
      { fieldName: "row" }
    );
  }
  // Accept either safe shape or raw DB row and project safely.
  const safe = toSafeCredential(row, { now });
  if (!safe) return null;
  return {
    ...safe,
    scopes: copyScopes(safe.scopes),
    metadata: deepCopyJson(safe.metadata),
  };
}

/**
 * Token lifecycle update: replace access and/or refresh tokens.
 *
 * Contract:
 * - Actor is required; audit writes token_updated on the same TX client.
 * - At least one of accessToken or refreshToken must be present (hasOwn).
 * - Omitted token fields preserve existing material (via decrypt + re-encrypt).
 * - null / empty string tokens are rejected (no clearing).
 * - Full resulting token set is re-encrypted with the active key version.
 * - Non-secret fields (expires, tokenType, scopes, metadata) may update only
 *   together with a token change.
 * - last_refreshed_at and updated_at use the same operationNow.
 *
 * Returns a safe credential row only.
 */
async function updateCodeClipProviderCredentialTokens(
  id,
  patch = {},
  {
    queryClient,
    env = process.env,
    now = new Date(),
    actor,
    reason = DEFAULT_TOKEN_UPDATE_AUDIT_REASON,
  } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const operationNow = normalizeOperationNow(now);
  const mutationActor = requireMutationActor(actor);
  const mutationReason = requireMutationReason(reason, {
    defaultReason: DEFAULT_TOKEN_UPDATE_AUDIT_REASON,
  });
  const normalizedId = normalizePositiveBigIntId(id, "id");

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "token update patch must be an object", {
      fieldName: "patch",
    });
  }

  // Fail-closed presence check before TX (same public contract as pre-extract).
  const accessPresent = hasOwn(patch, "accessToken");
  const refreshPresent = hasOwn(patch, "refreshToken");
  if (!accessPresent && !refreshPresent) {
    throw credentialError(
      "INVALID_CREDENTIAL_INPUT",
      "at least one of accessToken or refreshToken is required",
      { fieldName: "accessToken" }
    );
  }

  return withCredentialTransaction(client, async (tx) => {
    const locked = await tx.query(
      `
        SELECT ${TOKEN_UPDATE_SELECT_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw credentialError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }

    if (!TOKEN_UPDATE_ALLOWED_STATUSES.includes(current.status)) {
      throw credentialError(
        "INVALID_STATUS_FOR_TOKEN_UPDATE",
        "credential status does not allow token update",
        { status: current.status }
      );
    }

    const beforeState = dbRowForAudit(current);

    let prepared;
    try {
      prepared = prepareCodeClipProviderCredentialTokenMutation({
        lockedCredential: current,
        patch,
        env,
        requireAccessToken: false,
      });
    } catch (error) {
      mapTokenMutationError(error);
    }

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
          updated_at = $13::timestamptz
        WHERE id = $1
          AND vertical = $14
          AND status IN ('active', 'reauthorization_required')
        RETURNING ${SAFE_SELECT_COLUMNS}
      `,
      [
        normalizedId,
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
        operationNow,
        CODECLIP_VERTICAL,
      ]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw credentialError(
        "INVALID_STATUS_FOR_TOKEN_UPDATE",
        "credential status changed during token update"
      );
    }

    const afterRow = {
      ...row,
      updated_at: row.updated_at ?? operationNow,
      last_refreshed_at: row.last_refreshed_at ?? operationNow,
    };

    await appendMutationAudit(
      {
        credentialId: row.id,
        provider: row.provider,
        environment: row.environment,
        action: "token_updated",
        actor: mutationActor,
        reason: mutationReason,
        beforeState,
        afterState: afterRow,
      },
      tx
    );

    return {
      status: "updated",
      credential: toSafeCredential(afterRow, { now: operationNow }),
    };
  });
}

/**
 * Status lifecycle mutation with atomic audit (F1C2C2).
 * Does not load or decrypt token envelopes.
 */
async function setCodeClipProviderCredentialStatus(
  id,
  { status, reason, actor, now = new Date() } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const operationNow = normalizeOperationNow(now);
  const mutationActor = requireMutationActor(actor);
  const mutationReason = requireMutationReason(reason, { required: true });
  const normalizedId = normalizePositiveBigIntId(id, "id");

  const statusResult = normalizeCodeClipProviderCredentialStatus(status);
  if (!statusResult.ok) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "status is invalid", {
      fieldName: "status",
      reason: statusResult.reason || null,
    });
  }
  const targetStatus = statusResult.status;

  return withCredentialTransaction(client, async (tx) => {
    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        FOR UPDATE
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw credentialError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }

    const transition = validateStatusSetterTransition(current.status, targetStatus);
    const live = buildStatusLiveState(
      transition.fromStatus,
      transition.toStatus,
      mutationReason,
      operationNow
    );
    const auditAction = mapStatusSetterAuditAction(
      transition.fromStatus,
      transition.toStatus
    );
    const beforeState = dbRowForAudit(current);

    const setClauses = ["status = $3", "updated_at = $4::timestamptz"];
    const params = [normalizedId, CODECLIP_VERTICAL, live.status, operationNow];

    if (live.setDisabled) {
      params.push(live.disabledAt);
      setClauses.push(`disabled_at = $${params.length}::timestamptz`);
    }
    if (live.setRevoked) {
      params.push(live.revokedAt);
      setClauses.push(`revoked_at = $${params.length}::timestamptz`);
    }
    if (live.setReauth) {
      params.push(live.reauthorizationReason);
      setClauses.push(`reauthorization_reason = $${params.length}`);
    }

    params.push(transition.fromStatus);
    const fromStatusParam = params.length;

    const updated = await tx.query(
      `
        UPDATE codeclip_provider_credentials
        SET ${setClauses.join(", ")}
        WHERE id = $1
          AND vertical = $2
          AND status = $${fromStatusParam}
        RETURNING ${SAFE_SELECT_COLUMNS}
      `,
      params
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw credentialError(
        "CREDENTIAL_STATUS_RACE",
        "credential status changed during status update"
      );
    }

    const afterRow = {
      ...row,
      updated_at: row.updated_at ?? operationNow,
    };

    await appendMutationAudit(
      {
        credentialId: row.id,
        provider: row.provider,
        environment: row.environment,
        action: auditAction,
        actor: mutationActor,
        reason: mutationReason,
        beforeState,
        afterState: afterRow,
      },
      tx
    );

    return {
      status: "updated",
      credential: toSafeCredential(afterRow, { now: operationNow }),
    };
  });
}

/**
 * Explicit secret-read. Only purposes: provider_api | refresh.
 * Domain denials and decrypt failures return { ok: false, reason }.
 * Invalid id / missing queryClient throw typed errors (programming / infra).
 */
async function getCodeClipProviderCredentialSecretsForUse(
  { id, purpose, now = new Date() } = {},
  { queryClient, env = process.env } = {}
) {
  const client = requireQueryClient(queryClient);
  if (typeof client.query !== "function") {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "secret-read requires a query-capable client"
    );
  }
  await ensureCredentialsSchema(client);
  const normalizedId = normalizePositiveBigIntId(id, "id");

  const purposeResult = normalizeCodeClipProviderCredentialPurpose(purpose);
  if (!purposeResult.ok || !SECRET_READ_PURPOSES.includes(purposeResult.purpose)) {
    return secretReadFailure("INVALID_SECRET_PURPOSE");
  }
  const normalizedPurpose = purposeResult.purpose;

  try {
    if (normalizedPurpose === "provider_api") {
      const result = await client.query(
        `
          SELECT ${SECRET_PROVIDER_API_COLUMNS}
          FROM codeclip_provider_credentials
          WHERE id = $1
            AND vertical = $2
          LIMIT 1
        `,
        [normalizedId, CODECLIP_VERTICAL]
      );
      const row = result.rows?.[0] || null;
      if (!row) return secretReadFailure("CREDENTIAL_NOT_FOUND");

      if (row.status === "reauthorization_required") {
        return secretReadFailure("REAUTHORIZATION_REQUIRED");
      }
      if (row.status === "disabled" || row.status === "revoked") {
        return secretReadFailure("CREDENTIAL_NOT_USABLE");
      }
      if (row.status !== "active") {
        return secretReadFailure("CREDENTIAL_NOT_USABLE");
      }
      if (!row.has_access_token || !row.access_token_envelope) {
        return secretReadFailure("TOKEN_NOT_PRESENT");
      }

      const expiresAt = normalizeExpiresForSafeRow(row.access_token_expires_at);
      const expiry = isCodeClipProviderCredentialExpired({
        accessTokenExpiresAt: expiresAt,
        now,
      });
      if (!expiry.ok) {
        return secretReadFailure("CREDENTIAL_DECRYPTION_FAILED");
      }
      if (expiry.expired) {
        return secretReadFailure("TOKEN_EXPIRED");
      }

      const decrypted = tryDecryptForSecretRead(row.access_token_envelope, env);
      if (!decrypted.ok) {
        return secretReadFailure(decrypted.reason);
      }

      return {
        ok: true,
        purpose: "provider_api",
        accessToken: decrypted.plaintext,
        credential: {
          id: row.id,
          provider: row.provider,
          environment: row.environment,
          tokenType: row.token_type ?? null,
          accessTokenExpiresAt: expiresAt,
          expired: false,
        },
      };
    }

    // refresh
    const result = await client.query(
      `
        SELECT ${SECRET_REFRESH_COLUMNS}
        FROM codeclip_provider_credentials
        WHERE id = $1
          AND vertical = $2
        LIMIT 1
      `,
      [normalizedId, CODECLIP_VERTICAL]
    );
    const row = result.rows?.[0] || null;
    if (!row) return secretReadFailure("CREDENTIAL_NOT_FOUND");

    if (row.status === "disabled" || row.status === "revoked") {
      return secretReadFailure("CREDENTIAL_NOT_USABLE");
    }
    if (row.status !== "active" && row.status !== "reauthorization_required") {
      return secretReadFailure("CREDENTIAL_NOT_USABLE");
    }
    if (!row.has_refresh_token || !row.refresh_token_envelope) {
      return secretReadFailure("TOKEN_NOT_PRESENT");
    }

    const expiresAt = normalizeExpiresForSafeRow(row.access_token_expires_at);
    const expiry = isCodeClipProviderCredentialExpired({
      accessTokenExpiresAt: expiresAt,
      now,
    });
    const expired = expiry.ok ? expiry.expired : false;

    const decrypted = tryDecryptForSecretRead(row.refresh_token_envelope, env);
    if (!decrypted.ok) {
      return secretReadFailure(decrypted.reason);
    }

    // providerAccountId is authoritative identity for refresh verification
    // (memory-only; never part of operator serialization).
    const providerAccountId =
      row.provider_account_id !== undefined && row.provider_account_id !== null
        ? String(row.provider_account_id)
        : null;
    if (!providerAccountId) {
      return secretReadFailure("CREDENTIAL_NOT_USABLE");
    }

    return {
      ok: true,
      purpose: "refresh",
      refreshToken: decrypted.plaintext,
      credential: {
        id: row.id,
        provider: row.provider,
        environment: row.environment,
        status: row.status,
        providerAccountId,
        hasAccessToken: Boolean(row.has_access_token),
        accessTokenExpiresAt: expiresAt,
        expired,
      },
    };
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialError) throw error;
    return secretReadFailure("DATABASE_ERROR");
  }
}

/**
 * Safe usability inspection. Never decrypts. Does not use operator getById surface.
 * Own SQL projection — no envelopes, mask, metadata, or scopes.
 * Returns null when not found (same as getById).
 */
async function inspectCodeClipProviderCredentialUsability(
  { id, now = new Date() } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  if (typeof client.query !== "function") {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "inspect requires a query-capable client"
    );
  }
  await ensureCredentialsSchema(client);
  const normalizedId = normalizePositiveBigIntId(id, "id");

  const result = await client.query(
    `
      SELECT ${INSPECT_SELECT_COLUMNS}
      FROM codeclip_provider_credentials
      WHERE id = $1
        AND vertical = $2
      LIMIT 1
    `,
    [normalizedId, CODECLIP_VERTICAL]
  );
  const row = result.rows?.[0] || null;
  if (!row) return null;

  const status = row.status;
  const hasAccessToken = Boolean(row.has_access_token);
  const hasRefreshToken = Boolean(row.has_refresh_token);
  const accessTokenExpiresAt = normalizeExpiresForSafeRow(row.access_token_expires_at);
  const expiry = isCodeClipProviderCredentialExpired({
    accessTokenExpiresAt,
    now,
  });
  const expired = expiry.ok ? expiry.expired : false;

  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    status,
    hasAccessToken,
    hasRefreshToken,
    accessTokenExpiresAt,
    expired,
    reauthorizationRequired: status === "reauthorization_required",
    usableForProviderApi: status === "active" && hasAccessToken && !expired,
    usableForRefresh:
      (status === "active" || status === "reauthorization_required") && hasRefreshToken,
  };
}

module.exports = {
  CodeClipProviderCredentialError,
  createCodeClipProviderCredential,
  getCodeClipProviderCredentialById,
  findCodeClipProviderCredential,
  listCodeClipProviderCredentials,
  updateCodeClipProviderCredentialTokens,
  setCodeClipProviderCredentialStatus,
  getCodeClipProviderCredentialSecretsForUse,
  inspectCodeClipProviderCredentialUsability,
  serializeCodeClipProviderCredentialForOperator,
};
