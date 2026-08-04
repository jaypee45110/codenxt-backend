/**
 * Pure codeClip provider credential validators (F1C2A1).
 * No database, crypto, logging, or side effects.
 */

const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");

const CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS = Object.freeze([
  "sandbox",
  "production",
]);

const CODECLIP_PROVIDER_CREDENTIAL_STATUSES = Object.freeze([
  "active",
  "reauthorization_required",
  "revoked",
  "disabled",
]);

const CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES = Object.freeze([
  "provider_api",
  "refresh",
  "validation",
]);

const ENVIRONMENT_SET = new Set(CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS);
const STATUS_SET = new Set(CODECLIP_PROVIDER_CREDENTIAL_STATUSES);
const PURPOSE_SET = new Set(CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES);

const PROVIDER_ACCOUNT_ID_MAX_LENGTH = 256;
const SCOPES_MAX_COUNT = 32;
const SCOPE_MAX_LENGTH = 256;
const METADATA_MAX_BYTES = 4096;
const METADATA_MAX_DEPTH = 3;
const METADATA_MAX_NODES = 50;
const METADATA_MAX_ARRAY_ELEMENTS = 20;

const METADATA_DENIED_KEYS = Object.freeze(
  new Set([
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "authorization",
    "bearer",
    "client_secret",
    "password",
    "credential",
    "ciphertext",
    "envelope",
    "auth_tag",
    "iv",
    "page_access_token",
    "accesstoken",
    "refreshtoken",
    "webhook_secret",
    "api_key",
  ])
);

/** fromStatus -> Set of toStatus */
const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  active: Object.freeze(
    new Set(["disabled", "reauthorization_required", "revoked"])
  ),
  disabled: Object.freeze(new Set(["active", "revoked"])),
  reauthorization_required: Object.freeze(
    new Set(["active", "revoked", "disabled"])
  ),
  revoked: Object.freeze(new Set()),
});

function failure(reason) {
  return { ok: false, reason };
}

function normalizeCodeClipProviderCredentialEnvironment(value) {
  if (typeof value !== "string") {
    return failure("INVALID_ENVIRONMENT");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !ENVIRONMENT_SET.has(normalized)) {
    return failure("INVALID_ENVIRONMENT");
  }
  return { ok: true, environment: normalized };
}

function normalizeCodeClipProviderCredentialStatus(value) {
  if (typeof value !== "string") {
    return failure("INVALID_STATUS");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !STATUS_SET.has(normalized)) {
    return failure("INVALID_STATUS");
  }
  return { ok: true, status: normalized };
}

function normalizeCodeClipProviderCredentialPurpose(value) {
  if (typeof value !== "string") {
    return failure("INVALID_PURPOSE");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !PURPOSE_SET.has(normalized)) {
    return failure("INVALID_PURPOSE");
  }
  return { ok: true, purpose: normalized };
}

function normalizeCodeClipProviderCredentialAccountRef({
  provider,
  providerAccountId,
  environment,
} = {}) {
  const envResult = normalizeCodeClipProviderCredentialEnvironment(environment);
  if (!envResult.ok) return envResult;

  const normalizedProvider = normalizeCodeClipProviderName(provider);
  if (!normalizedProvider || !isCodeClipProviderRegistered(normalizedProvider)) {
    return failure("INVALID_PROVIDER");
  }

  if (typeof providerAccountId !== "string") {
    return failure("INVALID_PROVIDER_ACCOUNT_ID");
  }
  const normalizedAccountId = providerAccountId.trim();
  if (!normalizedAccountId) {
    return failure("INVALID_PROVIDER_ACCOUNT_ID");
  }
  if (/[\u0000-\u001f\u007f]/.test(normalizedAccountId)) {
    return failure("INVALID_PROVIDER_ACCOUNT_ID");
  }
  if (normalizedAccountId.length > PROVIDER_ACCOUNT_ID_MAX_LENGTH) {
    return failure("INVALID_PROVIDER_ACCOUNT_ID");
  }

  return {
    ok: true,
    provider: normalizedProvider,
    environment: envResult.environment,
    providerAccountId: normalizedAccountId,
    accountLookupKey: normalizedAccountId,
  };
}

function normalizeCodeClipProviderCredentialScopes(value) {
  if (value === undefined || value === null) {
    return { ok: true, scopes: [] };
  }
  if (!Array.isArray(value)) {
    return failure("INVALID_SCOPES");
  }
  if (value.length > SCOPES_MAX_COUNT) {
    return failure("INVALID_SCOPES");
  }

  const seen = new Set();
  const scopes = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return failure("INVALID_SCOPES");
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > SCOPE_MAX_LENGTH) {
      return failure("INVALID_SCOPES");
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return failure("INVALID_SCOPES");
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    scopes.push(trimmed);
    if (scopes.length > SCOPES_MAX_COUNT) {
      return failure("INVALID_SCOPES");
    }
  }

  return { ok: true, scopes };
}

function isDeniedMetadataKey(key) {
  return METADATA_DENIED_KEYS.has(String(key || "").trim().toLowerCase());
}

function isJsonPrimitive(value) {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return false;
}

function validateMetadataValue(value, depth, counters) {
  if (counters.nodes > METADATA_MAX_NODES) {
    return failure("INVALID_METADATA");
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return failure("INVALID_METADATA");
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return failure("INVALID_METADATA");
  }

  if (isJsonPrimitive(value)) {
    counters.nodes += 1;
    if (counters.nodes > METADATA_MAX_NODES) {
      return failure("INVALID_METADATA");
    }
    return { ok: true, value };
  }

  if (Array.isArray(value)) {
    if (depth > METADATA_MAX_DEPTH) {
      return failure("INVALID_METADATA");
    }
    counters.nodes += 1;
    if (counters.nodes > METADATA_MAX_NODES) {
      return failure("INVALID_METADATA");
    }
    if (value.length > METADATA_MAX_ARRAY_ELEMENTS) {
      return failure("INVALID_METADATA");
    }
    const copy = [];
    for (const entry of value) {
      const nested = validateMetadataValue(entry, depth + 1, counters);
      if (!nested.ok) return nested;
      copy.push(nested.value);
    }
    return { ok: true, value: copy };
  }

  if (value && typeof value === "object") {
    if (depth > METADATA_MAX_DEPTH) {
      return failure("INVALID_METADATA");
    }
    counters.nodes += 1;
    if (counters.nodes > METADATA_MAX_NODES) {
      return failure("INVALID_METADATA");
    }
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof key !== "string") {
        return failure("INVALID_METADATA");
      }
      if (isDeniedMetadataKey(key)) {
        return failure("INVALID_METADATA");
      }
      const nested = validateMetadataValue(entry, depth + 1, counters);
      if (!nested.ok) return nested;
      copy[key] = nested.value;
    }
    return { ok: true, value: copy };
  }

  return failure("INVALID_METADATA");
}

function normalizeCodeClipProviderCredentialMetadata(value) {
  if (value === undefined || value === null) {
    return { ok: true, metadata: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return failure("INVALID_METADATA");
  }

  const counters = { nodes: 0 };
  // Root object is depth 1
  const validated = validateMetadataValue(value, 1, counters);
  if (!validated.ok) return validated;

  let serialized;
  try {
    serialized = JSON.stringify(validated.value);
  } catch {
    return failure("INVALID_METADATA");
  }
  if (typeof serialized !== "string") {
    return failure("INVALID_METADATA");
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > METADATA_MAX_BYTES) {
    return failure("INVALID_METADATA");
  }

  // Defensive deep copy via JSON
  return {
    ok: true,
    metadata: JSON.parse(serialized),
  };
}

function parseTimestamp(value, fieldName) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      return failure("INVALID_TIMESTAMP");
    }
    return { ok: true, ms, iso: value.toISOString() };
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      return failure("INVALID_TIMESTAMP");
    }
    return { ok: true, ms, iso: new Date(ms).toISOString() };
  }
  return failure("INVALID_TIMESTAMP");
}

/**
 * Pure expiry helper. expired is never a stored status/column.
 */
function isCodeClipProviderCredentialExpired({
  accessTokenExpiresAt,
  now = new Date(),
} = {}) {
  if (accessTokenExpiresAt === undefined || accessTokenExpiresAt === null || accessTokenExpiresAt === "") {
    return { ok: true, expired: false };
  }

  const expires = parseTimestamp(accessTokenExpiresAt, "accessTokenExpiresAt");
  if (!expires.ok) return expires;

  const nowResult = parseTimestamp(now, "now");
  if (!nowResult.ok) return nowResult;

  return {
    ok: true,
    expired: expires.ms <= nowResult.ms,
  };
}

function validateCodeClipProviderCredentialStatusTransition(fromStatus, toStatus) {
  const from = normalizeCodeClipProviderCredentialStatus(fromStatus);
  if (!from.ok) return from;
  const to = normalizeCodeClipProviderCredentialStatus(toStatus);
  if (!to.ok) return to;

  if (from.status === to.status) {
    return failure("INVALID_STATUS_TRANSITION");
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[from.status];
  if (!allowed || !allowed.has(to.status)) {
    return failure("INVALID_STATUS_TRANSITION");
  }

  return {
    ok: true,
    fromStatus: from.status,
    toStatus: to.status,
  };
}

module.exports = {
  CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS,
  CODECLIP_PROVIDER_CREDENTIAL_STATUSES,
  CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES,
  CODECLIP_PROVIDER_CREDENTIAL_METADATA_DENIED_KEYS: METADATA_DENIED_KEYS,
  ALLOWED_CODECLIP_PROVIDER_CREDENTIAL_STATUS_TRANSITIONS: ALLOWED_STATUS_TRANSITIONS,
  normalizeCodeClipProviderCredentialEnvironment,
  normalizeCodeClipProviderCredentialStatus,
  normalizeCodeClipProviderCredentialPurpose,
  normalizeCodeClipProviderCredentialAccountRef,
  normalizeCodeClipProviderCredentialScopes,
  normalizeCodeClipProviderCredentialMetadata,
  isCodeClipProviderCredentialExpired,
  validateCodeClipProviderCredentialStatusTransition,
};
