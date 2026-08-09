/**
 * Safe provider-polling detection metadata snapshots.
 *
 * This is durable completion input only. It intentionally stores an
 * allowlisted normalized shape, not raw provider payloads.
 */

const PROVIDER_CHANNELS = Object.freeze({
  tiktok: "tiktok",
});

class CodeClipProviderPollingDetectionMetadataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingDetectionMetadataError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function metadataError(code, message, details = {}) {
  const safe = {};
  for (const key of ["fieldName", "reason"]) {
    if (details?.[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 80);
    }
  }
  return new CodeClipProviderPollingDetectionMetadataError(code, message, safe);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || value.constructor === Object;
}

function normalizeString(value, fieldName, { required = false, max = 256 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw metadataError(
        "INVALID_DETECTION_METADATA",
        "provider polling detection metadata is invalid",
        { fieldName }
      );
    }
    return null;
  }
  if (typeof value !== "string") {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName }
    );
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName }
    );
  }
  return trimmed;
}

function normalizeIso(value, fieldName, { required = false } = {}) {
  const normalized = normalizeString(value, fieldName, {
    required,
    max: 40,
  });
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== normalized) {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName }
    );
  }
  return normalized;
}

function normalizeHttpsUrl(value, fieldName) {
  const normalized = normalizeString(value, fieldName, {
    required: false,
    max: 2048,
  });
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName }
    );
  }
  if (parsed.protocol !== "https:") {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName }
    );
  }
  return normalized;
}

function normalizeProvider(value) {
  return normalizeString(value, "provider", { required: true, max: 40 }).toLowerCase();
}

function buildCodeClipProviderPollingDetectionMetadata({
  provider,
  detection,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!isPlainObject(detection)) {
    throw metadataError(
      "INVALID_DETECTION_METADATA",
      "provider polling detection metadata is invalid",
      { fieldName: "detection" }
    );
  }

  const metadata = {
    provider: normalizedProvider,
    channel: PROVIDER_CHANNELS[normalizedProvider] || normalizedProvider,
    providerContentId: normalizeString(detection.providerObjectId, "providerObjectId", {
      required: true,
      max: 256,
    }),
    publishedAt: normalizeIso(detection.publishedAt, "publishedAt", {
      required: true,
    }),
    detectedAt: normalizeIso(detection.detectedAt, "detectedAt", {
      required: true,
    }),
    detectionSource: normalizeString(detection.source, "source", {
      required: true,
      max: 80,
    }).toLowerCase(),
  };

  const canonicalUrl = normalizeHttpsUrl(detection.canonicalUrl, "canonicalUrl");
  if (canonicalUrl) metadata.canonicalUrl = canonicalUrl;

  return metadata;
}

function getCodeClipProviderPollingCompletionInput(delivery = {}) {
  const metadata =
    delivery.providerDetectionMetadata ||
    delivery.provider_detection_metadata ||
    null;
  const source =
    delivery.initialDeliverySource ||
    delivery.initial_delivery_source ||
    null;
  const provider = normalizeString(delivery.provider, "provider", {
    required: true,
    max: 40,
  }).toLowerCase();

  if (source !== "provider_polling") {
    return {
      ok: false,
      code: "UNSUPPORTED_DELIVERY_SOURCE",
      completionInput: null,
    };
  }
  if (!isPlainObject(metadata)) {
    return {
      ok: false,
      code: "COMPLETION_INPUT_INSUFFICIENT",
      completionInput: null,
    };
  }

  try {
    const completionInput = buildCodeClipProviderPollingDetectionMetadata({
      provider,
      detection: {
        providerObjectId: metadata.providerContentId,
        publishedAt: metadata.publishedAt,
        detectedAt: metadata.detectedAt,
        source: metadata.detectionSource,
        canonicalUrl: metadata.canonicalUrl,
      },
    });
    return {
      ok: true,
      code: "OK",
      completionInput,
    };
  } catch (_error) {
    return {
      ok: false,
      code: "COMPLETION_INPUT_INSUFFICIENT",
      completionInput: null,
    };
  }
}

module.exports = {
  CodeClipProviderPollingDetectionMetadataError,
  buildCodeClipProviderPollingDetectionMetadata,
  getCodeClipProviderPollingCompletionInput,
};
