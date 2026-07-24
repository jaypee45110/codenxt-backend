const crypto = require("node:crypto");

const database = require("../../db");
const {
  parseCodeClipYouTubeWebSubAtomFeed,
  CodeClipYouTubeWebSubFeedError,
  YOUTUBE_WEBSUB_MAX_ENTRIES,
} = require("./youtube-websub-feed");
const {
  verifyCodeClipProviderWebhook,
} = require("./provider-webhook-verification");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
  CodeClipYouTubeWebSubSecretError,
} = require("./youtube-websub-secret");
const {
  normalizeDiagnosticCallbackId,
  normalizeYouTubeDiagnosticChannelId,
  normalizeYouTubeDiagnosticTopic,
} = require("./youtube-websub-diagnostic-probe");
const repository = require("./youtube-websub-diagnostic-probe-repository");

const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(["application/atom+xml", "application/xml", "text/xml"]);
const MAX_CHALLENGE_LENGTH = 512;

function reject(httpStatus, code) {
  return { accepted: false, httpStatus, code, publicBody: { ok: false, error: "Diagnostic WebSub callback rejected" } };
}

function headerValue(headers = {}, name) {
  const expected = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || "").toLowerCase() === expected) return String(value || "").trim();
  }
  return "";
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  return Buffer.alloc(0);
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeMode(value) {
  const normalized = String(firstQueryValue(value) || "").trim().toLowerCase();
  return ["subscribe", "unsubscribe"].includes(normalized) ? normalized : null;
}

function normalizeChallenge(value) {
  const raw = firstQueryValue(value);
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!normalized || normalized.length > MAX_CHALLENGE_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeLeaseSeconds(value) {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === "") return null;
  const normalized = String(raw).trim();
  if (!/^[0-9]+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 60 * 60 * 24 * 30 ? parsed : null;
}

function channelIdFromTopic(topic) {
  try {
    return new URL(topic).searchParams.get("channel_id") || "";
  } catch {
    return "";
  }
}

function normalizeTopic(value) {
  const raw = firstQueryValue(value);
  if (typeof raw !== "string") return null;
  const channelId = channelIdFromTopic(raw);
  try {
    return {
      channelId: normalizeYouTubeDiagnosticChannelId(channelId),
      topic: normalizeYouTubeDiagnosticTopic(raw, channelId),
    };
  } catch {
    return null;
  }
}

async function verifyCodeClipYouTubeWebSubDiagnosticCallback(input = {}, options = {}) {
  let callbackId;
  try {
    callbackId = normalizeDiagnosticCallbackId(input.callbackId);
  } catch {
    return reject(404, "callback_not_found");
  }
  const query = input.query || {};
  const mode = normalizeMode(query["hub.mode"]);
  if (!mode) return reject(400, "invalid_mode");
  const challenge = normalizeChallenge(query["hub.challenge"]);
  if (!challenge) return reject(400, "invalid_challenge");
  const topic = normalizeTopic(query["hub.topic"]);
  if (!topic) return reject(400, "topic_mismatch");
  const now = input.now || new Date().toISOString();

  try {
    if (mode === "subscribe") {
      const leaseSeconds = normalizeLeaseSeconds(query["hub.lease_seconds"]);
      if (!leaseSeconds) return reject(400, "invalid_lease");
      await (options.runTransaction || defaultRunTransaction)(async ({ queryClient }) => {
        await (options.markVerificationReceived || repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived)({
          callbackId,
          verifiedAt: now,
          leaseSeconds,
          topic: topic.topic,
          channelId: topic.channelId,
        }, { queryClient });
      }, options.queryClient);
    } else {
      const probeResult = await (options.getProbeByCallbackId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByCallbackId)(
        callbackId,
        { queryClient: options.queryClient }
      );
      const probe = probeResult?.row;
      if (!probe || probe.topic !== topic.topic || probe.channelId !== topic.channelId) return reject(404, "callback_not_found");
      await (options.runTransaction || defaultRunTransaction)(async ({ queryClient }) => {
        await (options.markCleanupCompleted || repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted)({
          callbackId,
          completedAt: now,
        }, { queryClient });
      }, options.queryClient);
    }
    return { accepted: true, httpStatus: 200, challenge };
  } catch {
    return reject(404, "callback_not_found");
  }
}

function titleHash(title) {
  const value = typeof title === "string" && title ? title : "";
  return value ? crypto.createHash("sha256").update(value).digest("hex") : null;
}

function classifyFeedError(error) {
  if (!(error instanceof CodeClipYouTubeWebSubFeedError)) return "invalid_atom_feed";
  if (error.code === "EMPTY_BODY") return "empty_body";
  if (error.code === "MALFORMED_XML") return "malformed_xml";
  if (error.code === "TOO_MANY_ENTRIES") return "too_many_entries";
  return "invalid_atom_feed";
}

function deriveSecret(probe, env = process.env) {
  try {
    return deriveCodeClipYouTubeWebSubSubscriptionSecret({
      rootSecret: env.CODECLIP_YOUTUBE_WEBSUB_SECRET,
      secretVersion: probe.secretVersion,
      callbackId: probe.callbackId,
      providerAccountId: probe.channelId,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeWebSubSecretError) return null;
    throw error;
  }
}

async function defaultRunTransaction(work, queryClient) {
  return database.withCodeClipCorePersistenceTransaction(work, queryClient || database.pool);
}

async function processCodeClipYouTubeWebSubDiagnosticNotification(input = {}, options = {}) {
  let callbackId;
  try {
    callbackId = normalizeDiagnosticCallbackId(input.callbackId);
  } catch {
    return reject(404, "callback_not_found");
  }
  const rawBody = rawBodyBuffer(input.rawBody);
  const contentType = normalizeContentType(headerValue(input.headers, "content-type"));
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return reject(415, "invalid_content_type");
  if (!rawBody.length) return reject(400, "empty_body");
  if (rawBody.length > MAX_BODY_BYTES) return reject(413, "body_too_large");

  let probeResult;
  try {
    probeResult = await (options.getProbeByCallbackId || repository.getCodeClipYouTubeWebSubDiagnosticProbeByCallbackId)(
      callbackId,
      { queryClient: options.queryClient }
    );
  } catch {
    return reject(503, "persistence_failed");
  }
  const probe = probeResult?.row;
  if (!probe || probe.status !== "active" || probe.provider !== "youtube" || probe.channel !== "youtube") {
    return reject(404, "callback_not_found");
  }

  const secret = deriveSecret(probe, options.env || process.env);
  if (!secret) return reject(503, "authentication_unavailable");
  const verification = verifyCodeClipProviderWebhook({
    provider: "youtube",
    headers: input.headers || {},
    rawBody,
    secret,
    mode: "websub-hmac",
  });
  if (!verification.ok) return reject(401, "signature_invalid");

  let feed;
  try {
    feed = parseCodeClipYouTubeWebSubAtomFeed(rawBody, { maxEntries: options.maxEntries || YOUTUBE_WEBSUB_MAX_ENTRIES });
  } catch (error) {
    return reject(400, classifyFeedError(error));
  }
  if (feed.topic !== probe.topic || feed.channelId !== probe.channelId) return reject(400, "topic_mismatch");
  if (!feed.entries.length) return reject(400, "no_observable_entries");

  try {
    await (options.runTransaction || defaultRunTransaction)(async ({ queryClient }) => {
      for (const entry of feed.entries) {
        if (entry.channelId !== probe.channelId) throw new Error("entry channel mismatch");
        const result = await (options.recordObservation || repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation)({
          probeId: probe.probeId,
          callbackId,
          observedCallbackId: callbackId,
          channelId: entry.channelId,
          topic: feed.topic,
          entryId: entry.entryId,
          videoId: entry.videoId,
          publishedAt: entry.publishedAt,
          updatedAt: entry.updatedAt,
          observedAt: input.now || new Date().toISOString(),
          notificationHash: crypto.createHash("sha256").update(rawBody).digest("hex"),
          titleHash: titleHash(entry.title),
          contentType,
        }, { queryClient });
        if (!["recorded", "duplicate", "updated"].includes(result?.status)) {
          throw new Error("unknown diagnostic observation result");
        }
      }
    }, options.queryClient);
  } catch {
    return reject(503, "persistence_failed");
  }
  return { accepted: true, httpStatus: 204, publicBody: null };
}

module.exports = {
  ALLOWED_CONTENT_TYPES,
  MAX_BODY_BYTES,
  processCodeClipYouTubeWebSubDiagnosticNotification,
  verifyCodeClipYouTubeWebSubDiagnosticCallback,
};
