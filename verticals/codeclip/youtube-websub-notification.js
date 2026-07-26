const crypto = require("node:crypto");

const {
  parseCodeClipYouTubeWebSubAtomFeed,
  CodeClipYouTubeWebSubFeedError,
  YOUTUBE_WEBSUB_MAX_ENTRIES,
} = require("./youtube-websub-feed");
const {
  SUBSCRIPTION_STATUSES,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  recordCodeClipYouTubeWebSubFirstActivatedVideo,
} = require("./youtube-websub-subscriptions");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
  CodeClipYouTubeWebSubSecretError,
} = require("./youtube-websub-secret");
const {
  verifyCodeClipProviderWebhook,
} = require("./provider-webhook-verification");
const {
  findActiveCodeClipProviderAccountBinding,
} = require("./provider-account-bindings");
const {
  eventMatchesBoundProviderEventActivation,
} = require("./provider-activation");
const codeClipService = require("./service");
const database = require("../../db");

const YOUTUBE_WEBSUB_MAX_BODY_BYTES = 256 * 1024;
const YOUTUBE_WEBSUB_ALLOWED_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/xml",
  "text/xml",
]);

function notificationResult(httpStatus, payload) {
  return { httpStatus, payload };
}

function publicError(httpStatus, code, message = "YouTube WebSub notification rejected") {
  return notificationResult(httpStatus, {
    ok: false,
    error: message,
    code,
  });
}

function accepted(payload = {}) {
  return notificationResult(202, {
    ok: true,
    accepted: true,
    ...payload,
  });
}

function headerValue(headers = {}, name) {
  const expected = String(name || "").trim().toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || "").trim().toLowerCase() === expected) {
      return String(value || "").trim();
    }
  }
  return "";
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function isSupportedYouTubeWebSubContentType(value) {
  return YOUTUBE_WEBSUB_ALLOWED_CONTENT_TYPES.has(normalizeContentType(value));
}

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  return Buffer.alloc(0);
}

function buildCodeClipYouTubeWebSubPayloadFingerprint(rawBody) {
  return crypto.createHash("sha256").update(rawBodyBuffer(rawBody)).digest("hex");
}

function isCodeClipYouTubeSubscriptionScope(subscription) {
  return (
    String(subscription?.vertical || "").trim().toLowerCase() === "codeclip" &&
    String(subscription?.provider || "").trim().toLowerCase() === "youtube" &&
    String(subscription?.channel || "").trim().toLowerCase() === "youtube"
  );
}

function isSubscriptionLeaseValid(subscription, now) {
  if (!subscription?.leaseExpiresAt) return true;
  const leaseExpiresAt = Date.parse(subscription.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now.getTime();
}

function canonicalUrl(value) {
  try {
    return new URL(String(value || "")).toString();
  } catch {
    return "";
  }
}

function emitCodeClipYouTubeWebSubNotificationSignal(level, signal = {}) {
  const log = level === "warn" ? console.warn : console.log;
  log("codeClip YouTube WebSub notification signal", {
    vertical: "codeclip",
    provider: "youtube",
    route: "/api/codeclip/providers/youtube/websub/:callbackId",
    operationalEvent: signal.operationalEvent,
    eventCode: signal.eventCode || null,
    deliveryId: signal.deliveryId || null,
    reason: signal.reason,
  });
}

function classifyFeedError(error) {
  if (!(error instanceof CodeClipYouTubeWebSubFeedError)) {
    return { status: 400, code: "invalid_atom_feed" };
  }

  if (error.code === "EMPTY_BODY") return { status: 400, code: "empty_body" };
  if (error.code === "MALFORMED_XML") return { status: 400, code: "malformed_xml" };
  if (error.code === "TOO_MANY_ENTRIES") return { status: 400, code: "too_many_entries" };
  if (error.code === "INVALID_ATOM_ENTRY") return { status: 400, code: "invalid_entry" };
  return { status: 400, code: "invalid_atom_feed" };
}

function buildEntryDeliveryIdentity({ subscription, binding, entry }) {
  return {
    provider: "youtube",
    providerAccountId: subscription.providerAccountId,
    eventCode: binding.eventCode,
    externalMessageId: entry.externalMessageId,
  };
}

function buildEntryIdempotencyKey({ binding, entry }) {
  return `codeclip:provider:youtube:websub:${binding.eventCode}:${entry.activationIdentity}`;
}

function isHistoricalEntry(subscription, entry) {
  if (!subscription?.activationBoundaryAt) return false;
  const boundary = Date.parse(subscription.activationBoundaryAt);
  const published = Date.parse(entry.publishedAt);
  if (!Number.isFinite(boundary) || !Number.isFinite(published)) return true;
  return published <= boundary;
}

function providerEventRequiresRecipient(event = {}) {
  const rewardMode = String(
    event?.providerEventRewardMode ||
    event?.metadata?.providerEventRewardMode ||
    event?.config?.providerEventRewardMode ||
    ""
  ).trim().toLowerCase();

  return [
    "audience_reward",
    "individual_reward",
    "participant_reward",
  ].includes(rewardMode);
}

async function markDeliveryState({
  identity,
  updates,
  queryClient,
  updateCodeClipProviderDeliveryState = database.updateCodeClipProviderDeliveryState,
}) {
  const result = await updateCodeClipProviderDeliveryState(identity, updates, queryClient);
  return result?.status === "updated" && result.row;
}

async function processEntry({
  subscription,
  binding,
  event,
  entry,
  now,
  rawBody,
  queryClient,
  dependencies = {},
}) {
  const {
    createCodeClipProviderDelivery = database.createCodeClipProviderDelivery,
    getCodeClipProviderDeliveryByIdentity = database.getCodeClipProviderDeliveryByIdentity,
    updateCodeClipProviderDeliveryState = database.updateCodeClipProviderDeliveryState,
    recordFirstActivatedVideo = recordCodeClipYouTubeWebSubFirstActivatedVideo,
    createProviderEventInteraction = codeClipService.createProviderEventInteraction,
    persistCodeClipCoreInteraction = codeClipService.persistCodeClipCoreInteraction,
    saveCodeClipInteraction = database.saveCodeClipInteraction,
    saveCodeClipRewardAssignments = database.saveCodeClipRewardAssignments,
    saveCodeClipXtraRedemption = database.saveCodeClipXtraRedemption,
    runCodeClipCorePersistenceTransaction = database.withCodeClipCorePersistenceTransaction,
  } = dependencies;

  if (entry.channelId !== subscription.providerAccountId) {
    return { status: "rejected", code: "subscription_scope_mismatch" };
  }

  const identity = buildEntryDeliveryIdentity({ subscription, binding, entry });
  const idempotencyKey = buildEntryIdempotencyKey({ binding, entry });
  const delivery = await createCodeClipProviderDelivery(
    {
      ...identity,
      eventId: event?.id || null,
      idempotencyKey,
      payloadFingerprint: buildCodeClipYouTubeWebSubPayloadFingerprint(rawBody),
      verificationState: "verified",
      processingState: "processing",
      corePersistenceState: "not_started",
      completionState: "not_completed",
      receivedAt: now.toISOString(),
    },
    queryClient
  );

  if (delivery.status === "existing") {
    return { status: "duplicate", code: "duplicate_entry" };
  }

  if (delivery.status !== "created") {
    return { status: "failed", code: "persistence_failed" };
  }

  const finish = async (code, publicCode, corePersistenceState = "skipped") => {
    const updated = await markDeliveryState({
      identity,
      queryClient,
      updateCodeClipProviderDeliveryState,
      updates: {
        processingState: "completed",
        corePersistenceState,
        completionState: "completed",
        responseStatus: 202,
        publicResponseJson: {
          ok: true,
          accepted: true,
          status: publicCode,
        },
        errorClass: null,
        retryEligible: false,
        terminalState: true,
        completedAt: now.toISOString(),
        lastAttemptAt: now.toISOString(),
      },
    });
    return updated
      ? { status: "completed", code }
      : { status: "failed", code: "persistence_failed" };
  };

  if (isHistoricalEntry(subscription, entry)) {
    return finish("historical_entry", "non_activating_historical");
  }

  const rawEvent = event?.raw_event || event;
  const providerEventAllowed = eventMatchesBoundProviderEventActivation(rawEvent, {
    provider: "youtube",
    channel: "youtube",
    activationEvent: entry.eventType,
  });

  if (!providerEventAllowed) {
    return finish("provider_event_not_configured", "non_activating");
  }

  if (providerEventRequiresRecipient(event)) {
    return finish("provider_event_recipient_required", "provider_event_recipient_required");
  }

  const activation = await recordFirstActivatedVideo(
    subscription.callbackId,
    {
      videoId: entry.videoId,
      activatedAt: now.toISOString(),
      queryClient,
    },
  );
  if (!activation) {
    return { status: "failed", code: "persistence_failed" };
  }

  const interaction = createProviderEventInteraction({
    event,
    eventCode: binding.eventCode,
    eventId: event?.id || null,
    providerEvent: {
      provider: "youtube",
      channel: "youtube",
      activationEvent: entry.eventType,
      providerEventId: entry.activationIdentity,
      videoId: entry.videoId,
      externalMessageId: entry.externalMessageId,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
      title: entry.title,
      canonicalUrl: entry.alternateUrl,
    },
    occurredAt: entry.publishedAt,
  });
  await persistCodeClipCoreInteraction({
    interaction,
    saveCodeClipInteraction,
    saveCodeClipRewardAssignments,
    saveCodeClipXtraRedemption,
    runCodeClipCorePersistenceTransaction,
    logPrefix: "codeClip YouTube provider-event",
  });
  interaction.persistenceDecision = codeClipService.buildPersistenceDecision(
    interaction.persistenceStatus
  );
  interaction.persistenceGuaranteePolicy = codeClipService.applyPersistenceGuaranteePolicy(
    interaction.persistenceDecision
  );
  interaction.persistenceAction = codeClipService.buildPersistenceAction(
    interaction.persistenceGuaranteePolicy
  );

  if (!interaction.persistenceDecision.ok) {
    await markDeliveryState({
      identity,
      queryClient,
      updateCodeClipProviderDeliveryState,
      updates: {
        processingState: "failed",
        corePersistenceState: "failed",
        completionState: "not_completed",
        responseStatus: 503,
        publicResponseJson: {
          ok: false,
          error: "YouTube WebSub notification unavailable",
          code: "persistence_failed",
        },
        errorClass: "persistence_failed",
        retryEligible: true,
        terminalState: false,
        lastAttemptAt: now.toISOString(),
      },
    });
    return { status: "failed", code: "persistence_failed" };
  }

  return finish("runtime_completed", "processed", "committed");
}

async function processCodeClipYouTubeWebSubNotification(input = {}, options = {}) {
  const queryClient = options.queryClient;
  if (!queryClient || typeof queryClient.query !== "function") {
    return publicError(503, "persistence_failed", "YouTube WebSub notification unavailable");
  }

  const headers = input.headers || {};
  const rawBody = rawBodyBuffer(input.rawBody);
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());

  if (!isSupportedYouTubeWebSubContentType(headerValue(headers, "content-type"))) {
    return publicError(415, "invalid_content_type");
  }
  if (!rawBody.length) return publicError(400, "empty_body");
  if (rawBody.length > YOUTUBE_WEBSUB_MAX_BODY_BYTES) {
    return publicError(413, "body_too_large");
  }

  let subscription;
  try {
    subscription = await (
      options.getSubscriptionByCallbackId || getCodeClipYouTubeWebSubSubscriptionByCallbackId
    )(input.callbackId, { queryClient });
  } catch {
    return publicError(503, "persistence_failed", "YouTube WebSub notification unavailable");
  }

  if (!subscription) return publicError(404, "unknown_subscription");
  if (!isCodeClipYouTubeSubscriptionScope(subscription)) {
    return publicError(400, "subscription_scope_mismatch");
  }
  if (subscription.status !== SUBSCRIPTION_STATUSES.ACTIVE) {
    const code = subscription.status === SUBSCRIPTION_STATUSES.DISABLED
      ? "inactive_subscription"
      : "unverified_subscription";
    return publicError(409, code);
  }
  if (!isSubscriptionLeaseValid(subscription, now)) {
    return publicError(410, "expired_subscription");
  }

  let derivedSecret;
  try {
    derivedSecret = deriveCodeClipYouTubeWebSubSubscriptionSecret({
      rootSecret: options.env?.CODECLIP_YOUTUBE_WEBSUB_SECRET || process.env.CODECLIP_YOUTUBE_WEBSUB_SECRET,
      secretVersion: subscription.secretVersion,
      callbackId: subscription.callbackId,
      providerAccountId: subscription.providerAccountId,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubSecretError) {
      return publicError(
        503,
        "authentication_unavailable",
        "YouTube WebSub notification unavailable"
      );
    }
    throw error;
  }

  const verification = verifyCodeClipProviderWebhook({
    provider: "youtube",
    headers,
    rawBody,
    secret: derivedSecret,
    mode: "websub-hmac",
  });
  if (!verification.ok) {
    const code = verification.reason === "SIGNATURE_REQUIRED"
      ? "signature_missing"
      : "signature_invalid";
    return publicError(401, code);
  }

  let feed;
  try {
    feed = parseCodeClipYouTubeWebSubAtomFeed(rawBody, {
      maxEntries: options.maxEntries || YOUTUBE_WEBSUB_MAX_ENTRIES,
    });
  } catch (error) {
    const classification = classifyFeedError(error);
    return publicError(classification.status, classification.code);
  }

  if (canonicalUrl(feed.topic) !== canonicalUrl(subscription.topic)) {
    return publicError(400, "subscription_scope_mismatch");
  }
  if (feed.channelId !== subscription.providerAccountId) {
    return publicError(400, "subscription_scope_mismatch");
  }
  if (!feed.entries.length) {
    return accepted({ status: "no_entries", processed: 0 });
  }

  let binding;
  try {
    binding = await (
      options.findActiveBinding || findActiveCodeClipProviderAccountBinding
    )(
      {
        provider: "youtube",
        providerAccountId: subscription.providerAccountId,
      },
      { queryClient }
    );
  } catch {
    return publicError(503, "persistence_failed", "YouTube WebSub notification unavailable");
  }

  if (!binding) return publicError(404, "unknown_subscription");

  let campaign;
  try {
    campaign = await (options.getEventByCode || database.getCampaignByCode)(binding.eventCode);
  } catch {
    return publicError(503, "persistence_failed", "YouTube WebSub notification unavailable");
  }
  const event = campaign?.raw_event || campaign;
  if (!event || String(event.vertical || "").trim().toLowerCase() !== "codeclip") {
    return publicError(404, "unknown_subscription");
  }

  const results = [];
  for (const entry of feed.entries) {
    const result = await processEntry({
      subscription,
      binding,
      event,
      entry,
      now,
      rawBody,
      queryClient,
      dependencies: options,
    });
    results.push(result);
    emitCodeClipYouTubeWebSubNotificationSignal(
      result.status === "failed" || result.status === "rejected" ? "warn" : "info",
      {
        operationalEvent: result.code,
        eventCode: binding.eventCode,
      }
    );
  }

  if (results.some((result) => result.status === "failed")) {
    return publicError(503, "persistence_failed", "YouTube WebSub notification unavailable");
  }
  if (results.some((result) => result.status === "rejected")) {
    return publicError(400, "invalid_entry");
  }

  const counts = results.reduce((summary, result) => {
    summary[result.code] = (summary[result.code] || 0) + 1;
    return summary;
  }, {});

  return accepted({
    status: "processed",
    processed: results.length,
    duplicate: counts.duplicate_entry || 0,
  });
}

module.exports = {
  YOUTUBE_WEBSUB_ALLOWED_CONTENT_TYPES,
  YOUTUBE_WEBSUB_MAX_BODY_BYTES,
  buildEntryDeliveryIdentity,
  buildCodeClipYouTubeWebSubPayloadFingerprint,
  isSupportedYouTubeWebSubContentType,
  processEntry,
  processCodeClipYouTubeWebSubNotification,
};
