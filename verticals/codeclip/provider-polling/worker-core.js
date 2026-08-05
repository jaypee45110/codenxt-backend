/**
 * codeClip generic provider polling worker core (F3A).
 *
 * Runs one bounded cycle: list due poll sources, invoke the existing generic
 * polling service per source, and return a safe summary. No interval loop,
 * executable entrypoint, process signal handlers, logging, routes, or deploy.
 */

const crypto = require("node:crypto");

const {
  listDueCodeClipProviderPollSources,
} = require("../provider-poll-sources");
const {
  pollCodeClipProviderSource,
} = require("./service");
const {
  createCodeClipProductionPollAdapterRegistry,
} = require("./production-adapter-registry");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const DEFAULT_OWNER_PREFIX = "codeclip.provider.poll.worker";
const OWNER_PREFIX_MAX = 64;
const OWNER_MAX = 128;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 300_000;

class CodeClipProviderPollingWorkerCoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingWorkerCoreError";
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

function workerError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "classification"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 100);
      }
    }
  }
  return new CodeClipProviderPollingWorkerCoreError(code, message, safe);
}

function normalizeOptionalProvider(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "provider is invalid", {
      fieldName: "provider",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 64 ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)
  ) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "provider is invalid", {
      fieldName: "provider",
    });
  }
  return normalized;
}

function normalizeOptionalEnvironment(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "sandbox" && normalized !== "production") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return normalized;
}

function normalizePositiveInteger(value, { fieldName, defaultValue, max }) {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > max) {
    throw workerError(
      "INVALID_WORKER_CYCLE_INPUT",
      `${fieldName} is out of range`,
      { fieldName }
    );
  }
  return candidate;
}

function normalizeOptionalLeaseMs(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "leaseMs is invalid", {
      fieldName: "leaseMs",
    });
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_LEASE_MS ||
    value > MAX_LEASE_MS
  ) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "leaseMs is out of range", {
      fieldName: "leaseMs",
    });
  }
  return value;
}

function normalizeOwnerPrefix(value) {
  const candidate = value === undefined ? DEFAULT_OWNER_PREFIX : value;
  if (typeof candidate !== "string") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "ownerPrefix is invalid", {
      fieldName: "ownerPrefix",
    });
  }
  const normalized = candidate.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > OWNER_PREFIX_MAX ||
    !OWNER_PATTERN.test(normalized)
  ) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "ownerPrefix is invalid", {
      fieldName: "ownerPrefix",
    });
  }
  return normalized;
}

function normalizeOptionalNow(value) {
  if (value === undefined) return null;
  if (value === null || value === "") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "now is invalid", {
      fieldName: "now",
    });
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "now is invalid", {
      fieldName: "now",
    });
  }
  return new Date(ms).toISOString();
}

function normalizeOptionalSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (typeof signal !== "object" && typeof signal !== "function") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "signal is invalid", {
      fieldName: "signal",
    });
  }
  if (typeof signal.aborted !== "boolean") {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "signal is invalid", {
      fieldName: "signal",
    });
  }
  return signal;
}

function requirePool(queryClient) {
  if (
    !queryClient ||
    typeof queryClient.connect !== "function" ||
    typeof queryClient.query !== "function"
  ) {
    throw workerError(
      "DATABASE_UNAVAILABLE",
      "polling worker core requires a database pool"
    );
  }
  return queryClient;
}

function resolveAdapterRegistry(adapterRegistry) {
  const registry =
    adapterRegistry === undefined
      ? createCodeClipProductionPollAdapterRegistry()
      : adapterRegistry;
  if (!registry || typeof registry.get !== "function") {
    throw workerError(
      "ADAPTER_REGISTRY_NOT_AVAILABLE",
      "adapter registry is not available",
      { fieldName: "adapterRegistry" }
    );
  }
  if (
    Object.hasOwn(registry, "poll") ||
    Object.hasOwn(registry, "provider")
  ) {
    throw workerError(
      "ADAPTER_REGISTRY_NOT_AVAILABLE",
      "adapter registry is invalid",
      { fieldName: "adapterRegistry" }
    );
  }
  if (registry.list !== undefined && typeof registry.list !== "function") {
    throw workerError(
      "ADAPTER_REGISTRY_NOT_AVAILABLE",
      "adapter registry is invalid",
      { fieldName: "adapterRegistry" }
    );
  }
  return registry;
}

function startedAtForClock(nowIso) {
  return nowIso || new Date().toISOString();
}

function completedAtForClock(nowIso) {
  return nowIso || new Date().toISOString();
}

function durationBetween(startedAt, completedAt) {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
}

function makeCycleNonce() {
  return crypto.randomBytes(5).toString("hex");
}

function buildOwner({ ownerPrefix, sourceId, nonce, ordinal }) {
  const cleanId = String(sourceId || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "source";
  const cleanOrdinal = String(ordinal + 1);
  let owner = `${ownerPrefix}:${cleanId}:${cleanOrdinal}:${nonce}`;
  if (owner.length > OWNER_MAX) {
    owner = `${ownerPrefix.slice(0, 48)}:${cleanOrdinal}:${nonce}`;
  }
  if (!OWNER_PATTERN.test(owner) || owner.length > OWNER_MAX) {
    throw workerError("INVALID_WORKER_CYCLE_INPUT", "ownerPrefix is invalid", {
      fieldName: "ownerPrefix",
    });
  }
  return owner;
}

function sourceIdFrom(source) {
  if (!source || typeof source !== "object") return null;
  const id = source.id ?? source.pollSourceId ?? source.sourceId;
  if (id === undefined || id === null || id === "") return null;
  return String(id);
}

function skippedItem(sourceId, classification = "worker_aborted") {
  return {
    sourceId: sourceId ? String(sourceId) : null,
    status: "skipped",
    classification,
    detectionsCount: 0,
    deliveriesCount: 0,
    pageComplete: null,
    nextPollAt: null,
  };
}

function summarizeServiceResult(sourceId, result) {
  const classification =
    typeof result?.classification === "string"
      ? result.classification.slice(0, 80)
      : result?.ok === true
        ? "success"
        : "unknown";
  const detectionsCount = Number.isSafeInteger(result?.detectionCount)
    ? result.detectionCount
    : 0;
  const createdCount = Number.isSafeInteger(result?.createdCount)
    ? result.createdCount
    : 0;
  const existingCount = Number.isSafeInteger(result?.existingCount)
    ? result.existingCount
    : 0;
  const deliveryIds = Array.isArray(result?.deliveryIds)
    ? result.deliveryIds.length
    : 0;
  const deliveriesCount =
    createdCount + existingCount > 0 ? createdCount + existingCount : deliveryIds;

  if (result?.ok === true) {
    return {
      sourceId,
      status: "succeeded",
      classification,
      detectionsCount,
      deliveriesCount,
      pageComplete:
        typeof result.pageComplete === "boolean" ? result.pageComplete : null,
      nextPollAt: result.nextPollAt || null,
    };
  }

  if (
    classification === "claim_contention" ||
    classification === "source_not_claimable" ||
    classification === "source_not_due"
  ) {
    return {
      sourceId,
      status: "skipped",
      classification,
      detectionsCount: 0,
      deliveriesCount: 0,
      pageComplete: null,
      nextPollAt: result?.nextPollAt || null,
    };
  }

  return {
    sourceId,
    status: "failed",
    classification,
    detectionsCount: 0,
    deliveriesCount: 0,
    pageComplete: null,
    nextPollAt: result?.nextPollAt || null,
  };
}

function failedItem(sourceId, classification) {
  return {
    sourceId,
    status: "failed",
    classification,
    detectionsCount: 0,
    deliveriesCount: 0,
    pageComplete: null,
    nextPollAt: null,
  };
}

function summarizeCounts(items) {
  return items.reduce(
    (acc, item) => {
      if (item.status === "succeeded") acc.succeeded += 1;
      else if (item.status === "skipped") acc.skipped += 1;
      else acc.failed += 1;
      if (item.status !== "skipped") acc.attempted += 1;
      return acc;
    },
    { attempted: 0, succeeded: 0, failed: 0, skipped: 0 }
  );
}

function mapScanError(error) {
  if (error instanceof CodeClipProviderPollingWorkerCoreError) throw error;
  if (error && error.code === "DATABASE_UNAVAILABLE") {
    throw workerError("DATABASE_UNAVAILABLE", "due source scan failed");
  }
  throw workerError("DUE_SOURCE_SCAN_FAILED", "due source scan failed");
}

async function runCodeClipProviderPollingWorkerCycle(
  {
    provider,
    environment,
    limit,
    concurrency,
    ownerPrefix,
    leaseMs,
    now,
    signal,
  } = {},
  {
    queryClient,
    adapterRegistry,
  } = {}
) {
  const normalized = {
    provider: normalizeOptionalProvider(provider),
    environment: normalizeOptionalEnvironment(environment),
    limit: normalizePositiveInteger(limit, {
      fieldName: "limit",
      defaultValue: DEFAULT_LIMIT,
      max: MAX_LIMIT,
    }),
    concurrency: normalizePositiveInteger(concurrency, {
      fieldName: "concurrency",
      defaultValue: DEFAULT_CONCURRENCY,
      max: MAX_CONCURRENCY,
    }),
    ownerPrefix: normalizeOwnerPrefix(ownerPrefix),
    leaseMs: normalizeOptionalLeaseMs(leaseMs),
    now: normalizeOptionalNow(now),
    signal: normalizeOptionalSignal(signal),
  };

  const pool = requirePool(queryClient);
  const registry = resolveAdapterRegistry(adapterRegistry);
  const startedAt = startedAtForClock(normalized.now);

  if (normalized.signal?.aborted === true) {
    const completedAt = completedAtForClock(normalized.now);
    return {
      ok: true,
      status: "aborted",
      provider: normalized.provider,
      environment: normalized.environment,
      scanned: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      startedAt,
      completedAt,
      durationMs: durationBetween(startedAt, completedAt),
      items: [],
    };
  }

  let due;
  try {
    due = await listDueCodeClipProviderPollSources(
      {
        limit: normalized.limit,
        provider: normalized.provider || undefined,
        environment: normalized.environment || undefined,
        now: normalized.now || undefined,
      },
      { queryClient: pool }
    );
  } catch (error) {
    mapScanError(error);
  }

  const sources = Array.isArray(due?.items) ? due.items : [];
  const items = new Array(sources.length);
  const nonce = makeCycleNonce();
  let nextIndex = 0;

  async function runOne(index) {
    const source = sources[index];
    const sourceId = sourceIdFrom(source);
    if (!sourceId) {
      items[index] = failedItem(null, "invalid_source");
      return;
    }
    if (normalized.signal?.aborted === true) {
      items[index] = skippedItem(sourceId);
      return;
    }
    let owner;
    try {
      owner = buildOwner({
        ownerPrefix: normalized.ownerPrefix,
        sourceId,
        nonce,
        ordinal: index,
      });
    } catch (error) {
      if (error instanceof CodeClipProviderPollingWorkerCoreError) {
        items[index] = failedItem(sourceId, "WORKER_SOURCE_FAILED");
        return;
      }
      throw error;
    }

    try {
      const result = await pollCodeClipProviderSource({
        sourceId,
        owner,
        leaseMs: normalized.leaseMs,
        now: normalized.now || undefined,
        limit: normalized.limit,
        queryClient: pool,
        adapterRegistry: registry,
      });
      items[index] = summarizeServiceResult(sourceId, result);
    } catch {
      items[index] = failedItem(sourceId, "WORKER_SOURCE_FAILED");
    }
  }

  async function worker() {
    while (true) {
      if (normalized.signal?.aborted === true) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sources.length) return;
      await runOne(index);
    }
  }

  const workerCount = Math.min(normalized.concurrency, sources.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (let index = 0; index < sources.length; index += 1) {
    if (!items[index]) {
      items[index] = skippedItem(sourceIdFrom(sources[index]));
    }
  }

  const counts = summarizeCounts(items);
  const completedAt = completedAtForClock(normalized.now);
  const status = normalized.signal?.aborted === true ? "aborted" : "completed";

  return {
    ok: true,
    status,
    provider: normalized.provider,
    environment: normalized.environment,
    scanned: sources.length,
    attempted: counts.attempted,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
    startedAt,
    completedAt,
    durationMs: durationBetween(startedAt, completedAt),
    items,
  };
}

module.exports = {
  CodeClipProviderPollingWorkerCoreError,
  runCodeClipProviderPollingWorkerCycle,
};
