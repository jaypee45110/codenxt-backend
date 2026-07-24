const crypto = require("node:crypto");

const database = require("../../db");
const { requestSubscription } = require("./youtube-websub-hub-client");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
  CodeClipYouTubeWebSubSecretError,
} = require("./youtube-websub-secret");
const {
  buildDiagnosticCallbackPath,
  maskDiagnosticIdentifier,
  normalizeDiagnosticProbeId,
  normalizeYouTubeDiagnosticChannelId,
  normalizeYouTubeDiagnosticTopic,
} = require("./youtube-websub-diagnostic-probe");
const repository = require("./youtube-websub-diagnostic-probe-repository");

const DEFAULT_SECRET_VERSION = "diag-v1";
const DEFAULT_LEASE_SECONDS = 60 * 60 * 24 * 10;
const MAX_LEASE_SECONDS = 60 * 60 * 24 * 30;

class CodeClipYouTubeWebSubDiagnosticOperationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubDiagnosticOperationError";
    this.code = code;
    this.details = details;
  }
}

function operationError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubDiagnosticOperationError(code, message, details);
}

function normalizeLeaseSeconds(value = DEFAULT_LEASE_SECONDS) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(normalized)) throw operationError("validation_error", "leaseSeconds is invalid");
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LEASE_SECONDS) {
    throw operationError("validation_error", "leaseSeconds is invalid");
  }
  return parsed;
}

function normalizePublicBaseUrl(env = process.env) {
  const value = env.CODECLIP_PUBLIC_BASE_URL;
  if (typeof value !== "string" || !value.trim()) throw operationError("public_base_url_unavailable", "public_base_url_unavailable");
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw operationError("public_base_url_unavailable", "public_base_url_unavailable");
  }
  if (parsed.protocol !== "https:") throw operationError("public_base_url_unavailable", "public_base_url_unavailable");
  return parsed.toString().replace(/\/+$/, "");
}

function buildDiagnosticCallbackUrl(publicBaseUrl, callbackId) {
  return `${normalizePublicBaseUrl({ CODECLIP_PUBLIC_BASE_URL: publicBaseUrl })}${buildDiagnosticCallbackPath(callbackId)}`;
}

function buildDiagnosticTopic(channelId) {
  const normalized = normalizeYouTubeDiagnosticChannelId(channelId);
  return normalizeYouTubeDiagnosticTopic(`https://www.youtube.com/feeds/videos.xml?channel_id=${normalized}`, normalized);
}

function generateProbeId() {
  return `diag_${crypto.randomBytes(24).toString("base64url")}`;
}

function generateCallbackId() {
  return `diag_yt_${crypto.randomBytes(24).toString("base64url")}`;
}

function generateAttemptId() {
  return `attempt_diag_${crypto.randomBytes(18).toString("base64url")}`;
}

function requireQueryClient(queryClient) {
  if (!queryClient || (typeof queryClient.query !== "function" && typeof queryClient.connect !== "function")) {
    throw operationError("persistence_failed", "diagnostic persistence unavailable");
  }
  return queryClient;
}

async function runTransaction(options, queryClient, work) {
  if (typeof options.runTransaction === "function") return options.runTransaction(work, queryClient);
  return database.withCodeClipCorePersistenceTransaction(work, queryClient);
}

function publicProbe(row, fallback = {}) {
  const metadata = row?.diagnosticMetadata || {};
  return {
    ...fallback,
    probeId: row?.probeId || fallback.probeId || null,
    callbackId: maskDiagnosticIdentifier(row?.callbackId || fallback.callbackId),
    provider: row?.provider || fallback.provider || "youtube",
    channel: row?.channel || fallback.channel || "youtube",
    channelId: row?.channelId || fallback.channelId || null,
    topic: row?.topic || fallback.topic || null,
    status: row?.status || fallback.status || null,
    pendingMode: row?.pendingMode ?? fallback.pendingMode ?? null,
    cleanupRequired: Boolean(row?.cleanupRequired ?? fallback.cleanupRequired),
    subscriptionMayExist: Boolean(row?.subscriptionMayExist ?? fallback.subscriptionMayExist),
    failedOperation: row?.failedOperation || fallback.failedOperation || null,
    failedReasonCode: row?.failedReasonCode || fallback.failedReasonCode || null,
    leaseExpiresAt: row?.leaseExpiresAt || fallback.leaseExpiresAt || null,
    verifiedAt: row?.verifiedAt || fallback.verifiedAt || null,
    firstVerifiedAt: row?.firstVerifiedAt || fallback.firstVerifiedAt || null,
    lastNotificationAt: row?.lastNotificationAt || fallback.lastNotificationAt || null,
    unsubscribedAt: row?.unsubscribedAt || fallback.unsubscribedAt || null,
    lastDispatch: metadata.lastDispatch || null,
    lastVerification: metadata.lastVerification || null,
    lastNotification: metadata.lastNotification || null,
  };
}

function ok(code, row, fallback, extra = {}) {
  return { ok: true, code, probe: publicProbe(row, fallback), ...extra };
}

function fail(code, row, fallback, extra = {}) {
  return { ok: false, code, probe: row || fallback ? publicProbe(row, fallback) : null, ...extra };
}

function diagnosticSecret(rootSecret, row) {
  try {
    return deriveCodeClipYouTubeWebSubSubscriptionSecret({
      rootSecret,
      secretVersion: row.secretVersion || DEFAULT_SECRET_VERSION,
      callbackId: row.callbackId,
      providerAccountId: row.channelId,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubSecretError) {
      throw operationError("authentication_unavailable", "diagnostic WebSub secret unavailable");
    }
    throw error;
  }
}

function isExistingOpen(result) {
  return result?.status === "existing" && ["pending_subscribe", "active", "pending_unsubscribe", "failed"].includes(result.row?.status);
}

function isRepositoryStateConflict(error) {
  return error?.name === "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError" && error.code === "state_conflict";
}

function getLastDispatch(row) {
  return row?.diagnosticMetadata?.lastDispatch || null;
}

function getLastVerification(row) {
  return row?.diagnosticMetadata?.lastVerification || null;
}

function isSameSubscribeAttempt(row, { attemptId, attemptNumber }) {
  const dispatch = getLastDispatch(row);
  return Boolean(
    dispatch &&
    dispatch.mode === "subscribe" &&
    dispatch.attemptId === attemptId &&
    Number(dispatch.attemptNumber) === Number(attemptNumber)
  );
}

function isVerifiedActiveSubscribeAttempt(row, attempt) {
  const verification = getLastVerification(row);
  return Boolean(
    row &&
    row.status === "active" &&
    row.pendingMode === null &&
    row.verifiedAt &&
    row.firstVerifiedAt &&
    row.leaseExpiresAt &&
    verification &&
    verification.mode === "subscribe" &&
    isSameSubscribeAttempt(row, attempt)
  );
}

function isTerminalUnsubscribeAttempt(row, attempt) {
  const verification = getLastVerification(row);
  return Boolean(
    row &&
    row.status === "unsubscribed" &&
    row.pendingMode === null &&
    row.cleanupRequired === false &&
    row.subscriptionMayExist === false &&
    row.leaseExpiresAt === null &&
    row.unsubscribedAt &&
    verification &&
    verification.mode === "unsubscribe" &&
    isSameUnsubscribeAttempt(row, attempt)
  );
}

function isSameUnsubscribeAttempt(row, { attemptId, attemptNumber }) {
  const dispatch = getLastDispatch(row);
  return Boolean(
    dispatch &&
    dispatch.mode === "unsubscribe" &&
    dispatch.attemptId === attemptId &&
    Number(dispatch.attemptNumber) === Number(attemptNumber)
  );
}

function recoverableCleanupProbe(row, fallback = {}) {
  return {
    ...(row || fallback),
    probeId: row?.probeId || fallback.probeId || null,
    callbackId: row?.callbackId || fallback.callbackId || null,
    status: "failed",
    pendingMode: null,
    cleanupRequired: true,
    subscriptionMayExist: true,
    failedOperation: "subscribe",
    failedReasonCode: "hub_request_accepted_without_callback",
  };
}

function recoverablePendingUnsubscribeProbe(row, fallback = {}) {
  return {
    ...(row || fallback),
    probeId: row?.probeId || fallback.probeId || null,
    callbackId: row?.callbackId || fallback.callbackId || null,
    status: "pending_unsubscribe",
    pendingMode: "unsubscribe",
    cleanupRequired: true,
    subscriptionMayExist: true,
  };
}

async function createCodeClipYouTubeWebSubDiagnosticProbeOperation(input = {}, options = {}) {
  const env = options.env || process.env;
  const queryClient = requireQueryClient(options.queryClient);
  const publicBaseUrl = normalizePublicBaseUrl(env);
  const channelId = normalizeYouTubeDiagnosticChannelId(input.channelId || input.channel_id);
  const topic = buildDiagnosticTopic(channelId);
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds || input.lease_seconds);
  const probeId = (options.generateProbeId || generateProbeId)();
  const callbackId = (options.generateCallbackId || generateCallbackId)();
  const attemptId = (options.generateDispatchAttemptId || generateAttemptId)();
  const now = input.now || new Date().toISOString();

  const started = await runTransaction(options, queryClient, async ({ queryClient: txClient }) => {
    const created = await (options.createProbe || repository.createCodeClipYouTubeWebSubDiagnosticProbe)({
      probeId,
      callbackId,
      channelId,
      topic,
      secretVersion: DEFAULT_SECRET_VERSION,
      now,
    }, { queryClient: txClient });
    if (isExistingOpen(created)) return created;
    if (created.status !== "created") return created;
    return (options.markSubscribeDispatched || repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched)({
      probeId: created.row.probeId,
      callbackId: created.row.callbackId,
      dispatchedAt: now,
      attemptId,
      attemptNumber: 1,
      staleAfterAt: new Date(Date.parse(now) + 300000).toISOString(),
      leaseSeconds,
    }, { queryClient: txClient });
  });

  if (isExistingOpen(started)) return ok("diagnostic_probe_exists", started.row, started.public, { status: started.row.status });

  const row = started.row;
  const hubResult = await (options.requestSubscription || requestSubscription)({
    mode: "subscribe",
    operationMode: "diagnostic_subscribe",
    callbackUrl: buildDiagnosticCallbackUrl(publicBaseUrl, row.callbackId),
    topic: row.topic,
    secret: diagnosticSecret(env.CODECLIP_YOUTUBE_WEBSUB_SECRET, row),
    leaseSeconds,
    attemptId,
    attemptNumber: 1,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (!hubResult.ok) {
    const failed = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
      (options.markSubscribeFailed || repository.markCodeClipYouTubeWebSubDiagnosticSubscribeFailed)({
        probeId: row.probeId,
        callbackId: row.callbackId,
        failedAt: new Date().toISOString(),
        reasonCode: hubResult.code || "hub_request_failed",
        cleanupRequired: false,
        subscriptionMayExist: false,
      }, { queryClient: txClient })
    );
    return fail(hubResult.code || "hub_request_failed", failed.row, failed.public, { retryable: hubResult.retryable !== false });
  }
  const acceptedAt = new Date().toISOString();
  const acceptInput = {
    probeId: row.probeId,
    callbackId: row.callbackId,
    acceptedAt,
    attemptId,
    attemptNumber: 1,
    resultCode: "hub_request_accepted",
  };
  try {
    const accepted = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
      (options.markSubscribeAccepted || repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted)(
        acceptInput,
        { queryClient: txClient }
      )
    );
    return ok("diagnostic_subscribe_pending", accepted.row, accepted.public, { status: accepted.row.status });
  } catch (acceptError) {
    let latest = null;
    if (isRepositoryStateConflict(acceptError)) {
      latest = await (options.getProbeByProbeId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId)(
        row.probeId,
        { queryClient }
      );
      if (isVerifiedActiveSubscribeAttempt(latest?.row, acceptInput)) {
        const accepted = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
          (options.markSubscribeAccepted || repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted)(
            acceptInput,
            { queryClient: txClient }
          )
        );
        return ok("diagnostic_subscribe_pending", accepted.row, accepted.public, { status: accepted.row.status });
      }
    }

    const cleanupInput = {
      probeId: row.probeId,
      requiredAt: new Date().toISOString(),
      reasonCode: "hub_request_accepted_without_callback",
      subscriptionMayExist: true,
    };
    try {
      const cleanup = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
        (options.markCleanupRequired || repository.markCodeClipYouTubeWebSubDiagnosticCleanupRequired)(
          cleanupInput,
          { queryClient: txClient }
        )
      );
      return fail("diagnostic_cleanup_required", cleanup.row, cleanup.public, { retryable: false });
    } catch {
      const recoverable = recoverableCleanupProbe(latest?.row, row);
      return fail("diagnostic_cleanup_required", recoverable, {}, { retryable: false });
    }
  }
}

async function getCodeClipYouTubeWebSubDiagnosticProbeStatus(probeId, options = {}) {
  const queryClient = requireQueryClient(options.queryClient);
  const normalizedProbeId = normalizeDiagnosticProbeId(probeId);
  const probe = await (options.getProbeByProbeId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId)(normalizedProbeId, { queryClient });
  if (!probe) throw operationError("probe_not_found", "diagnostic probe was not found");
  const observations = await (options.getObservationSummary || repository.getCodeClipYouTubeWebSubDiagnosticObservationSummary)(
    normalizedProbeId,
    { queryClient, limit: options.limit || 10 }
  );
  return { ok: true, probe: { ...publicProbe(probe.row, probe.public), observationCount: observations.count, observations: observations.items } };
}

async function unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation(probeId, input = {}, options = {}) {
  const env = options.env || process.env;
  const queryClient = requireQueryClient(options.queryClient);
  const publicBaseUrl = normalizePublicBaseUrl(env);
  const normalizedProbeId = normalizeDiagnosticProbeId(probeId);
  const now = input.now || new Date().toISOString();
  const attemptId = (options.generateDispatchAttemptId || generateAttemptId)();
  const current = await (options.getProbeByProbeId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId)(normalizedProbeId, { queryClient });
  if (!current) throw operationError("probe_not_found", "diagnostic probe was not found");
  if (current.row.status === "unsubscribed") return ok("diagnostic_unsubscribed", current.row, current.public, { status: current.row.status });
  const dispatched = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
    (options.markUnsubscribeDispatched || repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeDispatched)({
      probeId: normalizedProbeId,
      callbackId: current.row.callbackId,
      dispatchedAt: now,
      attemptId,
      attemptNumber: 1,
      staleAfterAt: new Date(Date.parse(now) + 300000).toISOString(),
    }, { queryClient: txClient })
  );
  const hubResult = await (options.requestSubscription || requestSubscription)({
    mode: "unsubscribe",
    operationMode: "diagnostic_unsubscribe",
    callbackUrl: buildDiagnosticCallbackUrl(publicBaseUrl, dispatched.row.callbackId),
    topic: dispatched.row.topic,
    secret: diagnosticSecret(env.CODECLIP_YOUTUBE_WEBSUB_SECRET, dispatched.row),
    attemptId,
    attemptNumber: 1,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (!hubResult.ok) {
    const cleanup = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
      (options.markCleanupRequired || repository.markCodeClipYouTubeWebSubDiagnosticCleanupRequired)({
        probeId: normalizedProbeId,
        requiredAt: new Date().toISOString(),
        reasonCode: hubResult.code || "hub_request_failed",
      }, { queryClient: txClient })
    );
    return fail(hubResult.code || "hub_request_failed", cleanup.row, cleanup.public, { retryable: hubResult.retryable !== false });
  }
  const acceptInput = {
    probeId: normalizedProbeId,
    callbackId: dispatched.row.callbackId,
    acceptedAt: new Date().toISOString(),
    attemptId,
    attemptNumber: 1,
    resultCode: "hub_request_accepted",
  };
  try {
    const accepted = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
      (options.markUnsubscribeAccepted || repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted)(
        acceptInput,
        { queryClient: txClient }
      )
    );
    return ok("diagnostic_unsubscribe_pending", accepted.row, accepted.public, { status: accepted.row.status });
  } catch (acceptError) {
    let latest = null;
    if (isRepositoryStateConflict(acceptError)) {
      latest = await (options.getProbeByProbeId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId)(
        normalizedProbeId,
        { queryClient }
      );
      if (isTerminalUnsubscribeAttempt(latest?.row, acceptInput)) {
        const accepted = await runTransaction(options, queryClient, ({ queryClient: txClient }) =>
          (options.markUnsubscribeAccepted || repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted)(
            acceptInput,
            { queryClient: txClient }
          )
        );
        return ok("diagnostic_unsubscribe_pending", accepted.row, accepted.public, { status: accepted.row.status });
      }
    }

    const recoverable = recoverablePendingUnsubscribeProbe(latest?.row, dispatched.row);
    return fail("diagnostic_cleanup_pending", recoverable, {}, { retryable: false });
  }
}

module.exports = {
  CodeClipYouTubeWebSubDiagnosticOperationError,
  buildDiagnosticCallbackUrl,
  buildDiagnosticTopic,
  createCodeClipYouTubeWebSubDiagnosticProbeOperation,
  getCodeClipYouTubeWebSubDiagnosticProbeStatus,
  unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation,
};
