const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS,
  CODECLIP_PROVIDER_CREDENTIAL_STATUSES,
  CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES,
  normalizeCodeClipProviderCredentialEnvironment,
  normalizeCodeClipProviderCredentialStatus,
  normalizeCodeClipProviderCredentialPurpose,
  normalizeCodeClipProviderCredentialAccountRef,
  normalizeCodeClipProviderCredentialScopes,
  normalizeCodeClipProviderCredentialMetadata,
  isCodeClipProviderCredentialExpired,
  validateCodeClipProviderCredentialStatusTransition,
} = require("./verticals/codeclip/provider-credential-validators");

test("codeClip credential validators export frozen environment status and purpose constants", () => {
  assert.deepEqual(CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS, ["sandbox", "production"]);
  assert.deepEqual(CODECLIP_PROVIDER_CREDENTIAL_STATUSES, [
    "active",
    "reauthorization_required",
    "revoked",
    "disabled",
  ]);
  assert.deepEqual(CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES, [
    "provider_api",
    "refresh",
    "validation",
  ]);
  assert.equal(Object.isFrozen(CODECLIP_PROVIDER_CREDENTIAL_ENVIRONMENTS), true);
  assert.equal(Object.isFrozen(CODECLIP_PROVIDER_CREDENTIAL_STATUSES), true);
  assert.equal(Object.isFrozen(CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES), true);
});

test("codeClip credential environment normalizes trim and lowercase", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialEnvironment(" Sandbox "), {
    ok: true,
    environment: "sandbox",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialEnvironment("PRODUCTION"), {
    ok: true,
    environment: "production",
  });
});

test("codeClip credential environment rejects invalid values", () => {
  for (const value of ["", "  ", "staging", "prod", null, 1, undefined]) {
    assert.deepEqual(normalizeCodeClipProviderCredentialEnvironment(value), {
      ok: false,
      reason: "INVALID_ENVIRONMENT",
    });
  }
});

test("codeClip credential status accepts locked statuses only", () => {
  for (const status of CODECLIP_PROVIDER_CREDENTIAL_STATUSES) {
    assert.deepEqual(normalizeCodeClipProviderCredentialStatus(` ${status.toUpperCase()} `), {
      ok: true,
      status,
    });
  }
});

test("codeClip credential status rejects expired and unknown", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialStatus("expired"), {
    ok: false,
    reason: "INVALID_STATUS",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialStatus("pending"), {
    ok: false,
    reason: "INVALID_STATUS",
  });
});

test("codeClip credential purpose accepts locked purposes only", () => {
  for (const purpose of CODECLIP_PROVIDER_CREDENTIAL_SECRET_PURPOSES) {
    assert.deepEqual(normalizeCodeClipProviderCredentialPurpose(` ${purpose.toUpperCase()} `), {
      ok: true,
      purpose,
    });
  }
  assert.deepEqual(normalizeCodeClipProviderCredentialPurpose("debug"), {
    ok: false,
    reason: "INVALID_PURPOSE",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialPurpose(""), {
    ok: false,
    reason: "INVALID_PURPOSE",
  });
});

test("codeClip credential account ref normalizes lookup key as account id", () => {
  assert.deepEqual(
    normalizeCodeClipProviderCredentialAccountRef({
      provider: " Meta ",
      providerAccountId: " page-123 ",
      environment: "SANDBOX",
    }),
    {
      ok: true,
      provider: "meta",
      environment: "sandbox",
      providerAccountId: "page-123",
      accountLookupKey: "page-123",
    }
  );
});

test("codeClip credential account ref rejects unknown provider and bad account ids", () => {
  // tiktok is a registered credentials-capable provider (F2A1); use a non-provider.
  assert.deepEqual(
    normalizeCodeClipProviderCredentialAccountRef({
      provider: "not-a-registered-provider",
      providerAccountId: "x",
      environment: "sandbox",
    }),
    { ok: false, reason: "INVALID_PROVIDER" }
  );
  assert.deepEqual(
    normalizeCodeClipProviderCredentialAccountRef({
      provider: "meta",
      providerAccountId: "  ",
      environment: "sandbox",
    }),
    { ok: false, reason: "INVALID_PROVIDER_ACCOUNT_ID" }
  );
  assert.deepEqual(
    normalizeCodeClipProviderCredentialAccountRef({
      provider: "meta",
      providerAccountId: "a".repeat(257),
      environment: "sandbox",
    }),
    { ok: false, reason: "INVALID_PROVIDER_ACCOUNT_ID" }
  );
  assert.deepEqual(
    normalizeCodeClipProviderCredentialAccountRef({
      provider: "meta",
      providerAccountId: "bad\nid",
      environment: "sandbox",
    }),
    { ok: false, reason: "INVALID_PROVIDER_ACCOUNT_ID" }
  );
});

test("codeClip credential scopes normalize, dedupe, preserve case", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialScopes(undefined), {
    ok: true,
    scopes: [],
  });
  assert.deepEqual(
    normalizeCodeClipProviderCredentialScopes([
      " openid ",
      "profile",
      "openid",
      "",
      "  ",
      "email",
      "Profile",
    ]),
    {
      ok: true,
      scopes: ["openid", "profile", "email", "Profile"],
    }
  );
});

test("codeClip credential scopes reject invalid shapes and limits", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialScopes("openid profile"), {
    ok: false,
    reason: "INVALID_SCOPES",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialScopes([1]), {
    ok: false,
    reason: "INVALID_SCOPES",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialScopes(["a".repeat(257)]), {
    ok: false,
    reason: "INVALID_SCOPES",
  });
  assert.deepEqual(
    normalizeCodeClipProviderCredentialScopes(Array.from({ length: 33 }, (_, i) => `s${i}`)),
    { ok: false, reason: "INVALID_SCOPES" }
  );
});

test("codeClip credential scopes return a defensive copy", () => {
  const input = ["a", "b"];
  const result = normalizeCodeClipProviderCredentialScopes(input);
  assert.equal(result.ok, true);
  result.scopes.push("c");
  input.push("d");
  assert.deepEqual(normalizeCodeClipProviderCredentialScopes(["a", "b"]).scopes, ["a", "b"]);
});

test("codeClip credential metadata accepts nested plain objects within limits", () => {
  const result = normalizeCodeClipProviderCredentialMetadata({
    subject: "user",
    nested: { level: 2, items: ["a", "b"] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.metadata, {
    subject: "user",
    nested: { level: 2, items: ["a", "b"] },
  });
});

test("codeClip credential metadata rejects root array null and non-objects", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata([]), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata(null), {
    ok: true,
    metadata: {},
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata("x"), {
    ok: false,
    reason: "INVALID_METADATA",
  });
});

test("codeClip credential metadata denylist is case-insensitive exact match", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ Access_Token: "x" }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ client_secret: "x" }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  // token_type is not on denylist (exact key); allowed as metadata if needed
  assert.equal(normalizeCodeClipProviderCredentialMetadata({ token_type: "Bearer" }).ok, true);
});

test("codeClip credential metadata rejects nested denylist keys", () => {
  assert.deepEqual(
    normalizeCodeClipProviderCredentialMetadata({
      outer: { refresh_token: "secret" },
    }),
    { ok: false, reason: "INVALID_METADATA" }
  );
});

test("codeClip credential metadata enforces max depth", () => {
  // depth: root(1) -> a(2) -> b(3) -> c(4) should fail
  assert.deepEqual(
    normalizeCodeClipProviderCredentialMetadata({
      a: { b: { c: { d: 1 } } },
    }),
    { ok: false, reason: "INVALID_METADATA" }
  );
  // depth 3 ok: root -> a -> b
  assert.equal(
    normalizeCodeClipProviderCredentialMetadata({ a: { b: { c: 1 } } }).ok,
    true
  );
});

test("codeClip credential metadata enforces max nodes", () => {
  const many = {};
  for (let i = 0; i < 60; i += 1) many[`k${i}`] = i;
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata(many), {
    ok: false,
    reason: "INVALID_METADATA",
  });
});

test("codeClip credential metadata enforces max array elements", () => {
  assert.deepEqual(
    normalizeCodeClipProviderCredentialMetadata({
      items: Array.from({ length: 21 }, (_, i) => i),
    }),
    { ok: false, reason: "INVALID_METADATA" }
  );
});

test("codeClip credential metadata enforces max byte size", () => {
  assert.deepEqual(
    normalizeCodeClipProviderCredentialMetadata({
      blob: "x".repeat(5000),
    }),
    { ok: false, reason: "INVALID_METADATA" }
  );
});

test("codeClip credential metadata rejects unsupported JS values", () => {
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ n: NaN }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ n: Infinity }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ f: () => 1 }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
  assert.deepEqual(normalizeCodeClipProviderCredentialMetadata({ u: undefined }), {
    ok: false,
    reason: "INVALID_METADATA",
  });
});

test("codeClip credential metadata returns defensive deep copy", () => {
  const input = { a: { b: 1 } };
  const result = normalizeCodeClipProviderCredentialMetadata(input);
  assert.equal(result.ok, true);
  result.metadata.a.b = 99;
  input.a.b = 42;
  const again = normalizeCodeClipProviderCredentialMetadata({ a: { b: 1 } });
  assert.deepEqual(again.metadata, { a: { b: 1 } });
});

test("codeClip credential expiry helper derives expired without status", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  assert.deepEqual(
    isCodeClipProviderCredentialExpired({ accessTokenExpiresAt: null, now }),
    { ok: true, expired: false }
  );
  assert.deepEqual(
    isCodeClipProviderCredentialExpired({
      accessTokenExpiresAt: "2026-08-04T13:00:00.000Z",
      now,
    }),
    { ok: true, expired: false }
  );
  assert.deepEqual(
    isCodeClipProviderCredentialExpired({
      accessTokenExpiresAt: "2026-08-04T12:00:00.000Z",
      now,
    }),
    { ok: true, expired: true }
  );
  assert.deepEqual(
    isCodeClipProviderCredentialExpired({
      accessTokenExpiresAt: "2026-08-04T11:00:00.000Z",
      now,
    }),
    { ok: true, expired: true }
  );
  assert.deepEqual(
    isCodeClipProviderCredentialExpired({
      accessTokenExpiresAt: "not-a-date",
      now,
    }),
    { ok: false, reason: "INVALID_TIMESTAMP" }
  );
});

test("codeClip credential status transitions allow matrix and reject terminal revoked", () => {
  const allowed = [
    ["active", "disabled"],
    ["disabled", "active"],
    ["active", "reauthorization_required"],
    ["reauthorization_required", "active"],
    ["active", "revoked"],
    ["reauthorization_required", "revoked"],
    ["disabled", "revoked"],
    ["reauthorization_required", "disabled"],
  ];
  for (const [from, to] of allowed) {
    assert.deepEqual(validateCodeClipProviderCredentialStatusTransition(from, to), {
      ok: true,
      fromStatus: from,
      toStatus: to,
    });
  }

  const forbidden = [
    ["revoked", "active"],
    ["revoked", "disabled"],
    ["disabled", "reauthorization_required"],
    ["active", "active"],
    ["active", "expired"],
  ];
  for (const [from, to] of forbidden) {
    const result = validateCodeClipProviderCredentialStatusTransition(from, to);
    assert.equal(result.ok, false);
  }
});
