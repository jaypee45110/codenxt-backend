/**
 * Single-line structured JSON logging for provider polling worker/runtime.
 *
 * Emits one JSON object per line. Never accepts raw Error objects, tokens,
 * SQL, or host material — callers must pass only already-safe fields.
 */

const LOG_PREFIX = "codeClip provider polling worker";

const ALLOWED_KEYS = Object.freeze([
  "operationalEvent",
  "provider",
  "environment",
  "cycleNumber",
  "status",
  "state",
  "classification",
  "scanned",
  "attempted",
  "succeeded",
  "failed",
  "skipped",
  "detectionCount",
  "selected",
  "completed",
  "terminalFailed",
  "retryableFailed",
  "durationMs",
  "errorCode",
  "underlyingCode",
  "underlyingName",
  "underlyingErrno",
  "underlyingSyscall",
  "underlyingConstructor",
  "causeCode",
  "causeName",
  "causeErrno",
  "causeSyscall",
  "scanStage",
  "queryClientKind",
  "poolTotalCount",
  "poolIdleCount",
  "poolWaitingCount",
  "dueSourceQueryElapsedMs",
  "source",
  "code",
  "stage",
  "count",
]);

function isFiniteNonNegativeInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function sanitizeString(value, max = 120) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim().slice(0, max);
  return text || null;
}

function sanitizeField(key, value) {
  if (value === undefined || value === null) return null;
  if (
    [
      "cycleNumber",
      "scanned",
      "attempted",
      "succeeded",
      "failed",
      "skipped",
      "detectionCount",
      "selected",
      "completed",
      "terminalFailed",
      "retryableFailed",
      "durationMs",
      "poolTotalCount",
      "poolIdleCount",
      "poolWaitingCount",
      "dueSourceQueryElapsedMs",
      "count",
      "underlyingErrno",
      "causeErrno",
    ].includes(key)
  ) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (key === "underlyingErrno" || key === "causeErrno") {
        if (!Number.isInteger(value) || Math.abs(value) > 1_000_000) return null;
        return value;
      }
      if (!isFiniteNonNegativeInteger(value)) return null;
      return Math.min(value, 3_600_000);
    }
    if (typeof value === "string" && (key === "underlyingErrno" || key === "causeErrno")) {
      return sanitizeString(value, 80);
    }
    return null;
  }
  return sanitizeString(value, 120);
}

/**
 * Build a single safe payload object. Drops unknown keys and unsafe values.
 */
function buildCodeClipProviderPollingLogPayload(event, fields = {}) {
  const payload = {
    operationalEvent: sanitizeString(event, 80) || "provider_polling_event",
  };
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return payload;
  }
  for (const key of ALLOWED_KEYS) {
    if (key === "operationalEvent") continue;
    if (fields[key] === undefined || fields[key] === null) continue;
    const sanitized = sanitizeField(key, fields[key]);
    if (sanitized !== null && sanitized !== "") {
      payload[key] = sanitized;
    }
  }
  return payload;
}

function writeLine(streamFn, payload) {
  streamFn(JSON.stringify(payload));
}

function createCodeClipProviderPollingStructuredLogger(options = {}) {
  const infoStream = options.info || console.log.bind(console);
  const warnStream = options.warn || console.warn.bind(console);
  const errorStream = options.error || console.error.bind(console);

  function emit(streamFn, event, fields) {
    const payload = buildCodeClipProviderPollingLogPayload(event, fields);
    // Prefix keeps existing log grepping; payload is one JSON object.
    streamFn(`${LOG_PREFIX} ${JSON.stringify(payload)}`);
  }

  return {
    info: (event, fields) => emit(infoStream, event, fields),
    warn: (event, fields) => emit(warnStream, event, fields),
    error: (event, fields) => emit(errorStream, event, fields),
    buildPayload: buildCodeClipProviderPollingLogPayload,
  };
}

module.exports = {
  ALLOWED_KEYS,
  buildCodeClipProviderPollingLogPayload,
  createCodeClipProviderPollingStructuredLogger,
};
