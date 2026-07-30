/**
 * B11.2F2 Meta Messenger Dispatch Worker (testable cycle + config)
 *
 * Thin orchestration over:
 *   listEligible → dispatchCodeClipMetaMessengerOutbound (B11.2E)
 *   credentials via B11.2F1 resolver
 *
 * Cycle summary is computed ONLY from dispatch result objects — never by
 * re-reading or interpreting database row fields as truth.
 */

const crypto = require("node:crypto");

const {
  listEligibleCodeClipMetaMessengerOutboundIds,
} = require("./meta-messenger-outbound-repository");
const {
  dispatchCodeClipMetaMessengerOutbound,
} = require("./meta-messenger-outbound-dispatch");
const {
  ENV_CREDENTIALS_JSON,
  createMetaMessengerPageCredentialResolverFromEnv,
} = require("./meta-messenger-page-credentials");

const DEFAULTS = Object.freeze({
  enabled: false,
  limit: 5,
  concurrency: 1,
  intervalMs: 30_000,
  staleAfterSeconds: 300,
  timeoutMs: 10_000,
  minIntervalMs: 5_000,
  maxIntervalMs: 3_600_000,
  minLimit: 1,
  maxLimit: 100,
  minConcurrency: 1,
  maxConcurrency: 3,
  minStaleAfterSeconds: 1,
  maxStaleAfterSeconds: 7 * 24 * 60 * 60,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
});

const SECRET_LOG_KEYS = new Set([
  "pageaccesstoken",
  "access_token",
  "accesstoken",
  "authorization",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "raw",
  "body",
  "deliverable",
  "recipientid",
  "recipient",
  "message",
  "request",
  "response",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseBoundedInteger(value, name, defaultValue, { min, max }) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${name}_invalid` };
  }
  return parsed;
}

function configError(reason, details = {}) {
  return { ok: false, reason, details };
}

/**
 * Operational classification from a B11.2E dispatch result only.
 * Never inspects result.row or database fields.
 */
function classifyDispatchResultForSummary(result = {}) {
  const outcome = normalizeString(result.outcome).toLowerCase();
  switch (outcome) {
    case "sent":
      return "sent";
    case "retryable_failed":
      return "retryable_failed";
    case "terminal_failed":
      return "terminal_failed";
    case "claim_conflict":
      return "claim_conflict";
    case "credentials_failed":
      return "credentials_failed";
    case "builder_failed":
      return "builder_failed";
    case "provider_sent_record_unconfirmed":
      return "provider_sent_record_unconfirmed";
    case "record_conflict":
      return "record_conflict";
    case "failed":
      return "internal_error";
    default:
      return "internal_error";
  }
}

function emptySummary() {
  return {
    selected: 0,
    processed: 0,
    sent: 0,
    retryableFailed: 0,
    terminalFailed: 0,
    claimConflicts: 0,
    credentialsFailed: 0,
    builderFailed: 0,
    providerSentRecordUnconfirmed: 0,
    recordConflicts: 0,
    internalErrors: 0,
    durableHolds: 0,
    manualReviewRequired: 0,
  };
}

/**
 * Build cycle summary exclusively from dispatch result objects.
 */
function buildCycleSummaryFromDispatchResults(ids, results) {
  const summary = emptySummary();
  summary.selected = Array.isArray(ids) ? ids.length : 0;
  summary.processed = Array.isArray(results) ? results.length : 0;

  for (const result of results || []) {
    const bucket = classifyDispatchResultForSummary(result);
    if (bucket === "sent") summary.sent += 1;
    else if (bucket === "retryable_failed") summary.retryableFailed += 1;
    else if (bucket === "terminal_failed") summary.terminalFailed += 1;
    else if (bucket === "claim_conflict") summary.claimConflicts += 1;
    else if (bucket === "credentials_failed") summary.credentialsFailed += 1;
    else if (bucket === "builder_failed") summary.builderFailed += 1;
    else if (bucket === "provider_sent_record_unconfirmed") {
      summary.providerSentRecordUnconfirmed += 1;
    } else if (bucket === "record_conflict") summary.recordConflicts += 1;
    else summary.internalErrors += 1;

    if (result?.durableHold === true) summary.durableHolds += 1;
    if (result?.manualReviewRequired === true) summary.manualReviewRequired += 1;
  }

  return summary;
}

function toPublicItemFromDispatchResult(result = {}) {
  const item = {
    outboundId: result.outboundId ?? null,
    attemptId: result.attemptId ?? null,
    claimDisposition: result.claimDisposition ?? null,
    outcome: result.outcome ?? null,
    failureCode: result.failureCode ?? null,
    durableHold: Boolean(result.durableHold),
    manualReviewRequired: Boolean(result.manualReviewRequired),
    dispatchRecorded: Boolean(result.dispatchRecorded),
    providerAccepted: Boolean(result.providerAccepted),
    retryable: Boolean(result.retryable),
  };
  if (Object.prototype.hasOwnProperty.call(result, "attemptNumber")) {
    item.attemptNumber = result.attemptNumber;
  }
  return item;
}

function sanitizeMetaMessengerDispatchWorkerLogEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return {};
  const out = {};
  for (const [key, value] of Object.entries(event)) {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SECRET_LOG_KEYS.has(normalizedKey)) continue;
    if (normalizedKey.includes("token") || normalizedKey.includes("secret")) continue;
    if (normalizedKey.includes("password") || normalizedKey.includes("authorization")) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (key === "summary" || key === "items" || key === "details") {
        out[key] = sanitizeMetaMessengerDispatchWorkerLogEvent(value);
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function defaultCreateAttemptId() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function mapPool(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = [];
  for (let i = 0; i < safeConcurrency; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * One bounded worker cycle. Summary is operational only (from dispatch results).
 */
async function runCodeClipMetaMessengerDispatchCycle({
  limit = DEFAULTS.limit,
  concurrency = DEFAULTS.concurrency,
  staleAfterSeconds = DEFAULTS.staleAfterSeconds,
  timeoutMs = DEFAULTS.timeoutMs,
  now = new Date().toISOString(),
  queryClient,
  resolvePageAccessCredentials,
  selectCandidates = listEligibleCodeClipMetaMessengerOutboundIds,
  dispatchOutbound = dispatchCodeClipMetaMessengerOutbound,
  createAttemptId = defaultCreateAttemptId,
  fetchImpl,
  signal = null,
  cycleId = defaultCreateAttemptId(),
} = {}) {
  if (!queryClient) {
    return {
      ok: false,
      failureCode: "query_client_required",
      cycleId,
      summary: emptySummary(),
      items: [],
    };
  }
  if (typeof resolvePageAccessCredentials !== "function") {
    return {
      ok: false,
      failureCode: "credentials_resolver_required",
      cycleId,
      summary: emptySummary(),
      items: [],
    };
  }
  if (typeof selectCandidates !== "function" || typeof dispatchOutbound !== "function") {
    return {
      ok: false,
      failureCode: "worker_dependencies_required",
      cycleId,
      summary: emptySummary(),
      items: [],
    };
  }

  if (signal?.aborted) {
    return {
      ok: false,
      failureCode: "aborted",
      cycleId,
      aborted: true,
      summary: emptySummary(),
      items: [],
    };
  }

  let selection;
  try {
    selection = await selectCandidates({
      limit,
      now,
      queryClient,
    });
  } catch {
    return {
      ok: false,
      failureCode: "selection_failed",
      cycleId,
      summary: emptySummary(),
      items: [],
    };
  }

  if (!selection?.ok || !Array.isArray(selection.ids)) {
    return {
      ok: false,
      failureCode: "selection_failed",
      cycleId,
      summary: emptySummary(),
      items: [],
    };
  }

  const ids = selection.ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const results = await mapPool(ids, concurrency, async (outboundId) => {
    if (signal?.aborted) {
      return dispatchResultPlaceholder({
        outboundId,
        outcome: "failed",
        claimDisposition: "not_acquired",
        failureCode: "aborted",
      });
    }

    const attemptId = normalizeString(createAttemptId()) || defaultCreateAttemptId();
    try {
      const result = await dispatchOutbound({
        outboundId,
        attemptId,
        staleAfterSeconds,
        queryClient,
        resolvePageAccessCredentials,
        fetchImpl,
        now,
        timeoutMs,
      });
      return result && typeof result === "object"
        ? result
        : dispatchResultPlaceholder({
            outboundId,
            attemptId,
            outcome: "failed",
            failureCode: "dispatch_result_invalid",
          });
    } catch {
      return dispatchResultPlaceholder({
        outboundId,
        attemptId,
        outcome: "failed",
        failureCode: "dispatch_exception",
      });
    }
  });

  const summary = buildCycleSummaryFromDispatchResults(ids, results);
  const items = results.map((result) => toPublicItemFromDispatchResult(result));

  return {
    ok: true,
    cycleId,
    aborted: Boolean(signal?.aborted),
    summary,
    items,
  };
}

function dispatchResultPlaceholder(partial = {}) {
  return {
    ok: false,
    outcome: "failed",
    claimDisposition: "not_acquired",
    providerAccepted: false,
    dispatchRecorded: false,
    durableHold: false,
    retryable: false,
    manualReviewRequired: false,
    providerMessageId: null,
    failureCode: null,
    ...partial,
  };
}

function loadCodeClipMetaMessengerDispatchWorkerConfig(env = process.env) {
  const enabledFlag = parseBooleanFlag(env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_ENABLED, false);
  if (enabledFlag === null) {
    return configError("WORKER_ENABLED_INVALID");
  }

  if (!enabledFlag) {
    return {
      ok: true,
      config: {
        enabled: false,
        limit: DEFAULTS.limit,
        concurrency: DEFAULTS.concurrency,
        intervalMs: DEFAULTS.intervalMs,
        staleAfterSeconds: DEFAULTS.staleAfterSeconds,
        timeoutMs: DEFAULTS.timeoutMs,
        resolvePageAccessCredentials: null,
      },
    };
  }

  const limit = parseBoundedInteger(
    env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_LIMIT,
    "limit",
    DEFAULTS.limit,
    { min: DEFAULTS.minLimit, max: DEFAULTS.maxLimit }
  );
  if (limit?.error) return configError("WORKER_LIMIT_INVALID");

  const concurrency = parseBoundedInteger(
    env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_CONCURRENCY,
    "concurrency",
    DEFAULTS.concurrency,
    { min: DEFAULTS.minConcurrency, max: DEFAULTS.maxConcurrency }
  );
  if (concurrency?.error) return configError("WORKER_CONCURRENCY_INVALID");

  const intervalMs = parseBoundedInteger(
    env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_INTERVAL_MS,
    "intervalMs",
    DEFAULTS.intervalMs,
    { min: DEFAULTS.minIntervalMs, max: DEFAULTS.maxIntervalMs }
  );
  if (intervalMs?.error) return configError("WORKER_INTERVAL_INVALID");

  const staleAfterSeconds = parseBoundedInteger(
    env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_STALE_AFTER_SECONDS,
    "staleAfterSeconds",
    DEFAULTS.staleAfterSeconds,
    { min: DEFAULTS.minStaleAfterSeconds, max: DEFAULTS.maxStaleAfterSeconds }
  );
  if (staleAfterSeconds?.error) return configError("WORKER_STALE_AFTER_INVALID");

  const timeoutMs = parseBoundedInteger(
    env.CODECLIP_META_MESSENGER_DISPATCH_WORKER_TIMEOUT_MS,
    "timeoutMs",
    DEFAULTS.timeoutMs,
    { min: DEFAULTS.minTimeoutMs, max: DEFAULTS.maxTimeoutMs }
  );
  if (timeoutMs?.error) return configError("WORKER_TIMEOUT_INVALID");

  const resolverOrError = createMetaMessengerPageCredentialResolverFromEnv(env);
  if (resolverOrError && resolverOrError.ok === false) {
    return configError(resolverOrError.reason || "CREDENTIAL_CONFIG_INVALID", {
      field: ENV_CREDENTIALS_JSON,
    });
  }
  if (typeof resolverOrError !== "function") {
    return configError("CREDENTIAL_RESOLVER_INVALID");
  }

  return {
    ok: true,
    config: {
      enabled: true,
      limit,
      concurrency,
      intervalMs,
      staleAfterSeconds,
      timeoutMs,
      resolvePageAccessCredentials: resolverOrError,
    },
  };
}

function createCodeClipMetaMessengerDispatchWorkerState() {
  return {
    shuttingDown: false,
    cycleRunning: false,
  };
}

module.exports = {
  DEFAULTS,
  buildCycleSummaryFromDispatchResults,
  classifyDispatchResultForSummary,
  createCodeClipMetaMessengerDispatchWorkerState,
  loadCodeClipMetaMessengerDispatchWorkerConfig,
  runCodeClipMetaMessengerDispatchCycle,
  sanitizeMetaMessengerDispatchWorkerLogEvent,
  toPublicItemFromDispatchResult,
};
