const database = require("../../db");
const {
  CodeClipYouTubeWebSubSubscriptionError,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  listCodeClipYouTubeWebSubSubscriptionAudit,
  normalizeCallbackId,
  toInternalCodeClipYouTubeWebSubSubscription,
} = require("./youtube-websub-subscriptions");

const CODECLIP_VERTICAL = "codeclip";
const YOUTUBE_PROVIDER = "youtube";
const YOUTUBE_CHANNEL = "youtube";

class CodeClipSmoothOperatorYouTubeWebSubAuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipSmoothOperatorYouTubeWebSubAuditError";
    this.code = code;
    this.details = details;
  }
}

function auditError(code, message, details = {}) {
  return new CodeClipSmoothOperatorYouTubeWebSubAuditError(code, message, details);
}

function assertQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw auditError(
      "audit_unavailable",
      "SmoothOperator YouTube WebSub audit requires a query client"
    );
  }
  return queryClient;
}

function normalizeAuditCallbackId(value) {
  try {
    return normalizeCallbackId(value);
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubSubscriptionError) {
      throw auditError("invalid_callback_id", "callbackId is invalid");
    }
    throw error;
  }
}

function maskProviderAccountId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
}

function sanitizeMetadata(metadata = {}) {
  const sanitized = {};
  if (
    Number.isSafeInteger(metadata.requestedLeaseSeconds) &&
    metadata.requestedLeaseSeconds > 0
  ) {
    sanitized.requestedLeaseSeconds = metadata.requestedLeaseSeconds;
  }
  if (metadata.operationSource === "operator_key") {
    sanitized.operationSource = "operator_key";
  }
  if (typeof metadata.previousStatus === "string") {
    sanitized.previousStatus = metadata.previousStatus;
  }
  if (typeof metadata.resultingStatus === "string") {
    sanitized.resultingStatus = metadata.resultingStatus;
  }
  return sanitized;
}

function mapOperation(action) {
  if (action === "subscription_requested") return "create";
  if (action === "renewal_requested") return "renew";
  if (action === "unsubscribe_requested") return "unsubscribe";
  if (action === "hub_request_accepted") return "verification";
  if (action === "hub_request_failed") return "fail";
  return "unknown";
}

function toPublicAuditEvent(row = {}) {
  const metadata = sanitizeMetadata(row.metadata || {});
  return {
    id: row.id,
    action: row.action,
    operation: mapOperation(row.action),
    mode: row.mode || null,
    eventCode: row.eventCode || null,
    previousStatus: metadata.previousStatus || null,
    newStatus: metadata.resultingStatus || null,
    resultCode: row.resultCode,
    hubHttpStatus: row.hubHttpStatus ?? null,
    retryable: Boolean(row.retryable),
    actorType: metadata.operationSource === "operator_key" ? "operator" : null,
    metadata,
    createdAt: row.createdAt,
  };
}

function toPublicSubscriptionSummary(subscription) {
  const mapped = toInternalCodeClipYouTubeWebSubSubscription(subscription);
  if (!mapped) return null;
  return {
    callbackId: mapped.callbackId,
    provider: mapped.provider,
    channel: mapped.channel,
    providerAccountIdMasked: maskProviderAccountId(mapped.providerAccountId),
    status: mapped.status,
    pendingMode: mapped.pendingMode || null,
    leaseExpiresAt: mapped.leaseExpiresAt || null,
    lastVerifiedAt: mapped.lastVerifiedAt || null,
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
  };
}

async function getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit(
  callbackId,
  options = {}
) {
  const queryClient = assertQueryClient(options.queryClient || database.pool);
  const normalizedCallbackId = normalizeAuditCallbackId(callbackId);
  const getSubscription =
    options.getSubscriptionByCallbackId || getCodeClipYouTubeWebSubSubscriptionByCallbackId;
  const listAudit = options.listAudit || listCodeClipYouTubeWebSubSubscriptionAudit;

  const subscription = await getSubscription(normalizedCallbackId, { queryClient });
  if (!subscription) {
    throw auditError("subscription_not_found", "YouTube WebSub subscription not found");
  }

  const auditRows = await listAudit({ callbackId: normalizedCallbackId }, { queryClient });
  return {
    ok: true,
    vertical: CODECLIP_VERTICAL,
    surface: "smoothoperator",
    provider: YOUTUBE_PROVIDER,
    channel: YOUTUBE_CHANNEL,
    generatedAt: options.generatedAt || new Date().toISOString(),
    subscription: toPublicSubscriptionSummary(subscription),
    audit: {
      count: auditRows.length,
      items: auditRows.map(toPublicAuditEvent),
    },
  };
}

module.exports = {
  CodeClipSmoothOperatorYouTubeWebSubAuditError,
  getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit,
  maskProviderAccountId,
  toPublicAuditEvent,
  toPublicSubscriptionSummary,
};
