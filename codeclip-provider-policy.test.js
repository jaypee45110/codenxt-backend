const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCodeClipProviderPolicy,
} = require("./verticals/codeclip/provider-policy");

function assertDefaultIdempotency(policy) {
  assert.deepEqual(policy.idempotency, {
    enabled: true,
    claimTtlSeconds: 300,
    responseTtlSeconds: 86400,
  });
}

test("codeClip provider policy returns test provider policy", () => {
  const result = resolveCodeClipProviderPolicy("test");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "test");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "test");
  assert.equal(result.policy.envelopeType, "test");
  assert.equal(result.policy.verificationMode, "test");
  assert.equal(result.policy.secretEnvName, "");
  assertDefaultIdempotency(result.policy);
});

test("codeClip provider policy returns sms provider policy", () => {
  const result = resolveCodeClipProviderPolicy("sms");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "sms");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "sms");
  assert.equal(result.policy.envelopeType, "sms");
  assert.equal(result.policy.verificationMode, "disabled");
  assert.equal(result.policy.secretEnvName, "CODECLIP_SMS_WEBHOOK_SECRET");
  assertDefaultIdempotency(result.policy);
});

test("codeClip provider policy returns meta provider policy", () => {
  const result = resolveCodeClipProviderPolicy("meta");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "meta");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "meta");
  assert.equal(result.policy.envelopeType, "meta");
  assert.equal(result.policy.verificationMode, "disabled");
  assert.equal(result.policy.secretEnvName, "CODECLIP_META_WEBHOOK_SECRET");
  assertDefaultIdempotency(result.policy);
});

test("codeClip provider policy normalizes provider names", () => {
  const result = resolveCodeClipProviderPolicy(" SMS ");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "sms");
});

test("codeClip provider policy rejects missing and unsupported providers", () => {
  assert.deepEqual(
    resolveCodeClipProviderPolicy(""),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );

  assert.deepEqual(
    resolveCodeClipProviderPolicy("unknown"),
    { ok: false, reason: "UNSUPPORTED_PROVIDER" }
  );
});

test("codeClip provider policy returns a defensive copy", () => {
  const first = resolveCodeClipProviderPolicy("test");
  first.policy.idempotency.claimTtlSeconds = 1;

  const second = resolveCodeClipProviderPolicy("test");
  assertDefaultIdempotency(second.policy);
});
