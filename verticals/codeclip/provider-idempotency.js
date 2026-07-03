const PROVIDER_KEYWORD_PAYLOAD_INTERNAL_FIELDS = new Set([
  "audienceEntry",
  "audienceIntent",
  "audienceContext",
  "rewardAssignmentSnapshot",
  "persistenceStatus",
  "persistenceDecision",
  "persistenceGuaranteePolicy",
  "persistenceAction",
]);

function buildProviderKeywordIdempotencyKey({ provider, eventCode, messageId } = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedEventCode = String(eventCode || "").trim();
  const normalizedMessageId = String(messageId || "").trim();

  if (!normalizedProvider || !normalizedEventCode || !normalizedMessageId) {
    return null;
  }

  return `codeclip:provider:keyword:idempotency:${normalizedProvider}:${normalizedEventCode}:${normalizedMessageId}`;
}

function getProviderKeywordResponseKey(idempotencyKey) {
  return `${idempotencyKey}:response`;
}

function safeSerializeProviderKeywordPayload(payload = {}) {
  const publicPayload = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (!PROVIDER_KEYWORD_PAYLOAD_INTERNAL_FIELDS.has(key)) {
      publicPayload[key] = value;
    }
  }

  return JSON.stringify(publicPayload);
}

function safeParseProviderKeywordPayload(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function claimProviderKeywordIdempotency({ redis, key, ttlSeconds = 86400 } = {}) {
  if (!redis || !key) {
    return { enabled: false, claimed: true };
  }

  const result = await redis.set(key, "processing", "NX", "EX", ttlSeconds);

  return { enabled: true, claimed: Boolean(result) };
}

async function recordProviderKeywordResponse({ redis, key, payload, ttlSeconds = 86400 } = {}) {
  if (!redis || !key) {
    return { recorded: false };
  }

  await redis.set(
    getProviderKeywordResponseKey(key),
    safeSerializeProviderKeywordPayload(payload),
    "EX",
    ttlSeconds
  );

  return { recorded: true };
}

async function readProviderKeywordResponse({ redis, key } = {}) {
  if (!redis || !key) return null;

  const value = await redis.get(getProviderKeywordResponseKey(key));

  return safeParseProviderKeywordPayload(value);
}

module.exports = {
  buildProviderKeywordIdempotencyKey,
  claimProviderKeywordIdempotency,
  getProviderKeywordResponseKey,
  readProviderKeywordResponse,
  recordProviderKeywordResponse,
  safeParseProviderKeywordPayload,
  safeSerializeProviderKeywordPayload,
};
