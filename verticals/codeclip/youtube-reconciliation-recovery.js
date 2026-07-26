const crypto = require("node:crypto");

const database = require("../../db");
const {
  normalizeCodeClipProviderAccountId,
  listCodeClipProviderAccountBindings,
} = require("./provider-account-bindings");
const {
  SUBSCRIPTION_STATUSES,
  listCodeClipYouTubeWebSubSubscriptions,
} = require("./youtube-websub-subscriptions");
const {
  eventMatchesBoundProviderEventActivation,
} = require("./provider-activation");
const {
  fetchAtomUploads,
  buildDeliveryIdentity,
} = require("./youtube-reconciliation-scanner");
const {
  processEntry: processCodeClipYouTubeWebSubEntry,
} = require("./youtube-websub-notification");

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 5 * 60;
const YOUTUBE_PROVIDER = "youtube";
const YOUTUBE_CHANNEL = "youtube";
const PUBLISHED_VIDEO_EVENT = "published_video";

const SAFE_MESSAGES = Object.freeze({
  already_delivered: "Candidate already has a completed delivery",
  before_activation_boundary: "Candidate is before the activation boundary",
  binding_not_active: "Provider binding is not active",
  binding_not_found: "Provider binding was not found",
  confirmation_required: "Recovery confirmation token is required",
  event_not_found: "codeClip event was not found",
  execution_completed: "Recovery execution completed",
  execution_failed: "Recovery execution failed",
  explicit_confirmation_required: "Explicit recovery confirmation is required",
  identity_mismatch: "Candidate identity does not match server-calculated identity",
  in_flight: "Candidate already has an in-flight delivery",
  invalid_candidate: "Candidate identity is invalid",
  operator_secret_unavailable: "Recovery confirmation is unavailable",
  revalidation_failed: "Recovery candidate could not be revalidated",
  source_unavailable: "Upload source is unavailable",
  stale_confirmation: "Recovery confirmation is stale or invalid",
  subscription_not_active: "YouTube subscription is not active",
  subscription_not_found: "YouTube subscription was not found",
  subscription_pending: "YouTube subscription is pending",
  subscription_scope_mismatch: "YouTube subscription scope does not match candidate",
  unsupported_event_configuration: "Event is not configured for YouTube published-video activation",
  video_not_found: "Video was not found in the current upload source",
});

class CodeClipYouTubeReconciliationRecoveryError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || "Recovery operation failed", details = {}) {
    super(message);
    this.name = "CodeClipYouTubeReconciliationRecoveryError";
    this.code = normalizeCode(code);
    this.safeMessage = SAFE_MESSAGES[this.code] || message;
    this.details = sanitizeDetails(details);
  }
}

function normalizeCode(code, fallback = "invalid_candidate") {
  const normalized = String(code || fallback).trim().toLowerCase();
  return /^[a-z0-9_:-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function sanitizeDetails(details = {}) {
  const safe = {};
  for (const key of ["fieldName", "reason", "sourceCode"]) {
    const value = String(details[key] || "").trim().toLowerCase();
    if (/^[a-z0-9_:-]{1,80}$/.test(value)) safe[key] = value;
  }
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) {
    safe.httpStatus = details.httpStatus;
  }
  return safe;
}

function failure(status, details = {}) {
  const code = normalizeCode(status);
  return {
    ok: false,
    eligible: false,
    status: code,
    error: {
      code,
      message: SAFE_MESSAGES[code] || "Recovery operation failed",
      details: sanitizeDetails(details),
    },
  };
}

function nowDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function canonicalTopic(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

function canonicalUrl(value) {
  try {
    return new URL(String(value || "")).toString();
  } catch {
    return "";
  }
}

function normalizeVideoId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(normalized)) {
    throw new CodeClipYouTubeReconciliationRecoveryError("invalid_candidate", undefined, {
      fieldName: "videoId",
    });
  }
  return normalized;
}

function normalizeEventCode(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CodeClipYouTubeReconciliationRecoveryError("invalid_candidate", undefined, {
      fieldName: "eventCode",
    });
  }
  return normalized;
}

function normalizeCandidate(input = {}) {
  if (String(input.provider || "").trim().toLowerCase() !== YOUTUBE_PROVIDER) {
    throw new CodeClipYouTubeReconciliationRecoveryError("invalid_candidate", undefined, {
      fieldName: "provider",
    });
  }
  const channelId = normalizeCodeClipProviderAccountId(YOUTUBE_PROVIDER, input.channelId);
  const videoId = normalizeVideoId(input.videoId);
  const eventCode = normalizeEventCode(input.eventCode);
  const externalMessageId = String(input.externalMessageId || "").trim();
  const expectedExternalMessageId = `youtube:${channelId}:${videoId}:published`;
  if (externalMessageId !== expectedExternalMessageId) {
    throw new CodeClipYouTubeReconciliationRecoveryError("identity_mismatch", undefined, {
      fieldName: "externalMessageId",
    });
  }
  return {
    provider: YOUTUBE_PROVIDER,
    channelId,
    providerAccountId: channelId,
    videoId,
    eventCode,
    externalMessageId,
  };
}

function classifyDeliveryForRecovery(delivery) {
  if (!delivery) return "missing";
  const state = database.classifyCodeClipProviderDeliveryOperationalState(delivery);
  if (state === "completed") return "already_delivered";
  if (state === "processing" || delivery.processingState === "processing") return "in_flight";
  return "already_delivered";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot) {
  return crypto.createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

function signPayload(payload, adminSecret) {
  return crypto.createHmac("sha256", adminSecret).update(payload).digest("base64url");
}

function fingerprintValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function requireAdminSecret(adminSecret) {
  const secret = String(adminSecret || "").trim();
  if (!secret) {
    throw new CodeClipYouTubeReconciliationRecoveryError("operator_secret_unavailable");
  }
  return secret;
}

function createRecoveryConfirmationToken(snapshot, {
  adminSecret,
  now = new Date(),
  ttlSeconds = TOKEN_TTL_SECONDS,
} = {}) {
  const secret = requireAdminSecret(adminSecret);
  const issuedAt = nowDate(now);
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
  const payload = {
    v: TOKEN_VERSION,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    snapshotHash: hashSnapshot(snapshot),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${encoded}.${signPayload(encoded, secret)}`,
    expiresAt: payload.expiresAt,
    snapshot,
  };
}

function verifyRecoveryConfirmationToken(token, snapshot, {
  adminSecret,
  now = new Date(),
} = {}) {
  const secret = requireAdminSecret(adminSecret);
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return false;
  const expected = signPayload(encoded, secret);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (payload?.v !== TOKEN_VERSION) return false;
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowDate(now).getTime()) return false;
  return payload.snapshotHash === hashSnapshot(snapshot);
}

function audit(options, action, fields = {}) {
  const event = {
    vertical: "codeclip",
    provider: "youtube",
    operation: "youtube_reconciliation_recovery",
    action,
    eventCode: fields.eventCode || null,
    channelIdFingerprint: fingerprintValue(fields.channelId),
    callbackId: fields.callbackId || null,
    videoId: fields.videoId || null,
    status: fields.status || null,
  };
  if (typeof options.audit === "function") return options.audit(event);
  console.log("codeClip YouTube reconciliation recovery", event);
}

async function revalidateCandidate(input = {}, options = {}) {
  const queryClient = options.queryClient;
  if (!queryClient || typeof queryClient.query !== "function") {
    return failure("source_unavailable");
  }

  let candidate;
  try {
    candidate = normalizeCandidate(input);
  } catch (error) {
    if (error instanceof CodeClipYouTubeReconciliationRecoveryError) {
      return failure(error.code, error.details);
    }
    return failure("invalid_candidate");
  }

  const listBindings = options.listBindings || listCodeClipProviderAccountBindings;
  const listSubscriptions = options.listSubscriptions || listCodeClipYouTubeWebSubSubscriptions;
  const getEventByCode = options.getEventByCode || database.getCampaignByCode;
  const getDeliveryByIdentity = options.getDeliveryByIdentity || database.getCodeClipProviderDeliveryByIdentity;
  const fetchUploads = options.fetchUploads || ((target) => fetchAtomUploads(target, options));

  let bindingResult;
  try {
    bindingResult = await listBindings(
      {
        vertical: "codeclip",
        provider: YOUTUBE_PROVIDER,
        channel: YOUTUBE_CHANNEL,
        eventCode: candidate.eventCode,
        limit: 100,
      },
      { queryClient }
    );
  } catch {
    return { ...failure("revalidation_failed"), candidate };
  }
  const binding = (bindingResult?.items || []).find(
    (item) => item.providerAccountId === candidate.channelId && item.eventCode === candidate.eventCode
  );
  if (!binding) return { ...failure("binding_not_found"), candidate };
  if (binding.status !== "active") return { ...failure("binding_not_active"), candidate };

  let subscriptions;
  try {
    subscriptions = await listSubscriptions(
      { providerAccountId: candidate.channelId },
      { queryClient }
    );
  } catch {
    return { ...failure("revalidation_failed"), candidate };
  }
  const subscription = subscriptions.find(
    (item) => item.providerAccountId === candidate.channelId
  );
  if (!subscription) return { ...failure("subscription_not_found"), candidate };
  if (subscription.status !== SUBSCRIPTION_STATUSES.ACTIVE) {
    return { ...failure("subscription_not_active"), candidate };
  }
  if (subscription.pendingMode !== null) return { ...failure("subscription_pending"), candidate };
  if (
    subscription.provider !== YOUTUBE_PROVIDER ||
    subscription.channel !== YOUTUBE_CHANNEL ||
    canonicalUrl(subscription.topic) !== canonicalUrl(canonicalTopic(candidate.channelId))
  ) {
    return { ...failure("subscription_scope_mismatch"), candidate };
  }

  const boundaryEpoch = Date.parse(subscription.activationBoundaryAt);
  if (!Number.isFinite(boundaryEpoch)) return { ...failure("before_activation_boundary"), candidate };

  let eventRecord;
  try {
    eventRecord = await getEventByCode(candidate.eventCode);
  } catch {
    return { ...failure("revalidation_failed"), candidate };
  }
  const event = eventRecord?.raw_event || eventRecord;
  if (!event || String(event.vertical || "").trim().toLowerCase() !== "codeclip") {
    return { ...failure("event_not_found"), candidate };
  }
  if (!eventMatchesBoundProviderEventActivation(event, {
    provider: YOUTUBE_PROVIDER,
    channel: YOUTUBE_CHANNEL,
    activationEvent: PUBLISHED_VIDEO_EVENT,
  })) {
    return { ...failure("unsupported_event_configuration"), candidate };
  }

  const target = {
    bindingId: binding.id,
    subscriptionId: subscription.id,
    callbackId: subscription.callbackId,
    eventCode: candidate.eventCode,
    provider: YOUTUBE_PROVIDER,
    channel: YOUTUBE_CHANNEL,
    providerAccountId: candidate.channelId,
    channelId: candidate.channelId,
    topic: subscription.topic,
    activationBoundaryAt: new Date(boundaryEpoch).toISOString(),
  };
  let sourceResult;
  try {
    sourceResult = await fetchUploads(target, { now: options.now });
  } catch {
    return { ...failure("source_unavailable"), candidate, target };
  }
  const entry = (sourceResult.uploads || []).find((item) => item.videoId === candidate.videoId);
  if (!entry) return { ...failure("video_not_found"), candidate, target };
  if (entry.channelId !== candidate.channelId || entry.externalMessageId !== candidate.externalMessageId) {
    return { ...failure("identity_mismatch"), candidate, target };
  }
  const publishedEpoch = Date.parse(entry.publishedAt);
  if (!Number.isFinite(publishedEpoch) || publishedEpoch <= boundaryEpoch) {
    return { ...failure("before_activation_boundary"), candidate, target };
  }

  let delivery;
  try {
    delivery = await getDeliveryByIdentity(buildDeliveryIdentity(candidate), queryClient);
  } catch {
    return { ...failure("revalidation_failed"), candidate, target };
  }
  const deliveryStatus = classifyDeliveryForRecovery(delivery);
  const snapshot = {
    provider: YOUTUBE_PROVIDER,
    channelId: candidate.channelId,
    videoId: candidate.videoId,
    eventCode: candidate.eventCode,
    externalMessageId: candidate.externalMessageId,
    bindingId: String(binding.id || ""),
    subscriptionId: String(subscription.id || ""),
    callbackId: subscription.callbackId,
    eventId: String(event.id || ""),
    publishedAt: entry.publishedAt,
    activationBoundaryAt: target.activationBoundaryAt,
  };

  return {
    ok: true,
    candidate,
    target,
    binding,
    subscription,
    event,
    entry,
    delivery,
    deliveryStatus,
    snapshot,
  };
}

function publicCandidate(candidate, snapshot) {
  return {
    provider: YOUTUBE_PROVIDER,
    channelId: candidate.channelId,
    videoId: candidate.videoId,
    eventCode: candidate.eventCode,
    externalMessageId: candidate.externalMessageId,
    publishedAt: snapshot.publishedAt,
    activationBoundaryAt: snapshot.activationBoundaryAt,
  };
}

async function dryRunCodeClipYouTubeReconciliationRecovery(input = {}, options = {}) {
  const validation = await revalidateCandidate(input, options);
  if (!validation.ok) {
    audit(options, "dry_run_rejected", {
      ...validation.candidate,
      status: validation.status,
    });
    return validation;
  }
  if (validation.deliveryStatus !== "missing") {
    audit(options, "dry_run_rejected", {
      ...validation.candidate,
      status: validation.deliveryStatus,
    });
    return {
      ...failure(validation.deliveryStatus),
      candidate: publicCandidate(validation.candidate, validation.snapshot),
    };
  }
  let confirmation;
  try {
    confirmation = createRecoveryConfirmationToken(validation.snapshot, {
      adminSecret: options.adminSecret || process.env.CODECLIP_ADMIN_KEY,
      now: options.now,
      ttlSeconds: options.tokenTtlSeconds,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeReconciliationRecoveryError) return failure(error.code);
    return failure("operator_secret_unavailable");
  }
  audit(options, "dry_run_approved", {
    ...validation.candidate,
    status: "eligible",
  });
  return {
    ok: true,
    mode: "dry_run",
    eligible: true,
    status: "eligible",
    candidate: publicCandidate(validation.candidate, validation.snapshot),
    confirmationToken: confirmation.token,
    confirmationExpiresAt: confirmation.expiresAt,
  };
}

async function executeCodeClipYouTubeReconciliationRecovery(input = {}, options = {}) {
  if (input.confirm !== true) return failure("explicit_confirmation_required");
  if (!input.confirmationToken) return failure("confirmation_required");

  const validation = await revalidateCandidate(input, options);
  if (!validation.ok) return validation;

  let confirmed = false;
  try {
    confirmed = verifyRecoveryConfirmationToken(input.confirmationToken, validation.snapshot, {
      adminSecret: options.adminSecret || process.env.CODECLIP_ADMIN_KEY,
      now: options.now,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeReconciliationRecoveryError) return failure(error.code);
    return failure("operator_secret_unavailable");
  }
  if (!confirmed) {
    audit(options, "execute_failed", {
      ...validation.candidate,
      status: "stale_confirmation",
    });
    return failure("stale_confirmation");
  }

  if (validation.deliveryStatus === "already_delivered") {
    audit(options, "execute_idempotent_replay", {
      ...validation.candidate,
      status: "idempotent_replay",
    });
    return {
      ok: true,
      mode: "execute",
      status: "idempotent_replay",
      candidate: publicCandidate(validation.candidate, validation.snapshot),
    };
  }
  if (validation.deliveryStatus === "in_flight") return failure("in_flight");

  audit(options, "execute_started", {
    ...validation.candidate,
    status: "started",
  });
  const processEntry = options.processEntry || processCodeClipYouTubeWebSubEntry;
  const rawBody = Buffer.from(stableJson({
    source: "operator_reconciliation_recovery",
    snapshotHash: hashSnapshot(validation.snapshot),
  }), "utf8");
  try {
    const result = await processEntry({
      subscription: validation.subscription,
      binding: validation.binding,
      event: validation.event,
      entry: validation.entry,
      now: nowDate(options.now),
      rawBody,
      queryClient: options.queryClient,
      dependencies: { ...options, source: "operator_reconciliation_recovery" },
    });
    if (result.status === "duplicate") {
      audit(options, "execute_idempotent_replay", {
        ...validation.candidate,
        callbackId: validation.subscription.callbackId,
        status: "idempotent_replay",
      });
      return {
        ok: true,
        mode: "execute",
        status: "idempotent_replay",
        candidate: publicCandidate(validation.candidate, validation.snapshot),
      };
    }
    if (result.status === "completed") {
      audit(options, "execute_completed", {
        ...validation.candidate,
        callbackId: validation.subscription.callbackId,
        status: "execution_completed",
      });
      return {
        ok: true,
        mode: "execute",
        status: "execution_completed",
        resultCode: result.code,
        candidate: publicCandidate(validation.candidate, validation.snapshot),
      };
    }
  } catch {
    // Fall through to sanitized execution failure below.
  }
  audit(options, "execute_failed", {
    ...validation.candidate,
    callbackId: validation.subscription.callbackId,
    status: "execution_failed",
  });
  return failure("execution_failed");
}

module.exports = {
  CodeClipYouTubeReconciliationRecoveryError,
  createRecoveryConfirmationToken,
  dryRunCodeClipYouTubeReconciliationRecovery,
  executeCodeClipYouTubeReconciliationRecovery,
  revalidateCandidate,
  verifyRecoveryConfirmationToken,
};
