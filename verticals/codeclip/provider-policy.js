const PROVIDER_POLICIES = {
  meta: {
    provider: "meta",
    routeEnabled: true,
    adapter: "meta",
    envelopeType: "meta",
    verificationMode: "disabled",
    secretEnvName: "CODECLIP_META_WEBHOOK_SECRET",
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
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
    },
  },
};

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function clonePolicy(policy) {
  return {
    ...policy,
    idempotency: {
      ...policy.idempotency,
    },
  };
}

function resolveCodeClipProviderPolicy(provider) {
  const normalizedProvider = normalizeProvider(provider);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };

  const policy = PROVIDER_POLICIES[normalizedProvider];
  if (!policy) return { ok: false, reason: "UNSUPPORTED_PROVIDER" };

  return {
    ok: true,
    policy: clonePolicy(policy),
  };
}

module.exports = {
  resolveCodeClipProviderPolicy,
};
