/**
 * Generic provider-polling health classification for operator/monitor surfaces.
 *
 * Pure functions only — no DB, HTTP, or secrets.
 */

const CLASSIFICATIONS = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  REAUTHORIZATION: "reauthorization",
  STALE: "stale",
  INACTIVE: "inactive",
  NOT_CONFIGURED: "not_configured",
  TERMINAL_DELIVERY: "terminal_delivery",
});

const REAUTH_ERROR_CODES = Object.freeze(
  new Set([
    "reauthorization_required",
    "credential_unusable",
    "video_list_scope_required",
    "access_token_invalid",
  ])
);

function parseTimestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizePositiveInt(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * Classify poll-source operational health.
 *
 * @param {object} input
 * @param {object|null} input.source public/safe poll source row
 * @param {Date|string|number} [input.now]
 * @param {number} [input.staleMultiplier] multiples of pollIntervalMs (default 3)
 * @param {number} [input.minStaleMs] floor for stale threshold (default 15m)
 */
function classifyCodeClipProviderPollingSourceHealth(input = {}) {
  const source = input.source || null;
  if (!source) {
    return {
      classification: CLASSIFICATIONS.NOT_CONFIGURED,
      reason: "no_poll_source",
    };
  }

  const status = String(source.status || "").trim().toLowerCase();
  if (status === "disabled" || status === "paused") {
    const lastError = String(source.lastErrorCode || source.last_error_code || "")
      .trim()
      .toLowerCase();
    if (REAUTH_ERROR_CODES.has(lastError) || status === "paused") {
      if (REAUTH_ERROR_CODES.has(lastError)) {
        return {
          classification: CLASSIFICATIONS.REAUTHORIZATION,
          reason: lastError || "paused",
        };
      }
    }
    return {
      classification: CLASSIFICATIONS.INACTIVE,
      reason: status || "inactive",
    };
  }

  if (status !== "active") {
    return {
      classification: CLASSIFICATIONS.INACTIVE,
      reason: status || "unknown_status",
    };
  }

  const lastError = String(source.lastErrorCode || source.last_error_code || "")
    .trim()
    .toLowerCase();
  if (REAUTH_ERROR_CODES.has(lastError)) {
    return {
      classification: CLASSIFICATIONS.REAUTHORIZATION,
      reason: lastError,
    };
  }

  const failures = normalizePositiveInt(
    source.consecutiveFailures ?? source.consecutive_failures,
    0
  );
  if (failures > 0 || lastError) {
    return {
      classification: CLASSIFICATIONS.DEGRADED,
      reason: lastError || "consecutive_failures",
      consecutiveFailures: failures,
    };
  }

  const nowMs =
    parseTimestampMs(input.now) ??
    (input.now instanceof Date ? input.now.getTime() : Date.now());
  const lastSuccessMs = parseTimestampMs(
    source.lastSuccessAt || source.last_success_at
  );
  const pollIntervalMs = normalizePositiveInt(
    source.pollIntervalMs ?? source.poll_interval_ms,
    300_000
  );
  const multiplier =
    typeof input.staleMultiplier === "number" && input.staleMultiplier >= 1
      ? input.staleMultiplier
      : 3;
  const minStaleMs =
    typeof input.minStaleMs === "number" && input.minStaleMs > 0
      ? input.minStaleMs
      : 900_000;
  const staleAfterMs = Math.max(pollIntervalMs * multiplier, minStaleMs);

  if (lastSuccessMs !== null && nowMs - lastSuccessMs > staleAfterMs) {
    return {
      classification: CLASSIFICATIONS.STALE,
      reason: "last_success_stale",
      staleAfterMs,
    };
  }

  return {
    classification: CLASSIFICATIONS.HEALTHY,
    reason: "active_recent_success",
  };
}

/**
 * Classify delivery/completion aggregates for provider_polling.
 */
function classifyCodeClipProviderPollingDeliveryHealth(input = {}) {
  const terminalCompletionFailures = normalizePositiveInt(
    input.terminalCompletionFailures,
    0
  );
  const retryableFailures = normalizePositiveInt(input.retryableFailures, 0);
  const processing = normalizePositiveInt(input.processing, 0);
  const pendingCompletionReady = normalizePositiveInt(
    input.pendingCompletionReady,
    0
  );

  if (terminalCompletionFailures > 0) {
    return {
      classification: CLASSIFICATIONS.TERMINAL_DELIVERY,
      reason: "terminal_completion_failures",
      terminalCompletionFailures,
    };
  }
  if (retryableFailures > 0 || processing > 0) {
    return {
      classification: CLASSIFICATIONS.DEGRADED,
      reason: retryableFailures > 0 ? "retryable_failures" : "processing_backlog",
    };
  }
  if (pendingCompletionReady > 0) {
    return {
      classification: CLASSIFICATIONS.DEGRADED,
      reason: "pending_completion",
      pendingCompletionReady,
    };
  }
  return {
    classification: CLASSIFICATIONS.HEALTHY,
    reason: "delivery_stable",
  };
}

module.exports = {
  CLASSIFICATIONS,
  classifyCodeClipProviderPollingSourceHealth,
  classifyCodeClipProviderPollingDeliveryHealth,
};
