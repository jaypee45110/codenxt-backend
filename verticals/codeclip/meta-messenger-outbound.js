const crypto = require("node:crypto");

const PROVIDER = "meta";
const CHANNEL = "messenger";
const DELIVERABLE_TYPES = new Set(["reward_link"]);
const OUTBOUND_TYPES = new Set(["reward_link"]);
const MAX_URL_LENGTH = 2048;

const OUTBOUND_STATUSES = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  SENT: "sent",
  RETRYABLE_FAILED: "retryable_failed",
  TERMINAL_FAILED: "terminal_failed",
});

const TERMINAL_STATUSES = new Set([
  OUTBOUND_STATUSES.SENT,
  OUTBOUND_STATUSES.TERMINAL_FAILED,
]);

const VALID_STATUS_TRANSITIONS = Object.freeze({
  [OUTBOUND_STATUSES.PENDING]: new Set([
    OUTBOUND_STATUSES.CLAIMED,
    OUTBOUND_STATUSES.RETRYABLE_FAILED,
    OUTBOUND_STATUSES.TERMINAL_FAILED,
  ]),
  [OUTBOUND_STATUSES.CLAIMED]: new Set([
    OUTBOUND_STATUSES.SENT,
    OUTBOUND_STATUSES.RETRYABLE_FAILED,
    OUTBOUND_STATUSES.TERMINAL_FAILED,
  ]),
  [OUTBOUND_STATUSES.RETRYABLE_FAILED]: new Set([
    OUTBOUND_STATUSES.CLAIMED,
    OUTBOUND_STATUSES.TERMINAL_FAILED,
  ]),
  [OUTBOUND_STATUSES.SENT]: new Set(),
  [OUTBOUND_STATUSES.TERMINAL_FAILED]: new Set(),
});

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function outboundError(reason, details = {}) {
  return { ok: false, reason, details };
}

function maskIdentifier(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
}

function fingerprintIdentifier(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function isDeliverableHttpsUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length > MAX_URL_LENGTH) return false;

  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function buildMetaMessengerOutboundIdempotencyKey({
  provider = PROVIDER,
  channel = CHANNEL,
  providerAccountId,
  externalInboundMessageId,
  outboundType = "reward_link",
} = {}) {
  const normalizedProvider = normalizeToken(provider);
  const normalizedChannel = normalizeToken(channel);
  const normalizedProviderAccountId = normalizeString(providerAccountId);
  const normalizedExternalInboundMessageId = normalizeString(externalInboundMessageId);
  const normalizedOutboundType = normalizeToken(outboundType);

  if (
    normalizedProvider !== PROVIDER ||
    normalizedChannel !== CHANNEL ||
    !normalizedProviderAccountId ||
    !normalizedExternalInboundMessageId ||
    !OUTBOUND_TYPES.has(normalizedOutboundType)
  ) {
    return null;
  }

  return [
    "codeclip",
    PROVIDER,
    CHANNEL,
    "outbound",
    normalizedProviderAccountId,
    normalizedExternalInboundMessageId,
    normalizedOutboundType,
  ].join(":");
}

function selectRewardLinkDeliverable(result = {}) {
  const rewardTier = normalizeString(result.rewardTier || result.tier);
  const rewards = result.rewards && typeof result.rewards === "object" ? result.rewards : {};
  const reward = rewardTier ? rewards[rewardTier] : null;

  if (!rewardTier || !reward || reward.assigned !== true) {
    return outboundError("NO_DELIVERABLE_REWARD");
  }

  const url = normalizeString(reward.contentUrl);
  if (!url) return outboundError("NO_DELIVERABLE_REWARD");
  if (!isDeliverableHttpsUrl(url)) return outboundError("REWARD_URL_INVALID");

  return {
    ok: true,
    deliverable: {
      type: "reward_link",
      rewardTier,
      url,
      metadata: {
        displayTier: normalizeString(reward.displayTier) || null,
        title: normalizeString(reward.title) || null,
        rewardType: normalizeString(reward.type) || null,
      },
    },
  };
}

function validateMetaMessengerOutboundIntent(intent = {}) {
  const provider = normalizeToken(intent.provider);
  const channel = normalizeToken(intent.channel);
  if (provider !== PROVIDER) return outboundError("PROVIDER_REQUIRED");
  if (channel !== CHANNEL) return outboundError("CHANNEL_REQUIRED");

  const providerAccountId = normalizeString(intent.providerAccountId);
  const recipientId = normalizeString(intent.recipientId);
  const eventCode = normalizeString(intent.eventCode);
  const externalInboundMessageId = normalizeString(intent.externalInboundMessageId);
  const outboundType = normalizeToken(intent.outboundType);
  const idempotencyKey = normalizeString(intent.idempotencyKey);
  const createdAt = normalizeString(intent.createdAt);
  const deliverable = intent.deliverable || {};

  if (!providerAccountId) return outboundError("PROVIDER_ACCOUNT_ID_REQUIRED");
  if (!recipientId) return outboundError("RECIPIENT_ID_REQUIRED");
  if (!eventCode) return outboundError("EVENT_CODE_REQUIRED");
  if (!externalInboundMessageId) return outboundError("INBOUND_IDENTITY_REQUIRED");
  if (!OUTBOUND_TYPES.has(outboundType)) return outboundError("OUTBOUND_TYPE_UNSUPPORTED");
  if (!idempotencyKey) return outboundError("IDEMPOTENCY_KEY_REQUIRED");
  const expectedIdempotencyKey = buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId,
    externalInboundMessageId,
    outboundType,
  });
  if (idempotencyKey !== expectedIdempotencyKey) {
    return outboundError("IDEMPOTENCY_KEY_MISMATCH");
  }
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    return outboundError("CREATED_AT_INVALID");
  }

  if (!deliverable || typeof deliverable !== "object" || Array.isArray(deliverable)) {
    return outboundError("DELIVERABLE_REQUIRED");
  }
  if (!DELIVERABLE_TYPES.has(normalizeToken(deliverable.type))) {
    return outboundError("DELIVERABLE_TYPE_UNSUPPORTED");
  }
  if (!normalizeString(deliverable.rewardTier)) {
    return outboundError("REWARD_TIER_REQUIRED");
  }
  if (!isDeliverableHttpsUrl(deliverable.url)) {
    return outboundError("REWARD_URL_INVALID");
  }

  return { ok: true };
}

function buildMetaMessengerRewardOutboundIntent(input = {}) {
  const providerAccountId = normalizeString(input.providerAccountId);
  const recipientId = normalizeString(input.recipientId);
  const eventCode = normalizeString(input.eventCode);
  const bindingId = normalizeString(input.bindingId);
  const inboundDeliveryId = normalizeString(input.inboundDeliveryId);
  const externalInboundMessageId = normalizeString(input.externalInboundMessageId);
  const interactionId = normalizeString(input.interactionId);
  const createdAt = normalizeString(input.createdAt) || new Date().toISOString();
  const outboundType = "reward_link";

  const idempotencyKey = buildMetaMessengerOutboundIdempotencyKey({
    provider: PROVIDER,
    channel: CHANNEL,
    providerAccountId,
    externalInboundMessageId,
    outboundType,
  });

  if (!idempotencyKey && !externalInboundMessageId) {
    return outboundError("INBOUND_IDENTITY_REQUIRED");
  }

  const deliverableResult = selectRewardLinkDeliverable(input.result || input);
  if (!deliverableResult.ok) return deliverableResult;

  const intent = {
    provider: PROVIDER,
    channel: CHANNEL,
    providerAccountId,
    recipientId,
    eventCode,
    bindingId: bindingId || null,
    inboundDeliveryId: inboundDeliveryId || null,
    externalInboundMessageId,
    interactionId: interactionId || null,
    outboundType,
    deliverable: deliverableResult.deliverable,
    idempotencyKey,
    createdAt,
  };

  const validation = validateMetaMessengerOutboundIntent(intent);
  if (!validation.ok) return validation;

  return { ok: true, intent };
}

function createMetaMessengerOutboundStatus(intent = {}) {
  const validation = validateMetaMessengerOutboundIntent(intent);
  if (!validation.ok) return validation;

  return {
    ok: true,
    status: {
      provider: PROVIDER,
      channel: CHANNEL,
      providerAccountId: intent.providerAccountId,
      recipientId: intent.recipientId,
      externalInboundMessageId: intent.externalInboundMessageId,
      inboundDeliveryId: intent.inboundDeliveryId,
      idempotencyKey: intent.idempotencyKey,
      outboundType: intent.outboundType,
      status: OUTBOUND_STATUSES.PENDING,
      attemptCount: 0,
      nextAttemptAt: null,
      terminal: false,
      retryEligible: true,
      failureCode: null,
      providerMessageId: null,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    },
  };
}

function transitionMetaMessengerOutboundStatus(status = {}, updates = {}) {
  const current = normalizeToken(status.status);
  const next = normalizeToken(updates.status);
  if (!Object.values(OUTBOUND_STATUSES).includes(current)) {
    return outboundError("OUTBOUND_STATUS_INVALID");
  }
  if (!Object.values(OUTBOUND_STATUSES).includes(next)) {
    return outboundError("OUTBOUND_NEXT_STATUS_INVALID");
  }
  if (!VALID_STATUS_TRANSITIONS[current].has(next)) {
    return outboundError("OUTBOUND_STATUS_TRANSITION_INVALID", { from: current, to: next });
  }

  const now = normalizeString(updates.updatedAt) || new Date().toISOString();
  const attemptCount =
    updates.attemptCount === undefined
      ? Number(status.attemptCount || 0)
      : Number(updates.attemptCount);
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    return outboundError("ATTEMPT_COUNT_INVALID");
  }

  const terminal = TERMINAL_STATUSES.has(next);
  const retryEligible = next === OUTBOUND_STATUSES.RETRYABLE_FAILED;

  return {
    ok: true,
    status: {
      ...status,
      status: next,
      attemptCount,
      nextAttemptAt: retryEligible ? normalizeString(updates.nextAttemptAt) || null : null,
      terminal,
      retryEligible,
      failureCode: normalizeString(updates.failureCode) || null,
      providerMessageId: normalizeString(updates.providerMessageId) || status.providerMessageId || null,
      updatedAt: now,
    },
  };
}

function toPublicMetaMessengerOutboundStatus(status = {}) {
  return {
    provider: normalizeToken(status.provider) || PROVIDER,
    channel: normalizeToken(status.channel) || CHANNEL,
    providerAccountIdMasked: maskIdentifier(status.providerAccountId),
    recipientIdMasked: maskIdentifier(status.recipientId),
    externalInboundMessageIdMasked: maskIdentifier(status.externalInboundMessageId),
    providerMessageIdMasked: maskIdentifier(status.providerMessageId),
    idempotencyKeyFingerprint: fingerprintIdentifier(status.idempotencyKey),
    outboundType: normalizeToken(status.outboundType),
    status: normalizeToken(status.status),
    attemptCount: Number(status.attemptCount || 0),
    nextAttemptAt: status.nextAttemptAt || null,
    terminal: Boolean(status.terminal),
    retryEligible: Boolean(status.retryEligible),
    failureCode: status.failureCode || null,
    createdAt: status.createdAt || null,
    updatedAt: status.updatedAt || null,
  };
}

module.exports = {
  CHANNEL,
  OUTBOUND_STATUSES,
  PROVIDER,
  buildMetaMessengerOutboundIdempotencyKey,
  buildMetaMessengerRewardOutboundIntent,
  createMetaMessengerOutboundStatus,
  maskMetaMessengerOutboundIdentifier: maskIdentifier,
  selectRewardLinkDeliverable,
  toPublicMetaMessengerOutboundStatus,
  transitionMetaMessengerOutboundStatus,
  validateMetaMessengerOutboundIntent,
};
