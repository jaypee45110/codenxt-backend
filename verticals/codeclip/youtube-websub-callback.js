const {
  PENDING_MODES,
  SUBSCRIPTION_STATUSES,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribed,
  markCodeClipYouTubeWebSubSubscriptionVerified,
  normalizeCallbackId,
} = require("./youtube-websub-subscriptions");

const CALLBACK_CHALLENGE_MAX_LENGTH = 512;
const MAX_LEASE_SECONDS = 60 * 60 * 24 * 30;

const CALLBACK_REJECTION_REASONS = Object.freeze({
  CALLBACK_ID_INVALID: "CALLBACK_ID_INVALID",
  SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
  SUBSCRIPTION_SCOPE_INVALID: "SUBSCRIPTION_SCOPE_INVALID",
  SUBSCRIPTION_STATE_INVALID: "SUBSCRIPTION_STATE_INVALID",
  MODE_INVALID: "MODE_INVALID",
  MODE_MISMATCH: "MODE_MISMATCH",
  TOPIC_INVALID: "TOPIC_INVALID",
  TOPIC_MISMATCH: "TOPIC_MISMATCH",
  CHALLENGE_INVALID: "CHALLENGE_INVALID",
  LEASE_INVALID: "LEASE_INVALID",
  REPOSITORY_UNAVAILABLE: "REPOSITORY_UNAVAILABLE",
});

class CodeClipYouTubeWebSubCallbackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubCallbackError";
    this.code = code;
    this.details = details;
  }
}

function rejectCallback({ httpStatus = 400, reasonCode, mode = null, callbackId = null } = {}) {
  return {
    accepted: false,
    httpStatus,
    mode,
    callbackId,
    reasonCode,
  };
}

function acceptedCallback({ challenge, mode, callbackId }) {
  return {
    accepted: true,
    httpStatus: 200,
    challenge,
    mode,
    callbackId,
  };
}

function firstQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeMode(value) {
  const normalized = String(firstQueryValue(value) || "").trim().toLowerCase();
  if (![PENDING_MODES.SUBSCRIBE, PENDING_MODES.UNSUBSCRIBE].includes(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeChallenge(value) {
  if (typeof firstQueryValue(value) !== "string") return null;
  const normalized = firstQueryValue(value).trim();
  if (!normalized || normalized.length > CALLBACK_CHALLENGE_MAX_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeLeaseSeconds(value) {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const normalized = String(raw).trim();
  if (!/^[0-9]+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LEASE_SECONDS) return null;
  return parsed;
}

function canonicalTopic(value) {
  const raw = firstQueryValue(value);
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed.toString();
}

function subscriptionHasCodeClipYouTubeScope(subscription) {
  return (
    subscription?.vertical === "codeclip" &&
    subscription?.provider === "youtube" &&
    subscription?.channel === "youtube"
  );
}

function subscriptionAllowsMode(subscription, mode) {
  if (subscription?.pendingMode !== mode) return false;
  if (mode === PENDING_MODES.SUBSCRIBE) {
    return [
      SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
      SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
    ].includes(subscription.status);
  }
  if (mode === PENDING_MODES.UNSUBSCRIBE) {
    return subscription.status === SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE;
  }
  return false;
}

function addSeconds(timestamp, seconds) {
  return new Date(new Date(timestamp).getTime() + seconds * 1000).toISOString();
}

async function verifyCodeClipYouTubeWebSubCallback(
  { callbackId, query = {}, now = new Date().toISOString() } = {},
  { queryClient } = {}
) {
  let normalizedCallbackId;
  try {
    normalizedCallbackId = normalizeCallbackId(callbackId);
  } catch {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.CALLBACK_ID_INVALID,
    });
  }

  const mode = normalizeMode(query["hub.mode"]);
  if (!mode) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.MODE_INVALID,
      callbackId: normalizedCallbackId,
    });
  }

  const challenge = normalizeChallenge(query["hub.challenge"]);
  if (!challenge) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.CHALLENGE_INVALID,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  const topic = canonicalTopic(query["hub.topic"]);
  if (!topic) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.TOPIC_INVALID,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  let subscription;
  try {
    subscription = await getCodeClipYouTubeWebSubSubscriptionByCallbackId(
      normalizedCallbackId,
      { queryClient }
    );
  } catch {
    return rejectCallback({
      httpStatus: 503,
      reasonCode: CALLBACK_REJECTION_REASONS.REPOSITORY_UNAVAILABLE,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  if (!subscription) {
    return rejectCallback({
      httpStatus: 404,
      reasonCode: CALLBACK_REJECTION_REASONS.SUBSCRIPTION_NOT_FOUND,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  if (!subscriptionHasCodeClipYouTubeScope(subscription)) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.SUBSCRIPTION_SCOPE_INVALID,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  if (canonicalTopic(subscription.topic) !== topic) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.TOPIC_MISMATCH,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  const topicChannelId = new URL(topic).searchParams.get("channel_id") || "";
  if (topicChannelId !== subscription.providerAccountId) {
    return rejectCallback({
      httpStatus: 400,
      reasonCode: CALLBACK_REJECTION_REASONS.TOPIC_MISMATCH,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  if (!subscriptionAllowsMode(subscription, mode)) {
    return rejectCallback({
      httpStatus: 409,
      reasonCode:
        subscription.pendingMode && subscription.pendingMode !== mode
          ? CALLBACK_REJECTION_REASONS.MODE_MISMATCH
          : CALLBACK_REJECTION_REASONS.SUBSCRIPTION_STATE_INVALID,
      mode,
      callbackId: normalizedCallbackId,
    });
  }

  try {
    if (mode === PENDING_MODES.SUBSCRIBE) {
      const leaseSeconds = normalizeLeaseSeconds(query["hub.lease_seconds"]);
      if (!leaseSeconds) {
        return rejectCallback({
          httpStatus: 400,
          reasonCode: CALLBACK_REJECTION_REASONS.LEASE_INVALID,
          mode,
          callbackId: normalizedCallbackId,
        });
      }

      const verificationUpdate = {
        verifiedAt: now,
        leaseStartedAt: now,
        leaseExpiresAt: addSeconds(now, leaseSeconds),
        queryClient,
      };
      if (subscription.status === SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE) {
        verificationUpdate.activationBoundaryAt = now;
      }

      const updated = await markCodeClipYouTubeWebSubSubscriptionVerified(
        normalizedCallbackId,
        verificationUpdate
      );
      if (!updated) {
        return rejectCallback({
          httpStatus: 503,
          reasonCode: CALLBACK_REJECTION_REASONS.REPOSITORY_UNAVAILABLE,
          mode,
          callbackId: normalizedCallbackId,
        });
      }

      return acceptedCallback({
        challenge,
        mode,
        callbackId: normalizedCallbackId,
      });
    }

    const updated = await markCodeClipYouTubeWebSubSubscriptionUnsubscribed(
      normalizedCallbackId,
      { queryClient }
    );
    if (!updated) {
      return rejectCallback({
        httpStatus: 503,
        reasonCode: CALLBACK_REJECTION_REASONS.REPOSITORY_UNAVAILABLE,
        mode,
        callbackId: normalizedCallbackId,
      });
    }

    return acceptedCallback({
      challenge,
      mode,
      callbackId: normalizedCallbackId,
    });
  } catch {
    return rejectCallback({
      httpStatus: 503,
      reasonCode: CALLBACK_REJECTION_REASONS.REPOSITORY_UNAVAILABLE,
      mode,
      callbackId: normalizedCallbackId,
    });
  }
}

module.exports = {
  CALLBACK_REJECTION_REASONS,
  CodeClipYouTubeWebSubCallbackError,
  verifyCodeClipYouTubeWebSubCallback,
};
