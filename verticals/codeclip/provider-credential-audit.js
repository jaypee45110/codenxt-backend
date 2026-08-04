/**
 * codeClip provider credential audit foundation (F1C2C1).
 *
 * Owns actor/reason validation, safe audit snapshots, append and list.
 * Does not own transactions (caller supplies query client).
 * Does not mutate credential status or encrypt/decrypt tokens.
 * Does not wire into create/token-update until F1C2C2.
 *
 * Schema: codeclip_provider_credential_audit (F1C2A1).
 */

const {
  normalizeCodeClipProviderCredentialEnvironment,
} = require("./provider-credential-validators");
const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");

const CODECLIP_VERTICAL = "codeclip";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const AUDIT_CURSOR_VERSION = 1;
const MAX_BIGINT_ID = 9223372036854775807n;
const ACTOR_ID_MAX = 80;
const REASON_MAX = 64;

const AUDIT_ACTIONS = Object.freeze([
  "created",
  "token_updated",
  "reauthorization_required",
  "revoked",
  "disabled",
  "reactivated",
  "refresh_claimed",
  "refresh_succeeded",
  "refresh_failed",
  "refresh_released",
]);
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);

const ACTOR_TYPES = Object.freeze(["operator", "operator_key", "system"]);
const ACTOR_TYPE_SET = new Set(ACTOR_TYPES);

const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const SNAPSHOT_ALLOWLIST = Object.freeze([
  "id",
  "provider",
  "environment",
  "status",
  "maskedAccountId",
  "hasAccessToken",
  "hasRefreshToken",
  "accessTokenExpiresAt",
  "encryptionKeyVersion",
  "tokenType",
  "scopes",
  "reauthorizationReason",
  "disabledAt",
  "revokedAt",
  "lastRefreshedAt",
  "updatedAt",
]);
const SNAPSHOT_ALLOWLIST_SET = new Set(SNAPSHOT_ALLOWLIST);

const SNAPSHOT_FORBIDDEN_KEYS = Object.freeze(
  new Set([
    "provideraccountid",
    "provider_account_id",
    "accountlookupkey",
    "account_lookup_key",
    "accesstokenenvelope",
    "access_token_envelope",
    "refreshtokenenvelope",
    "refresh_token_envelope",
    "metadata",
    "plaintext",
    "token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "ciphertext",
    "key",
    "iv",
    "authtag",
    "auth_tag",
    "cryptoreason",
    "crypto_reason",
  ])
);

const LIST_SELECT_COLUMNS = `
  id,
  credential_id,
  vertical,
  provider,
  environment,
  action,
  actor_type,
  actor_id,
  reason_code,
  before_state,
  after_state,
  metadata,
  created_at
`.replace(/\s+/g, " ").trim();

class CodeClipProviderCredentialAuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderCredentialAuditError";
    this.code = code;
    this.details = details && typeof details === "object" ? { ...details } : {};
  }
}

function auditError(code, message, details = {}) {
  // Never put sensitive payloads in details.
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "action", "reason"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderCredentialAuditError(code, message, safe);
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw auditError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider credential audit requires an explicit query client"
    );
  }
  return queryClient;
}

function normalizePositiveBigIntId(value, fieldName = "id") {
  let normalized;
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", `${fieldName} is invalid`, {
        fieldName,
      });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  return normalized;
}

function maskAccountId(providerAccountId) {
  const value = String(providerAccountId || "").trim();
  if (!value) return "";
  if (value.length <= 2) return "••";
  if (value.length <= 4) return `${"•".repeat(value.length - 1)}${value.slice(-1)}`;
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function normalizeIsoTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "actor is required");
  }
  const type = String(actor.type || "").trim().toLowerCase();
  if (!ACTOR_TYPE_SET.has(type)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "actor type is invalid");
  }

  if (type === "operator") {
    if (typeof actor.id !== "string") {
      throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "operator actor id is required");
    }
    const id = actor.id.trim().toLowerCase();
    if (!id || id.length > ACTOR_ID_MAX || !ACTOR_ID_PATTERN.test(id)) {
      throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "operator actor id is invalid");
    }
    return { type, id };
  }

  if (type === "operator_key") {
    if (actor.id !== undefined && actor.id !== null && String(actor.id).trim() !== "") {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_ACTOR",
        "operator_key actor must not include an id"
      );
    }
    return { type, id: null };
  }

  // system
  if (actor.id === undefined || actor.id === null || String(actor.id).trim() === "") {
    return { type, id: null };
  }
  if (typeof actor.id !== "string") {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "system actor id is invalid");
  }
  const systemId = actor.id.trim().toLowerCase();
  if (!systemId || systemId.length > ACTOR_ID_MAX || !ACTOR_ID_PATTERN.test(systemId)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTOR", "system actor id is invalid");
  }
  return { type, id: systemId };
}

function normalizeReasonCode(reason) {
  if (typeof reason !== "string") {
    throw auditError("INVALID_CREDENTIAL_AUDIT_REASON", "reason is required");
  }
  const normalized = reason.trim().toLowerCase();
  if (!normalized || normalized.length > REASON_MAX || !REASON_PATTERN.test(normalized)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_REASON", "reason is invalid");
  }
  return normalized;
}

function normalizeAction(action) {
  if (typeof action !== "string") {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTION", "action is required");
  }
  const normalized = action.trim().toLowerCase();
  if (!AUDIT_ACTION_SET.has(normalized)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_ACTION", "action is not supported", {
      action: normalized || null,
    });
  }
  return normalized;
}

function normalizeProvider(provider) {
  const normalized = normalizeCodeClipProviderName(provider);
  if (!normalized || !isCodeClipProviderRegistered(normalized)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", "provider is invalid", {
      fieldName: "provider",
    });
  }
  return normalized;
}

function normalizeEnvironment(environment) {
  const result = normalizeCodeClipProviderCredentialEnvironment(environment);
  if (!result.ok) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return result.environment;
}

function assertNoForbiddenKeys(value, path = "snapshot") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const lower = String(key).trim().toLowerCase();
    if (SNAPSHOT_FORBIDDEN_KEYS.has(lower)) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot contains forbidden fields"
      );
    }
    assertNoForbiddenKeys(entry, `${path}.${key}`);
  }
}

/**
 * Flat allowlist-only snapshot contract:
 * - only SNAPSHOT_ALLOWLIST top-level keys
 * - scopes is the only permitted array (of primitives)
 * - no other nested objects or arrays
 */
function assertSnapshotShape(snapshot) {
  if (snapshot === null) return null;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      "audit snapshot must be a plain object or null"
    );
  }
  const keys = Object.keys(snapshot);
  for (const key of keys) {
    if (!SNAPSHOT_ALLOWLIST_SET.has(key)) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot contains non-allowlisted fields"
      );
    }
    const lower = key.toLowerCase();
    if (SNAPSHOT_FORBIDDEN_KEYS.has(lower)) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot contains forbidden fields"
      );
    }
    const value = snapshot[key];
    if (key === "scopes") {
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        throw auditError(
          "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
          "audit snapshot scopes must be an array"
        );
      }
      for (const entry of value) {
        if (entry !== null && typeof entry === "object") {
          throw auditError(
            "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
            "audit snapshot scopes must not contain nested objects or arrays"
          );
        }
      }
      continue;
    }
    // Flat contract: no nested objects or arrays outside scopes.
    if (value !== null && value !== undefined && typeof value === "object") {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot must be flat"
      );
    }
  }
  assertNoForbiddenKeys(snapshot);
  return snapshot;
}

function normalizeScopesArray(scopesRaw) {
  if (scopesRaw === undefined || scopesRaw === null) return [];
  if (!Array.isArray(scopesRaw)) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      "audit snapshot scopes must be an array"
    );
  }
  for (const entry of scopesRaw) {
    if (entry !== null && typeof entry === "object") {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot scopes must not contain nested objects or arrays"
      );
    }
  }
  return scopesRaw.map((entry) => String(entry));
}

/**
 * Build an allowlist-only audit snapshot from a credential DB row or safe-like object.
 * Never spreads raw rows.
 */
function buildCredentialAuditSnapshot(input) {
  if (input === undefined || input === null) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      "snapshot input is required"
    );
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      "snapshot input must be an object"
    );
  }

  // Reject if caller passed clearly forbidden top-level keys (fail closed).
  // provider_account_id / providerAccountId are allowed only as mask sources.
  const allowedMaskSources = new Set(["provider_account_id", "provideraccountid"]);
  for (const key of Object.keys(input)) {
    const lower = key.trim().toLowerCase();
    if (allowedMaskSources.has(lower)) continue;
    if (
      SNAPSHOT_FORBIDDEN_KEYS.has(lower) ||
      [
        "access_token_envelope",
        "refresh_token_envelope",
        "plaintext",
        "token",
        "access_token",
        "refresh_token",
        "metadata",
        "ciphertext",
        "account_lookup_key",
      ].includes(lower)
    ) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
        "audit snapshot input contains forbidden fields"
      );
    }
  }

  const rawAccountId =
    input.providerAccountId !== undefined
      ? input.providerAccountId
      : input.provider_account_id;
  const existingMask =
    typeof input.maskedAccountId === "string" && input.maskedAccountId
      ? input.maskedAccountId
      : null;
  const maskedAccountId = existingMask || maskAccountId(rawAccountId);

  const scopes = normalizeScopesArray(input.scopes);

  const read = (camel, snake) => {
    if (input[camel] !== undefined) return input[camel];
    if (snake && input[snake] !== undefined) return input[snake];
    return undefined;
  };

  const snapshot = {
    id: read("id"),
    provider: read("provider"),
    environment: read("environment"),
    status: read("status"),
    maskedAccountId,
    hasAccessToken: Boolean(read("hasAccessToken", "has_access_token")),
    hasRefreshToken: Boolean(read("hasRefreshToken", "has_refresh_token")),
    accessTokenExpiresAt: normalizeIsoTimestamp(
      read("accessTokenExpiresAt", "access_token_expires_at")
    ),
    encryptionKeyVersion: Number(
      read("encryptionKeyVersion", "encryption_key_version")
    ),
    tokenType: read("tokenType", "token_type") ?? null,
    scopes,
    reauthorizationReason:
      read("reauthorizationReason", "reauthorization_reason") ?? null,
    disabledAt: normalizeIsoTimestamp(read("disabledAt", "disabled_at")),
    revokedAt: normalizeIsoTimestamp(read("revokedAt", "revoked_at")),
    lastRefreshedAt: normalizeIsoTimestamp(
      read("lastRefreshedAt", "last_refreshed_at")
    ),
    updatedAt: normalizeIsoTimestamp(read("updatedAt", "updated_at")),
  };

  // Drop undefined id if missing
  if (snapshot.id === undefined || snapshot.id === null) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      "audit snapshot id is required"
    );
  }

  return assertSnapshotShape(snapshot);
}

function validateActionStates(action, beforeState, afterState) {
  if (action === "created") {
    if (beforeState !== null) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_INPUT",
        "created audit requires beforeState null"
      );
    }
    if (!afterState) {
      throw auditError(
        "INVALID_CREDENTIAL_AUDIT_INPUT",
        "created audit requires afterState"
      );
    }
    return;
  }
  // token_updated and status actions require both
  if (!beforeState || !afterState) {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_INPUT",
      "audit action requires beforeState and afterState"
    );
  }
}

function cloneSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  const validated = assertSnapshotShape(snapshot);
  return {
    ...validated,
    scopes: normalizeScopesArray(validated.scopes),
  };
}

function mapAuditRow(row) {
  if (!row) return null;
  const before =
    row.before_state === undefined ? row.beforeState : row.before_state;
  const after = row.after_state === undefined ? row.afterState : row.after_state;
  const beforeParsed =
    before === null || before === undefined
      ? null
      : typeof before === "string"
        ? JSON.parse(before)
        : before;
  const afterParsed =
    after === null || after === undefined
      ? null
      : typeof after === "string"
        ? JSON.parse(after)
        : after;
  return {
    id: row.id,
    credentialId: row.credential_id !== undefined ? row.credential_id : row.credentialId,
    vertical: row.vertical,
    provider: row.provider,
    environment: row.environment,
    action: row.action,
    actorType: row.actor_type !== undefined ? row.actor_type : row.actorType,
    actorId: row.actor_id !== undefined ? row.actor_id : row.actorId ?? null,
    reasonCode: row.reason_code !== undefined ? row.reason_code : row.reasonCode ?? null,
    beforeState: cloneSnapshot(beforeParsed),
    afterState: cloneSnapshot(afterParsed),
    metadata: {},
    createdAt: row.created_at !== undefined ? row.created_at : row.createdAt,
  };
}

function encodeAuditCursor(event) {
  if (!event) return null;
  const createdAt =
    event.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : String(event.createdAt);
  return Buffer.from(
    JSON.stringify({
      v: AUDIT_CURSOR_VERSION,
      createdAt,
      id: String(event.id),
    })
  ).toString("base64url");
}

function decodeAuditCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > 512) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_CURSOR", "audit cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const keys = Object.keys(decoded || {}).sort().join(",");
    if (!decoded || decoded.v !== AUDIT_CURSOR_VERSION || keys !== "createdAt,id,v") {
      throw new Error("invalid cursor shape");
    }
    const createdAt = String(decoded.createdAt || "").trim();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new Error("invalid cursor timestamp");
    }
    return {
      createdAt,
      id: normalizePositiveBigIntId(decoded.id, "cursor.id"),
    };
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialAuditError) throw error;
    throw auditError("INVALID_CREDENTIAL_AUDIT_CURSOR", "audit cursor is invalid");
  }
}

function normalizeListLimit(limit) {
  // Fail-closed: only omit/undefined → default. No clamp, no numeric strings.
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", "limit is invalid", {
      fieldName: "limit",
    });
  }
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw auditError("INVALID_CREDENTIAL_AUDIT_INPUT", "limit is invalid", {
      fieldName: "limit",
    });
  }
  return limit;
}

/**
 * Append a credential audit event. Does not start or end transactions.
 */
async function appendCodeClipProviderCredentialAudit(
  {
    credentialId,
    provider,
    environment,
    action,
    actor,
    reason,
    beforeState = null,
    afterState = null,
  } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedCredentialId = normalizePositiveBigIntId(credentialId, "credentialId");
  const normalizedProvider = normalizeProvider(provider);
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedAction = normalizeAction(action);
  const normalizedActor = normalizeActor(actor);
  const normalizedReason = normalizeReasonCode(reason);

  let normalizedBefore = beforeState === null || beforeState === undefined ? null : beforeState;
  let normalizedAfter = afterState === null || afterState === undefined ? null : afterState;

  // If caller passed a credential-like object, build snapshot; if already snapshot, validate.
  // Validate flat shape before any String() coercion so nested objects cannot be hidden.
  if (normalizedBefore !== null) {
    if (
      typeof normalizedBefore === "object" &&
      !Array.isArray(normalizedBefore) &&
      Object.keys(normalizedBefore).every((k) => SNAPSHOT_ALLOWLIST_SET.has(k))
    ) {
      assertSnapshotShape(normalizedBefore);
      normalizedBefore = assertSnapshotShape({
        ...normalizedBefore,
        scopes: normalizeScopesArray(normalizedBefore.scopes),
      });
    } else {
      normalizedBefore = buildCredentialAuditSnapshot(normalizedBefore);
    }
  }
  if (normalizedAfter !== null) {
    if (
      typeof normalizedAfter === "object" &&
      !Array.isArray(normalizedAfter) &&
      Object.keys(normalizedAfter).every((k) => SNAPSHOT_ALLOWLIST_SET.has(k))
    ) {
      assertSnapshotShape(normalizedAfter);
      normalizedAfter = assertSnapshotShape({
        ...normalizedAfter,
        scopes: normalizeScopesArray(normalizedAfter.scopes),
      });
    } else {
      normalizedAfter = buildCredentialAuditSnapshot(normalizedAfter);
    }
  }

  validateActionStates(normalizedAction, normalizedBefore, normalizedAfter);

  try {
    const result = await client.query(
      `
        INSERT INTO codeclip_provider_credential_audit (
          credential_id,
          vertical,
          provider,
          environment,
          action,
          actor_type,
          actor_id,
          reason_code,
          before_state,
          after_state,
          metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb
        )
        RETURNING ${LIST_SELECT_COLUMNS}
      `,
      [
        normalizedCredentialId,
        CODECLIP_VERTICAL,
        normalizedProvider,
        normalizedEnvironment,
        normalizedAction,
        normalizedActor.type,
        normalizedActor.id,
        normalizedReason,
        normalizedBefore === null ? null : JSON.stringify(normalizedBefore),
        normalizedAfter === null ? null : JSON.stringify(normalizedAfter),
        JSON.stringify({}),
      ]
    );
    const row = result.rows?.[0] || null;
    if (!row) {
      throw auditError("DATABASE_ERROR", "audit append returned no row");
    }
    return mapAuditRow(row);
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialAuditError) throw error;
    throw auditError("DATABASE_ERROR", "audit append failed");
  }
}

/**
 * List credential audit events for one credential. No transaction ownership.
 */
async function listCodeClipProviderCredentialAudit(
  { credentialId, action, limit, cursor } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  if (credentialId === undefined || credentialId === null || credentialId === "") {
    throw auditError(
      "INVALID_CREDENTIAL_AUDIT_INPUT",
      "credentialId is required",
      { fieldName: "credentialId" }
    );
  }
  const normalizedCredentialId = normalizePositiveBigIntId(credentialId, "credentialId");
  const normalizedLimit = normalizeListLimit(limit);
  const normalizedCursor = decodeAuditCursor(cursor);

  let normalizedAction = null;
  if (action !== undefined && action !== null && action !== "") {
    normalizedAction = normalizeAction(action);
  }

  const predicates = ["vertical = $1", "credential_id = $2"];
  const params = [CODECLIP_VERTICAL, normalizedCredentialId];

  if (normalizedAction) {
    params.push(normalizedAction);
    predicates.push(`action = $${params.length}`);
  }
  if (normalizedCursor) {
    params.push(normalizedCursor.createdAt);
    const createdAtParam = params.length;
    params.push(normalizedCursor.id);
    const idParam = params.length;
    predicates.push(`(
      created_at < $${createdAtParam}::timestamptz
      OR (created_at = $${createdAtParam}::timestamptz AND id < $${idParam}::bigint)
    )`);
  }

  params.push(normalizedLimit + 1);

  try {
    const result = await client.query(
      `
        SELECT ${LIST_SELECT_COLUMNS}
        FROM codeclip_provider_credential_audit
        WHERE ${predicates.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}
      `,
      params
    );

    const mapped = (result.rows || []).map((row) => {
      const item = mapAuditRow(row);
      return {
        ...item,
        beforeState: item.beforeState
          ? {
              ...item.beforeState,
              scopes: Array.isArray(item.beforeState.scopes)
                ? [...item.beforeState.scopes]
                : [],
            }
          : null,
        afterState: item.afterState
          ? {
              ...item.afterState,
              scopes: Array.isArray(item.afterState.scopes)
                ? [...item.afterState.scopes]
                : [],
            }
          : null,
        metadata: {},
      };
    });
    const hasMore = mapped.length > normalizedLimit;
    const items = hasMore ? mapped.slice(0, normalizedLimit) : mapped;

    return {
      items,
      page: {
        limit: normalizedLimit,
        hasMore,
        nextCursor: hasMore ? encodeAuditCursor(items[items.length - 1]) : null,
      },
    };
  } catch (error) {
    if (error instanceof CodeClipProviderCredentialAuditError) throw error;
    throw auditError("DATABASE_ERROR", "audit list failed");
  }
}

module.exports = {
  CodeClipProviderCredentialAuditError,
  appendCodeClipProviderCredentialAudit,
  listCodeClipProviderCredentialAudit,
};
