const crypto = require("node:crypto");

const {
  findActiveCodeClipProviderAccountBinding,
  normalizeCodeClipProviderAccountId,
} = require("./provider-account-bindings");
const {
  eventMatchesBoundProviderEventActivation,
} = require("./provider-activation");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
  CodeClipYouTubeWebSubSecretError,
} = require("./youtube-websub-secret");
const {
  PENDING_MODES,
  SUBSCRIPTION_STATUSES,
  createPendingCodeClipYouTubeWebSubSubscription,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  getCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  listCodeClipYouTubeWebSubSubscriptions,
  markCodeClipYouTubeWebSubSubscriptionRenewalPending,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribePending,
  normalizeCallbackId,
  recordCodeClipYouTubeWebSubSubscriptionAudit,
  toInternalCodeClipYouTubeWebSubSubscription,
} = require("./youtube-websub-subscriptions");
const {
  requestSubscription,
} = require("./youtube-websub-hub-client");
const database = require("../../db");

const DEFAULT_LEASE_SECONDS = 60 * 60 * 24 * 10;
const MAX_LEASE_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_SECRET_VERSION = "v1";
const RENEWAL_WARNING_SECONDS = 60 * 60 * 24 * 3;

class CodeClipYouTubeWebSubOperationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubOperationError";
    this.code = code;
    this.details = details;
  }
}

function operationError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubOperationError(code, message, details);
}

function normalizeRequiredString(value, fieldName, maxLength = 160) {
  if (typeof value !== "string") {
    throw operationError("validation_error", `${fieldName} is required`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw operationError("validation_error", `${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeEventCode(value) {
  return normalizeRequiredString(value, "eventCode", 120);
}

function normalizeProviderAccountId(value) {
  try {
    return normalizeCodeClipProviderAccountId("youtube", value);
  } catch {
    throw operationError("validation_error", "providerAccountId is invalid", {
      fieldName: "providerAccountId",
    });
  }
}

function normalizeLeaseSeconds(value = DEFAULT_LEASE_SECONDS) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw operationError("validation_error", "leaseSeconds is invalid", {
      fieldName: "leaseSeconds",
    });
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LEASE_SECONDS) {
    throw operationError("validation_error", "leaseSeconds is invalid", {
      fieldName: "leaseSeconds",
      max: MAX_LEASE_SECONDS,
    });
  }
  return parsed;
}

function normalizeRootSecret(env = process.env) {
  const secret = env.CODECLIP_YOUTUBE_WEBSUB_SECRET;
  if (typeof secret !== "string" || !secret.trim()) {
    throw operationError(
      "authentication_unavailable",
      "YouTube WebSub root secret is not configured"
    );
  }
  return secret.trim();
}

function normalizePublicBaseUrl(env = process.env) {
  const value = env.CODECLIP_PUBLIC_BASE_URL;
  if (typeof value !== "string" || !value.trim()) {
    throw operationError(
      "public_base_url_unavailable",
      "codeClip public base URL is not configured"
    );
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw operationError(
      "public_base_url_unavailable",
      "codeClip public base URL is invalid"
    );
  }
  if (parsed.protocol !== "https:") {
    throw operationError(
      "public_base_url_unavailable",
      "codeClip public base URL must be HTTPS"
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function buildCallbackId() {
  return `yt_${crypto.randomBytes(18).toString("base64url")}`;
}

function buildTopic(providerAccountId) {
  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", providerAccountId);
  return url.toString();
}

function buildCallbackUrl(publicBaseUrl, callbackId) {
  return `${publicBaseUrl}/api/codeclip/providers/youtube/websub/${callbackId}`;
}

function isActiveCodeClipEpisode(event) {
  const rawEvent = event?.raw_event || event;
  return (
    rawEvent &&
    String(rawEvent.vertical || "").trim().toLowerCase() === "codeclip" &&
    eventMatchesBoundProviderEventActivation(rawEvent, {
      provider: "youtube",
      channel: "youtube",
      activationEvent: "published_video",
    })
  );
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getPublicLastOperation(mapped, metadata = {}) {
  const dispatch = metadata?.dispatch;
  if (dispatch && typeof dispatch === "object") {
    return {
      mode: dispatch.mode || mapped.pendingMode || null,
      status: dispatch.status || null,
      resultCode: dispatch.resultCode || null,
      hubHttpStatus: dispatch.hubHttpStatus || null,
      retryEligible: dispatch.retryEligible === true,
      attemptNumber: Number.isSafeInteger(dispatch.attemptNumber) ? dispatch.attemptNumber : null,
      startedAt: dispatch.startedAt || null,
      completedAt: dispatch.completedAt || null,
    };
  }
  const operation = metadata?.operation;
  if (!operation) return null;
  return {
    mode: operation,
    status: mapped.status,
    resultCode: null,
    hubHttpStatus: null,
    retryEligible: false,
    attemptNumber: null,
    startedAt: null,
    completedAt: mapped.updatedAt || null,
  };
}

function classifyOperatorSubscriptionStatus(mapped, now = new Date()) {
  if (!mapped) return "not_configured";
  const status = String(mapped.status || "").trim().toLowerCase();
  const expiresAt = parseTimestamp(mapped.leaseExpiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (status === SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE) return "pending_activation";
  if (status === SUBSCRIPTION_STATUSES.PENDING_RENEWAL) return "needs_renewal";
  if (status === SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE) return "disabled";
  if (status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED || status === SUBSCRIPTION_STATUSES.DISABLED) {
    return "disabled";
  }
  if (status === SUBSCRIPTION_STATUSES.EXPIRED) return "expired";
  if (status === SUBSCRIPTION_STATUSES.ACTIVE) {
    if (Number.isFinite(expiresAt) && Number.isFinite(nowMs)) {
      if (expiresAt <= nowMs) return "expired";
      if ((expiresAt - nowMs) / 1000 <= RENEWAL_WARNING_SECONDS) return "needs_renewal";
    }
    return "active";
  }
  return "error";
}

function getRecommendedSubscriptionAction(operatorStatus) {
  if (operatorStatus === "pending_activation") return "wait_for_activation";
  if (operatorStatus === "needs_renewal" || operatorStatus === "expired") return "renew";
  if (operatorStatus === "error") return "review_error";
  return null;
}

function toPublicSubscriptionStatus(subscription = null, options = {}) {
  const mapped = toInternalCodeClipYouTubeWebSubSubscription(subscription);
  if (!mapped) return null;
  const now = options.now || new Date();
  const metadata = mapped.metadata || subscription?.metadata || {};
  const leaseSeconds =
    mapped.leaseStartedAt && mapped.leaseExpiresAt
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(mapped.leaseExpiresAt) - Date.parse(mapped.leaseStartedAt)) / 1000
          )
        )
      : null;
  const leaseExpiresAtMs = parseTimestamp(mapped.leaseExpiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const expiresInSeconds =
    Number.isFinite(leaseExpiresAtMs) && Number.isFinite(nowMs)
      ? Math.max(0, Math.floor((leaseExpiresAtMs - nowMs) / 1000))
      : null;
  const operatorStatus = classifyOperatorSubscriptionStatus(mapped, now);
  return {
    callbackId: mapped.callbackId,
    provider: mapped.provider,
    providerAccountId: mapped.providerAccountId,
    topic: mapped.topic,
    status: mapped.status,
    operatorStatus,
    recommendedAction: getRecommendedSubscriptionAction(operatorStatus),
    pendingMode: mapped.pendingMode,
    requestedLeaseSeconds: metadata?.requestedLeaseSeconds || null,
    leaseSeconds,
    expiresInSeconds,
    leaseExpiresAt: mapped.leaseExpiresAt,
    activationBoundaryAt: mapped.activationBoundaryAt,
    firstActivatedVideoId: mapped.firstActivatedVideoId,
    lastOperation: getPublicLastOperation(mapped, metadata),
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
  };
}

function deriveSubscriptionSecret({ rootSecret, subscription }) {
  try {
    return deriveCodeClipYouTubeWebSubSubscriptionSecret({
      rootSecret,
      secretVersion: subscription.secretVersion,
      callbackId: subscription.callbackId,
      providerAccountId: subscription.providerAccountId,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubSecretError) {
      throw operationError("authentication_unavailable", "YouTube WebSub secret unavailable");
    }
    throw error;
  }
}

function assertQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw operationError("persistence_failed", "YouTube WebSub persistence unavailable");
  }
  return queryClient;
}

function isOpenSubscriptionStatus(status) {
  return [
    SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
    SUBSCRIPTION_STATUSES.ACTIVE,
    SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
    SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
  ].includes(status);
}

function isOpenSubscriptionUniqueConflict(error) {
  return (
    error?.code === "23505" &&
    error?.constraint === "codeclip_youtube_websub_subscriptions_open_account_uidx"
  );
}

async function runLocalSubscriptionTransaction(options, queryClient, work) {
  if (typeof options.runTransaction === "function") {
    return options.runTransaction(work, queryClient);
  }
  return database.withCodeClipCorePersistenceTransaction(work, queryClient);
}

async function findOpenSubscriptionByProviderAccountId(providerAccountId, options = {}) {
  const lookup = options.getOpenSubscriptionByProviderAccountId ||
    getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId;
  const subscription = await lookup(providerAccountId, { queryClient: options.queryClient });
  return subscription && isOpenSubscriptionStatus(subscription.status) ? subscription : null;
}

async function recordSubscriptionAudit(input, options = {}) {
  const recordAudit = options.recordAudit || recordCodeClipYouTubeWebSubSubscriptionAudit;
  return recordAudit(input, { queryClient: options.queryClient });
}

async function auditHubResult({
  subscription,
  eventCode,
  mode,
  hubResult,
  queryClient,
  recordAudit,
}) {
  try {
    await recordSubscriptionAudit(
      {
        callbackId: subscription.callbackId,
        providerAccountId: subscription.providerAccountId,
        eventCode,
        action: hubResult.ok ? "hub_request_accepted" : "hub_request_failed",
        mode,
        resultCode: hubResult.code,
        hubHttpStatus: hubResult.status || null,
        retryable: !hubResult.ok,
        metadata: {
          operationSource: "operator_key",
          resultingStatus: subscription.status,
        },
      },
      { queryClient, recordAudit }
    );
  } catch (error) {
    console.warn("codeClip YouTube WebSub subscription audit failed", {
      vertical: "codeclip",
      provider: "youtube",
      operation: mode,
      auditAction: hubResult.ok ? "hub_request_accepted" : "hub_request_failed",
      error: error?.name || "Error",
    });
  }
}

async function resolveEligibleBindingAndEpisode({
  eventCode,
  providerAccountId,
  queryClient,
  getEventByCode = database.getCampaignByCode,
  findActiveBinding = findActiveCodeClipProviderAccountBinding,
}) {
  const event = await getEventByCode(eventCode);
  if (!event || String((event.raw_event || event).vertical || "").trim().toLowerCase() !== "codeclip") {
    throw operationError("episode_not_found", "Episode was not found");
  }
  if (!isActiveCodeClipEpisode(event)) {
    throw operationError("episode_not_eligible", "Episode is not eligible for YouTube WebSub");
  }

  const binding = await findActiveBinding(
    { provider: "youtube", providerAccountId },
    { queryClient }
  );
  if (!binding) {
    throw operationError("binding_not_found", "YouTube provider binding was not found");
  }
  if (binding.eventCode !== eventCode) {
    throw operationError("binding_episode_mismatch", "Binding belongs to a different Episode", {
      bindingEventCode: binding.eventCode,
    });
  }
  return { event, binding };
}

async function createCodeClipYouTubeWebSubSubscriptionOperation(input = {}, options = {}) {
  const env = options.env || process.env;
  const rootSecret = normalizeRootSecret(env);
  const publicBaseUrl = normalizePublicBaseUrl(env);
  const queryClient = assertQueryClient(options.queryClient);
  const eventCode = normalizeEventCode(input.eventCode || input.event_code);
  const providerAccountId = normalizeProviderAccountId(
    input.providerAccountId || input.provider_account_id
  );
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds || input.lease_seconds);

  const { binding } = await resolveEligibleBindingAndEpisode({
    eventCode,
    providerAccountId,
    queryClient,
    getEventByCode: options.getEventByCode,
    findActiveBinding: options.findActiveBinding,
  });

  const existing = await findOpenSubscriptionByProviderAccountId(providerAccountId, {
    queryClient,
    getOpenSubscriptionByProviderAccountId:
      options.getOpenSubscriptionByProviderAccountId || options.getSubscriptionByProviderAccountId,
  });
  if (existing) {
    return {
      ok: true,
      code: "subscription_already_exists",
      status: existing.status,
      subscription: toPublicSubscriptionStatus(existing),
      bindingId: binding.id,
    };
  }

  const callbackId = (options.generateCallbackId || buildCallbackId)();
  const topic = buildTopic(providerAccountId);
  let subscription;
  try {
    subscription = await runLocalSubscriptionTransaction(options, queryClient, async ({ queryClient: txClient }) => {
      const created = await (
        options.createPendingSubscription || createPendingCodeClipYouTubeWebSubSubscription
      )(
        {
          providerAccountId,
          callbackId,
          topic,
          secretVersion: DEFAULT_SECRET_VERSION,
          metadata: {
            requestedBy: "operator_key",
            requestedLeaseSeconds: leaseSeconds,
            operation: "subscribe",
          },
        },
        { queryClient: txClient }
      );
      await recordSubscriptionAudit(
        {
          callbackId: created.callbackId,
          providerAccountId,
          eventCode,
          action: "subscription_requested",
          mode: "subscribe",
          resultCode: "subscription_pending",
          retryable: false,
          metadata: {
            requestedLeaseSeconds: leaseSeconds,
            operationSource: "operator_key",
            resultingStatus: created.status,
          },
        },
        { queryClient: txClient, recordAudit: options.recordAudit }
      );
      return created;
    });
  } catch (error) {
    if (!isOpenSubscriptionUniqueConflict(error)) throw error;
    const conflicted = await findOpenSubscriptionByProviderAccountId(providerAccountId, {
      queryClient,
      getOpenSubscriptionByProviderAccountId:
        options.getOpenSubscriptionByProviderAccountId || options.getSubscriptionByProviderAccountId,
    });
    if (!conflicted) throw error;
    return {
      ok: true,
      code: "subscription_already_exists",
      status: conflicted.status,
      subscription: toPublicSubscriptionStatus(conflicted),
      bindingId: binding.id,
    };
  }

  const derivedSecret = deriveSubscriptionSecret({ rootSecret, subscription });
  const hubResult = await (options.requestSubscription || requestSubscription)({
    mode: "subscribe",
    callbackUrl: buildCallbackUrl(publicBaseUrl, subscription.callbackId),
    topic,
    secret: derivedSecret,
    leaseSeconds,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  await auditHubResult({
    subscription,
    eventCode,
    mode: "subscribe",
    hubResult,
    queryClient,
    recordAudit: options.recordAudit,
  });

  if (!hubResult.ok) {
    return {
      ok: false,
      code: hubResult.code,
      status: subscription.status,
      retryable: true,
      subscription: toPublicSubscriptionStatus(subscription),
    };
  }

  return {
    ok: true,
    code: "subscription_pending",
    status: subscription.status,
    subscription: toPublicSubscriptionStatus(subscription),
  };
}

async function renewCodeClipYouTubeWebSubSubscriptionOperation(callbackId, input = {}, options = {}) {
  const env = options.env || process.env;
  const rootSecret = normalizeRootSecret(env);
  const publicBaseUrl = normalizePublicBaseUrl(env);
  const queryClient = assertQueryClient(options.queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds || input.lease_seconds);
  const existing = await (
    options.getSubscriptionByCallbackId || getCodeClipYouTubeWebSubSubscriptionByCallbackId
  )(normalizedCallbackId, { queryClient });
  if (!existing) throw operationError("subscription_not_found", "Subscription was not found");
  if (![
    SUBSCRIPTION_STATUSES.ACTIVE,
    SUBSCRIPTION_STATUSES.EXPIRED,
    SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
  ].includes(existing.status)) {
    throw operationError("subscription_state_conflict", "Subscription cannot be renewed");
  }

  const pending = await runLocalSubscriptionTransaction(options, queryClient, async ({ queryClient: txClient }) => {
    const updated = existing.status === SUBSCRIPTION_STATUSES.PENDING_RENEWAL
      ? existing
      : await (options.markRenewalPending || markCodeClipYouTubeWebSubSubscriptionRenewalPending)(
          normalizedCallbackId,
          { queryClient: txClient }
        );
    await recordSubscriptionAudit(
      {
        callbackId: updated.callbackId,
        providerAccountId: updated.providerAccountId,
        action: "renewal_requested",
        mode: "subscribe",
        resultCode: "renewal_pending",
        retryable: false,
        metadata: {
          requestedLeaseSeconds: leaseSeconds,
          operationSource: "operator_key",
          previousStatus: existing.status,
          resultingStatus: updated.status,
        },
      },
      { queryClient: txClient, recordAudit: options.recordAudit }
    );
    return updated;
  });
  const derivedSecret = deriveSubscriptionSecret({ rootSecret, subscription: pending });
  const hubResult = await (options.requestSubscription || requestSubscription)({
    mode: "subscribe",
    callbackUrl: buildCallbackUrl(publicBaseUrl, pending.callbackId),
    topic: pending.topic,
    secret: derivedSecret,
    leaseSeconds,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  await auditHubResult({
    subscription: pending,
    mode: "subscribe",
    hubResult,
    queryClient,
    recordAudit: options.recordAudit,
  });
  if (!hubResult.ok) {
    return {
      ok: false,
      code: hubResult.code,
      status: pending.status,
      retryable: true,
      subscription: toPublicSubscriptionStatus(pending),
    };
  }
  return {
    ok: true,
    code: "renewal_pending",
    status: pending.status,
    subscription: toPublicSubscriptionStatus(pending),
  };
}

async function unsubscribeCodeClipYouTubeWebSubSubscriptionOperation(callbackId, input = {}, options = {}) {
  const env = options.env || process.env;
  const rootSecret = normalizeRootSecret(env);
  const publicBaseUrl = normalizePublicBaseUrl(env);
  const queryClient = assertQueryClient(options.queryClient);
  const normalizedCallbackId = normalizeCallbackId(callbackId);
  const existing = await (
    options.getSubscriptionByCallbackId || getCodeClipYouTubeWebSubSubscriptionByCallbackId
  )(normalizedCallbackId, { queryClient });
  if (!existing) throw operationError("subscription_not_found", "Subscription was not found");
  if (![
    SUBSCRIPTION_STATUSES.ACTIVE,
    SUBSCRIPTION_STATUSES.EXPIRED,
    SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
  ].includes(existing.status)) {
    throw operationError("subscription_state_conflict", "Subscription cannot be unsubscribed");
  }

  const pending = await runLocalSubscriptionTransaction(options, queryClient, async ({ queryClient: txClient }) => {
    const updated = existing.status === SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE
      ? existing
      : await (
          options.markUnsubscribePending || markCodeClipYouTubeWebSubSubscriptionUnsubscribePending
        )(normalizedCallbackId, { queryClient: txClient });
    await recordSubscriptionAudit(
      {
        callbackId: updated.callbackId,
        providerAccountId: updated.providerAccountId,
        action: "unsubscribe_requested",
        mode: "unsubscribe",
        resultCode: "unsubscribe_pending",
        retryable: false,
        metadata: {
          operationSource: "operator_key",
          previousStatus: existing.status,
          resultingStatus: updated.status,
        },
      },
      { queryClient: txClient, recordAudit: options.recordAudit }
    );
    return updated;
  });
  const derivedSecret = deriveSubscriptionSecret({ rootSecret, subscription: pending });
  const hubResult = await (options.requestSubscription || requestSubscription)({
    mode: "unsubscribe",
    callbackUrl: buildCallbackUrl(publicBaseUrl, pending.callbackId),
    topic: pending.topic,
    secret: derivedSecret,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  await auditHubResult({
    subscription: pending,
    mode: "unsubscribe",
    hubResult,
    queryClient,
    recordAudit: options.recordAudit,
  });
  if (!hubResult.ok) {
    return {
      ok: false,
      code: hubResult.code,
      status: pending.status,
      retryable: true,
      subscription: toPublicSubscriptionStatus(pending),
    };
  }
  return {
    ok: true,
    code: "unsubscribe_pending",
    status: pending.status,
    subscription: toPublicSubscriptionStatus(pending),
  };
}

async function listCodeClipYouTubeWebSubSubscriptionStatuses(filters = {}, options = {}) {
  const queryClient = assertQueryClient(options.queryClient);
  const rows = await (options.listSubscriptions || listCodeClipYouTubeWebSubSubscriptions)(
    filters,
    { queryClient }
  );
  return rows.map(toPublicSubscriptionStatus);
}

async function getCodeClipYouTubeWebSubSubscriptionStatus(callbackId, options = {}) {
  const queryClient = assertQueryClient(options.queryClient);
  const subscription = await (
    options.getSubscriptionByCallbackId || getCodeClipYouTubeWebSubSubscriptionByCallbackId
  )(callbackId, { queryClient });
  return toPublicSubscriptionStatus(subscription);
}

module.exports = {
  CodeClipYouTubeWebSubOperationError,
  buildCallbackUrl,
  buildTopic,
  createCodeClipYouTubeWebSubSubscriptionOperation,
  getCodeClipYouTubeWebSubSubscriptionStatus,
  listCodeClipYouTubeWebSubSubscriptionStatuses,
  renewCodeClipYouTubeWebSubSubscriptionOperation,
  toPublicSubscriptionStatus,
  unsubscribeCodeClipYouTubeWebSubSubscriptionOperation,
};
