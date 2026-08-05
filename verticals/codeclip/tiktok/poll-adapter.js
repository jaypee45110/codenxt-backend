/**
 * codeClip TikTok polling adapter (COAS35 F2C2).
 *
 * Bridges the TikTok Display API List Videos client to the generic provider
 * polling adapter result contract. No DB, credentials, refresh, routes, worker,
 * or poll-source creation.
 */

const {
  CodeClipTikTokDisplayClientError,
  listCodeClipTikTokVideos,
} = require("./display-client");
const {
  resolveCodeClipProviderDetectionSource,
} = require("../provider-policy");

const PROVIDER = "tiktok";
const DETECTION_SOURCE = "display_api_polling";
const RAW_TYPE = "video";
const DISPLAY_FIELDS = Object.freeze([
  "id",
  "create_time",
  "share_url",
  "title",
  "duration",
]);

const VIDEO_ID_MAX = 256;
const CHECKPOINT_ALLOWED_KEYS = new Set([
  "initialized",
  "highWaterPublishedAt",
  "highWaterVideoId",
  "pendingHighWaterPublishedAt",
  "pendingHighWaterVideoId",
  "cursor",
]);

const DISPLAY_ERROR_TO_FAILURE = Object.freeze({
  ACCESS_TOKEN_INVALID: {
    classification: "reauthorization_required",
    code: "access_token_invalid",
  },
  TIKTOK_SCOPE_NOT_AUTHORIZED: {
    classification: "reauthorization_required",
    code: "video_list_scope_required",
  },
  TIKTOK_RATE_LIMITED: {
    classification: "rate_limited",
    code: "tiktok_rate_limited",
  },
  TIKTOK_SERVICE_UNAVAILABLE: {
    classification: "retryable",
    code: "tiktok_service_unavailable",
  },
  TIKTOK_DISPLAY_REQUEST_FAILED: {
    classification: "retryable",
    code: "tiktok_display_request_failed",
  },
  INVALID_TIKTOK_DISPLAY_RESPONSE: {
    classification: "provider_malformed_response",
    code: "invalid_tiktok_display_response",
  },
  INVALID_DISPLAY_REQUEST: {
    classification: "terminal_configuration",
    code: "invalid_display_request",
  },
});

class CodeClipTikTokPollAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokPollAdapterError";
    this.code = code;
    this.details = sanitizeDetails(details);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      details: this.details,
    };
  }
}

function sanitizeDetails(details) {
  const safe = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return safe;
  }
  for (const key of ["fieldName", "reason"]) {
    if (details[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 80);
    }
  }
  return safe;
}

function adapterError(code, message, details = {}) {
  return new CodeClipTikTokPollAdapterError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || value.constructor === Object;
}

function canonicalIso(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName,
    });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName,
    });
  }
  return value;
}

function normalizeVideoId(value, fieldName) {
  if (typeof value !== "string") {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName,
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > VIDEO_ID_MAX) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName,
    });
  }
  return trimmed;
}

function normalizeCursor(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName: "cursor",
    });
  }
  return value;
}

function hasBothOrNeither(object, left, right) {
  return Object.hasOwn(object, left) === Object.hasOwn(object, right);
}

function normalizeCheckpoint(checkpoint = {}) {
  if (!isPlainObject(checkpoint)) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName: "checkpoint",
    });
  }
  for (const [key, value] of Object.entries(checkpoint)) {
    if (!CHECKPOINT_ALLOWED_KEYS.has(key)) {
      throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
        fieldName: "checkpoint",
        reason: "UNKNOWN_FIELD",
      });
    }
    if (value && typeof value === "object") {
      throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
        fieldName: key,
      });
    }
  }

  const initialized = checkpoint.initialized === true;
  if (
    Object.hasOwn(checkpoint, "initialized") &&
    typeof checkpoint.initialized !== "boolean"
  ) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      fieldName: "initialized",
    });
  }
  if (!initialized) {
    if (Object.keys(checkpoint).some((key) => key !== "initialized")) {
      throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
        fieldName: "checkpoint",
      });
    }
    return { initialized: false };
  }

  if (!hasBothOrNeither(checkpoint, "highWaterPublishedAt", "highWaterVideoId")) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      reason: "HALF_HIGH_WATER",
    });
  }
  if (
    !hasBothOrNeither(
      checkpoint,
      "pendingHighWaterPublishedAt",
      "pendingHighWaterVideoId"
    )
  ) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      reason: "HALF_PENDING_HIGH_WATER",
    });
  }

  const hasHighWater = Object.hasOwn(checkpoint, "highWaterPublishedAt");
  const hasPending = Object.hasOwn(checkpoint, "pendingHighWaterPublishedAt");
  const hasCursor = Object.hasOwn(checkpoint, "cursor");
  if (hasCursor && (!hasHighWater || !hasPending)) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      reason: "CURSOR_REQUIRES_PAGINATION_STATE",
    });
  }
  if (hasPending && !hasCursor) {
    throw adapterError("INVALID_CHECKPOINT", "TikTok checkpoint is invalid", {
      reason: "PENDING_REQUIRES_CURSOR",
    });
  }

  const normalized = { initialized: true };
  if (hasHighWater) {
    normalized.highWaterPublishedAt = canonicalIso(
      checkpoint.highWaterPublishedAt,
      "highWaterPublishedAt"
    );
    normalized.highWaterVideoId = normalizeVideoId(
      checkpoint.highWaterVideoId,
      "highWaterVideoId"
    );
  }
  if (hasPending) {
    normalized.pendingHighWaterPublishedAt = canonicalIso(
      checkpoint.pendingHighWaterPublishedAt,
      "pendingHighWaterPublishedAt"
    );
    normalized.pendingHighWaterVideoId = normalizeVideoId(
      checkpoint.pendingHighWaterVideoId,
      "pendingHighWaterVideoId"
    );
  }
  if (hasCursor) normalized.cursor = normalizeCursor(checkpoint.cursor);
  return normalized;
}

function highWaterFromVideo(video) {
  return {
    publishedAt: new Date(video.createTimeSec * 1000).toISOString(),
    videoId: video.id,
  };
}

function compareHighWater(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const leftMs = Date.parse(left.publishedAt);
  const rightMs = Date.parse(right.publishedAt);
  if (leftMs !== rightMs) return leftMs > rightMs ? 1 : -1;
  if (left.videoId === right.videoId) return 0;
  return left.videoId > right.videoId ? 1 : -1;
}

function maxHighWater(values) {
  let max = null;
  for (const value of values) {
    if (compareHighWater(value, max) > 0) max = value;
  }
  return max;
}

function checkpointHighWater(checkpoint, prefix = "highWater") {
  const publishedAt = checkpoint[`${prefix}PublishedAt`];
  const videoId = checkpoint[`${prefix}VideoId`];
  if (!publishedAt || !videoId) return null;
  return { publishedAt, videoId };
}

function setHighWaterFields(out, highWater, prefix = "highWater") {
  if (!highWater) return;
  out[`${prefix}PublishedAt`] = highWater.publishedAt;
  out[`${prefix}VideoId`] = highWater.videoId;
}

function toDetection(video, detectedAt, source) {
  const detection = {
    providerObjectId: video.id,
    publishedAt: new Date(video.createTimeSec * 1000).toISOString(),
    detectedAt,
    source,
    rawType: RAW_TYPE,
  };
  if (video.shareUrl) detection.canonicalUrl = video.shareUrl;
  return detection;
}

function sortVideosNewestFirst(videos) {
  return videos.slice().sort((a, b) => {
    const cmp = compareHighWater(highWaterFromVideo(a), highWaterFromVideo(b));
    return cmp === 0 ? 0 : -cmp;
  });
}

function sortDetectionsOldestFirst(detections) {
  return detections.slice().sort((a, b) => {
    const cmp = compareHighWater(
      { publishedAt: a.publishedAt, videoId: a.providerObjectId },
      { publishedAt: b.publishedAt, videoId: b.providerObjectId }
    );
    return cmp;
  });
}

function dedupeDetections(detections) {
  const seen = new Map();
  const out = [];
  for (const detection of detections) {
    const prior = seen.get(detection.providerObjectId);
    if (!prior) {
      seen.set(detection.providerObjectId, detection);
      out.push(detection);
      continue;
    }
    if (prior.publishedAt !== detection.publishedAt || prior.source !== detection.source) {
      throw adapterError("INVALID_ADAPTER_RESULT", "TikTok detections conflict", {
        reason: "CONFLICTING_DUPLICATE",
      });
    }
  }
  return out;
}

function mapDisplayClientError(error) {
  if (error instanceof CodeClipTikTokDisplayClientError) {
    return (
      DISPLAY_ERROR_TO_FAILURE[error.code] || {
        classification: "retryable",
        code: "tiktok_display_request_failed",
      }
    );
  }
  throw error;
}

function resolveDetectionSource() {
  const resolved = resolveCodeClipProviderDetectionSource(
    PROVIDER,
    DETECTION_SOURCE
  );
  if (!resolved.ok || resolved.detectionSource !== DETECTION_SOURCE) {
    throw adapterError("INVALID_POLICY", "TikTok detection source is unavailable", {
      reason: resolved.reason || "INVALID_DETECTION_SOURCE",
    });
  }
  return resolved.detectionSource;
}

function normalizeProvider(input) {
  if (String(input?.provider || "").trim().toLowerCase() !== PROVIDER) {
    throw adapterError("INVALID_ADAPTER_INPUT", "TikTok poll input is invalid", {
      fieldName: "provider",
    });
  }
}

function createBaselineResult(page) {
  const newest = maxHighWater(page.videos.map(highWaterFromVideo));
  const nextCheckpoint = { initialized: true };
  setHighWaterFields(nextCheckpoint, newest);
  return {
    ok: true,
    detections: [],
    nextCheckpoint,
    page: { complete: true },
  };
}

function createNormalResult({ checkpoint, page, now, source }) {
  const cutoff = checkpointHighWater(checkpoint);
  const pending = checkpointHighWater(checkpoint, "pendingHighWater");
  const sortedVideos = sortVideosNewestFirst(page.videos);
  const pageNewest = maxHighWater(sortedVideos.map(highWaterFromVideo));
  const hasCursor = Object.hasOwn(checkpoint, "cursor");
  const oldBoundaryReached = sortedVideos.some(
    (video) => compareHighWater(highWaterFromVideo(video), cutoff) <= 0
  );
  const newVideos = sortedVideos.filter(
    (video) => compareHighWater(highWaterFromVideo(video), cutoff) > 0
  );
  const detections = sortDetectionsOldestFirst(
    dedupeDetections(newVideos.map((video) => toDetection(video, now, source)))
  );
  const observedHighWater = maxHighWater([pending, pageNewest, cutoff]);

  if (hasCursor) {
    if (page.hasMore && !oldBoundaryReached) {
      const nextCheckpoint = { initialized: true };
      setHighWaterFields(nextCheckpoint, cutoff);
      setHighWaterFields(nextCheckpoint, observedHighWater, "pendingHighWater");
      nextCheckpoint.cursor = page.cursor;
      return {
        ok: true,
        detections,
        nextCheckpoint,
        page: { complete: false },
      };
    }

    const nextCheckpoint = { initialized: true };
    setHighWaterFields(nextCheckpoint, observedHighWater || cutoff);
    return {
      ok: true,
      detections,
      nextCheckpoint,
      page: { complete: true },
    };
  }

  if (page.hasMore && !oldBoundaryReached && cutoff) {
    const nextCheckpoint = { initialized: true };
    setHighWaterFields(nextCheckpoint, cutoff);
    setHighWaterFields(nextCheckpoint, observedHighWater, "pendingHighWater");
    nextCheckpoint.cursor = page.cursor;
    return {
      ok: true,
      detections,
      nextCheckpoint,
      page: { complete: false },
    };
  }

  const nextCheckpoint = { initialized: true };
  setHighWaterFields(nextCheckpoint, observedHighWater || cutoff);
  return {
    ok: true,
    detections,
    nextCheckpoint,
    page: { complete: true },
  };
}

function createCodeClipTikTokPollAdapter({ fetchImpl, timeoutMs } = {}) {
  return Object.freeze({
    provider: PROVIDER,
    async poll(input = {}) {
      normalizeProvider(input);
      const checkpoint = normalizeCheckpoint(input.checkpoint || {});
      const source = resolveDetectionSource();
      const maxCount = Math.min(input.limit, 20);

      let page;
      try {
        page = await listCodeClipTikTokVideos(
          {
            accessToken: input.accessToken,
            cursor: checkpoint.cursor,
            maxCount,
            fields: DISPLAY_FIELDS,
          },
          { fetchImpl, timeoutMs }
        );
      } catch (error) {
        const mapped = mapDisplayClientError(error);
        return {
          ok: false,
          classification: mapped.classification,
          code: mapped.code,
        };
      }

      if (!checkpoint.initialized) {
        return createBaselineResult(page);
      }

      return createNormalResult({
        checkpoint,
        page,
        now: input.now,
        source,
      });
    },
  });
}

module.exports = {
  CodeClipTikTokPollAdapterError,
  createCodeClipTikTokPollAdapter,
};
