const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");

function buildCapabilities({ runtimeVerification }) {
  return {
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
  };
}

const PROVIDER_POLICIES = {
  meta: {
    provider: "meta",
    routeEnabled: true,
    adapter: "meta",
    envelopeType: "meta",
    verificationMode: "disabled",
    secretEnvName: "CODECLIP_META_WEBHOOK_SECRET",
    capabilities: buildCapabilities({ runtimeVerification: false }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
    },
  },
  sms: {
    provider: "sms",
    routeEnabled: true,
    adapter: "sms",
    envelopeType: "sms",
    verificationMode: "disabled",
    secretEnvName: "CODECLIP_SMS_WEBHOOK_SECRET",
    capabilities: buildCapabilities({ runtimeVerification: false }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
    },
  },
  test: {
    provider: "test",
    routeEnabled: true,
    adapter: "test",
    envelopeType: "test",
    verificationMode: "test",
    secretEnvName: "",
    capabilities: buildCapabilities({ runtimeVerification: true }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
    },
  },
};

function clonePolicy(policy) {
  return {
    ...policy,
    capabilities: {
      ...policy.capabilities,
    },
    idempotency: {
      ...policy.idempotency,
    },
  };
}

function resolveCodeClipProviderPolicy(provider) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };
  if (!isCodeClipProviderRegistered(normalizedProvider)) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  return {
    ok: true,
    policy: clonePolicy(PROVIDER_POLICIES[normalizedProvider]),
  };
}

module.exports = {
  resolveCodeClipProviderPolicy,
};
