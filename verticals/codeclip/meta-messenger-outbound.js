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

/** Opaque ownership token key inside last_error_metadata. Never source of truth for lifecycle state. */
const DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY = "attemptId";
const DISPATCH_ATTEMPT_ID_MAX_LENGTH = 128;
const DISPATCH_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DISPATCH_MAX_ATTEMPT_COUNT = 2147483646;
const DISPATCH_MAX_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;
const DISPATCH_DEFAULT_STALE_AFTER_SECONDS = 300;
const NEXT_ATTEMPT_BASE_SECONDS = 30;
const NEXT_ATTEMPT_CAP_SECONDS = 3600;
const NEXT_ATTEMPT_RETRY_AFTER_MIN_SECONDS = 1;
const NEXT_ATTEMPT_RETRY_AFTER_MAX_SECONDS = 3600;

/**
 * Invariant: last_error_metadata.attemptId is an ownership token only.
 * Authoritative dispatch state is status, attempt_count, terminal, retry_eligible,
 * claimed_at, sent_at, failed_at, and last_error_code. Never reconstruct or repair
 * authoritative fields from the ownership token.
 */
const DISPATCH_OWNERSHIP_TOKEN_INVARIANT = Object.freeze({
  sourceOfTruth: false,
  role: "ownership_token_only",
  field: `last_error_metadata.${DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY}`,
  authoritativeFields: Object.freeze([
    "status",
    "attemptCount",
    "terminal",
    "retryEligible",
    "claimedAt",
    "sentAt",
    "failedAt",
    "lastErrorCode",
  ]),
});

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

function normalizeDispatchAttemptId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return outboundError("ATTEMPT_ID_REQUIRED");
  if (normalized.length > DISPATCH_ATTEMPT_ID_MAX_LENGTH) {
    return outboundError("ATTEMPT_ID_INVALID");
  }
  if (!DISPATCH_ATTEMPT_ID_PATTERN.test(normalized)) {
    return outboundError("ATTEMPT_ID_INVALID");
  }
  return { ok: true, attemptId: normalized };
}

function normalizeDispatchAttemptNumber(value) {
  const attemptNumber = Number(value);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    return outboundError("ATTEMPT_NUMBER_INVALID");
  }
  if (attemptNumber > DISPATCH_MAX_ATTEMPT_COUNT + 1) {
    return outboundError("ATTEMPT_NUMBER_OVERFLOW");
  }
  return { ok: true, attemptNumber };
}

function normalizeDispatchStaleAfterSeconds(value = DISPATCH_DEFAULT_STALE_AFTER_SECONDS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > DISPATCH_MAX_STALE_AFTER_SECONDS) {
    return outboundError("STALE_AFTER_SECONDS_INVALID", {
      max: DISPATCH_MAX_STALE_AFTER_SECONDS,
    });
  }
  return { ok: true, staleAfterSeconds: parsed };
}

function normalizeDispatchNow(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, now: new Date(), nowIso: new Date().toISOString() };
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      return outboundError("DISPATCH_NOW_INVALID");
    }
    return { ok: true, now: value, nowIso: value.toISOString() };
  }
  const normalized = normalizeString(value);
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) {
    return outboundError("DISPATCH_NOW_INVALID");
  }
  return { ok: true, now: new Date(parsed), nowIso: new Date(parsed).toISOString() };
}

/**
 * Reads ownership token only. Does not interpret lifecycle state.
 * Callers must use authoritative row fields for status decisions.
 */
function readDispatchOwnershipAttemptId(lastErrorMetadata) {
  if (lastErrorMetadata === undefined || lastErrorMetadata === null) {
    return { ok: true, present: false, attemptId: null };
  }
  if (typeof lastErrorMetadata !== "object" || Array.isArray(lastErrorMetadata)) {
    return outboundError("DISPATCH_OWNERSHIP_METADATA_INVALID");
  }
  if (!Object.prototype.hasOwnProperty.call(lastErrorMetadata, DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY)) {
    return { ok: true, present: false, attemptId: null };
  }
  const raw = lastErrorMetadata[DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY];
  if (raw === undefined || raw === null || raw === "") {
    return outboundError("DISPATCH_OWNERSHIP_METADATA_INVALID");
  }
  if (typeof raw !== "string") {
    return outboundError("DISPATCH_OWNERSHIP_METADATA_INVALID");
  }
  const normalized = normalizeDispatchAttemptId(raw);
  if (!normalized.ok) {
    return outboundError("DISPATCH_OWNERSHIP_METADATA_INVALID", normalized.details || {});
  }
  return { ok: true, present: true, attemptId: normalized.attemptId };
}

function buildDispatchOwnershipMetadata(attemptId) {
  const normalized = normalizeDispatchAttemptId(attemptId);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    metadata: {
      [DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY]: normalized.attemptId,
    },
  };
}

/**
 * Pure, deterministic next-attempt scheduling for retryable Meta Messenger outbound failures.
 * No jitter. Injected `now` only (no hidden wall clock).
 */
function computeCodeClipMetaMessengerNextAttemptAt({
  now,
  attemptNumber,
  retryAfterSeconds,
} = {}) {
  const nowResult = normalizeDispatchNow(now);
  if (!nowResult.ok) {
    return outboundError(nowResult.reason || "DISPATCH_NOW_INVALID");
  }

  const attempt = Number(attemptNumber);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > DISPATCH_MAX_ATTEMPT_COUNT) {
    return outboundError("ATTEMPT_NUMBER_INVALID");
  }

  let normalizedRetryAfter = 0;
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null) {
    const parsed = Number(retryAfterSeconds);
    if (
      !Number.isInteger(parsed) ||
      parsed < NEXT_ATTEMPT_RETRY_AFTER_MIN_SECONDS ||
      parsed > NEXT_ATTEMPT_RETRY_AFTER_MAX_SECONDS
    ) {
      return outboundError("RETRY_AFTER_SECONDS_INVALID");
    }
    normalizedRetryAfter = parsed;
  }

  // Overflow-safe exponential: 30 * 2^(attemptNumber-1), capped at 3600.
  let exponentialDelay = NEXT_ATTEMPT_BASE_SECONDS;
  for (let step = 1; step < attempt; step += 1) {
    if (exponentialDelay >= NEXT_ATTEMPT_CAP_SECONDS) {
      exponentialDelay = NEXT_ATTEMPT_CAP_SECONDS;
      break;
    }
    const doubled = exponentialDelay * 2;
    exponentialDelay =
      doubled >= NEXT_ATTEMPT_CAP_SECONDS ? NEXT_ATTEMPT_CAP_SECONDS : doubled;
  }

  const delaySeconds = Math.max(exponentialDelay, normalizedRetryAfter);
  const nextMs = nowResult.now.getTime() + delaySeconds * 1000;
  if (!Number.isFinite(nextMs)) {
    return outboundError("NEXT_ATTEMPT_AT_OVERFLOW");
  }

  return {
    ok: true,
    nextAttemptAt: new Date(nextMs).toISOString(),
    delaySeconds,
  };
}

module.exports = {
  CHANNEL,
  DISPATCH_ATTEMPT_ID_MAX_LENGTH,
  DISPATCH_DEFAULT_STALE_AFTER_SECONDS,
  DISPATCH_MAX_ATTEMPT_COUNT,
  DISPATCH_MAX_STALE_AFTER_SECONDS,
  DISPATCH_OWNERSHIP_ATTEMPT_ID_KEY,
  DISPATCH_OWNERSHIP_TOKEN_INVARIANT,
  NEXT_ATTEMPT_BASE_SECONDS,
  NEXT_ATTEMPT_CAP_SECONDS,
  OUTBOUND_STATUSES,
  PROVIDER,
  buildDispatchOwnershipMetadata,
  buildMetaMessengerOutboundIdempotencyKey,
  buildMetaMessengerRewardOutboundIntent,
  computeCodeClipMetaMessengerNextAttemptAt,
  createMetaMessengerOutboundStatus,
  maskMetaMessengerOutboundIdentifier: maskIdentifier,
  normalizeDispatchAttemptId,
  normalizeDispatchAttemptNumber,
  normalizeDispatchNow,
  normalizeDispatchStaleAfterSeconds,
  readDispatchOwnershipAttemptId,
  selectRewardLinkDeliverable,
  toPublicMetaMessengerOutboundStatus,
  transitionMetaMessengerOutboundStatus,
  validateMetaMessengerOutboundIntent,
};
