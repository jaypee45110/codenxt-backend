const BLOCKED_METADATA_KEYS = new Set([
  "authorization",
  "headers",
  "ip",
  "rawbody",
  "rawheaders",
  "rawpayload",
  "secret",
  "signature",
  "token",
]);

function normalizeValue(value) {
  return String(value || "").trim();
}

function normalizeMetadataKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sanitizeMetadata(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !BLOCKED_METADATA_KEYS.has(normalizeMetadataKey(key)))
      .map(([key, entry]) => [key, sanitizeMetadata(entry)])
  );
}

function normalizeCodePodProviderEnvelope(input = {}) {
  const provider = normalizeValue(input.provider).toLowerCase();

  if (!provider) {
    return {
      ok: false,
      reason: "PROVIDER_REQUIRED",
      envelope: null,
    };
  }

  return {
    ok: true,
    provider,
    envelope: {
      vertical: "codepod",
      provider,
      eventCode: normalizeValue(input.eventCode || input.entryCode),
      keyword: normalizeValue(input.keyword),
      messageId: normalizeValue(input.messageId),
      providerAccountId: normalizeValue(input.providerAccountId),
      senderId: normalizeValue(input.senderId),
      recipientId: normalizeValue(input.recipientId),
      channel: normalizeValue(input.channel),
      receivedAt: normalizeValue(input.receivedAt),
      metadata: sanitizeMetadata(input.metadata || {}),
    },
  };
}

module.exports = {
  normalizeCodePodProviderEnvelope,
};
