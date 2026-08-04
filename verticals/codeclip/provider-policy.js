const {
  getCodeClipProviderDefinition,
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
  providerAccountIdRequired = false,
  durableDeliveryRequired = false,
  // Registry metadata (authoritative; attached when resolving policy)
  webhook = false,
  polling = false,
  credentials = false,
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
    providerAccountIdRequired,
    durableDeliveryRequired,
    // Provider-class foundation metadata from registry (no runtime use in F1A)
    webhook,
    polling,
    credentials,
  };
}

/**
 * Operational policy fields only. providerClass and registry capabilities are
 * attached from the registry at resolve time — not hardcoded here.
 */
const PROVIDER_POLICIES = {
  meta: {
    provider: "meta",
    routeEnabled: true,
    adapter: "meta",
    envelopeType: "meta",
    verificationMode: "hmac-sha256",
    secretEnvName: "CODECLIP_META_WEBHOOK_SECRET",
    verifyTokenEnvName: "CODECLIP_META_VERIFY_TOKEN",
    capabilities: buildCapabilities({
      verificationMode: "hmac-sha256",
      hmacVerification: true,
      rawBodyRequired: true,
      liveProvider: true,
    }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
      requireStoreForLiveProvider: true,
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
  youtube: {
    provider: "youtube",
    routeEnabled: true,
    adapter: "youtube",
    envelopeType: "youtube-websub",
    verificationMode: "websub-hmac",
    secretEnvName: "CODECLIP_YOUTUBE_WEBSUB_SECRET",
    signatureHeader: "X-Hub-Signature",
    capabilities: buildCapabilities({
      verificationMode: "websub-hmac",
      hmacVerification: true,
      rawBodyRequired: true,
      liveProvider: true,
      providerAccountIdRequired: true,
      durableDeliveryRequired: true,
    }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
      requireStoreForLiveProvider: true,
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

function clonePolicy(policy, definition) {
  if (!definition || typeof definition.providerClass !== "string") {
    throw new Error("codeClip provider policy requires registry definition with providerClass");
  }
  const registryCapabilities = definition.capabilities || {};
  return {
    ...policy,
    providerClass: definition.providerClass,
    capabilities: {
      ...policy.capabilities,
      webhook: registryCapabilities.webhook === true,
      polling: registryCapabilities.polling === true,
      credentials: registryCapabilities.credentials === true,
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

  const operational = PROVIDER_POLICIES[normalizedProvider];
  if (!operational) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  const definition = getCodeClipProviderDefinition(normalizedProvider);
  if (!definition) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  return {
    ok: true,
    policy: clonePolicy(operational, definition),
  };
}

module.exports = {
  buildCodeClipProviderVerificationRequest,
  resolveCodeClipProviderPolicy,
};
