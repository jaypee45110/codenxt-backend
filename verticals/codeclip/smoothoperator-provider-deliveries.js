const database = require("../../db");

class CodeClipSmoothOperatorProviderDeliveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipSmoothOperatorProviderDeliveryError";
    this.code = code;
    this.details = details;
  }
}

function deliveryError(code, message, details = {}) {
  return new CodeClipSmoothOperatorProviderDeliveryError(code, message, details);
}

function assertQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw deliveryError(
      "delivery_unavailable",
      "SmoothOperator provider delivery read requires a query client"
    );
  }
  return queryClient;
}

function isInvalidDeliveryReadError(error) {
  return error?.code === "CODECLIP_PROVIDER_DELIVERY_INVALID_REQUEST";
}

function maskIdentifier(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
}

function readNullableBoolean(value) {
  if (value === true || value === false) return value;
  return null;
}

function pickPublicResponseSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Explicit public-safe allowlist for stored public responses.
  const summary = {};
  if (typeof value.ok === "boolean") summary.ok = value.ok;
  if (typeof value.accepted === "boolean") summary.accepted = value.accepted;
  if (typeof value.status === "string") summary.status = value.status;
  if (typeof value.code === "string") summary.code = value.code;
  if (typeof value.processing === "string") summary.processing = value.processing;
  if (typeof value.error === "string") summary.error = value.error;
  return Object.keys(summary).length ? summary : null;
}

function readDeliveryField(delivery, camelName, snakeName) {
  if (delivery?.[camelName] !== undefined) return delivery[camelName];
  if (delivery?.[snakeName] !== undefined) return delivery[snakeName];
  return null;
}

function toPublicDeliverySummary(delivery = {}) {
  const category = database.classifyCodeClipProviderDeliveryOperationalState(delivery);
  const terminal = readNullableBoolean(readDeliveryField(delivery, "terminalState", "terminal_state"));
  const retryEligible = readNullableBoolean(readDeliveryField(
    delivery,
    "retryEligible",
    "retry_eligible"
  ));
  return {
    deliveryId: delivery.id,
    provider: delivery.provider,
    channel:
      delivery.channel ??
      delivery.providerChannel ??
      delivery.provider_channel ??
      null,
    providerAccountIdMasked: maskIdentifier(readDeliveryField(
      delivery,
      "providerAccountId",
      "provider_account_id"
    )),
    eventCode: readDeliveryField(delivery, "eventCode", "event_code"),
    externalMessageIdMasked: maskIdentifier(readDeliveryField(
      delivery,
      "externalMessageId",
      "external_message_id"
    )),
    category,
    processingState: readDeliveryField(delivery, "processingState", "processing_state"),
    corePersistenceState: readDeliveryField(
      delivery,
      "corePersistenceState",
      "core_persistence_state"
    ),
    completionState: readDeliveryField(delivery, "completionState", "completion_state"),
    terminal,
    retryEligible,
    responseStatus: readDeliveryField(delivery, "responseStatus", "response_status"),
    resultCode: readDeliveryField(delivery, "resultCode", "result_code"),
    failureCode: readDeliveryField(delivery, "failureCode", "failure_code"),
    createdAt: readDeliveryField(delivery, "createdAt", "created_at"),
    updatedAt: readDeliveryField(delivery, "updatedAt", "updated_at"),
    completedAt: readDeliveryField(delivery, "completedAt", "completed_at"),
  };
}

function toPublicDeliveryDetail(delivery = {}) {
  const summary = toPublicDeliverySummary(delivery);
  return {
    ...summary,
    attempts: readDeliveryField(delivery, "attemptCount", "attempt_count"),
    verificationState: readDeliveryField(delivery, "verificationState", "verification_state"),
    receivedAt: readDeliveryField(delivery, "receivedAt", "received_at"),
    lastAttemptAt: readDeliveryField(delivery, "lastAttemptAt", "last_attempt_at"),
    lifecycle: {
      verification: readDeliveryField(delivery, "verificationState", "verification_state"),
      processing: readDeliveryField(delivery, "processingState", "processing_state"),
      persistence: readDeliveryField(delivery, "corePersistenceState", "core_persistence_state"),
      completion: readDeliveryField(delivery, "completionState", "completion_state"),
      terminal: summary.terminal,
      retryEligible: summary.retryEligible,
    },
    publicResponse: {
      status: readDeliveryField(delivery, "responseStatus", "response_status"),
      summary: pickPublicResponseSummary(readDeliveryField(
        delivery,
        "publicResponseJson",
        "public_response_json"
      )),
    },
  };
}

async function listCodeClipSmoothOperatorProviderDeliveries(filters = {}, options = {}) {
  const queryClient = assertQueryClient(options.queryClient || database.pool);
  const listDeliveries = options.listDeliveries || database.listCodeClipProviderDeliveries;
  let deliveries;
  try {
    deliveries = await listDeliveries(filters, queryClient);
  } catch (error) {
    if (isInvalidDeliveryReadError(error)) {
      throw deliveryError("invalid_filter", "Provider delivery filters are invalid");
    }
    throw error;
  }

  return {
    ok: true,
    vertical: "codeclip",
    surface: "smoothoperator",
    generatedAt: options.generatedAt || new Date().toISOString(),
    filters: {
      provider: filters.provider || null,
      eventCode: filters.eventCode || null,
      category: filters.category || null,
      terminal: filters.terminal ?? null,
      retryEligible: filters.retryEligible ?? null,
    },
    count: deliveries.length,
    items: deliveries.map(toPublicDeliverySummary),
  };
}

async function getCodeClipSmoothOperatorProviderDelivery(deliveryId, options = {}) {
  const queryClient = assertQueryClient(options.queryClient || database.pool);
  const getDelivery = options.getDeliveryById || database.getCodeClipProviderDeliveryById;
  let delivery;
  try {
    delivery = await getDelivery(deliveryId, queryClient);
  } catch (error) {
    if (isInvalidDeliveryReadError(error)) {
      throw deliveryError("invalid_delivery_id", "Provider delivery ID is invalid");
    }
    throw error;
  }
  if (!delivery) {
    throw deliveryError("delivery_not_found", "Provider delivery not found");
  }
  return {
    ok: true,
    vertical: "codeclip",
    surface: "smoothoperator",
    generatedAt: options.generatedAt || new Date().toISOString(),
    delivery: toPublicDeliveryDetail(delivery),
  };
}

module.exports = {
  CodeClipSmoothOperatorProviderDeliveryError,
  getCodeClipSmoothOperatorProviderDelivery,
  listCodeClipSmoothOperatorProviderDeliveries,
  maskIdentifier,
  pickPublicResponseSummary,
  readNullableBoolean,
  toPublicDeliveryDetail,
  toPublicDeliverySummary,
};
