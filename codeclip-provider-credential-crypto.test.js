const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CODECLIP_PROVIDER_CREDENTIAL_AAD,
  CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION,
  CODECLIP_PROVIDER_CREDENTIAL_CRYPTO_REASONS: REASONS,
  loadCodeClipProviderCredentialEncryptionKeyring,
  encryptCodeClipProviderCredentialSecret,
  decryptCodeClipProviderCredentialSecret,
} = require("./verticals/codeclip/provider-credential-crypto");

const ENV_KEYS = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS";
const ENV_ACTIVE = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION";

const SAVED_ENV = {
  keys: process.env[ENV_KEYS],
  active: process.env[ENV_ACTIVE],
};

function restoreEnv() {
  if (SAVED_ENV.keys === undefined) delete process.env[ENV_KEYS];
  else process.env[ENV_KEYS] = SAVED_ENV.keys;
  if (SAVED_ENV.active === undefined) delete process.env[ENV_ACTIVE];
  else process.env[ENV_ACTIVE] = SAVED_ENV.active;
}

function clearCryptoEnv() {
  delete process.env[ENV_KEYS];
  delete process.env[ENV_ACTIVE];
}

function keyB64(bytes = crypto.randomBytes(32)) {
  return bytes.toString("base64");
}

function makeEnv({ versions = [1], activeVersion = 1, keys } = {}) {
  const keyMap = keys || Object.fromEntries(versions.map((v) => [v, keyB64()]));
  const keysString = Object.entries(keyMap)
    .map(([v, k]) => `${v}:${k}`)
    .join(";");
  return {
    [ENV_KEYS]: keysString,
    [ENV_ACTIVE]: String(activeVersion),
    keyMap,
  };
}

test.afterEach(() => {
  restoreEnv();
});

test("codeClip credential crypto exports locked AAD and envelope version", () => {
  assert.equal(CODECLIP_PROVIDER_CREDENTIAL_AAD, "codeclip:provider-credential:v1");
  assert.equal(CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION, "v1");
});

test("codeClip credential crypto loads a valid keyring", () => {
  const env = makeEnv({ versions: [1], activeVersion: 1 });
  const loaded = loadCodeClipProviderCredentialEncryptionKeyring(env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.keyring.activeVersion, 1);
  assert.equal(loaded.keyring.keys.size, 1);
  assert.equal(loaded.keyring.keys.get(1).length, 32);
});

test("codeClip credential crypto loads multiple key versions", () => {
  const env = makeEnv({ versions: [1, 2, 3], activeVersion: 2 });
  const loaded = loadCodeClipProviderCredentialEncryptionKeyring(env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.keyring.activeVersion, 2);
  assert.equal(loaded.keyring.keys.size, 3);
  assert.equal(loaded.keyring.keys.has(1), true);
  assert.equal(loaded.keyring.keys.has(2), true);
  assert.equal(loaded.keyring.keys.has(3), true);
});

test("codeClip credential crypto encrypt uses active key version", () => {
  const env = makeEnv({ versions: [1, 2], activeVersion: 2 });
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "secret-token-value",
    env,
  });
  assert.equal(encrypted.ok, true);
  assert.equal(encrypted.keyVersion, 2);
  assert.match(encrypted.envelope, /^v1\.2\./);
});

test("codeClip credential crypto encrypt/decrypt roundtrip", () => {
  const env = makeEnv();
  const plaintext = "ya29.access-token-example";
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  assert.equal(encrypted.ok, true);
  const decrypted = decryptCodeClipProviderCredentialSecret({
    envelope: encrypted.envelope,
    env,
  });
  assert.equal(decrypted.ok, true);
  assert.equal(decrypted.plaintext, plaintext);
  assert.equal(decrypted.keyVersion, encrypted.keyVersion);
});

test("codeClip credential crypto unicode plaintext roundtrip", () => {
  const env = makeEnv();
  const plaintext = "tokén-🔐-αβγ-日本語";
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  assert.equal(encrypted.ok, true);
  const decrypted = decryptCodeClipProviderCredentialSecret({
    envelope: encrypted.envelope,
    env,
  });
  assert.equal(decrypted.ok, true);
  assert.equal(decrypted.plaintext, plaintext);
});

test("codeClip credential crypto same plaintext yields distinct envelopes (unique IV)", () => {
  const env = makeEnv();
  const plaintext = "same-token";
  const a = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  const b = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.envelope, b.envelope);
  assert.equal(
    decryptCodeClipProviderCredentialSecret({ envelope: a.envelope, env }).plaintext,
    plaintext
  );
  assert.equal(
    decryptCodeClipProviderCredentialSecret({ envelope: b.envelope, env }).plaintext,
    plaintext
  );
});

test("codeClip credential crypto envelope has exactly five segments and v1", () => {
  const env = makeEnv();
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "segment-check",
    env,
  });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "v1");
  assert.equal(parts[0], CODECLIP_PROVIDER_CREDENTIAL_ENVELOPE_VERSION);
  assert.match(parts[1], /^[1-9][0-9]*$/);
  assert.ok(parts[2].length > 0);
  assert.ok(parts[3].length > 0);
  assert.ok(parts[4].length > 0);
});

test("codeClip credential crypto rejects tampered ciphertext", () => {
  const env = makeEnv();
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext: "tamper-ct", env });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  const ct = Buffer.from(parts[3], "base64url");
  ct[0] ^= 0xff;
  parts[3] = ct.toString("base64url");
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: parts.join("."),
    env,
  });
  assert.deepEqual(result, { ok: false, reason: REASONS.DECRYPT_FAILED });
});

test("codeClip credential crypto rejects tampered auth tag", () => {
  const env = makeEnv();
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext: "tamper-tag", env });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  const tag = Buffer.from(parts[4], "base64url");
  tag[0] ^= 0xff;
  parts[4] = tag.toString("base64url");
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: parts.join("."),
    env,
  });
  assert.deepEqual(result, { ok: false, reason: REASONS.DECRYPT_FAILED });
});

test("codeClip credential crypto rejects tampered IV", () => {
  const env = makeEnv();
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext: "tamper-iv", env });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  const iv = Buffer.from(parts[2], "base64url");
  iv[0] ^= 0xff;
  parts[2] = iv.toString("base64url");
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: parts.join("."),
    env,
  });
  assert.deepEqual(result, { ok: false, reason: REASONS.DECRYPT_FAILED });
});

test("codeClip credential crypto rejects wrong AAD", () => {
  // Build a syntactically valid v1 envelope with Node crypto using a different AAD.
  // Public decrypt always uses the locked AAD and must fail closed.
  const keyBytes = crypto.randomBytes(32);
  const env = makeEnv({ keys: { 1: keyBytes.toString("base64") }, activeVersion: 1 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  cipher.setAAD(Buffer.from("codeclip:provider-credential:wrong", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update("aad-check", "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const envelope = [
    "v1",
    "1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");

  const result = decryptCodeClipProviderCredentialSecret({ envelope, env });
  assert.deepEqual(result, { ok: false, reason: REASONS.DECRYPT_FAILED });
});

test("codeClip credential crypto rejects wrong key material", () => {
  const key1 = keyB64();
  const key2 = keyB64();
  const envEncrypt = makeEnv({
    keys: { 1: key1 },
    activeVersion: 1,
  });
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "wrong-key",
    env: envEncrypt,
  });
  assert.equal(encrypted.ok, true);
  const envWrong = makeEnv({
    keys: { 1: key2 },
    activeVersion: 1,
  });
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: encrypted.envelope,
    env: envWrong,
  });
  assert.deepEqual(result, { ok: false, reason: REASONS.DECRYPT_FAILED });
});

test("codeClip credential crypto rejects unknown key version in envelope", () => {
  const env = makeEnv({ versions: [1], activeVersion: 1 });
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "version-gap",
    env,
  });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  parts[1] = "9";
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: parts.join("."),
    env,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: REASONS.ENCRYPTION_KEY_VERSION_NOT_FOUND,
  });
});

test("codeClip credential crypto rejects unsupported envelope version", () => {
  const env = makeEnv();
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "env-version",
    env,
  });
  assert.equal(encrypted.ok, true);
  const parts = encrypted.envelope.split(".");
  parts[0] = "v2";
  const result = decryptCodeClipProviderCredentialSecret({
    envelope: parts.join("."),
    env,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: REASONS.UNSUPPORTED_ENVELOPE_VERSION,
  });
});

test("codeClip credential crypto rejects malformed envelopes", () => {
  const env = makeEnv();
  assert.deepEqual(
    decryptCodeClipProviderCredentialSecret({ envelope: "", env }),
    { ok: false, reason: REASONS.MALFORMED_ENVELOPE }
  );
  assert.deepEqual(
    decryptCodeClipProviderCredentialSecret({ envelope: "only.one", env }),
    { ok: false, reason: REASONS.MALFORMED_ENVELOPE }
  );
  assert.deepEqual(
    decryptCodeClipProviderCredentialSecret({ envelope: "v1.1.a.b", env }),
    { ok: false, reason: REASONS.MALFORMED_ENVELOPE }
  );
  assert.deepEqual(
    decryptCodeClipProviderCredentialSecret({
      envelope: "v1.notanumber.a.b.c",
      env,
    }),
    { ok: false, reason: REASONS.MALFORMED_ENVELOPE }
  );
});

test("codeClip credential crypto missing keyring fails closed", () => {
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring({}), {
    ok: false,
    reason: REASONS.ENCRYPTION_KEYS_NOT_CONFIGURED,
  });
  assert.deepEqual(
    encryptCodeClipProviderCredentialSecret({ plaintext: "x", env: {} }),
    { ok: false, reason: REASONS.ENCRYPTION_KEYS_NOT_CONFIGURED }
  );
});

test("codeClip credential crypto rejects invalid base64 key", () => {
  const env = {
    [ENV_KEYS]: "1:%%%not-base64%%%",
    [ENV_ACTIVE]: "1",
  };
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring(env), {
    ok: false,
    reason: REASONS.INVALID_ENCRYPTION_KEYRING,
  });
});

test("codeClip credential crypto rejects wrong key length", () => {
  const shortKey = crypto.randomBytes(16).toString("base64");
  const env = {
    [ENV_KEYS]: `1:${shortKey}`,
    [ENV_ACTIVE]: "1",
  };
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring(env), {
    ok: false,
    reason: REASONS.INVALID_ENCRYPTION_KEYRING,
  });
});

test("codeClip credential crypto rejects duplicate key versions", () => {
  const k = keyB64();
  const env = {
    [ENV_KEYS]: `1:${k};1:${keyB64()}`,
    [ENV_ACTIVE]: "1",
  };
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring(env), {
    ok: false,
    reason: REASONS.INVALID_ENCRYPTION_KEYRING,
  });
});

test("codeClip credential crypto rejects missing active version", () => {
  const env = {
    [ENV_KEYS]: `1:${keyB64()}`,
  };
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring(env), {
    ok: false,
    reason: REASONS.ACTIVE_KEY_VERSION_NOT_CONFIGURED,
  });
});

test("codeClip credential crypto rejects active version not in keyring", () => {
  const env = {
    [ENV_KEYS]: `1:${keyB64()}`,
    [ENV_ACTIVE]: "2",
  };
  assert.deepEqual(loadCodeClipProviderCredentialEncryptionKeyring(env), {
    ok: false,
    reason: REASONS.ACTIVE_KEY_VERSION_NOT_FOUND,
  });
});

test("codeClip credential crypto rejects empty plaintext", () => {
  const env = makeEnv();
  assert.deepEqual(
    encryptCodeClipProviderCredentialSecret({ plaintext: "", env }),
    { ok: false, reason: REASONS.INVALID_PLAINTEXT }
  );
  assert.deepEqual(
    encryptCodeClipProviderCredentialSecret({ plaintext: null, env }),
    { ok: false, reason: REASONS.INVALID_PLAINTEXT }
  );
});

test("codeClip credential crypto plaintext is not present in envelope", () => {
  const env = makeEnv();
  const plaintext = "super-secret-plain-token-value-XYZ";
  const encrypted = encryptCodeClipProviderCredentialSecret({ plaintext, env });
  assert.equal(encrypted.ok, true);
  assert.equal(encrypted.envelope.includes(plaintext), false);
  assert.equal(encrypted.envelope.includes("super-secret"), false);
});

test("codeClip credential crypto failures never serialize secrets", () => {
  const secret = "leak-candidate-token-value";
  const keyMaterial = keyB64();
  const env = {
    [ENV_KEYS]: `1:${keyMaterial}`,
    [ENV_ACTIVE]: "1",
  };
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: secret,
    env,
  });
  assert.equal(encrypted.ok, true);

  const wrongAadKey = Buffer.from(keyMaterial, "base64");
  const wrongIv = crypto.randomBytes(12);
  const wrongCipher = crypto.createCipheriv("aes-256-gcm", wrongAadKey, wrongIv);
  wrongCipher.setAAD(Buffer.from("wrong-aad", "utf8"));
  const wrongCt = Buffer.concat([
    wrongCipher.update(secret, "utf8"),
    wrongCipher.final(),
  ]);
  const wrongTag = wrongCipher.getAuthTag();
  const wrongAadEnvelope = [
    "v1",
    "1",
    wrongIv.toString("base64url"),
    wrongCt.toString("base64url"),
    wrongTag.toString("base64url"),
  ].join(".");

  const failures = [
    decryptCodeClipProviderCredentialSecret({
      envelope: wrongAadEnvelope,
      env,
    }),
    decryptCodeClipProviderCredentialSecret({ envelope: "bad", env }),
    encryptCodeClipProviderCredentialSecret({ plaintext: "", env }),
    loadCodeClipProviderCredentialEncryptionKeyring({}),
  ];

  for (const result of failures) {
    assert.equal(result.ok, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(keyMaterial), false);
    assert.equal(serialized.includes(encrypted.envelope), false);
    assert.equal(Object.hasOwn(result, "details"), false);
    assert.equal(Object.hasOwn(result, "message"), false);
    assert.equal(Object.hasOwn(result, "stack"), false);
  }
});

test("codeClip credential crypto public encrypt cannot force old key version", () => {
  const env = makeEnv({ versions: [1, 2], activeVersion: 2 });
  // Passing keyVersion on public encrypt must not switch away from active version.
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "no-force-version",
    env,
    keyVersion: 1,
  });
  assert.equal(encrypted.ok, true);
  assert.equal(encrypted.keyVersion, 2);
  assert.match(encrypted.envelope, /^v1\.2\./);
});

test("codeClip credential crypto decrypt with older key version still works", () => {
  const key1 = keyB64();
  const key2 = keyB64();
  const envV1 = makeEnv({ keys: { 1: key1, 2: key2 }, activeVersion: 1 });
  const encrypted = encryptCodeClipProviderCredentialSecret({
    plaintext: "legacy-token",
    env: envV1,
  });
  assert.equal(encrypted.keyVersion, 1);
  const envActive2 = makeEnv({ keys: { 1: key1, 2: key2 }, activeVersion: 2 });
  const decrypted = decryptCodeClipProviderCredentialSecret({
    envelope: encrypted.envelope,
    env: envActive2,
  });
  assert.equal(decrypted.ok, true);
  assert.equal(decrypted.plaintext, "legacy-token");
  assert.equal(decrypted.keyVersion, 1);
});

test("codeClip credential crypto does not read process.env when env object is passed", () => {
  clearCryptoEnv();
  process.env[ENV_KEYS] = `9:${keyB64()}`;
  process.env[ENV_ACTIVE] = "9";
  const env = makeEnv({ versions: [1], activeVersion: 1 });
  const loaded = loadCodeClipProviderCredentialEncryptionKeyring(env);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.keyring.activeVersion, 1);
  assert.equal(loaded.keyring.keys.has(9), false);
});
