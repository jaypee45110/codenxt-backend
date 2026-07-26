const {
  normalizeCodeClipProviderAccountId,
  listCodeClipProviderAccountBindings,
} = require("./provider-account-bindings");
const {
  SUBSCRIPTION_STATUSES,
  listCodeClipYouTubeWebSubSubscriptions,
} = require("./youtube-websub-subscriptions");
const {
  parseCodeClipYouTubeWebSubAtomFeed,
  CodeClipYouTubeWebSubFeedError,
} = require("./youtube-websub-feed");
const {
  eventMatchesBoundProviderEventActivation,
} = require("./provider-activation");
const database = require("../../db");

const SCANNER_VERSION = 1;
const READ_ONLY_MODE = "read_only";
const YOUTUBE_PROVIDER = "youtube";
const YOUTUBE_CHANNEL = "youtube";
const PUBLISHED_VIDEO_EVENT = "published_video";
const ATOM_SOURCE = "atom";
const DATA_API_SOURCE = "data_api";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_LOOKBACK_HOURS = 72;
const MAX_LOOKBACK_HOURS = 24 * 30;

const SAFE_ERROR_MESSAGES = Object.freeze({
  ambiguous_active_subscription: "Target has an ambiguous active subscription state",
  binding_not_active_youtube: "Target binding is not an active codeClip YouTube binding",
  channel_mismatch: "Upload channel identity does not match the target",
  database_lookup_failed: "Delivery lookup failed",
  database_unavailable: "Database access is unavailable",
  invalid_activation_boundary: "Target activation boundary is invalid",
  invalid_argument: "Scanner argument is invalid",
  invalid_candidate: "Candidate could not be safely normalized",
  invalid_now: "Scanner timestamp is invalid",
  invalid_source: "Scanner source is invalid",
  no_active_subscription: "Target has no active matching subscription",
  source_failed: "Upload source failed",
  source_identity_mismatch: "Upload source identity does not match the target",
  source_malformed_response: "Upload source returned a malformed response",
  source_unavailable: "Upload source is unavailable",
  subscription_channel_mismatch: "Subscription channel identity does not match binding identity",
  subscription_pending: "Target subscription is pending",
  subscription_topic_mismatch: "Subscription topic identity does not match binding identity",
  target_discovery_failed: "Target discovery failed",
  unsupported_event_configuration: "Target event is not configured for YouTube published-video activation",
});

class CodeClipYouTubeReconciliationScannerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeReconciliationScannerError";
    this.code = sanitizeErrorCode(code);
    this.safeMessage = SAFE_ERROR_MESSAGES[this.code] || message || "Scanner error";
    this.details = sanitizeErrorDetails(details);
  }
}

function sanitizeErrorCode(code, fallback = "source_failed") {
  const normalized = String(code || fallback).trim().toLowerCase();
  return /^[a-z0-9_:-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function sanitizeReason(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_:-]{1,80}$/.test(normalized) ? normalized : null;
}

function sanitizeErrorDetails(details = {}) {
  const safe = {};
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) {
    safe.httpStatus = details.httpStatus;
  }
  for (const key of ["fieldName", "reason", "sourceCode"]) {
    const value = sanitizeReason(details[key]);
    if (value) safe[key] = value;
  }
  return safe;
}

function sanitizeOperationalError(error, fallbackCode = "source_failed") {
  const code = sanitizeErrorCode(error?.code, fallbackCode);
  return {
    code,
    message: SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES[fallbackCode] || "Scanner operation failed",
    details: sanitizeErrorDetails(error?.details || {}),
  };
}

function scannerError(code, message, details = {}) {
  return new CodeClipYouTubeReconciliationScannerError(code, message, details);
}

function isoNow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw scannerError("invalid_now", "now must be a valid timestamp");
  }
  return date.toISOString();
}

function normalizePositiveInteger(value, fieldName, defaultValue, maxValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw scannerError("invalid_argument", "positive integer expected", { fieldName });
  }
  return Math.min(parsed, maxValue);
}

function normalizeSource(value) {
  const normalized = String(value || ATOM_SOURCE).trim().toLowerCase();
  if (normalized === ATOM_SOURCE || normalized === DATA_API_SOURCE) return normalized;
  throw scannerError("invalid_source", "unsupported source");
}

function normalizeOptionalText(value, fieldName, maxLength = 180) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized) || normalized.length > maxLength) {
    throw scannerError("invalid_argument", "text argument invalid", { fieldName });
  }
  return normalized;
}

function normalizeYouTubeChannelId(value) {
  return normalizeCodeClipProviderAccountId(YOUTUBE_PROVIDER, value);
}

function canonicalUrl(value) {
  try {
    return new URL(String(value || "")).toString();
  } catch {
    return "";
  }
}

function topicChannelId(topic) {
  try {
    return new URL(topic).searchParams.get("channel_id") || "";
  } catch {
    return "";
  }
}

function buildYouTubeAtomFeedUrl(channelId) {
  const normalized = normalizeYouTubeChannelId(channelId);
  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", normalized);
  return url.toString();
}

function buildDeliveryIdentity(candidate) {
  return {
    provider: YOUTUBE_PROVIDER,
    providerAccountId: candidate.providerAccountId,
    eventCode: candidate.eventCode,
    externalMessageId: candidate.externalMessageId,
  };
}

function normalizeUploadEntry(entry, target, source, sourceObservedAt) {
  const channelId = normalizeYouTubeChannelId(entry.channelId || target.channelId);
  const videoId = String(entry.videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(videoId)) {
    throw scannerError("invalid_candidate", "invalid video id", { fieldName: "videoId" });
  }
  if (channelId !== target.channelId || channelId !== target.providerAccountId) {
    throw scannerError("channel_mismatch", "channel mismatch");
  }
  const publishedAt = new Date(entry.publishedAt);
  if (!Number.isFinite(publishedAt.getTime())) {
    throw scannerError("invalid_candidate", "invalid published timestamp", {
      fieldName: "publishedAt",
    });
  }
  const updatedAt = entry.updatedAt ? new Date(entry.updatedAt) : null;
  if (updatedAt && !Number.isFinite(updatedAt.getTime())) {
    throw scannerError("invalid_candidate", "invalid updated timestamp", { fieldName: "updatedAt" });
  }
  const externalMessageId =
    entry.externalMessageId || `youtube:${channelId}:${videoId}:published`;

  return {
    provider: YOUTUBE_PROVIDER,
    providerAccountId: target.providerAccountId,
    channelId,
    eventCode: target.eventCode,
    eventType: PUBLISHED_VIDEO_EVENT,
    videoId,
    title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : null,
    publishedAt: publishedAt.toISOString(),
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    source,
    sourceObservedAt,
    activationBoundaryAt: target.activationBoundaryAt,
    topic: target.topic,
    externalMessageId,
  };
}

function classifyExistingDelivery(delivery) {
  if (!delivery) return "missing";
  const operationalState = database.classifyCodeClipProviderDeliveryOperationalState(delivery);
  if (operationalState === "completed") return "existing_completed";
  if (operationalState === "failed_precommit") return "existing_failed";
  return "existing_incomplete";
}

function summarizeCandidates(candidates) {
  const summary = {
    uploadsExamined: candidates.length,
    uploadsExcludedBeforeActivation: 0,
    existingDeliveries: 0,
    missingCandidates: 0,
    invalidCandidates: 0,
  };

  for (const candidate of candidates) {
    if (candidate.classification === "excluded_before_activation") {
      summary.uploadsExcludedBeforeActivation += 1;
    } else if (candidate.classification === "invalid_candidate") {
      summary.invalidCandidates += 1;
    } else if (candidate.classification === "missing") {
      summary.missingCandidates += 1;
    } else if (String(candidate.classification || "").startsWith("existing_")) {
      summary.existingDeliveries += 1;
    }
  }

  return summary;
}

async function fetchAtomUploads(target, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") {
    throw scannerError("source_unavailable", "fetch unavailable");
  }
  const url = buildYouTubeAtomFeedUrl(target.channelId);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
    });
  } catch {
    throw scannerError("source_unavailable", "fetch failed");
  }
  if (!response || !response.ok) {
    throw scannerError("source_unavailable", "feed request failed", {
      httpStatus: response?.status || null,
    });
  }
  let body;
  try {
    body = await response.text();
  } catch {
    throw scannerError("source_malformed_response", "feed body unavailable");
  }
  let feed;
  try {
    feed = parseCodeClipYouTubeWebSubAtomFeed(body, {
      maxEntries: Math.max(options.limit || DEFAULT_LIMIT, DEFAULT_LIMIT),
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubFeedError) {
      throw scannerError("source_malformed_response", "malformed feed", {
        sourceCode: error.code,
      });
    }
    throw scannerError("source_malformed_response", "malformed feed");
  }
  if (feed.channelId !== target.channelId || canonicalUrl(feed.topic) !== canonicalUrl(target.topic)) {
    throw scannerError("source_identity_mismatch", "source identity mismatch");
  }
  return {
    source: ATOM_SOURCE,
    sourceIdentity: feed.topic,
    observedAt: options.sourceObservedAt || isoNow(options.now),
    uploads: feed.entries,
  };
}

async function fetchDataApiUploads() {
  throw scannerError("source_unavailable", "data api source unavailable");
}

function createUploadSourceAdapter(source, options = {}) {
  const normalized = normalizeSource(source);
  if (normalized === ATOM_SOURCE) {
    return {
      source: ATOM_SOURCE,
      fetchUploads: (target, input = {}) => fetchAtomUploads(target, { ...options, ...input }),
    };
  }
  return {
    source: DATA_API_SOURCE,
    fetchUploads: (target, input = {}) => fetchDataApiUploads(target, { ...options, ...input }),
  };
}

function safeTargetError(target, error, fallbackCode = "target_discovery_failed") {
  const safe = sanitizeOperationalError(error, fallbackCode);
  return {
    code: safe.code,
    message: safe.message,
    target: {
      eventCode: target?.eventCode || null,
      providerAccountId: target?.providerAccountId || null,
      channelId: target?.channelId || null,
    },
    details: safe.details,
  };
}

async function discoverEligibleTargets(options = {}) {
  const queryClient = options.queryClient;
  if (!queryClient || typeof queryClient.query !== "function") {
    throw scannerError("database_unavailable", "query client unavailable");
  }
  const listBindings = options.listBindings || listCodeClipProviderAccountBindings;
  const listSubscriptions =
    options.listSubscriptions || listCodeClipYouTubeWebSubSubscriptions;
  const getEventByCode = options.getEventByCode || database.getCampaignByCode;
  const providerAccountFilter = options.providerAccountId
    ? normalizeYouTubeChannelId(options.providerAccountId)
    : options.channelId
      ? normalizeYouTubeChannelId(options.channelId)
      : null;

  let bindingResult;
  try {
    bindingResult = await listBindings(
      {
        vertical: "codeclip",
        provider: YOUTUBE_PROVIDER,
        channel: YOUTUBE_CHANNEL,
        status: "active",
        eventCode: options.eventCode || undefined,
        limit: options.targetLimit || 100,
      },
      { queryClient }
    );
  } catch (error) {
    throw scannerError("target_discovery_failed", "binding discovery failed", error?.details);
  }

  const bindings = Array.isArray(bindingResult?.items) ? bindingResult.items : [];
  const filteredBindings = providerAccountFilter
    ? bindings.filter((binding) => binding.providerAccountId === providerAccountFilter)
    : bindings;

  const eligible = [];
  const skipped = [];
  const errors = [];

  for (const binding of filteredBindings) {
    const targetBase = {
      eventCode: binding.eventCode,
      providerAccountId: binding.providerAccountId,
      channelId: binding.providerAccountId,
    };
    try {
      if (
        binding.vertical !== "codeclip" ||
        binding.provider !== YOUTUBE_PROVIDER ||
        binding.channel !== YOUTUBE_CHANNEL ||
        binding.status !== "active"
      ) {
        skipped.push({ ...targetBase, reason: "binding_not_active_youtube" });
        continue;
      }
      const channelId = normalizeYouTubeChannelId(binding.providerAccountId);
      const subscriptions = await listSubscriptions(
        {
          providerAccountId: channelId,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
        },
        { queryClient }
      );
      const activeYoutubeSubscriptions = subscriptions.filter(
        (subscription) =>
          subscription.vertical === "codeclip" &&
          subscription.provider === YOUTUBE_PROVIDER &&
          subscription.channel === YOUTUBE_CHANNEL &&
          subscription.status === SUBSCRIPTION_STATUSES.ACTIVE
      );
      if (activeYoutubeSubscriptions.some((subscription) => subscription.providerAccountId !== channelId)) {
        skipped.push({ ...targetBase, reason: "subscription_channel_mismatch" });
        continue;
      }
      const activeSubscriptions = activeYoutubeSubscriptions.filter(
        (subscription) => subscription.providerAccountId === channelId && subscription.pendingMode === null
      );
      if (activeYoutubeSubscriptions.some((subscription) => subscription.pendingMode !== null)) {
        skipped.push({ ...targetBase, reason: "subscription_pending" });
        continue;
      }
      if (activeSubscriptions.length !== 1) {
        skipped.push({
          ...targetBase,
          reason: activeSubscriptions.length ? "ambiguous_active_subscription" : "no_active_subscription",
        });
        continue;
      }
      const subscription = activeSubscriptions[0];
      if (topicChannelId(subscription.topic) !== channelId) {
        skipped.push({ ...targetBase, reason: "subscription_topic_mismatch" });
        continue;
      }
      const boundary = new Date(subscription.activationBoundaryAt);
      if (!subscription.activationBoundaryAt || !Number.isFinite(boundary.getTime())) {
        skipped.push({ ...targetBase, reason: "invalid_activation_boundary" });
        continue;
      }
      const eventRecord = await getEventByCode(binding.eventCode);
      const event = eventRecord?.raw_event || eventRecord;
      if (
        !eventMatchesBoundProviderEventActivation(event, {
          provider: YOUTUBE_PROVIDER,
          channel: YOUTUBE_CHANNEL,
          activationEvent: PUBLISHED_VIDEO_EVENT,
        })
      ) {
        skipped.push({ ...targetBase, reason: "unsupported_event_configuration" });
        continue;
      }
      eligible.push({
        bindingId: binding.id,
        subscriptionId: subscription.id,
        callbackId: subscription.callbackId,
        eventCode: binding.eventCode,
        provider: YOUTUBE_PROVIDER,
        channel: YOUTUBE_CHANNEL,
        providerAccountId: channelId,
        channelId,
        topic: subscription.topic,
        activationBoundaryAt: boundary.toISOString(),
        activationBoundaryVideoId: subscription.activationBoundaryVideoId || null,
        sourceIdentity: subscription.topic,
      });
    } catch (error) {
      errors.push(safeTargetError(targetBase, error, "target_discovery_failed"));
    }
  }

  return { eligible, skipped, errors };
}

async function classifyTargetUploads(target, sourceResult, options = {}) {
  const getDeliveryByIdentity =
    options.getDeliveryByIdentity || database.getCodeClipProviderDeliveryByIdentity;
  const queryClient = options.queryClient;
  const sourceObservedAt = sourceResult.observedAt || isoNow(options.now);
  const boundaryEpoch = Date.parse(target.activationBoundaryAt);
  const lookbackStartEpoch =
    Date.parse(sourceObservedAt) - options.lookbackHours * 60 * 60 * 1000;
  const seenVideoIds = new Set();
  const candidates = [];

  for (const entry of sourceResult.uploads || []) {
    let candidate;
    try {
      candidate = normalizeUploadEntry(entry, target, sourceResult.source, sourceObservedAt);
      if (seenVideoIds.has(candidate.videoId)) continue;
      seenVideoIds.add(candidate.videoId);
      const publishedEpoch = Date.parse(candidate.publishedAt);
      if (publishedEpoch < lookbackStartEpoch) {
        candidates.push({
          ...candidate,
          classification: "excluded_outside_lookback",
          decision: {
            activationBoundaryAt: target.activationBoundaryAt,
            lookbackStartAt: new Date(lookbackStartEpoch).toISOString(),
          },
        });
        continue;
      }
      if (!Number.isFinite(boundaryEpoch) || publishedEpoch <= boundaryEpoch) {
        candidates.push({
          ...candidate,
          classification: "excluded_before_activation",
          decision: {
            activationBoundaryAt: target.activationBoundaryAt,
            boundaryRule: "publishedAt <= activationBoundaryAt is excluded",
          },
        });
        continue;
      }
      let delivery;
      try {
        delivery = await getDeliveryByIdentity(buildDeliveryIdentity(candidate), queryClient);
      } catch (error) {
        const safe = sanitizeOperationalError(error, "database_lookup_failed");
        candidates.push({
          ...candidate,
          classification: "invalid_candidate",
          error: safe,
        });
        continue;
      }
      candidates.push({
        ...candidate,
        classification: classifyExistingDelivery(delivery),
        delivery: delivery
          ? {
              id: delivery.id,
              processingState: delivery.processingState,
              corePersistenceState: delivery.corePersistenceState,
              completionState: delivery.completionState,
              terminalState: delivery.terminalState,
            }
          : null,
        decision: {
          activationBoundaryAt: target.activationBoundaryAt,
          boundaryRule: "publishedAt > activationBoundaryAt is eligible",
        },
      });
    } catch (error) {
      candidates.push({
        provider: YOUTUBE_PROVIDER,
        providerAccountId: target.providerAccountId,
        channelId: target.channelId,
        eventCode: target.eventCode,
        source: sourceResult.source,
        sourceObservedAt,
        activationBoundaryAt: target.activationBoundaryAt,
        classification: "invalid_candidate",
        error: sanitizeOperationalError(error, "invalid_candidate"),
      });
    }
  }

  return candidates;
}

async function scanCodeClipYouTubeReconciliation(input = {}) {
  const startedAt = isoNow(input.now);
  const source = normalizeSource(input.source);
  const limit = normalizePositiveInteger(input.limit, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  const lookbackHours = normalizePositiveInteger(
    input.lookbackHours,
    "lookbackHours",
    DEFAULT_LOOKBACK_HOURS,
    MAX_LOOKBACK_HOURS
  );
  const eventCode = normalizeOptionalText(input.eventCode, "eventCode", 120);
  const providerAccountId = normalizeOptionalText(input.providerAccountId, "providerAccountId", 256);
  const channelId = normalizeOptionalText(input.channelId, "channelId", 256);
  const adapter = input.sourceAdapter || createUploadSourceAdapter(source, input);
  const report = {
    version: SCANNER_VERSION,
    mode: READ_ONLY_MODE,
    source: adapter.source,
    startedAt,
    completedAt: null,
    summary: {
      targetsDiscovered: 0,
      targetsEligible: 0,
      targetsSkipped: 0,
      uploadsExamined: 0,
      uploadsExcludedBeforeActivation: 0,
      existingDeliveries: 0,
      missingCandidates: 0,
      targetErrors: 0,
      invalidCandidates: 0,
    },
    targets: [],
    candidates: [],
    errors: [],
  };

  const discovery = await discoverEligibleTargets({
    ...input,
    eventCode,
    providerAccountId,
    channelId,
    targetLimit: input.targetLimit || 100,
  });
  report.summary.targetsDiscovered = discovery.eligible.length + discovery.skipped.length;
  report.summary.targetsEligible = discovery.eligible.length;
  report.summary.targetsSkipped = discovery.skipped.length;
  report.errors.push(...discovery.errors);

  for (const skipped of discovery.skipped) {
    report.targets.push({ ...skipped, eligible: false });
  }

  for (const target of discovery.eligible) {
    const targetReport = {
      ...target,
      eligible: true,
      source: adapter.source,
      status: "scanned",
      error: null,
    };
    report.targets.push(targetReport);
    try {
      const sourceResult = await adapter.fetchUploads(target, {
        limit,
        lookbackHours,
        now: input.now,
      });
      const candidates = await classifyTargetUploads(target, sourceResult, {
        ...input,
        lookbackHours,
      });
      report.candidates.push(...candidates);
      targetReport.summary = summarizeCandidates(candidates);
    } catch (error) {
      const safe = sanitizeOperationalError(error, "source_failed");
      targetReport.status = "source_failed";
      targetReport.error = safe;
      report.errors.push(safeTargetError(target, safe, "source_failed"));
    }
  }

  const totals = summarizeCandidates(report.candidates);
  report.summary.uploadsExamined = totals.uploadsExamined;
  report.summary.uploadsExcludedBeforeActivation = totals.uploadsExcludedBeforeActivation;
  report.summary.existingDeliveries = totals.existingDeliveries;
  report.summary.missingCandidates = totals.missingCandidates;
  report.summary.invalidCandidates = totals.invalidCandidates;
  report.summary.targetErrors = report.errors.length;
  report.completedAt = isoNow();
  return report;
}

function formatHumanReport(report) {
  const lines = [
    "codeClip YouTube reconciliation scanner",
    "Mode: READ-ONLY",
    `Version: ${report.version}`,
    `Source: ${report.source}`,
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    "",
    "Summary:",
    `  Targets discovered: ${report.summary.targetsDiscovered}`,
    `  Targets eligible: ${report.summary.targetsEligible}`,
    `  Targets skipped: ${report.summary.targetsSkipped}`,
    `  Uploads examined: ${report.summary.uploadsExamined}`,
    `  Uploads excluded before activation: ${report.summary.uploadsExcludedBeforeActivation}`,
    `  Existing deliveries: ${report.summary.existingDeliveries}`,
    `  Missing candidates: ${report.summary.missingCandidates}`,
    `  Target-level errors: ${report.summary.targetErrors}`,
  ];

  const missing = report.candidates.filter((candidate) => candidate.classification === "missing");
  if (missing.length) {
    lines.push("", "Missing candidates:");
    for (const candidate of missing) {
      lines.push(
        `  ${candidate.eventCode} ${candidate.channelId} ${candidate.videoId} ${candidate.publishedAt}`
      );
    }
  }

  if (report.errors.length) {
    lines.push("", "Errors:");
    for (const error of report.errors) {
      lines.push(`  ${error.code}: ${error.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  ATOM_SOURCE,
  DATA_API_SOURCE,
  PUBLISHED_VIDEO_EVENT,
  READ_ONLY_MODE,
  SCANNER_VERSION,
  CodeClipYouTubeReconciliationScannerError,
  buildDeliveryIdentity,
  buildYouTubeAtomFeedUrl,
  classifyExistingDelivery,
  classifyTargetUploads,
  createUploadSourceAdapter,
  discoverEligibleTargets,
  fetchAtomUploads,
  formatHumanReport,
  normalizeUploadEntry,
  sanitizeOperationalError,
  scanCodeClipYouTubeReconciliation,
};
