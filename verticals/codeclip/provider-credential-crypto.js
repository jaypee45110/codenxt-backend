/**
 * codeClip provider credential crypto foundation (F1C1).
 * AES-256-GCM envelopes for account-scoped credential secrets.
 * Lazy keyring load; no schema, repository, or runtime wiring.
 */

const crypto = require("node:crypto");

const CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION = "v1";
const CODECLIP_PROVIDER_CREDENTIAL_AAD = "codeclip:provider-credential:v1";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const ENV_KEYS = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS";
const ENV_ACTIVE_VERSION = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION";

const REASONS = Object.freeze({
  ENCRYPTION_KEYS_NOT_CONFIGURED: "ENCRYPTION_KEYS_NOT_CONFIGURED",
  INVALID_ENCRYPTION_KEYRING: "INVALID_ENCRYPTION_KEYRING",
  ACTIVE_KEY_VERSION_NOT_CONFIGURED: "ACTIVE_KEY_VERSION_NOT_CONFIGURED",
  ACTIVE_KEY_VERSION_NOT_FOUND: "ACTIVE_KEY_VERSION_NOT_FOUND",
  INVALID_PLAINTEXT: "INVALID_PLAINTEXT",
  MALFORMED_ENVELOPE: "MALFORMED_ENVELOPE",
  UNSUPPORTED_ENVELOPE_VERSION: "UNSUPPORTED_ENVELOPE_VERSION",
  ENCRYPTION_KEY_VERSION_NOT_FOUND: "ENCRYPTION_KEY_VERSION_NOT_FOUND",
  ENCRYPT_FAILED: "ENCRYPT_FAILED",
  DECRYPT_FAILED: "DECRYPT_FAILED",
});

function failure(reason) {
  return { ok: false, reason };
}

function isPositiveIntegerString(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function parsePositiveInteger(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isPositiveIntegerString(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function decodeBase64Key(encoded) {
  if (typeof encoded !== "string" || !encoded.trim()) {
    return null;
  }
  const trimmed = encoded.trim();
  // Reject non-base64 characters early (standard base64 or base64url alphabet).
  const isStd = /^[A-Za-z0-9+/]+=*$/.test(trimmed);
  const isUrl = /^[A-Za-z0-9_-]+=*$/.test(trimmed);
  if (!isStd && !isUrl) {
    return null;
  }
  let buffer;
  try {
    buffer = Buffer.from(trimmed, isUrl && !isStd ? "base64url" : "base64");
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length !== KEY_BYTES) {
    return null;
  }
  return buffer;
}

/**
 * Lazy-load and validate encryption keyring from env.
 * @returns {{ ok: true, keyring: { keys: Map<number, Buffer>, activeVersion: number } }
 *         | { ok: false, reason: string }}
 */
function loadCodeClipProviderCredentialEncryptionKeyring(env = process.env) {
  const rawKeys = env?.[ENV_KEYS];
  if (rawKeys === undefined || rawKeys === null || String(rawKeys).trim() === "") {
    return failure(REASONS.ENCRYPTION_KEYS_NOT_CONFIGURED);
  }
  if (typeof rawKeys !== "string") {
    return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
  }

  const entries = rawKeys.split(";").map((part) => part.trim()).filter(Boolean);
  if (entries.length === 0) {
    return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
  }

  const keys = new Map();
  for (const entry of entries) {
    const colon = entry.indexOf(":");
    if (colon <= 0 || colon === entry.length - 1) {
      return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
    }
    const versionPart = entry.slice(0, colon).trim();
    const keyPart = entry.slice(colon + 1).trim();
    const version = parsePositiveInteger(versionPart);
    if (version === null) {
      return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
    }
    if (keys.has(version)) {
      return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
    }
    const keyBuffer = decodeBase64Key(keyPart);
    if (!keyBuffer) {
      return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
    }
    keys.set(version, keyBuffer);
  }

  const rawActive = env?.[ENV_ACTIVE_VERSION];
  if (rawActive === undefined || rawActive === null || String(rawActive).trim() === "") {
    return failure(REASONS.ACTIVE_KEY_VERSION_NOT_CONFIGURED);
  }
  const activeVersion = parsePositiveInteger(rawActive);
  if (activeVersion === null) {
    return failure(REASONS.INVALID_ENCRYPTION_KEYRING);
  }
  if (!keys.has(activeVersion)) {
    return failure(REASONS.ACTIVE_KEY_VERSION_NOT_FOUND);
  }

  return {
    ok: true,
    keyring: {
      keys,
      activeVersion,
    },
  };
}

function normalizePlaintext(plaintext) {
  if (typeof plaintext !== "string") {
    return { ok: false, reason: REASONS.INVALID_PLAINTEXT };
  }
  if (plaintext.length === 0) {
    return { ok: false, reason: REASONS.INVALID_PLAINTEXT };
  }
  return { ok: true, plaintext };
}

/**
 * Encrypt plaintext with the active key version from the keyring.
 * Callers cannot force a non-active key version on this public path.
 *
 * @returns {{ ok: true, envelope: string, keyVersion: number }
 *         | { ok: false, reason: string }}
 */
function encryptCodeClipProviderCredentialSecret({ plaintext, env = process.env } = {}) {
  const normalized = normalizePlaintext(plaintext);
  if (!normalized.ok) return failure(normalized.reason);

  const loaded = loadCodeClipProviderCredentialEncryptionKeyring(env);
  if (!loaded.ok) return failure(loaded.reason);

  const { keys, activeVersion } = loaded.keyring;
  const key = keys.get(activeVersion);
  if (!key) {
    return failure(REASONS.ACTIVE_KEY_VERSION_NOT_FOUND);
  }

  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(CODECLIP_PROVIDER_CREDENTIAL_AAD, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(normalized.plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    if (tag.length !== AUTH_TAG_BYTES) {
      return failure(REASONS.ENCRYPT_FAILED);
    }

    const envelope = [
      CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION,
      String(activeVersion),
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");

    return {
      ok: true,
      envelope,
      keyVersion: activeVersion,
    };
  } catch {
    return failure(REASONS.ENCRYPT_FAILED);
  }
}

function parseEnvelope(envelope) {
  if (typeof envelope !== "string" || !envelope.trim()) {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }
  const parts = envelope.split(".");
  if (parts.length !== 5) {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }
  const [version, versionPart, ivPart, ciphertextPart, tagPart] = parts;
  if (!version || !versionPart || !ivPart || !ciphertextPart || !tagPart) {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }
  if (version !== CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION) {
    return failure(REASONS.UNSUPPORTED_ENVELOPE_VERSION);
  }
  const keyVersion = parsePositiveInteger(versionPart);
  if (keyVersion === null) {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }

  let iv;
  let ciphertext;
  let tag;
  try {
    iv = Buffer.from(ivPart, "base64url");
    ciphertext = Buffer.from(ciphertextPart, "base64url");
    tag = Buffer.from(tagPart, "base64url");
  } catch {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }

  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    return failure(REASONS.MALFORMED_ENVELOPE);
  }

  return {
    ok: true,
    keyVersion,
    iv,
    ciphertext,
    tag,
  };
}

/**
 * Decrypt a credential secret envelope.
 * Always uses the locked AAD constant; callers cannot override AAD.
 *
 * @returns {{ ok: true, plaintext: string, keyVersion: number }
 *         | { ok: false, reason: string }}
 */
function decryptCodeClipProviderCredentialSecret({
  envelope,
  env = process.env,
} = {}) {
  const parsed = parseEnvelope(envelope);
  if (!parsed.ok) return failure(parsed.reason);

  const loaded = loadCodeClipProviderCredentialEncryptionKeyring(env);
  if (!loaded.ok) return failure(loaded.reason);

  const key = loaded.keyring.keys.get(parsed.keyVersion);
  if (!key) {
    return failure(REASONS.ENCRYPTION_KEY_VERSION_NOT_FOUND);
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, parsed.iv);
    decipher.setAAD(Buffer.from(CODECLIP_PROVIDER_CREDENTIAL_AAD, "utf8"));
    decipher.setAuthTag(parsed.tag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return {
      ok: true,
      plaintext,
      keyVersion: parsed.keyVersion,
    };
  } catch {
    return failure(REASONS.DECRYPT_FAILED);
  }
}

module.exports = {
  CODECLIP_PROVIDER_CREDENTIAL_AAD,
  CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION,
  CODECLIP_PROVIDER_CREDENTIAL_CRYPTO_REASONS: REASONS,
  loadCodeClipProviderCredentialEncryptionKeyring,
  encryptCodeClipProviderCredentialSecret,
  decryptCodeClipProviderCredentialSecret,
};
