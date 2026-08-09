/**
 * codeClip provider poll delivery ingest (F1D2B).
 *
 * Durable ledger ingest under fenced poll-source completion:
 *   fence lock → create deliveries → complete UPDATE (same transaction)
 *
 * Does not call adapters, credentials, HTTP, or core/reward pipeline.
 * Checkpoint advances only after every required delivery is created|existing.
 */

const database = require("../../../db");
const {
  CodeClipProviderPollSourceError,
  completeCodeClipProviderPollSourceClaim,
} = require("../provider-poll-sources");
const {
  buildCodeClipProviderPollingExternalMessageId,
} = require("./adapter-contract");
const {
  CodeClipProviderPollingDetectionMetadataError,
  buildCodeClipProviderPollingDetectionMetadata,
} = require("./detection-metadata");

class CodeClipProviderPollingIngestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingIngestError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function ingestError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "status"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderPollingIngestError(code, message, safe);
}

function mapPollSourceError(error) {
  if (error instanceof CodeClipProviderPollSourceError) {
    throw ingestError(error.code, error.message, error.details || {});
  }
  throw error;
}

function mapDetectionMetadataError(error) {
  if (error instanceof CodeClipProviderPollingDetectionMetadataError) {
    throw ingestError(error.code, error.message, error.details || {});
  }
  throw error;
}

/**
 * Persist detections to the delivery ledger and complete the poll claim.
 *
 * @param {object} args
 * @param {string|number} args.pollSourceId
 * @param {string} args.owner
 * @param {number|string} args.expectedVersion
 * @param {object} args.checkpoint
 * @param {string} [args.nextPollAt]
 * @param {Array<object>} args.detections - normalized detections with deliverySource
 * @param {Array<object>} args.bindings - active bindings (0..N, schema currently 0..1)
 * @param {string} args.provider
 * @param {string} args.providerAccountId
 * @param {object} [args.observability] - consecutiveFailures, lastErrorCode, etc.
 * @param {string|Date} [args.now]
 * @param {object} deps
 * @param {object} deps.queryClient
 * @param {Function} [deps.createDelivery]
 * @param {Function} [deps.completeClaim]
 */
async function ingestCodeClipProviderPollDetections(
  {
    pollSourceId,
    owner,
    expectedVersion,
    checkpoint,
    nextPollAt,
    detections = [],
    bindings = [],
    provider,
    providerAccountId,
    observability = {},
    now,
  } = {},
  {
    queryClient,
    createDelivery = database.createCodeClipProviderDelivery,
    completeClaim = completeCodeClipProviderPollSourceClaim,
  } = {}
) {
  if (!queryClient) {
    throw ingestError(
      "DATABASE_UNAVAILABLE",
      "delivery ingest requires an explicit query client"
    );
  }
  if (typeof createDelivery !== "function") {
    throw ingestError("DATABASE_UNAVAILABLE", "createDelivery is required");
  }
  if (!Array.isArray(detections)) {
    throw ingestError("INVALID_INGEST_INPUT", "detections must be an array", {
      fieldName: "detections",
    });
  }
  if (!Array.isArray(bindings)) {
    throw ingestError("INVALID_INGEST_INPUT", "bindings must be an array", {
      fieldName: "bindings",
    });
  }

  const deliveryIds = [];
  let createdCount = 0;
  let existingCount = 0;

  const required = [];
  for (const detection of detections) {
    if (!detection || typeof detection !== "object") {
      throw ingestError("INVALID_INGEST_INPUT", "detection is invalid", {
        fieldName: "detections",
      });
    }
    if (!bindings.length) continue;
    let externalMessageId;
    let providerDetectionMetadata;
    try {
      externalMessageId = buildCodeClipProviderPollingExternalMessageId({
        provider,
        providerObjectId: detection.providerObjectId,
      });
      providerDetectionMetadata = buildCodeClipProviderPollingDetectionMetadata({
        provider,
        detection: {
          ...detection,
          source: detection.source || detection.deliverySource,
          detectedAt: detection.detectedAt || now,
        },
      });
    } catch (error) {
      mapDetectionMetadataError(error);
    }
    for (const binding of bindings) {
      const eventCode =
        binding.eventCode || binding.event_code || null;
      if (!eventCode) {
        throw ingestError(
          "INVALID_INGEST_INPUT",
          "binding eventCode is required",
          { fieldName: "bindings" }
        );
      }
      required.push({
        provider,
        providerAccountId,
        eventCode,
        externalMessageId,
        providerDetectionMetadata,
        initialDeliverySource: detection.deliverySource,
        receivedAt: detection.detectedAt || null,
      });
    }
  }

  let completeResult;
  try {
    completeResult = await completeClaim(
      {
        pollSourceId,
        owner,
        expectedVersion,
        checkpoint,
        nextPollAt,
        now,
        consecutiveFailures: observability.consecutiveFailures ?? 0,
        lastErrorCode: observability.lastErrorCode ?? null,
        lastSuccessAt: observability.lastSuccessAt,
        lastDetectionAt: observability.lastDetectionAt,
        lastAttemptDurationMs: observability.lastAttemptDurationMs,
        lastDetectionsCount:
          observability.lastDetectionsCount ?? detections.length,
        status: observability.status ?? "active",
      },
      {
        queryClient,
        beforeComplete: async ({ queryClient: tx }) => {
          for (const identity of required) {
            const result = await createDelivery(
              {
                provider: identity.provider,
                providerAccountId: identity.providerAccountId,
                eventCode: identity.eventCode,
                externalMessageId: identity.externalMessageId,
                providerDetectionMetadata: identity.providerDetectionMetadata,
                initialDeliverySource: identity.initialDeliverySource,
                verificationState: "verified",
                processingState: "processing",
                corePersistenceState: "not_started",
                completionState: "not_completed",
                receivedAt: identity.receivedAt,
              },
              tx
            );

            if (
              !result ||
              (result.status !== "created" && result.status !== "existing")
            ) {
              throw ingestError(
                "DELIVERY_PERSISTENCE_FAILED",
                "delivery ledger write failed",
                { status: result?.status || "unknown" }
              );
            }
            if (result.status === "created") createdCount += 1;
            else existingCount += 1;
            if (result.row?.id != null) {
              deliveryIds.push(String(result.row.id));
            }
          }
        },
      }
    );
  } catch (error) {
    if (error instanceof CodeClipProviderPollingIngestError) throw error;
    mapPollSourceError(error);
  }

  return {
    status: "ingested",
    pollSource: completeResult.pollSource,
    createdCount,
    existingCount,
    deliveryIds,
    bindingCount: bindings.length,
    requiredDeliveryCount: required.length,
  };
}

module.exports = {
  CodeClipProviderPollingIngestError,
  ingestCodeClipProviderPollDetections,
};
