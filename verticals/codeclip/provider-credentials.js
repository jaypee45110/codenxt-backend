/**
 * codeClip provider credential repository (F1C2B1 + F1C2B2A).
 *
 * Public surface:
 * - create + safe get/find/list (B1)
 * - updateCodeClipProviderCredentialTokens (B2A token lifecycle)
 *
 * Encryption invariant:
 * - Access and refresh tokens for a credential are always stored with the same
 *   active encryption key version from the F1C1 keyring at write time.
 * - encryption_key_version represents the key version used for the last stored
 *   credential token set. Any token update re-encrypts the full resulting set
 *   with the active key so both envelopes stay aligned.
 *
 * Mutation APIs (token update) must not be wired to production consumers or
 * routes before F1C2C audit integration.
 *
 * Token-update transaction ownership:
 * - Pass a pool (connect): repository owns BEGIN/COMMIT/ROLLBACK.
 * - Pass an explicit query client: caller owns the transaction; repository
 *   will not BEGIN/COMMIT/ROLLBACK. Caller must already be in an active TX.
 *
 * TODO(F1C2B2B): secret-read (provider_api, refresh) and usability inspect.
 * No audit, status setter, token clearing, refresh claims, or routes in B2A.
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
  isCodeClipProviderCredentialExpired,
} = require("./provider-credential-validators");
const {
  encryptCodeClipProviderCredentialSecret,
  decryptCodeClipProviderCredentialSecret,
} = require("./provider-credential-crypto");

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

const TOKEN_UPDATE_ALLOWED_STATUSES = Object.freeze([
  "active",
  "reauthorization_required",
]);

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

/**
 * Transaction contract for multi-statement credential mutations (FOR UPDATE + UPDATE):
 *
 * - Pool (has connect): repository owns the transaction.
 *   connect → BEGIN → work(client) → COMMIT|ROLLBACK → release.
 *   Matches db.withCodeClipCorePersistenceTransaction ownership model.
 *
 * - Explicit client (query only, no connect): caller owns the transaction.
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

  // Pool path: repository-owned transaction (same model as withCodeClipCorePersistenceTransaction).
  if (typeof queryClient.connect === "function") {
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

  // Caller-owned client: must already participate in an active transaction.
  if (typeof queryClient.query !== "function") {
    throw credentialError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential repository requires an explicit query client"
    );
  }
  return work(queryClient);
}

function decryptToken(envelope, env) {
  const result = decryptCodeClipProviderCredentialSecret({ envelope, env });
  if (!result.ok) {
    throw credentialError(
      "CREDENTIAL_DECRYPTION_FAILED",
      "credential decryption failed",
      { cryptoReason: result.reason }
    );
  }
  return result.plaintext;
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

function encryptToken(plaintext, env) {
  const result = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  if (!result.ok) {
    throw credentialError(
      "CREDENTIAL_ENCRYPTION_FAILED",
      "credential encryption failed",
      { cryptoReason: result.reason }
    );
  }
  return {
    envelope: result.envelope,
    keyVersion: result.keyVersion,
  };
}

/**
 * Encrypt access and refresh with the same active key version (F1C1 active key).
 * Both calls use the keyring active version; versions must match.
 */
function encryptCredentialTokenPair({ accessToken, refreshToken, env }) {
  let accessEnvelope = null;
  let refreshEnvelope = null;
  let keyVersion = null;

  if (accessToken) {
    const encrypted = encryptToken(accessToken, env);
    accessEnvelope = encrypted.envelope;
    keyVersion = encrypted.keyVersion;
  }
  if (refreshToken) {
    const encrypted = encryptToken(refreshToken, env);
    refreshEnvelope = encrypted.envelope;
    if (keyVersion === null) {
      keyVersion = encrypted.keyVersion;
    } else if (encrypted.keyVersion !== keyVersion) {
      // Invariant: both tokens must use the same active key version.
      throw credentialError(
        "CREDENTIAL_ENCRYPTION_FAILED",
        "credential tokens must share the same encryption key version",
        { cryptoReason: "KEY_VERSION_MISMATCH" }
      );
    }
  }

  if (keyVersion === null || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw credentialError(
      "CREDENTIAL_ENCRYPTION_FAILED",
      "credential encryption key version is invalid"
    );
  }

  return { accessEnvelope, refreshEnvelope, keyVersion };
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
 * Returns only a safe row (no envelopes / raw account id).
 */
async function createCodeClipProviderCredential(
  input = {},
  { queryClient, env = process.env, now = new Date() } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);

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
  const { accessEnvelope, refreshEnvelope, keyVersion } = encryptCredentialTokenPair({
    accessToken,
    refreshToken,
    env,
  });

  try {
    const result = await client.query(
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
          $11,$12,$13,NULL,$14::jsonb,NOW()
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
      ]
    );

    const row = result.rows?.[0] || null;
    if (!row) {
      throw credentialError("DATABASE_ERROR", "credential create returned no row");
    }

    return {
      status: "created",
      created: true,
      credential: toSafeCredential(row, { now }),
    };
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
 * - At least one of accessToken or refreshToken must be present (hasOwn).
 * - Omitted token fields preserve existing material (via decrypt + re-encrypt).
 * - null / empty string tokens are rejected (no clearing in B2A).
 * - Full resulting token set is re-encrypted with the active key version.
 * - Non-secret fields (expires, tokenType, scopes, metadata) may update only
 *   together with a token change.
 *
 * Returns a safe credential row only. No audit write.
 */
async function updateCodeClipProviderCredentialTokens(
  id,
  patch = {},
  { queryClient, env = process.env, now = new Date() } = {}
) {
  const client = requireQueryClient(queryClient);
  await ensureCredentialsSchema(client);
  const normalizedId = normalizePositiveBigIntId(id, "id");

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw credentialError("INVALID_CREDENTIAL_INPUT", "token update patch must be an object", {
      fieldName: "patch",
    });
  }

  const accessPresent = hasOwn(patch, "accessToken");
  const refreshPresent = hasOwn(patch, "refreshToken");
  if (!accessPresent && !refreshPresent) {
    throw credentialError(
      "INVALID_CREDENTIAL_INPUT",
      "at least one of accessToken or refreshToken is required",
      { fieldName: "accessToken" }
    );
  }

  // Reject explicit null/empty token clearing (B2A).
  let nextAccessFromPatch = null;
  let nextRefreshFromPatch = null;
  if (accessPresent) {
    if (patch.accessToken === null || patch.accessToken === "") {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "accessToken cannot be cleared", {
        fieldName: "accessToken",
      });
    }
    nextAccessFromPatch = normalizeOptionalTokenString(patch.accessToken, "accessToken");
    if (!nextAccessFromPatch) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "accessToken is invalid", {
        fieldName: "accessToken",
      });
    }
  }
  if (refreshPresent) {
    if (patch.refreshToken === null || patch.refreshToken === "") {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "refreshToken cannot be cleared", {
        fieldName: "refreshToken",
      });
    }
    nextRefreshFromPatch = normalizeOptionalTokenString(patch.refreshToken, "refreshToken");
    if (!nextRefreshFromPatch) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "refreshToken is invalid", {
        fieldName: "refreshToken",
      });
    }
  }

  let nextExpiresAt;
  let expiresProvided = false;
  if (hasOwn(patch, "accessTokenExpiresAt") || hasOwn(patch, "access_token_expires_at")) {
    expiresProvided = true;
    const raw = hasOwn(patch, "accessTokenExpiresAt")
      ? patch.accessTokenExpiresAt
      : patch.access_token_expires_at;
    nextExpiresAt = normalizeOptionalExpiresAt(raw);
  }

  let nextTokenType;
  let tokenTypeProvided = false;
  if (hasOwn(patch, "tokenType") || hasOwn(patch, "token_type")) {
    tokenTypeProvided = true;
    const raw = hasOwn(patch, "tokenType") ? patch.tokenType : patch.token_type;
    if (raw === null) {
      nextTokenType = null;
    } else if (raw === "") {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "tokenType is invalid", {
        fieldName: "tokenType",
      });
    } else {
      nextTokenType = normalizeOptionalTokenType(raw);
    }
  }

  let nextScopes;
  let scopesProvided = false;
  if (hasOwn(patch, "scopes")) {
    scopesProvided = true;
    if (patch.scopes === null) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "scopes cannot be null", {
        fieldName: "scopes",
      });
    }
    const scopesResult = normalizeCodeClipProviderCredentialScopes(patch.scopes);
    mapValidatorFailure(scopesResult);
    nextScopes = scopesResult.scopes;
  }

  let nextMetadata;
  let metadataProvided = false;
  if (hasOwn(patch, "metadata")) {
    metadataProvided = true;
    if (patch.metadata === null) {
      throw credentialError("INVALID_CREDENTIAL_INPUT", "metadata cannot be null", {
        fieldName: "metadata",
      });
    }
    const metadataResult = normalizeCodeClipProviderCredentialMetadata(patch.metadata);
    mapValidatorFailure(metadataResult);
    nextMetadata = metadataResult.metadata;
  }

  const nowIso =
    now instanceof Date
      ? now.toISOString()
      : Number.isFinite(Date.parse(now))
        ? new Date(now).toISOString()
        : new Date().toISOString();

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

    // Build resulting plaintext token set (full re-encrypt with active key).
    let accessPlaintext = nextAccessFromPatch;
    let refreshPlaintext = nextRefreshFromPatch;

    if (!accessPresent) {
      if (current.has_access_token && current.access_token_envelope) {
        accessPlaintext = decryptToken(current.access_token_envelope, env);
      } else {
        accessPlaintext = null;
      }
    }
    if (!refreshPresent) {
      if (current.has_refresh_token && current.refresh_token_envelope) {
        refreshPlaintext = decryptToken(current.refresh_token_envelope, env);
      } else {
        refreshPlaintext = null;
      }
    }

    if (!accessPlaintext && !refreshPlaintext) {
      throw credentialError(
        "INVALID_CREDENTIAL_INPUT",
        "credential must retain at least one token after update"
      );
    }

    const { accessEnvelope, refreshEnvelope, keyVersion } = encryptCredentialTokenPair({
      accessToken: accessPlaintext || undefined,
      refreshToken: refreshPlaintext || undefined,
      env,
    });

    // Drop plaintexts from further use (locals end at function return).
    accessPlaintext = null;
    refreshPlaintext = null;

    const expiresAt = expiresProvided
      ? nextExpiresAt
      : current.access_token_expires_at ?? null;
    const tokenType = tokenTypeProvided ? nextTokenType : current.token_type ?? null;
    const scopes = scopesProvided ? nextScopes : current.scopes || [];
    const metadata = metadataProvided
      ? nextMetadata
      : current.metadata && typeof current.metadata === "object"
        ? current.metadata
        : {};

    const nextStatus =
      current.status === "reauthorization_required" ? "active" : current.status;
    const nextReauthReason =
      current.status === "reauthorization_required" ? null : current.reauthorization_reason;

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
          updated_at = NOW()
        WHERE id = $1
          AND vertical = $14
          AND status IN ('active', 'reauthorization_required')
        RETURNING ${SAFE_SELECT_COLUMNS}
      `,
      [
        normalizedId,
        accessEnvelope,
        refreshEnvelope,
        Boolean(accessEnvelope),
        Boolean(refreshEnvelope),
        keyVersion,
        expiresAt,
        tokenType,
        scopes,
        JSON.stringify(metadata),
        nextStatus,
        nextReauthReason,
        nowIso,
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

    return {
      status: "updated",
      credential: toSafeCredential(row, { now }),
    };
  });
}

module.exports = {
  CodeClipProviderCredentialError,
  createCodeClipProviderCredential,
  getCodeClipProviderCredentialById,
  findCodeClipProviderCredential,
  listCodeClipProviderCredentials,
  updateCodeClipProviderCredentialTokens,
  serializeCodeClipProviderCredentialForOperator,
};
