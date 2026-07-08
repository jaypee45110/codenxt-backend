const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCodeClipProviderVerificationSecret,
} = require("./verticals/codeclip/provider-secret-resolver");

function buildHmacPolicy(overrides = {}) {
  return {
    verificationMode: "hmac-sha256",
    secretEnvName: "CODECLIP_TEST_SECRET",
    capabilities: {
      hmacVerification: true,
    },
    ...overrides,
  };
}

test("codeClip provider secret resolver returns no secret when policy does not require one", () => {
  assert.deepEqual(
    resolveCodeClipProviderVerificationSecret({
      verificationMode: "test",
      secretEnvName: "",
      capabilities: {
        hmacVerification: false,
      },
    }),
    { ok: true, secret: "", required: false }
  );
});

test("codeClip provider secret resolver does not require secret for disabled policy with secretEnvName", () => {
  assert.deepEqual(
    resolveCodeClipProviderVerificationSecret(
      {
        verificationMode: "disabled",
        secretEnvName: "CODECLIP_DISABLED_SECRET",
        capabilities: {
          hmacVerification: false,
        },
      },
      {}
    ),
    { ok: true, secret: "", required: false }
  );
});

test("codeClip provider secret resolver reads configured secret from env when required", () => {
  const result = resolveCodeClipProviderVerificationSecret(buildHmacPolicy(), {
    CODECLIP_TEST_SECRET: " test-secret ",
  });

  assert.deepEqual(result, {
    ok: true,
    secret: "test-secret",
    required: true,
  });
});

test("codeClip provider secret resolver reports missing env value when secret is required", () => {
  assert.deepEqual(
    resolveCodeClipProviderVerificationSecret(buildHmacPolicy(), {}),
    { ok: false, reason: "SECRET_NOT_CONFIGURED", required: true }
  );

  assert.deepEqual(
    resolveCodeClipProviderVerificationSecret(buildHmacPolicy(), {
      CODECLIP_TEST_SECRET: "   ",
    }),
    { ok: false, reason: "SECRET_NOT_CONFIGURED", required: true }
  );
});

test("codeClip provider secret resolver does not leak secret in missing-secret result", () => {
  const result = resolveCodeClipProviderVerificationSecret(
    buildHmacPolicy({ secretEnvName: "MISSING_SECRET" }),
    {
      OTHER_SECRET: "must-not-leak",
    }
  );

  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(Object.hasOwn(result, "metadata"), false);
  assert.equal(Object.values(result).includes("must-not-leak"), false);
});
