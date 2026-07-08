const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCodeClipProviderVerificationRequest,
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

function assertRuntimeVerificationInvariant(policy) {
  assert.equal(
    policy.capabilities.runtimeVerification,
    policy.verificationMode !== "disabled"
  );
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
  assertRuntimeVerificationInvariant(result.policy);
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
  assertRuntimeVerificationInvariant(result.policy);
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
  assertRuntimeVerificationInvariant(result.policy);
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

test("codeClip provider policy builds verifier request for test provider", () => {
  const { policy } = resolveCodeClipProviderPolicy("test");
  const headers = { "x-codeclip-test-signature": "valid" };
  const rawBody = "";

  assert.deepEqual(
    buildCodeClipProviderVerificationRequest({
      policy,
      provider: "test",
      headers,
      rawBody,
    }),
    {
      provider: "test",
      headers,
      rawBody,
      mode: "test",
    }
  );
});

test("codeClip provider policy builds disabled verifier request for sms and meta", () => {
  const headers = { "x-provider-signature": "unused" };
  const rawBody = "";

  for (const provider of ["sms", "meta"]) {
    const { policy } = resolveCodeClipProviderPolicy(provider);
    const request = buildCodeClipProviderVerificationRequest({
      policy,
      provider,
      headers,
      rawBody,
    });

    assert.equal(request.provider, provider);
    assert.equal(request.headers, headers);
    assert.equal(request.rawBody, rawBody);
    assert.equal(request.mode, "disabled");
    assert.equal(Object.hasOwn(request, "secret"), false);
    assert.equal(Object.hasOwn(request, "signatureHeader"), false);
    assert.equal(Object.hasOwn(request, "signatureHeaders"), false);
    assert.equal(Object.hasOwn(request, "verificationMethod"), false);
    assert.equal(Object.hasOwn(request, "rawBodyRequired"), false);
    assert.equal(policy.capabilities.hmacVerification, false);
    assert.equal(policy.capabilities.rawBodyRequired, false);
    assert.equal(policy.capabilities.liveProvider, false);
  }
});
