const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");
const {
  resolveCodeClipProviderVerificationSecret,
} = require("./provider-secret-resolver");

function isCodeClipRuntimeVerificationEnabled(verificationMode) {
  return String(verificationMode || "").trim().toLowerCase() !== "disabled";
}

function buildCapabilities({
  verificationMode,
  hmacVerification = false,
  rawBodyRequired = false,
  liveProvider = false,
}) {
  return {
    route: true,
    envelope: true,
    adapter: true,
    keywordActivation: true,
    accountResolution: true,
    activationLookup: true,
    idempotency: true,
    webhookVerification: true,
    runtimeVerification: isCodeClipRuntimeVerificationEnabled(verificationMode),
    hmacVerification,
    rawBodyRequired,
    liveProvider,
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
    capabilities: buildCapabilities({ verificationMode: "disabled" }),
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
    verificationMode: "hmac-sha256",
    secretEnvName: "CODECLIP_SMS_WEBHOOK_SECRET",
    capabilities: buildCapabilities({
      verificationMode: "hmac-sha256",
      hmacVerification: true,
      rawBodyRequired: true,
    }),
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
    capabilities: buildCapabilities({ verificationMode: "test" }),
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

function buildCodeClipProviderVerificationRequest({
  policy,
  provider,
  headers,
  rawBody,
  env = process.env,
}) {
  const request = {
    provider,
    headers,
    rawBody,
    mode: policy.verificationMode,
  };
  const secretResolution = resolveCodeClipProviderVerificationSecret(policy, env);

  if (secretResolution.required && secretResolution.ok) {
    request.secret = secretResolution.secret;
  } else if (secretResolution.required && !secretResolution.ok) {
    request.secretResolution = {
      ok: false,
      reason: secretResolution.reason,
      required: true,
    };
  }

  return request;
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
  buildCodeClipProviderVerificationRequest,
  resolveCodeClipProviderPolicy,
};
