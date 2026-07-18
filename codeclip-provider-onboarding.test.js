const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCodeClipRegisteredProviders,
  isCodeClipProviderRegistered,
} = require("./verticals/codeclip/provider-registry");
const {
  buildCodeClipProviderVerificationRequest,
  resolveCodeClipProviderPolicy,
} = require("./verticals/codeclip/provider-policy");
const {
  getRegisteredKeywordProviderAdapters,
  normalizeProviderKeywordIngress,
} = require("./verticals/codeclip/provider-adapters");
const {
  normalizeCodeClipProviderEnvelope,
} = require("./verticals/codeclip/provider-envelope-normalizer");

const RECEIVED_AT = "2026-07-07T00:00:00.000Z";

const PROVIDER_FIXTURES = {
  meta: {
    body: {
      messageId: "meta-message-1",
      text: "CLIP",
      recipient: { id: "meta-account-1" },
      sender: { id: "meta-sender-1" },
    },
    adapterInput: {
      eventCode: "CC-META",
      text: "CLIP",
      messageId: "meta-message-1",
    },
  },
  sms: {
    body: {
      MessageSid: "sms-message-1",
      Body: "OPEN",
      To: "+15550000001",
      From: "+15550000002",
    },
    adapterInput: {
      eventCode: "CC-SMS",
      Body: "OPEN",
      MessageSid: "sms-message-1",
    },
  },
  test: {
    body: {
      providerEventId: "test-message-1",
      text: "WOW",
      providerAccountId: "test",
    },
    adapterInput: {
      eventCode: "CC-TEST",
      text: "WOW",
      providerEventId: "test-message-1",
    },
  },
};

function assertProviderCapabilitiesShape(capabilities) {
  for (const key of [
    "route",
    "envelope",
    "adapter",
    "keywordActivation",
    "accountResolution",
    "activationLookup",
    "idempotency",
    "webhookVerification",
    "runtimeVerification",
    "hmacVerification",
    "rawBodyRequired",
    "liveProvider",
    "providerAccountIdRequired",
    "durableDeliveryRequired",
  ]) {
    assert.equal(typeof capabilities[key], "boolean", `missing boolean capability ${key}`);
  }
}

test("registered codeClip providers have onboarding support", () => {
  const providers = getCodeClipRegisteredProviders();
  const adapters = getRegisteredKeywordProviderAdapters();

  for (const provider of providers) {
    assert.equal(isCodeClipProviderRegistered(provider), true);

    const policyResult = resolveCodeClipProviderPolicy(provider);
    assert.equal(policyResult.ok, true, `missing policy for ${provider}`);
    const { policy } = policyResult;

    assert.equal(policy.provider, provider);
    assert.equal(policy.routeEnabled, true);
    assert.equal(policy.adapter, provider);
    assert.equal(typeof policy.verificationMode, "string");
    assert.notEqual(policy.verificationMode.trim(), "");
    assertProviderCapabilitiesShape(policy.capabilities);
    assert.equal(policy.idempotency.enabled, true);
    assert.equal(policy.idempotency.claimTtlSeconds, 300);
    assert.equal(policy.idempotency.responseTtlSeconds, 86400);
    assert.equal(
      Boolean(policy.idempotency.requireStoreForLiveProvider),
      Boolean(policy.capabilities.liveProvider)
    );

    if (provider === "youtube") {
      assert.equal(policy.adapter, "youtube");
      assert.equal(policy.envelopeType, "youtube-websub");
      assert.equal(policy.verificationMode, "websub-hmac");
      assert.equal(policy.secretEnvName, "CODECLIP_YOUTUBE_WEBSUB_SECRET");
      assert.equal(policy.signatureHeader, "X-Hub-Signature");
      assert.equal(policy.capabilities.hmacVerification, true);
      assert.equal(policy.capabilities.rawBodyRequired, true);
      assert.equal(policy.capabilities.liveProvider, true);
      assert.equal(policy.capabilities.providerAccountIdRequired, true);
      assert.equal(policy.capabilities.durableDeliveryRequired, true);
      assert.equal(adapters.includes(provider), false);
    } else {
      assert.ok(PROVIDER_FIXTURES[provider], `missing onboarding fixture for ${provider}`);
      assert.equal(policy.envelopeType, provider);
      assert.equal(adapters.includes(provider), true, `missing keyword adapter for ${provider}`);

      const adapterResult = normalizeProviderKeywordIngress(
        provider,
        PROVIDER_FIXTURES[provider].adapterInput
      );
      assert.equal(adapterResult.ok, true, `adapter fixture failed for ${provider}`);
      assert.notEqual(adapterResult.eventCode, "");
      assert.notEqual(adapterResult.keyword, "");
      assert.notEqual(adapterResult.messageId, "");

      const envelopeResult = normalizeCodeClipProviderEnvelope({
        provider,
        body: PROVIDER_FIXTURES[provider].body,
        receivedAt: RECEIVED_AT,
      });
      assert.equal(envelopeResult.ok, true, `envelope fixture failed for ${provider}`);
      assert.equal(envelopeResult.envelope.provider, provider);
      assert.notEqual(envelopeResult.envelope.messageId, "");
      assert.notEqual(envelopeResult.envelope.text, "");
    }

    const verificationRequest = buildCodeClipProviderVerificationRequest({
      policy,
      provider,
      headers: {},
      rawBody: "",
      env: {},
    });
    assert.equal(verificationRequest.provider, provider);
    assert.equal(verificationRequest.mode, policy.verificationMode);
    assert.equal(Object.hasOwn(verificationRequest, "headers"), true);
    assert.equal(Object.hasOwn(verificationRequest, "rawBody"), true);
  }
});
