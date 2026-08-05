const {
  getCodeClipProviderDefinition,
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");
const {
  resolveCodeClipProviderVerificationSecret,
} = require("./provider-secret-resolver");
const {
  isCodeClipProviderDeliveryInitialSource,
} = require("./provider-delivery-sources");

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

function isSafeIntegerInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Fail-closed structural validation of detection + grace policy against
 * resolved capabilities. Used at resolve time and by tests.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateCodeClipProviderDetectionAndGracePolicy({
  detection = null,
  grace = null,
  capabilities = {},
} = {}) {
  const hasDetection = detection !== null && detection !== undefined;
  const hasGrace = grace !== null && grace !== undefined;

  if (hasDetection) {
    if (capabilities.polling !== true) {
      return { ok: false, reason: "DETECTION_NOT_SUPPORTED" };
    }
    if (!detection || typeof detection !== "object" || Array.isArray(detection)) {
      return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
    }
    if (!detection.sources || typeof detection.sources !== "object" || Array.isArray(detection.sources)) {
      return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
    }

    const sourceKeys = Object.keys(detection.sources);
    if (sourceKeys.length === 0) {
      return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
    }

    for (const key of sourceKeys) {
      const normalizedKey = String(key || "").trim().toLowerCase();
      if (!normalizedKey || normalizedKey !== key) {
        return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
      }
      const entry = detection.sources[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
      }
      const deliverySource = entry.deliverySource;
      if (typeof deliverySource !== "string" || !deliverySource.trim()) {
        return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
      }
      if (!isCodeClipProviderDeliveryInitialSource(deliverySource)) {
        return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
      }
      if (deliverySource.trim().toLowerCase() !== deliverySource) {
        return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
      }
    }

    const defaultSource = detection.defaultSource;
    if (typeof defaultSource !== "string" || !defaultSource.trim()) {
      return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
    }
    const normalizedDefault = defaultSource.trim().toLowerCase();
    if (normalizedDefault !== defaultSource || !Object.prototype.hasOwnProperty.call(detection.sources, normalizedDefault)) {
      return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
    }
  }

  if (hasGrace) {
    if (!grace || typeof grace !== "object" || Array.isArray(grace)) {
      return { ok: false, reason: "INVALID_GRACE_POLICY" };
    }
    const { defaultMs, minMs, maxMs, sourceOverrides } = grace;
    if (!Number.isSafeInteger(minMs) || minMs <= 0) {
      return { ok: false, reason: "INVALID_GRACE_POLICY" };
    }
    if (!Number.isSafeInteger(maxMs) || maxMs <= 0 || maxMs < minMs) {
      return { ok: false, reason: "INVALID_GRACE_POLICY" };
    }
    if (!isSafeIntegerInRange(defaultMs, minMs, maxMs)) {
      return { ok: false, reason: "INVALID_GRACE_POLICY" };
    }
    if (
      sourceOverrides === null ||
      sourceOverrides === undefined ||
      typeof sourceOverrides !== "object" ||
      Array.isArray(sourceOverrides)
    ) {
      return { ok: false, reason: "INVALID_GRACE_POLICY" };
    }

    for (const [key, overrideMs] of Object.entries(sourceOverrides)) {
      const normalizedKey = String(key || "").trim().toLowerCase();
      if (!normalizedKey || normalizedKey !== key) {
        return { ok: false, reason: "INVALID_GRACE_POLICY" };
      }
      if (hasDetection && !Object.prototype.hasOwnProperty.call(detection.sources, normalizedKey)) {
        return { ok: false, reason: "UNSUPPORTED_DETECTION_SOURCE" };
      }
      if (!isSafeIntegerInRange(overrideMs, minMs, maxMs)) {
        return { ok: false, reason: "INVALID_GRACE_POLICY" };
      }
    }
  }

  return { ok: true };
}

function cloneDetectionPolicy(detection) {
  if (!detection) return null;
  const sources = {};
  for (const [key, entry] of Object.entries(detection.sources || {})) {
    sources[key] = {
      deliverySource: entry.deliverySource,
    };
  }
  return {
    defaultSource: detection.defaultSource,
    sources,
  };
}

function cloneGracePolicy(grace) {
  if (!grace) return null;
  return {
    defaultMs: grace.defaultMs,
    minMs: grace.minMs,
    maxMs: grace.maxMs,
    sourceOverrides: { ...(grace.sourceOverrides || {}) },
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
    detection: {
      defaultSource: "atom",
      sources: {
        atom: {
          deliverySource: "atom_reconciliation",
        },
        data_api: {
          deliverySource: "data_api_polling",
        },
      },
    },
    grace: {
      defaultMs: 180000,
      minMs: 60000,
      maxMs: 3600000,
      sourceOverrides: {},
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
  // TikTok: poll_only credentials provider. Detection/grace deferred until poll adapter.
  tiktok: {
    provider: "tiktok",
    routeEnabled: false,
    adapter: "tiktok",
    envelopeType: "tiktok",
    verificationMode: "disabled",
    secretEnvName: "",
    capabilities: buildCapabilities({
      verificationMode: "disabled",
      liveProvider: true,
      providerAccountIdRequired: true,
      durableDeliveryRequired: true,
      // Registry overwrites webhook/polling/credentials at resolve time.
    }),
    idempotency: {
      enabled: true,
      claimTtlSeconds: 300,
      responseTtlSeconds: 86400,
      requireStoreForLiveProvider: true,
    },
  },
};

function mapProviderResolveFailure(reason) {
  if (reason === "PROVIDER_REQUIRED" || reason === "UNSUPPORTED_PROVIDER") {
    return "UNSUPPORTED_PROVIDER";
  }
  return reason || "UNSUPPORTED_PROVIDER";
}

function clonePolicy(policy, definition) {
  if (!definition || typeof definition.providerClass !== "string") {
    throw new Error("codeClip provider policy requires registry definition with providerClass");
  }
  const registryCapabilities = definition.capabilities || {};
  const capabilities = {
    ...policy.capabilities,
    webhook: registryCapabilities.webhook === true,
    polling: registryCapabilities.polling === true,
    credentials: registryCapabilities.credentials === true,
  };

  const detection = cloneDetectionPolicy(policy.detection || null);
  const grace = cloneGracePolicy(policy.grace || null);

  const validation = validateCodeClipProviderDetectionAndGracePolicy({
    detection,
    grace,
    capabilities,
  });
  if (!validation.ok) {
    throw new Error(
      `codeClip provider "${policy.provider}" has invalid detection/grace policy: ${validation.reason}`
    );
  }

  return {
    ...policy,
    providerClass: definition.providerClass,
    capabilities,
    idempotency: {
      ...policy.idempotency,
    },
    detection,
    grace,
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

/**
 * Resolve a provider-local detection source (allowlisted).
 * Omits rawSource / empty → defaultSource when configured.
 */
function resolveCodeClipProviderDetectionSource(provider, rawSource) {
  const resolved = resolveCodeClipProviderPolicy(provider);
  if (!resolved.ok) {
    return { ok: false, reason: mapProviderResolveFailure(resolved.reason) };
  }

  const detection = resolved.policy.detection;
  if (!detection) {
    return { ok: false, reason: "DETECTION_NOT_SUPPORTED" };
  }

  let candidate;
  if (rawSource === undefined || rawSource === null || String(rawSource).trim() === "") {
    candidate = detection.defaultSource;
  } else {
    candidate = String(rawSource).trim().toLowerCase();
  }

  if (!candidate) {
    return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
  }
  if (!Object.prototype.hasOwnProperty.call(detection.sources, candidate)) {
    return { ok: false, reason: "UNSUPPORTED_DETECTION_SOURCE" };
  }

  return { ok: true, detectionSource: candidate };
}

/**
 * Map a provider-local detection source to a canonical ledger delivery source.
 */
function mapCodeClipProviderDetectionSourceToDeliverySource(provider, detectionSource) {
  const resolved = resolveCodeClipProviderPolicy(provider);
  if (!resolved.ok) {
    return { ok: false, reason: mapProviderResolveFailure(resolved.reason) };
  }

  const detection = resolved.policy.detection;
  if (!detection) {
    return { ok: false, reason: "DETECTION_NOT_SUPPORTED" };
  }

  if (detectionSource === undefined || detectionSource === null || String(detectionSource).trim() === "") {
    return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
  }

  const normalized = String(detectionSource).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(detection.sources, normalized)) {
    return { ok: false, reason: "UNSUPPORTED_DETECTION_SOURCE" };
  }

  const deliverySource = detection.sources[normalized].deliverySource;
  if (!isCodeClipProviderDeliveryInitialSource(deliverySource)) {
    return { ok: false, reason: "INVALID_DETECTION_SOURCE" };
  }

  return { ok: true, deliverySource };
}

/**
 * List allowed provider-local detection source keys (defensive copy).
 */
function listCodeClipProviderDetectionSources(provider) {
  const resolved = resolveCodeClipProviderPolicy(provider);
  if (!resolved.ok) {
    return { ok: false, reason: mapProviderResolveFailure(resolved.reason) };
  }

  const detection = resolved.policy.detection;
  if (!detection) {
    return { ok: false, reason: "DETECTION_NOT_SUPPORTED" };
  }

  return {
    ok: true,
    sources: Object.keys(detection.sources).slice(),
  };
}

/**
 * Pure grace selection from an already-resolved grace policy object.
 * detectionSource selects sourceOverrides when present; otherwise defaultMs.
 */
function selectCodeClipProviderGraceMs(grace, { detectionSource, detection = null } = {}) {
  if (!grace) {
    return { ok: false, reason: "GRACE_NOT_SUPPORTED" };
  }

  let graceMs = grace.defaultMs;

  if (detectionSource !== undefined && detectionSource !== null && String(detectionSource).trim() !== "") {
    const normalized = String(detectionSource).trim().toLowerCase();
    if (detection && !Object.prototype.hasOwnProperty.call(detection.sources, normalized)) {
      return { ok: false, reason: "UNSUPPORTED_DETECTION_SOURCE" };
    }
    if (Object.prototype.hasOwnProperty.call(grace.sourceOverrides || {}, normalized)) {
      graceMs = grace.sourceOverrides[normalized];
    }
  }

  if (!isSafeIntegerInRange(graceMs, grace.minMs, grace.maxMs)) {
    return { ok: false, reason: "INVALID_GRACE_POLICY" };
  }

  return { ok: true, graceMs };
}

/**
 * Resolve grace window in ms for a provider.
 * Extensible options object; detectionSource selects sourceOverrides when set.
 */
function resolveCodeClipProviderGrace({ provider, detectionSource } = {}) {
  const resolved = resolveCodeClipProviderPolicy(provider);
  if (!resolved.ok) {
    return { ok: false, reason: mapProviderResolveFailure(resolved.reason) };
  }

  return selectCodeClipProviderGraceMs(resolved.policy.grace, {
    detectionSource,
    detection: resolved.policy.detection,
  });
}

module.exports = {
  buildCodeClipProviderVerificationRequest,
  listCodeClipProviderDetectionSources,
  mapCodeClipProviderDetectionSourceToDeliverySource,
  resolveCodeClipProviderDetectionSource,
  resolveCodeClipProviderGrace,
  resolveCodeClipProviderPolicy,
};
