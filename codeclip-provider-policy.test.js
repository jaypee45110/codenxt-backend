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

function assertDefaultCapabilities(policy, { runtimeVerification }) {
  assert.deepEqual(policy.capabilities, {
    route: true,
    envelope: true,
    adapter: true,
    keywordActivation: true,
    accountResolution: true,
    activationLookup: true,
    idempotency: true,
    webhookVerification: true,
    runtimeVerification,
    hmacVerification: false,
    rawBodyRequired: false,
    liveProvider: false,
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
  assertDefaultCapabilities(result.policy, { runtimeVerification: true });
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
  assertDefaultCapabilities(result.policy, { runtimeVerification: false });
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
  assertDefaultCapabilities(result.policy, { runtimeVerification: false });
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
  first.policy.capabilities.runtimeVerification = false;
  first.policy.idempotency.claimTtlSeconds = 1;

  const second = resolveCodeClipProviderPolicy("test");
  assertDefaultCapabilities(second.policy, { runtimeVerification: true });
  assertDefaultIdempotency(second.policy);
});
