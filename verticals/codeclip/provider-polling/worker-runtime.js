/**
 * codeClip generic provider polling worker runtime (F3B).
 *
 * Wraps the F3A worker core in a small runtime: config, single-flight cycles,
 * completion-based scheduling, safe logs, and graceful shutdown. No process
 * signal handlers, routes, health server, schema ensure, deploy, or provider
 * specific refresh.
 */

const {
  runCodeClipProviderPollingWorkerCycle,
} = require("./worker-core");
const {
  runCodeClipProviderPollingDeliveryCompletionCycle,
} = require("./delivery-completion");
const {
  resolveCodeClipProviderPolicy,
} = require("../provider-policy");

const ENV_PREFIX = "CODECLIP_PROVIDER_POLLING_WORKER_";

const DEFAULTS = Object.freeze({
  enabled: true,
  provider: "tiktok",
  environment: "production",
  intervalMs: 30_000,
  limit: 25,
  concurrency: 4,
  leaseMs: 60_000,
  ownerPrefix: "codeclip.provider.poll.worker",
  failureBackoffMs: 30_000,
  shutdownTimeoutMs: 30_000,
  runOnStart: true,
  oneShot: false,
});

const NUMBER_RANGES = Object.freeze({
  intervalMs: { min: 1_000, max: 3_600_000 },
  limit: { min: 1, max: 100 },
  concurrency: { min: 1, max: 16 },
  leaseMs: { min: 5_000, max: 300_000 },
  failureBackoffMs: { min: 1_000, max: 3_600_000 },
  shutdownTimeoutMs: { min: 1_000, max: 300_000 },
});

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

class CodeClipProviderPollingWorkerRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingWorkerRuntimeError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function runtimeError(code, message, details = {}) {
  const safe = {};
  for (const key of ["fieldName", "reason", "state"]) {
    if (details?.[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 100);
    }
  }
  return new CodeClipProviderPollingWorkerRuntimeError(code, message, safe);
}

function parseBooleanEnv(value, defaultValue, fieldName) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw runtimeError("INVALID_WORKER_RUNTIME_CONFIG", `${fieldName} is invalid`, {
    fieldName,
  });
}

function parseIntegerEnv(value, defaultValue, fieldName, range) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const raw = String(value).trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw runtimeError("INVALID_WORKER_RUNTIME_CONFIG", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < range.min ||
    parsed > range.max
  ) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      `${fieldName} is out of range`,
      { fieldName }
    );
  }
  return parsed;
}

function normalizeProvider(value, fieldName = "provider") {
  if (typeof value !== "string") {
    throw runtimeError("INVALID_WORKER_RUNTIME_CONFIG", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !PROVIDER_PATTERN.test(normalized)) {
    throw runtimeError("INVALID_WORKER_RUNTIME_CONFIG", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  const resolved = resolveCodeClipProviderPolicy(normalized);
  if (!resolved.ok || resolved.policy?.capabilities?.polling !== true) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      `${fieldName} is not polling capable`,
      { fieldName, reason: "PROVIDER_NOT_POLLING_CAPABLE" }
    );
  }
  return normalized;
}

function normalizeEnvironment(value) {
  if (typeof value !== "string") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      "environment is invalid",
      { fieldName: "environment" }
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "sandbox" && normalized !== "production") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      "environment is invalid",
      { fieldName: "environment" }
    );
  }
  return normalized;
}

function normalizeOwnerPrefix(value) {
  if (typeof value !== "string") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      "ownerPrefix is invalid",
      { fieldName: "ownerPrefix" }
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 64 || !OWNER_PATTERN.test(normalized)) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      "ownerPrefix is invalid",
      { fieldName: "ownerPrefix" }
    );
  }
  return normalized;
}

function loadCodeClipProviderPollingWorkerConfig(env = process.env) {
  const get = (name) => env[`${ENV_PREFIX}${name}`];
  return {
    enabled: parseBooleanEnv(get("ENABLED"), DEFAULTS.enabled, "enabled"),
    provider: normalizeProvider(get("PROVIDER") || DEFAULTS.provider),
    environment: normalizeEnvironment(
      get("ENVIRONMENT") || DEFAULTS.environment
    ),
    intervalMs: parseIntegerEnv(
      get("INTERVAL_MS"),
      DEFAULTS.intervalMs,
      "intervalMs",
      NUMBER_RANGES.intervalMs
    ),
    limit: parseIntegerEnv(
      get("LIMIT"),
      DEFAULTS.limit,
      "limit",
      NUMBER_RANGES.limit
    ),
    concurrency: parseIntegerEnv(
      get("CONCURRENCY"),
      DEFAULTS.concurrency,
      "concurrency",
      NUMBER_RANGES.concurrency
    ),
    leaseMs: parseIntegerEnv(
      get("LEASE_MS"),
      DEFAULTS.leaseMs,
      "leaseMs",
      NUMBER_RANGES.leaseMs
    ),
    ownerPrefix: normalizeOwnerPrefix(
      get("OWNER_PREFIX") || DEFAULTS.ownerPrefix
    ),
    failureBackoffMs: parseIntegerEnv(
      get("FAILURE_BACKOFF_MS"),
      DEFAULTS.failureBackoffMs,
      "failureBackoffMs",
      NUMBER_RANGES.failureBackoffMs
    ),
    shutdownTimeoutMs: parseIntegerEnv(
      get("SHUTDOWN_TIMEOUT_MS"),
      DEFAULTS.shutdownTimeoutMs,
      "shutdownTimeoutMs",
      NUMBER_RANGES.shutdownTimeoutMs
    ),
    runOnStart: parseBooleanEnv(
      get("RUN_ON_START"),
      DEFAULTS.runOnStart,
      "runOnStart"
    ),
    oneShot: parseBooleanEnv(
      get("ONE_SHOT"),
      DEFAULTS.oneShot,
      "oneShot"
    ),
  };
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      "worker runtime config is invalid"
    );
  }
  return {
    enabled: validateBooleanConfig("enabled", config.enabled),
    provider: normalizeProvider(config.provider || DEFAULTS.provider),
    environment: normalizeEnvironment(config.environment || DEFAULTS.environment),
    intervalMs: validateIntegerConfig("intervalMs", config.intervalMs),
    limit: validateIntegerConfig("limit", config.limit),
    concurrency: validateIntegerConfig("concurrency", config.concurrency),
    leaseMs: validateIntegerConfig("leaseMs", config.leaseMs),
    ownerPrefix: normalizeOwnerPrefix(config.ownerPrefix || DEFAULTS.ownerPrefix),
    failureBackoffMs: validateIntegerConfig(
      "failureBackoffMs",
      config.failureBackoffMs
    ),
    shutdownTimeoutMs: validateIntegerConfig(
      "shutdownTimeoutMs",
      config.shutdownTimeoutMs
    ),
    runOnStart: validateBooleanConfig("runOnStart", config.runOnStart),
    oneShot: validateBooleanConfig("oneShot", config.oneShot),
  };
}

function validateBooleanConfig(fieldName, value) {
  if (value === undefined) return DEFAULTS[fieldName];
  if (typeof value !== "boolean") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  return value;
}

function validateIntegerConfig(fieldName, value) {
  const candidate = value === undefined ? DEFAULTS[fieldName] : value;
  const range = NUMBER_RANGES[fieldName];
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < range.min ||
    candidate > range.max
  ) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_CONFIG",
      `${fieldName} is out of range`,
      { fieldName }
    );
  }
  return candidate;
}

function requirePool(queryClient) {
  if (
    !queryClient ||
    typeof queryClient.connect !== "function" ||
    typeof queryClient.query !== "function"
  ) {
    throw runtimeError(
      "DATABASE_UNAVAILABLE",
      "provider polling worker requires a database pool"
    );
  }
  return queryClient;
}

function validateRegistry(adapterRegistry) {
  if (adapterRegistry === undefined || adapterRegistry === null) {
    return undefined;
  }
  if (!adapterRegistry || typeof adapterRegistry.get !== "function") {
    throw runtimeError(
      "ADAPTER_REGISTRY_NOT_AVAILABLE",
      "adapter registry is not available",
      { fieldName: "adapterRegistry" }
    );
  }
  if (
    Object.hasOwn(adapterRegistry, "poll") ||
    Object.hasOwn(adapterRegistry, "provider")
  ) {
    throw runtimeError(
      "ADAPTER_REGISTRY_NOT_AVAILABLE",
      "adapter registry is invalid",
      { fieldName: "adapterRegistry" }
    );
  }
  return adapterRegistry;
}

function validateLogger(logger) {
  if (logger === undefined || logger === null) {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }
  for (const level of ["info", "warn", "error"]) {
    if (typeof logger[level] !== "function") {
      throw runtimeError(
        "INVALID_WORKER_RUNTIME_DEPENDENCY",
        "logger is invalid",
        { fieldName: "logger" }
      );
    }
  }
  return logger;
}

function validateClock(clock) {
  if (clock === undefined || clock === null) {
    return { now: () => new Date() };
  }
  if (typeof clock.now !== "function") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_DEPENDENCY",
      "clock is invalid",
      { fieldName: "clock" }
    );
  }
  return clock;
}

function validateTimers(timers) {
  if (timers === undefined || timers === null) {
    return {
      setTimeout: global.setTimeout.bind(global),
      clearTimeout: global.clearTimeout.bind(global),
    };
  }
  if (
    typeof timers.setTimeout !== "function" ||
    typeof timers.clearTimeout !== "function"
  ) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_DEPENDENCY",
      "timers are invalid",
      { fieldName: "timers" }
    );
  }
  return timers;
}

function validateCompletionCycle(completionCycle) {
  if (completionCycle === undefined || completionCycle === null) {
    return runCodeClipProviderPollingDeliveryCompletionCycle;
  }
  if (typeof completionCycle !== "function") {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_DEPENDENCY",
      "completionCycle is invalid",
      { fieldName: "completionCycle" }
    );
  }
  return completionCycle;
}

function isoFromClock(clock) {
  const value = clock.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw runtimeError(
      "INVALID_WORKER_RUNTIME_DEPENDENCY",
      "clock returned invalid time",
      { fieldName: "clock" }
    );
  }
  return date.toISOString();
}

function durationBetween(startedAt, completedAt) {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
}

function sanitizeCycleSummary(summary = {}) {
  return {
    ok: summary.ok === true,
    status:
      typeof summary.status === "string"
        ? summary.status.slice(0, 40)
        : "unknown",
    scanned: Number.isSafeInteger(summary.scanned) ? summary.scanned : 0,
    attempted: Number.isSafeInteger(summary.attempted) ? summary.attempted : 0,
    succeeded: Number.isSafeInteger(summary.succeeded) ? summary.succeeded : 0,
    failed: Number.isSafeInteger(summary.failed) ? summary.failed : 0,
    skipped: Number.isSafeInteger(summary.skipped) ? summary.skipped : 0,
    durationMs: Number.isSafeInteger(summary.durationMs)
      ? summary.durationMs
      : 0,
  };
}

function sanitizeErrorCode(error) {
  return String(error?.code || error?.name || "WORKER_RUNTIME_ERROR").slice(
    0,
    80
  );
}

const SCAN_STAGE_ALLOWLIST = Object.freeze(
  new Set([
    "due_source_scan_enter",
    "due_source_query_start",
    "due_source_query_failed",
    "due_source_row_mapping_failed",
    "due_source_scan_failed",
  ])
);

const QUERY_CLIENT_KIND_ALLOWLIST = Object.freeze(
  new Set(["pg_pool", "pg_pool_client", "query_client", "unknown"])
);

const SYSCALL_PATTERN = /^[a-z][a-z0-9_]{0,79}$/i;

const CYCLE_FAILED_DIAGNOSTIC_KEYS = Object.freeze([
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
]);

function sanitizeString80(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim().slice(0, 80);
  return text || null;
}

function sanitizeErrnoValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (Math.abs(value) > 1_000_000) return null;
    return value;
  }
  return sanitizeString80(value);
}

function sanitizeSyscallValue(value) {
  const syscall = sanitizeString80(value);
  if (!syscall || !SYSCALL_PATTERN.test(syscall)) return null;
  return syscall;
}

function sanitizePoolCountValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return null;
  return value;
}

function sanitizeElapsedMsValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return Math.min(value, 3_600_000);
}

/**
 * Pull only allowlisted safe diagnostic fields from a worker error.
 * Never copies message, stack, SQL, host, or raw cause objects.
 */
function extractSafeCycleFailureDiagnostics(error) {
  if (!error || typeof error !== "object") return {};
  const out = {};

  const underlyingCode = sanitizeString80(error.underlyingCode);
  const underlyingName = sanitizeString80(error.underlyingName);
  const underlyingErrno = sanitizeErrnoValue(error.underlyingErrno);
  const underlyingSyscall = sanitizeSyscallValue(error.underlyingSyscall);
  const underlyingConstructor = sanitizeString80(error.underlyingConstructor);
  const causeCode = sanitizeString80(error.causeCode);
  const causeName = sanitizeString80(error.causeName);
  const causeErrno = sanitizeErrnoValue(error.causeErrno);
  const causeSyscall = sanitizeSyscallValue(error.causeSyscall);
  const scanStageRaw = sanitizeString80(error.scanStage);
  const scanStage =
    scanStageRaw && SCAN_STAGE_ALLOWLIST.has(scanStageRaw) ? scanStageRaw : null;
  const queryClientKindRaw = sanitizeString80(error.queryClientKind);
  const queryClientKind =
    queryClientKindRaw && QUERY_CLIENT_KIND_ALLOWLIST.has(queryClientKindRaw)
      ? queryClientKindRaw
      : null;
  const poolTotalCount = sanitizePoolCountValue(error.poolTotalCount);
  const poolIdleCount = sanitizePoolCountValue(error.poolIdleCount);
  const poolWaitingCount = sanitizePoolCountValue(error.poolWaitingCount);
  const dueSourceQueryElapsedMs = sanitizeElapsedMsValue(
    error.dueSourceQueryElapsedMs
  );

  if (underlyingCode) out.underlyingCode = underlyingCode;
  if (underlyingName) out.underlyingName = underlyingName;
  if (underlyingErrno !== null && underlyingErrno !== undefined) {
    out.underlyingErrno = underlyingErrno;
  }
  if (underlyingSyscall) out.underlyingSyscall = underlyingSyscall;
  if (underlyingConstructor) out.underlyingConstructor = underlyingConstructor;
  if (causeCode) out.causeCode = causeCode;
  if (causeName) out.causeName = causeName;
  if (causeErrno !== null && causeErrno !== undefined) {
    out.causeErrno = causeErrno;
  }
  if (causeSyscall) out.causeSyscall = causeSyscall;
  if (scanStage) out.scanStage = scanStage;
  if (queryClientKind) out.queryClientKind = queryClientKind;
  if (poolTotalCount !== null) out.poolTotalCount = poolTotalCount;
  if (poolIdleCount !== null) out.poolIdleCount = poolIdleCount;
  if (poolWaitingCount !== null) out.poolWaitingCount = poolWaitingCount;
  if (dueSourceQueryElapsedMs !== null) {
    out.dueSourceQueryElapsedMs = dueSourceQueryElapsedMs;
  }
  return out;
}

function createController() {
  if (typeof AbortController === "function") {
    return new AbortController();
  }
  const signal = { aborted: false };
  return {
    signal,
    abort() {
      signal.aborted = true;
    },
  };
}

function createCodeClipProviderPollingWorkerRuntime(
  config,
  {
    queryClient,
    adapterRegistry,
    logger,
    clock,
    timers,
    completionCycle,
  } = {}
) {
  const normalized = validateConfig(config);
  const pool = requirePool(queryClient);
  const registry = validateRegistry(adapterRegistry);
  const log = validateLogger(logger);
  const runtimeClock = validateClock(clock);
  const runtimeTimers = validateTimers(timers);
  const runCompletionCycle = validateCompletionCycle(completionCycle);

  let state = "idle";
  let startedAt = null;
  let stoppedAt = null;
  let timer = null;
  let activeCycle = null;
  let activeController = null;
  let cycleSequence = 0;
  let stopPromise = null;
  let lastCycleStartedAt = null;
  let lastCycleCompletedAt = null;
  let lastCycleStatus = null;
  let lastErrorCode = null;
  let cyclesStarted = 0;
  let cyclesCompleted = 0;
  let cyclesFailed = 0;

  function safeLog(level, event, fields = {}) {
    const safe = {
      provider: normalized.provider,
      environment: normalized.environment,
    };
    for (const key of [
      "cycleNumber",
      "status",
      "scanned",
      "attempted",
      "succeeded",
      "failed",
      "skipped",
      "durationMs",
      "errorCode",
      ...CYCLE_FAILED_DIAGNOSTIC_KEYS,
      "state",
    ]) {
      if (fields[key] !== undefined && fields[key] !== null) {
        safe[key] = fields[key];
      }
    }
    log[level](event, safe);
  }

  function clearScheduledTimer() {
    if (timer !== null) {
      runtimeTimers.clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(delayMs) {
    if (state !== "running" || normalized.oneShot) return;
    clearScheduledTimer();
    timer = runtimeTimers.setTimeout(() => {
      timer = null;
      void runLoopCycle();
    }, delayMs);
  }

  function executeCycle() {
    if (activeCycle) return activeCycle;

    const cycleNumber = cycleSequence + 1;
    cycleSequence = cycleNumber;
    cyclesStarted += 1;
    lastCycleStartedAt = isoFromClock(runtimeClock);
    activeController = createController();
    safeLog("info", "provider_polling_cycle_started", { cycleNumber });

    activeCycle = runCodeClipProviderPollingWorkerCycle(
      {
        provider: normalized.provider,
        environment: normalized.environment,
        limit: normalized.limit,
        concurrency: normalized.concurrency,
        ownerPrefix: normalized.ownerPrefix,
        leaseMs: normalized.leaseMs,
        now: lastCycleStartedAt,
        signal: activeController.signal,
      },
      {
        queryClient: pool,
        adapterRegistry: registry,
      }
    )
      .then(async (summary) => {
        const completionSummary = await runCompletionCycle(
          {
            provider: normalized.provider,
            environment: normalized.environment,
            limit: normalized.limit,
          },
          {
            queryClient: pool,
            logger: log,
          }
        );
        cyclesCompleted += 1;
        lastCycleCompletedAt = isoFromClock(runtimeClock);
        lastCycleStatus =
          typeof summary?.status === "string" ? summary.status : "completed";
        lastErrorCode = null;
        safeLog("info", "provider_polling_cycle_completed", {
          cycleNumber,
          ...sanitizeCycleSummary(summary),
        });
        safeLog("info", "provider_polling_completion_completed", {
          cycleNumber,
          status: "completed",
          attempted: completionSummary?.selected || 0,
          succeeded: completionSummary?.completed || 0,
          failed:
            (completionSummary?.retryableFailed || 0) +
            (completionSummary?.terminalFailed || 0),
          skipped: completionSummary?.skipped || 0,
        });
        return {
          ...summary,
          completion: {
            selected: completionSummary?.selected || 0,
            completed: completionSummary?.completed || 0,
            skipped: completionSummary?.skipped || 0,
            retryableFailed: completionSummary?.retryableFailed || 0,
            terminalFailed: completionSummary?.terminalFailed || 0,
          },
        };
      })
      .catch((error) => {
        cyclesFailed += 1;
        lastCycleCompletedAt = isoFromClock(runtimeClock);
        lastCycleStatus = "failed";
        lastErrorCode = sanitizeErrorCode(error);
        const diagnostics = extractSafeCycleFailureDiagnostics(error);
        safeLog("error", "provider_polling_cycle_failed", {
          cycleNumber,
          errorCode: lastErrorCode,
          ...diagnostics,
        });
        return {
          ok: false,
          status: "failed",
          provider: normalized.provider,
          environment: normalized.environment,
          errorCode: lastErrorCode,
          ...diagnostics,
          startedAt: lastCycleStartedAt,
          completedAt: lastCycleCompletedAt,
          durationMs: durationBetween(lastCycleStartedAt, lastCycleCompletedAt),
        };
      })
      .finally(() => {
        activeCycle = null;
        activeController = null;
      });

    return activeCycle;
  }

  async function runLoopCycle() {
    const summary = await executeCycle();
    if (state === "running" && !normalized.oneShot) {
      scheduleNext(summary?.ok === false ? normalized.failureBackoffMs : normalized.intervalMs);
    } else if (normalized.oneShot && state === "running") {
      await stop();
    }
    return summary;
  }

  async function start() {
    if (state === "running") {
      throw runtimeError("WORKER_ALREADY_RUNNING", "worker runtime is running", {
        state,
      });
    }
    if (state === "stopping") {
      throw runtimeError("WORKER_STOPPING", "worker runtime is stopping", {
        state,
      });
    }
    if (!normalized.enabled) {
      state = "stopped";
      stoppedAt = isoFromClock(runtimeClock);
      safeLog("info", "provider_polling_worker_disabled", { state });
      return { ok: true, status: "disabled" };
    }

    state = "running";
    startedAt = isoFromClock(runtimeClock);
    stoppedAt = null;
    safeLog("info", "provider_polling_worker_started", {
      state,
    });

    if (normalized.oneShot) {
      const summary = await runLoopCycle();
      return { ok: summary?.ok !== false, status: "stopped", summary };
    }

    if (normalized.runOnStart) {
      void runLoopCycle();
    } else {
      scheduleNext(normalized.intervalMs);
    }
    return { ok: true, status: "running" };
  }

  function runOnce() {
    if (state === "stopping" || state === "stopped") {
      throw runtimeError("WORKER_NOT_RUNNING", "worker runtime is not runnable", {
        state,
      });
    }
    return executeCycle();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (state === "stopped") {
        return { ok: true, status: "stopped" };
      }
      if (state === "idle") {
        state = "stopped";
        stoppedAt = isoFromClock(runtimeClock);
        return { ok: true, status: "stopped" };
      }

      state = "stopping";
      safeLog("info", "provider_polling_worker_stopping", { state });
      clearScheduledTimer();
      if (activeController) activeController.abort();

      let timedOut = false;
      if (activeCycle) {
        await new Promise((resolve) => {
          const timeout = runtimeTimers.setTimeout(() => {
            timedOut = true;
          }, normalized.shutdownTimeoutMs);
          activeCycle.finally(() => {
            runtimeTimers.clearTimeout(timeout);
            resolve();
          });
        });
      }

      state = "stopped";
      stoppedAt = isoFromClock(runtimeClock);
      safeLog(timedOut ? "warn" : "info", "provider_polling_worker_stopped", {
        state,
        status: timedOut ? "timeout" : "stopped",
      });
      return { ok: !timedOut, status: timedOut ? "timeout" : "stopped" };
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  function getStatus() {
    return Object.freeze({
      state,
      startedAt,
      stoppedAt,
      cycleRunning: Boolean(activeCycle),
      cyclesStarted,
      cyclesCompleted,
      cyclesFailed,
      lastCycleStartedAt,
      lastCycleCompletedAt,
      lastCycleStatus,
      lastErrorCode,
    });
  }

  return Object.freeze({
    start,
    stop,
    runOnce,
    getStatus,
  });
}

module.exports = {
  CodeClipProviderPollingWorkerRuntimeError,
  createCodeClipProviderPollingWorkerRuntime,
  loadCodeClipProviderPollingWorkerConfig,
};
