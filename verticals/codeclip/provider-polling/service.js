/**
 * codeClip provider poll service (F1D2B).
 *
 * Single-source orchestration:
 *   claim → credential resolve/inspect/secret-read → adapter.poll (HTTP outside TX)
 *   → fenced durable ledger ingest + checkpoint complete
 *   → or fenced failure release with scheduling
 *
 * Does not run core/reward pipeline, YouTube processEntry, token refresh,
 * workers, or routes. Delivery IDs are returned for later processing (F1D3+).
 */

const {
  CodeClipProviderPollSourceError,
  claimCodeClipProviderPollSource,
  getCodeClipProviderPollSourceById,
  releaseCodeClipProviderPollSourceClaim,
} = require("../provider-poll-sources");
const {
  CodeClipProviderCredentialError,
  findCodeClipProviderCredential,
  inspectCodeClipProviderCredentialUsability,
  getCodeClipProviderCredentialSecretsForUse,
} = require("../provider-credentials");
const {
  listActiveCodeClipProviderAccountBindings,
  CodeClipProviderAccountBindingError,
} = require("../provider-account-bindings");
const {
  CodeClipProviderPollAdapterContractError,
  normalizeCodeClipProviderPollAdapterInput,
  normalizeCodeClipProviderPollAdapterResult,
} = require("./adapter-contract");
const {
  CodeClipProviderPollAdapterRegistryError,
} = require("./adapter-registry");
const {
  CodeClipProviderPollingIngestError,
  ingestCodeClipProviderPollDetections,
} = require("./delivery-ingest");

const PAGE_DELAY_DEFAULT_MS = 5_000;
const PAGE_DELAY_MIN_MS = 1_000;
const PAGE_DELAY_MAX_MS = 30_000;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 86_400_000;
const MAX_ATTEMPT_DURATION_MS = 3_600_000;

class CodeClipProviderPollingServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingServiceError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function serviceError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "classification"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderPollingServiceError(code, message, safe);
}

function mapKnownError(error) {
  if (error instanceof CodeClipProviderPollingServiceError) throw error;
  if (error instanceof CodeClipProviderPollingIngestError) {
    throw serviceError(error.code, error.message, error.details || {});
  }
  if (error instanceof CodeClipProviderPollSourceError) {
    throw serviceError(error.code, error.message, error.details || {});
  }
  if (error instanceof CodeClipProviderCredentialError) {
    throw serviceError(error.code, error.message, error.details || {});
  }
  if (error instanceof CodeClipProviderPollAdapterContractError) {
    throw serviceError(
      "PROVIDER_MALFORMED_RESPONSE",
      "adapter contract validation failed",
      { reason: error.code || null }
    );
  }
  if (error instanceof CodeClipProviderPollAdapterRegistryError) {
    throw serviceError(error.code, error.message, error.details || {});
  }
  if (error instanceof CodeClipProviderAccountBindingError) {
    throw serviceError(
      "BINDING_LOOKUP_FAILED",
      "binding lookup failed",
      { reason: error.code || null }
    );
  }
  throw serviceError("DATABASE_ERROR", "polling service failed");
}

function computeBackoffMs(failures, retryAfterMs) {
  if (
    typeof retryAfterMs === "number" &&
    Number.isInteger(retryAfterMs) &&
    retryAfterMs >= RETRY_AFTER_MIN_MS &&
    retryAfterMs <= RETRY_AFTER_MAX_MS
  ) {
    return retryAfterMs;
  }
  const exp = Math.max(0, Math.min(Number(failures) || 1, 10) - 1);
  const raw = BACKOFF_BASE_MS * 2 ** exp;
  return Math.min(raw, BACKOFF_MAX_MS);
}

function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function measureDurationMs(startedAtMs, nowMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;
  const d = Math.max(0, Math.floor(nowMs - startedAtMs));
  return Math.min(d, MAX_ATTEMPT_DURATION_MS);
}

function failureSummary(sourceId, classification, nextPollAt) {
  return {
    ok: false,
    sourceId: String(sourceId),
    classification,
    nextPollAt: nextPollAt || null,
  };
}

function successSummary({
  sourceId,
  classification,
  claimVersion,
  pageComplete,
  detectionCount,
  duplicateCount,
  bindingCount,
  createdCount,
  existingCount,
  deliveryIds,
  nextPollAt,
}) {
  return {
    ok: true,
    sourceId: String(sourceId),
    classification,
    claimVersion,
    pageComplete: Boolean(pageComplete),
    detectionCount: Number(detectionCount) || 0,
    duplicateCount: Number(duplicateCount) || 0,
    bindingCount: Number(bindingCount) || 0,
    createdCount: Number(createdCount) || 0,
    existingCount: Number(existingCount) || 0,
    deliveryIds: Array.isArray(deliveryIds)
      ? deliveryIds.map((id) => String(id))
      : [],
    nextPollAt: nextPollAt || null,
  };
}

async function releaseWithScheduling({
  pollSourceId,
  owner,
  expectedVersion,
  now,
  classification,
  consecutiveFailures,
  nextPollAt,
  status,
  lastAttemptDurationMs,
  queryClient,
  releaseClaim = releaseCodeClipProviderPollSourceClaim,
}) {
  try {
    return await releaseClaim(
      {
        pollSourceId,
        owner,
        expectedVersion,
        now,
        nextPollAt,
        consecutiveFailures,
        lastErrorCode: classification,
        lastAttemptDurationMs,
        lastDetectionsCount: 0,
        status,
      },
      { queryClient }
    );
  } catch (error) {
    mapKnownError(error);
  }
}

/**
 * Poll one provider poll source end-to-end for a single page.
 *
 * Full service flow requires a pool-like dependency with connect() so claim,
 * reads, and ingest use short separate transactions. A caller-owned query-only
 * client (already inside an open TX) is rejected: adapter HTTP must never run
 * while holding a DB transaction.
 *
 * Delivery-ingest alone may still accept a caller-owned active TX client for
 * pure persistence tests; that path is not the full service.
 *
 * Reactivation (credential usable → status active + explicit next_poll_at) is
 * out of F1D2B scope and belongs to a later operator/OAuth flow.
 */
async function pollCodeClipProviderSource(
  {
    sourceId,
    owner,
    leaseMs,
    now,
    limit,
    queryClient,
    credentialEnv = process.env,
    adapterRegistry,
    clock = () => Date.now(),
  } = {},
  dependencies = {}
) {
  if (!queryClient || typeof queryClient.connect !== "function") {
    throw serviceError(
      "DATABASE_UNAVAILABLE",
      "polling service requires a pool with connect()"
    );
  }
  if (
    !adapterRegistry ||
    typeof adapterRegistry.get !== "function"
  ) {
    throw serviceError(
      "INVALID_SERVICE_INPUT",
      "adapterRegistry is required",
      { fieldName: "adapterRegistry" }
    );
  }

  const claimFn = dependencies.claim || claimCodeClipProviderPollSource;
  const getById = dependencies.getById || getCodeClipProviderPollSourceById;
  const findCredential =
    dependencies.findCredential || findCodeClipProviderCredential;
  const inspectUsability =
    dependencies.inspectUsability || inspectCodeClipProviderCredentialUsability;
  const secretRead =
    dependencies.secretRead || getCodeClipProviderCredentialSecretsForUse;
  const listBindings =
    dependencies.listBindings || listActiveCodeClipProviderAccountBindings;
  const ingest =
    dependencies.ingest || ingestCodeClipProviderPollDetections;
  const releaseClaim =
    dependencies.releaseClaim || releaseCodeClipProviderPollSourceClaim;

  const startedAtMs = Number(clock());

  let claim;
  try {
    claim = await claimFn(
      { pollSourceId: sourceId, owner, leaseMs, now },
      { queryClient }
    );
  } catch (error) {
    mapKnownError(error);
  }

  if (!claim || claim.ok !== true) {
    if (claim && claim.reason === "POLL_CLAIM_CONTENTION") {
      return failureSummary(sourceId, "retryable", null);
    }
    if (claim && claim.reason === "POLL_SOURCE_NOT_CLAIMABLE") {
      return failureSummary(sourceId, "terminal_configuration", null);
    }
    throw serviceError("POLL_CLAIM_FAILED", "poll source claim failed");
  }

  const claimVersion = claim.claimVersion;
  const claimOwner = owner;

  let pollSource;
  try {
    pollSource = await getById(sourceId, { queryClient });
  } catch (error) {
    mapKnownError(error);
  }
  if (!pollSource) {
    throw serviceError("POLL_SOURCE_NOT_FOUND", "poll source was not found");
  }

  const finishFailure = async (classification, { retryAfterMs, status } = {}) => {
    const failures = (pollSource.consecutiveFailures || 0) + 1;
    const durationMs = measureDurationMs(startedAtMs, Number(clock()));
    const resolvedStatus =
      status ||
      (classification === "credential_unusable" ||
      classification === "reauthorization_required" ||
      classification === "terminal_configuration"
        ? "paused"
        : "active");
    // paused: not scheduled (next_poll_at NULL). active: bounded retry/backoff.
    const nextPollAt =
      resolvedStatus === "paused" || resolvedStatus === "disabled"
        ? null
        : addMs(
            claim.claimedAt || new Date().toISOString(),
            computeBackoffMs(failures, retryAfterMs)
          );
    const released = await releaseWithScheduling({
      pollSourceId: sourceId,
      owner: claimOwner,
      expectedVersion: claimVersion,
      now,
      classification,
      consecutiveFailures: failures,
      nextPollAt,
      status: resolvedStatus,
      lastAttemptDurationMs: durationMs,
      queryClient,
      releaseClaim,
    });
    return failureSummary(
      sourceId,
      classification,
      released?.pollSource?.nextPollAt ?? nextPollAt
    );
  };

  // --- Credential resolve / inspect / secret-read (no long TX) ---
  let credential;
  try {
    credential = await findCredential(
      {
        provider: pollSource.provider,
        providerAccountId: pollSource.providerAccountId,
        environment: pollSource.environment,
      },
      { queryClient, now }
    );
  } catch (error) {
    mapKnownError(error);
  }

  if (!credential) {
    return finishFailure("credential_unusable");
  }

  let usability;
  try {
    usability = await inspectUsability(
      { id: credential.id, now },
      { queryClient }
    );
  } catch (error) {
    mapKnownError(error);
  }

  if (!usability) {
    return finishFailure("credential_unusable");
  }
  if (usability.reauthorizationRequired === true) {
    return finishFailure("reauthorization_required");
  }
  if (usability.usableForProviderApi !== true) {
    return finishFailure("credential_unusable");
  }

  let secrets;
  try {
    secrets = await secretRead(
      { id: credential.id, purpose: "provider_api", now },
      { queryClient, env: credentialEnv }
    );
  } catch (error) {
    mapKnownError(error);
  }

  if (!secrets || secrets.ok !== true || !secrets.accessToken) {
    const reason = secrets?.reason || "";
    if (reason === "REAUTHORIZATION_REQUIRED") {
      return finishFailure("reauthorization_required");
    }
    if (reason === "TOKEN_EXPIRED" || reason === "TOKEN_NOT_PRESENT") {
      return finishFailure("credential_unusable");
    }
    return finishFailure("credential_unusable");
  }

  // --- Adapter registry + poll (HTTP outside TX) ---
  let adapter;
  try {
    adapter = adapterRegistry.get(pollSource.provider);
  } catch (error) {
    mapKnownError(error);
  }
  if (!adapter || typeof adapter.poll !== "function") {
    return finishFailure("terminal_configuration");
  }

  let adapterInput;
  try {
    adapterInput = normalizeCodeClipProviderPollAdapterInput({
      provider: pollSource.provider,
      environment: pollSource.environment,
      providerAccountId: pollSource.providerAccountId,
      accessToken: secrets.accessToken,
      checkpoint: pollSource.checkpoint,
      now: now || claim.claimedAt || new Date(),
      limit,
    });
  } catch (error) {
    mapKnownError(error);
  }

  let rawResult;
  try {
    rawResult = await adapter.poll(adapterInput);
  } catch {
    // Transport/programming throws: treat as malformed/retryable surface without leaking messages.
    return finishFailure("provider_malformed_response");
  }

  let adapterResult;
  try {
    adapterResult = normalizeCodeClipProviderPollAdapterResult(rawResult, {
      provider: pollSource.provider,
    });
  } catch {
    return finishFailure("provider_malformed_response");
  }

  if (adapterResult.ok !== true) {
    return finishFailure(adapterResult.classification, {
      retryAfterMs: adapterResult.retryAfterMs,
    });
  }

  // --- Bindings + durable ingest under fence ---
  let bindings;
  try {
    bindings = await listBindings(
      {
        provider: pollSource.provider,
        providerAccountId: pollSource.providerAccountId,
      },
      { queryClient }
    );
  } catch (error) {
    mapKnownError(error);
  }
  if (!Array.isArray(bindings)) bindings = [];

  const operationNow = adapterInput.now;
  const pageComplete = adapterResult.page.complete === true;
  const pageDelayMs = Math.min(
    PAGE_DELAY_MAX_MS,
    Math.max(PAGE_DELAY_MIN_MS, PAGE_DELAY_DEFAULT_MS)
  );
  const nextPollAt = pageComplete
    ? addMs(operationNow, pollSource.pollIntervalMs)
    : addMs(operationNow, pageDelayMs);

  const durationMs = measureDurationMs(startedAtMs, Number(clock()));
  const detectionCount = adapterResult.detections.length;

  let ingestResult;
  try {
    ingestResult = await ingest(
      {
        pollSourceId: sourceId,
        owner: claimOwner,
        expectedVersion: claimVersion,
        checkpoint: adapterResult.nextCheckpoint,
        nextPollAt,
        detections: adapterResult.detections,
        bindings,
        provider: pollSource.provider,
        providerAccountId: pollSource.providerAccountId,
        now: operationNow,
        observability: {
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastSuccessAt: operationNow,
          lastDetectionAt: detectionCount > 0 ? operationNow : null,
          lastAttemptDurationMs: durationMs,
          lastDetectionsCount: detectionCount,
          status: "active",
        },
      },
      { queryClient }
    );
  } catch (error) {
    if (
      error instanceof CodeClipProviderPollingIngestError ||
      error instanceof CodeClipProviderPollSourceError
    ) {
      if (
        error.code === "POLL_CLAIM_FENCE_MISMATCH" ||
        error.code === "DELIVERY_PERSISTENCE_FAILED"
      ) {
        // Do not attempt unfenced failure update after fence failure.
        if (error.code === "POLL_CLAIM_FENCE_MISMATCH") {
          return failureSummary(sourceId, "retryable", null);
        }
        // Persistence failed after fence: claim may still be held — try fenced release.
        try {
          return await finishFailure("retryable");
        } catch {
          return failureSummary(sourceId, "retryable", null);
        }
      }
    }
    mapKnownError(error);
  }

  return successSummary({
    sourceId,
    classification: detectionCount === 0 ? "empty" : "success",
    claimVersion,
    pageComplete,
    detectionCount,
    duplicateCount: adapterResult.duplicateCount || 0,
    bindingCount: bindings.length,
    createdCount: ingestResult.createdCount,
    existingCount: ingestResult.existingCount,
    deliveryIds: ingestResult.deliveryIds,
    nextPollAt: ingestResult.pollSource?.nextPollAt || nextPollAt,
  });
}

module.exports = {
  CodeClipProviderPollingServiceError,
  pollCodeClipProviderSource,
};
