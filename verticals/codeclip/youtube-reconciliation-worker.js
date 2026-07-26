const crypto = require("node:crypto");

const database = require("../../db");
const {
  ATOM_SOURCE,
  buildDeliveryIdentity,
  discoverEligibleTargets,
  fetchAtomUploads,
  normalizeUploadEntry,
} = require("./youtube-reconciliation-scanner");
const {
  processEntry: processCodeClipYouTubeWebSubEntry,
} = require("./youtube-websub-notification");

const ATOM_RECONCILIATION_SOURCE = "atom_reconciliation";
const WORKER_VERSION = 1;

const DEFAULTS = Object.freeze({
  intervalMs: 5 * 60 * 1000,
  jitterMs: 60 * 1000,
  graceMs: 3 * 60 * 1000,
  maxEntriesPerSubscription: 10,
  maxAutoProcessAgeMs: 24 * 60 * 60 * 1000,
  lookbackHours: 72,
  globalConcurrency: 2,
  claimLeaseMs: 5 * 60 * 1000,
  dryRun: false,
});

function parseBoundedInteger(value, name, defaultValue, { min, max }) {
  const raw = value === undefined || value === null || value === "" ? defaultValue : value;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  throw new Error("dryRun must be a boolean");
}

function loadCodeClipYouTubeReconciliationWorkerConfig(env = process.env) {
  return {
    intervalMs: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS,
      "intervalMs",
      DEFAULTS.intervalMs,
      { min: 60_000, max: 24 * 60 * 60 * 1000 }
    ),
    jitterMs: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS,
      "jitterMs",
      DEFAULTS.jitterMs,
      { min: 0, max: 10 * 60 * 1000 }
    ),
    graceMs: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_GRACE_MS,
      "graceMs",
      DEFAULTS.graceMs,
      { min: 60_000, max: 60 * 60 * 1000 }
    ),
    maxEntriesPerSubscription: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_MAX_ENTRIES,
      "maxEntriesPerSubscription",
      DEFAULTS.maxEntriesPerSubscription,
      { min: 1, max: 50 }
    ),
    maxAutoProcessAgeMs: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_MAX_AUTO_PROCESS_AGE_MS,
      "maxAutoProcessAgeMs",
      DEFAULTS.maxAutoProcessAgeMs,
      { min: 10 * 60 * 1000, max: 7 * 24 * 60 * 60 * 1000 }
    ),
    lookbackHours: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_LOOKBACK_HOURS,
      "lookbackHours",
      DEFAULTS.lookbackHours,
      { min: 1, max: 24 * 30 }
    ),
    globalConcurrency: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_GLOBAL_CONCURRENCY,
      "globalConcurrency",
      DEFAULTS.globalConcurrency,
      { min: 1, max: 10 }
    ),
    claimLeaseMs: parseBoundedInteger(
      env.CODECLIP_YOUTUBE_RECONCILIATION_CLAIM_LEASE_MS,
      "claimLeaseMs",
      DEFAULTS.claimLeaseMs,
      { min: 60_000, max: 60 * 60 * 1000 }
    ),
    dryRun: parseBoolean(env.CODECLIP_YOUTUBE_RECONCILIATION_DRY_RUN, DEFAULTS.dryRun),
  };
}

function isoNow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("now is invalid");
  return date.toISOString();
}

function channelFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function sanitizeWorkerLogEvent(event = {}) {
  const safe = {};
  for (const key of ["eventCode", "videoId", "outcome", "detectionSource", "initialDeliverySource", "reason"]) {
    if (event[key] !== undefined && event[key] !== null) safe[key] = String(event[key]).slice(0, 160);
  }
  if (event.channelId || event.providerAccountId) {
    safe.channelFingerprint = channelFingerprint(event.channelId || event.providerAccountId);
  } else if (event.channelFingerprint) {
    safe.channelFingerprint = String(event.channelFingerprint).slice(0, 32);
  }
  return safe;
}

function createSummary() {
  return {
    subscriptionsDiscovered: 0,
    eligibleSubscriptions: 0,
    skippedSubscriptions: 0,
    claimsAcquired: 0,
    claimsContended: 0,
    feedsFetched: 0,
    uploadsExamined: 0,
    eligibleForProcessing: 0,
    insideGraceWindow: 0,
    beforeActivation: 0,
    olderThanAutoProcessWindow: 0,
    existingCompleted: 0,
    existingInFlight: 0,
    processedCompleted: 0,
    processedRetryableFailed: 0,
    processedTerminalFailed: 0,
    invalid: 0,
    sourceFailures: 0,
    targetFailures: 0,
    observabilityFailures: 0,
    durationMs: 0,
  };
}

function createCodeClipYouTubeReconciliationWorkerState() {
  const claims = new Map();
  return {
    running: false,
    shuttingDown: false,
    claimSubscription({ callbackId, claimId, now, leaseMs }) {
      const current = claims.get(callbackId);
      if (current && Date.parse(current.expiresAt) > Date.parse(now)) {
        return { status: "contended", claim: current };
      }
      const claim = {
        callbackId,
        claimId,
        claimedAt: now,
        expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
      };
      claims.set(callbackId, claim);
      return { status: "claimed", claim };
    },
    releaseSubscriptionClaim({ callbackId, claimId }) {
      const current = claims.get(callbackId);
      if (!current || current.claimId !== claimId) return { status: "not_owner" };
      claims.delete(callbackId);
      return { status: "released" };
    },
  };
}

function deliveryState(delivery) {
  if (!delivery) return "missing";
  const state = database.classifyCodeClipProviderDeliveryOperationalState(delivery);
  if (state === "completed") return "existing_completed";
  if (state === "processing" || delivery.processingState === "processing") return "existing_in_flight";
  return "existing_in_flight";
}

function normalizeProcessResult(result = {}) {
  if (result.status === "completed" || result.status === "duplicate") return "completed";
  if (result.status === "failed") return "retryable_failed";
  return "terminal_failed";
}

async function processCandidate({ target, candidate, input, report, now }) {
  const summary = report.summary;
  const delivery = await input.getDeliveryByIdentity(buildDeliveryIdentity(candidate), input.queryClient);
  const state = deliveryState(delivery);
  if (state === "existing_completed") {
    summary.existingCompleted += 1;
    const deliveryReport = {
      ...sanitizeWorkerLogEvent(candidate),
      detectionSource: ATOM_SOURCE,
      initialDeliverySource: delivery.initialDeliverySource || "websub",
      outcome: "existing_completed",
    };
    report.deliveries.push(deliveryReport);
    await recordDetectionObservation(input, candidate, deliveryReport, now, report);
    return;
  }
  if (state === "existing_in_flight") {
    summary.existingInFlight += 1;
    const deliveryReport = {
      ...sanitizeWorkerLogEvent(candidate),
      detectionSource: ATOM_SOURCE,
      initialDeliverySource: delivery.initialDeliverySource || null,
      outcome: "existing_in_flight",
    };
    report.deliveries.push(deliveryReport);
    await recordDetectionObservation(input, candidate, deliveryReport, now, report);
    return;
  }
  summary.eligibleForProcessing += 1;
  if (report.mode === "dry_run") {
    report.deliveries.push({
      ...sanitizeWorkerLogEvent(candidate),
      detectionSource: ATOM_SOURCE,
      initialDeliverySource: ATOM_RECONCILIATION_SOURCE,
      outcome: "eligible_dry_run",
    });
    return;
  }
  const result = await input.processEntry({
    subscription: target.subscription,
    binding: target.binding,
    event: target.event,
    entry: candidate,
    now,
    rawBody: Buffer.from(JSON.stringify({ source: ATOM_RECONCILIATION_SOURCE }), "utf8"),
    queryClient: input.queryClient,
    dependencies: { ...input, source: ATOM_RECONCILIATION_SOURCE },
  });
  const outcome = normalizeProcessResult(result);
  if (outcome === "completed") summary.processedCompleted += 1;
  else if (outcome === "retryable_failed") summary.processedRetryableFailed += 1;
  else summary.processedTerminalFailed += 1;
  const deliveryReport = {
    ...sanitizeWorkerLogEvent(candidate),
    detectionSource: ATOM_SOURCE,
    initialDeliverySource: ATOM_RECONCILIATION_SOURCE,
    outcome,
  };
  report.deliveries.push(deliveryReport);
  await recordDetectionObservation(input, candidate, deliveryReport, now, report);
}

async function recordDetectionObservation(input, candidate, deliveryReport, now, report) {
  const recorder =
    input.recordDetectionObservation ||
    database.recordCodeClipYouTubeReconciliationDetectionObservation;
  if (typeof recorder !== "function") return;
  try {
    await recorder({
      eventCode: candidate.eventCode,
      channelFingerprint: deliveryReport.channelFingerprint,
      videoId: candidate.videoId,
      detectionSource: ATOM_SOURCE,
      outcome: deliveryReport.outcome,
      initialDeliverySource: deliveryReport.initialDeliverySource || null,
      observedAt: now.toISOString(),
      queryClient: input.queryClient,
    });
  } catch {
    report.summary.observabilityFailures += 1;
    input.logger?.warn?.({ reason: "detection_observation_failed" });
  }
}

async function recordHeartbeat(input, report) {
  const heartbeat =
    input.recordHeartbeat || database.recordCodeClipYouTubeReconciliationWorkerHeartbeat;
  if (typeof heartbeat !== "function") return;
  const heartbeatSummary = { ...report.summary };
  try {
    await heartbeat({
      workerId: input.workerId || "codeclip-youtube-reconciliation-worker",
      status: report.errors.length ? "warning" : "ok",
      summary: heartbeatSummary,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      now: report.completedAt,
      queryClient: input.queryClient,
    });
  } catch {
    report.summary.observabilityFailures += 1;
    input.logger?.warn?.({ reason: "worker_heartbeat_failed" });
  }
}

async function processTarget(target, input, report, now) {
  const summary = report.summary;
  const config = input.config;
  const claimId = crypto.randomBytes(12).toString("base64url");
  let claim = null;
  if (report.mode !== "dry_run") {
    const claimResult = await input.claimSubscription({
      callbackId: target.callbackId,
      claimId,
      now: now.toISOString(),
      leaseMs: config.claimLeaseMs,
      queryClient: input.queryClient,
    });
    if (claimResult.status !== "claimed") {
      summary.claimsContended += 1;
      return;
    }
    claim = claimResult.claim || { callbackId: target.callbackId, claimId };
    summary.claimsAcquired += 1;
  }
  try {
    let sourceResult;
    try {
      sourceResult = await input.fetchUploads(target, {
        now,
        limit: config.maxEntriesPerSubscription,
        lookbackHours: config.lookbackHours,
      });
      summary.feedsFetched += 1;
    } catch {
      summary.sourceFailures += 1;
      report.errors.push({ code: "source_unavailable", message: "Upload source is unavailable" });
      return;
    }
    const uploads = [...(sourceResult.uploads || [])]
      .slice(0, config.maxEntriesPerSubscription)
      .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    for (const entry of uploads) {
      summary.uploadsExamined += 1;
      let candidate;
      try {
        candidate = normalizeUploadEntry(entry, target, ATOM_SOURCE, sourceResult.observedAt || now.toISOString());
      } catch {
        summary.invalid += 1;
        continue;
      }
      const published = Date.parse(candidate.publishedAt);
      const boundary = Date.parse(target.activationBoundaryAt);
      const age = now.getTime() - published;
      if (!Number.isFinite(published) || published <= boundary) {
        summary.beforeActivation += 1;
        continue;
      }
      if (age < config.graceMs) {
        summary.insideGraceWindow += 1;
        continue;
      }
      if (age > config.maxAutoProcessAgeMs) {
        summary.olderThanAutoProcessWindow += 1;
        continue;
      }
      await processCandidate({ target, candidate, input, report, now });
    }
  } finally {
    if (claim) {
      await input.releaseSubscriptionClaim({
        callbackId: target.callbackId,
        claimId: claim.claimId || claimId,
        queryClient: input.queryClient,
      });
    }
  }
}

async function runBoundedConcurrency(items, limit, worker) {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
}

function sortDeliveryReports(deliveries) {
  deliveries.sort((left, right) => {
    const eventCompare = String(left.eventCode || "").localeCompare(String(right.eventCode || ""));
    if (eventCompare !== 0) return eventCompare;
    const videoCompare = String(left.videoId || "").localeCompare(String(right.videoId || ""));
    if (videoCompare !== 0) return videoCompare;
    return String(left.outcome || "").localeCompare(String(right.outcome || ""));
  });
}

function targetFailureReport(target) {
  return {
    code: "target_failed",
    message: "Target processing failed",
    eventCode: String(target?.eventCode || "").slice(0, 160),
    channelFingerprint: channelFingerprint(target?.channelId || target?.providerAccountId || ""),
  };
}

async function processCodeClipYouTubeReconciliationRun(input = {}) {
  const startedMs = Date.now();
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const config = input.config || loadCodeClipYouTubeReconciliationWorkerConfig(input.env || process.env);
  const dryRun = input.dryRun === true || config.dryRun === true;
  const report = {
    version: WORKER_VERSION,
    mode: dryRun ? "dry_run" : "write_enabled",
    startedAt: now.toISOString(),
    completedAt: null,
    summary: createSummary(),
    targets: [],
    deliveries: [],
    errors: [],
  };

  const discovery = await discoverEligibleTargets({
    ...input,
    targetLimit: input.targetLimit || 100,
  });
  report.summary.subscriptionsDiscovered = discovery.eligible.length + discovery.skipped.length;
  report.summary.eligibleSubscriptions = discovery.eligible.length;
  report.summary.skippedSubscriptions = discovery.skipped.length;
  for (const skipped of discovery.skipped) report.targets.push({ eligible: false, reason: skipped.reason });
  for (const error of discovery.errors || []) {
    report.errors.push({ code: error.code, message: error.message });
  }
  const firstEligibleTargetIndex = report.targets.length;
  await runBoundedConcurrency(discovery.eligible, config.globalConcurrency, async (target, index) => {
    const binding = (input.bindingsById && input.bindingsById.get(target.bindingId)) || {
      id: target.bindingId,
      eventCode: target.eventCode,
      providerAccountId: target.providerAccountId,
    };
    const subscription = {
      id: target.subscriptionId,
      callbackId: target.callbackId,
      providerAccountId: target.providerAccountId,
      topic: target.topic,
      status: "active",
      pendingMode: null,
      activationBoundaryAt: target.activationBoundaryAt,
    };
    report.targets[firstEligibleTargetIndex + index] = {
      eligible: true,
      eventCode: target.eventCode,
      channelFingerprint: channelFingerprint(target.channelId),
    };
    try {
      const event = await (input.getEventByCode || database.getCampaignByCode)(target.eventCode);
      const enriched = { ...target, binding, subscription, event: event?.raw_event || event };
      await processTarget(enriched, {
        queryClient: input.queryClient,
        config,
        fetchUploads: input.fetchUploads || ((scanTarget, options) => fetchAtomUploads(scanTarget, options)),
        getDeliveryByIdentity: input.getDeliveryByIdentity || database.getCodeClipProviderDeliveryByIdentity,
        processEntry: input.processEntry || processCodeClipYouTubeWebSubEntry,
        claimSubscription: input.claimSubscription || database.claimCodeClipYouTubeReconciliationSubscription,
        releaseSubscriptionClaim: input.releaseSubscriptionClaim || database.releaseCodeClipYouTubeReconciliationSubscriptionClaim,
        logger: input.logger || console,
        recordDetectionObservation: input.recordDetectionObservation,
      }, report, now);
    } catch {
      report.summary.targetFailures += 1;
      report.errors.push(targetFailureReport(target));
      (input.logger || console)?.warn?.({
        reason: "target_failed",
        eventCode: String(target.eventCode || "").slice(0, 160),
        channelFingerprint: channelFingerprint(target.channelId),
      });
    }
  });
  report.targets = report.targets.filter(Boolean);
  sortDeliveryReports(report.deliveries);
  report.completedAt = isoNow();
  report.summary.durationMs = Date.now() - startedMs;
  await recordHeartbeat(input, report);
  return report;
}

async function runCodeClipYouTubeReconciliationWorkerOnce(input = {}) {
  const workerState = input.workerState || createCodeClipYouTubeReconciliationWorkerState();
  if (workerState.shuttingDown) return { status: "shutdown" };
  if (workerState.running) return { status: "overlap_skipped" };
  workerState.running = true;
  try {
    return await processCodeClipYouTubeReconciliationRun(input);
  } finally {
    workerState.running = false;
  }
}

module.exports = {
  ATOM_RECONCILIATION_SOURCE,
  DEFAULTS,
  WORKER_VERSION,
  createCodeClipYouTubeReconciliationWorkerState,
  loadCodeClipYouTubeReconciliationWorkerConfig,
  processCodeClipYouTubeReconciliationRun,
  runCodeClipYouTubeReconciliationWorkerOnce,
  sanitizeWorkerLogEvent,
};
