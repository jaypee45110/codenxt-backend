/**
 * Internal codeClip provider credential token mutation helpers (F1C3B1).
 *
 * Authoritative token merge / re-encryption used by:
 * - updateCodeClipProviderCredentialTokens (public)
 * - future completeCodeClipProviderCredentialRefresh (F1C3B2)
 *
 * Does not own transactions, SQL, audit, claims, or status setters.
 * Not part of the public credentials module surface.
 */

const {
  normalizeCodeClipProviderCredentialScopes,
  normalizeCodeClipProviderCredentialMetadata,
} = require("./provider-credential-validators");
const {
  encryptCodeClipProviderCredentialSecret,
  decryptCodeClipProviderCredentialSecret,
} = require("./provider-credential-crypto");

const TOKEN_TYPE_MAX_LENGTH = 64;

class CodeClipProviderCredentialTokenMutationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderCredentialTokenMutationError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function mutationError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "cryptoReason"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderCredentialTokenMutationError(code, message, safe);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function mapValidatorFailure(result, fallbackCode = "INVALID_CREDENTIAL_INPUT") {
  if (result.ok) return;
  const reason = result.reason || fallbackCode;
  throw mutationError(fallbackCode, "credential input is invalid", { reason });
}

function normalizeOptionalTokenString(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw mutationError("INVALID_CREDENTIAL_INPUT", `${fieldName} must be a string`, {
      fieldName,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      `${fieldName} must be a non-empty string`,
      { fieldName }
    );
  }
  return normalized;
}

function normalizeOptionalTokenType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw mutationError("INVALID_CREDENTIAL_INPUT", "tokenType must be a string", {
      fieldName: "tokenType",
    });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.length > TOKEN_TYPE_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw mutationError("INVALID_CREDENTIAL_INPUT", "tokenType is invalid", {
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
      throw mutationError(
        "INVALID_CREDENTIAL_INPUT",
        "accessTokenExpiresAt is invalid",
        { fieldName: "accessTokenExpiresAt" }
      );
    }
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw mutationError(
        "INVALID_CREDENTIAL_INPUT",
        "accessTokenExpiresAt is invalid",
        { fieldName: "accessTokenExpiresAt" }
      );
    }
    return new Date(ms).toISOString();
  }
  throw mutationError(
    "INVALID_CREDENTIAL_INPUT",
    "accessTokenExpiresAt is invalid",
    { fieldName: "accessTokenExpiresAt" }
  );
}

function decryptToken(envelope, env) {
  const result = decryptCodeClipProviderCredentialSecret({ envelope, env });
  if (!result.ok) {
    throw mutationError(
      "CREDENTIAL_DECRYPTION_FAILED",
      "credential decryption failed",
      { cryptoReason: result.reason }
    );
  }
  return result.plaintext;
}

function encryptToken(plaintext, env) {
  const result = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  if (!result.ok) {
    throw mutationError(
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
 * Encrypt access and refresh with the same active key version (F1C1).
 * Used by create and token mutation prepare.
 */
function encryptCodeClipProviderCredentialTokenPair({
  accessToken,
  refreshToken,
  env,
} = {}) {
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
      throw mutationError(
        "CREDENTIAL_ENCRYPTION_FAILED",
        "credential tokens must share the same encryption key version",
        { cryptoReason: "KEY_VERSION_MISMATCH" }
      );
    }
  }

  if (keyVersion === null || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw mutationError(
      "CREDENTIAL_ENCRYPTION_FAILED",
      "credential encryption key version is invalid"
    );
  }

  return { accessEnvelope, refreshEnvelope, keyVersion };
}

/**
 * Prepare the authoritative token-field mutation from a locked credential row
 * and a caller patch. No SQL / TX / audit / claim logic.
 *
 * @param {object} options
 * @param {object} options.lockedCredential locked DB row including envelopes
 * @param {object} options.patch token update patch
 * @param {object} [options.env]
 * @param {boolean} [options.requireAccessToken=false]
 *   When true (future refresh complete): accessToken must be present in patch.
 *   When false (public token update): at least one of access/refresh present.
 */
function prepareCodeClipProviderCredentialTokenMutation({
  lockedCredential,
  patch = {},
  env = process.env,
  requireAccessToken = false,
} = {}) {
  if (!lockedCredential || typeof lockedCredential !== "object") {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      "locked credential is required for token mutation"
    );
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      "token update patch must be an object",
      { fieldName: "patch" }
    );
  }

  const accessPresent = hasOwn(patch, "accessToken");
  const refreshPresent = hasOwn(patch, "refreshToken");

  if (requireAccessToken) {
    if (!accessPresent) {
      throw mutationError(
        "INVALID_CREDENTIAL_INPUT",
        "accessToken is required",
        { fieldName: "accessToken" }
      );
    }
  } else if (!accessPresent && !refreshPresent) {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      "at least one of accessToken or refreshToken is required",
      { fieldName: "accessToken" }
    );
  }

  let nextAccessFromPatch = null;
  let nextRefreshFromPatch = null;

  if (accessPresent) {
    if (patch.accessToken === null || patch.accessToken === "") {
      throw mutationError(
        "INVALID_CREDENTIAL_INPUT",
        "accessToken cannot be cleared",
        { fieldName: "accessToken" }
      );
    }
    nextAccessFromPatch = normalizeOptionalTokenString(
      patch.accessToken,
      "accessToken"
    );
    if (!nextAccessFromPatch) {
      throw mutationError("INVALID_CREDENTIAL_INPUT", "accessToken is invalid", {
        fieldName: "accessToken",
      });
    }
  }

  if (refreshPresent) {
    if (patch.refreshToken === null || patch.refreshToken === "") {
      throw mutationError(
        "INVALID_CREDENTIAL_INPUT",
        "refreshToken cannot be cleared",
        { fieldName: "refreshToken" }
      );
    }
    nextRefreshFromPatch = normalizeOptionalTokenString(
      patch.refreshToken,
      "refreshToken"
    );
    if (!nextRefreshFromPatch) {
      throw mutationError("INVALID_CREDENTIAL_INPUT", "refreshToken is invalid", {
        fieldName: "refreshToken",
      });
    }
  }

  let nextExpiresAt;
  let expiresProvided = false;
  if (
    hasOwn(patch, "accessTokenExpiresAt") ||
    hasOwn(patch, "access_token_expires_at")
  ) {
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
      throw mutationError("INVALID_CREDENTIAL_INPUT", "tokenType is invalid", {
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
      throw mutationError("INVALID_CREDENTIAL_INPUT", "scopes cannot be null", {
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
      throw mutationError("INVALID_CREDENTIAL_INPUT", "metadata cannot be null", {
        fieldName: "metadata",
      });
    }
    const metadataResult = normalizeCodeClipProviderCredentialMetadata(
      patch.metadata
    );
    mapValidatorFailure(metadataResult);
    nextMetadata = metadataResult.metadata;
  }

  const current = lockedCredential;

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

  if (requireAccessToken && !accessPlaintext) {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      "accessToken is required",
      { fieldName: "accessToken" }
    );
  }

  if (!accessPlaintext && !refreshPlaintext) {
    throw mutationError(
      "INVALID_CREDENTIAL_INPUT",
      "credential must retain at least one token after update"
    );
  }

  const { accessEnvelope, refreshEnvelope, keyVersion } =
    encryptCodeClipProviderCredentialTokenPair({
      accessToken: accessPlaintext || undefined,
      refreshToken: refreshPlaintext || undefined,
      env,
    });

  // Drop plaintexts before return.
  accessPlaintext = null;
  refreshPlaintext = null;

  const accessTokenExpiresAt = expiresProvided
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
  const nextReauthorizationReason =
    current.status === "reauthorization_required"
      ? null
      : current.reauthorization_reason;

  return {
    accessTokenEnvelope: accessEnvelope,
    refreshTokenEnvelope: refreshEnvelope,
    encryptionKeyVersion: keyVersion,
    hasAccessToken: Boolean(accessEnvelope),
    hasRefreshToken: Boolean(refreshEnvelope),
    accessTokenExpiresAt,
    tokenType,
    scopes,
    metadata,
    nextStatus,
    nextReauthorizationReason,
  };
}

module.exports = {
  CodeClipProviderCredentialTokenMutationError,
  prepareCodeClipProviderCredentialTokenMutation,
  encryptCodeClipProviderCredentialTokenPair,
};
