const crypto = require("node:crypto");

const {
  CodeClipProviderAccountBindingError,
  createCodeClipProviderAccountBinding,
  findActiveCodeClipProviderAccountBinding,
  maskCodeClipProviderAccountId,
  toPublicCodeClipProviderBinding,
} = require("./provider-account-bindings");
const {
  appendCodeClipProviderAccountBindingAuditEvent,
  toAuditState,
} = require("./provider-account-binding-audit");
const {
  createPendingCodeClipYouTubeWebSubSubscription,
  getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  recordCodeClipYouTubeWebSubSubscriptionAudit,
  toInternalCodeClipYouTubeWebSubSubscription,
} = require("./youtube-websub-subscriptions");
const {
  CodeClipYouTubeConnectionPolicyError,
  assertAllowedReturnUrl,
  loadCodeClipYouTubeConnectionPolicy,
} = require("./youtube-connection-policy");
const {
  CodeClipYouTubeOAuthClientError,
  buildCodeClipYouTubeAuthorizationUrl,
  exchangeCodeClipYouTubeAuthorizationCode,
  fetchAuthenticatedYouTubeChannel,
} = require("./youtube-oauth-client");
const {
  CodeClipYouTubeOAuthStateError,
  createCodeClipYouTubeOAuthState,
  verifyCodeClipYouTubeOAuthState,
} = require("./youtube-oauth-state");

class CodeClipYouTubeConnectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeConnectionError";
    this.code = code;
    this.details = details;
  }
}

function connectionError(code, message, details = {}) {
  return new CodeClipYouTubeConnectionError(code, message, details);
}

function normalizeEventCode(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw connectionError("youtube_connection_invalid", "Event code is invalid");
  }
  return normalized;
}

function isCodeClipEvent(event) {
  return String(event?.vertical || event?.raw_event?.vertical || "").trim().toLowerCase() === "codeclip";
}

async function requireCodeClipEpisode(eventCode, { getEventByCode } = {}) {
  if (typeof getEventByCode !== "function") {
    throw connectionError("youtube_connection_unavailable", "Episode lookup unavailable");
  }
  const event = await getEventByCode(eventCode);
  if (!event || !isCodeClipEvent(event)) {
    throw connectionError("youtube_episode_not_found", "Episode not found");
  }
  return event;
}

function buildCallbackId(providerAccountId) {
  const digest = crypto
    .createHash("sha256")
    .update(`codeclip:youtube:${providerAccountId}`)
    .digest("base64url")
    .slice(0, 24);
  return `yt_${digest}`;
}

function buildTopic(providerAccountId) {
  const url = new URL("https://www.youtube.com/feeds/videos.xml");
  url.searchParams.set("channel_id", providerAccountId);
  return url.toString();
}

function cloneState(value) {
  if (value === undefined || value === null) return null;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function toPublicSubscription(subscription = null) {
  const mapped = toInternalCodeClipYouTubeWebSubSubscription(subscription);
  if (!mapped) return null;
  return {
    callbackId: mapped.callbackId,
    provider: mapped.provider,
    channel: mapped.channel,
    status: mapped.status,
    pendingMode: mapped.pendingMode,
    verifiedAt: mapped.lastVerifiedAt,
    leaseExpiresAt: mapped.leaseExpiresAt,
    reconnectRequired: mapped.status === "disabled" || mapped.status === "expired",
  };
}

function toConnectionStatus({ binding = null, subscription = null, requested = false } = {}) {
  const publicBinding = toPublicCodeClipProviderBinding(binding);
  const publicSubscription = toPublicSubscription(subscription);
  const providerAccountId = binding?.providerAccountId || binding?.provider_account_id || "";
  return {
    provider: "youtube",
    selected: Boolean(requested || binding || subscription),
    requested: Boolean(requested || binding || subscription),
    connectionStatus: binding?.status === "active" ? "connected" : requested ? "requested" : "not_connected",
    channelDisplayName: binding?.displayName || binding?.display_name || null,
    maskedChannelId: providerAccountId ? maskCodeClipProviderAccountId(providerAccountId) : null,
    bindingStatus: publicBinding?.status || null,
    subscriptionStatus: publicSubscription?.status || null,
    verifiedAt: publicSubscription?.verifiedAt || null,
    leaseExpiresAt: publicSubscription?.leaseExpiresAt || null,
    reconnectRequired: Boolean(publicSubscription?.reconnectRequired),
    errorCode: null,
  };
}

async function startCodeClipYouTubeConnection(input = {}, options = {}) {
  const eventCode = normalizeEventCode(input.eventCode);
  await requireCodeClipEpisode(eventCode, { getEventByCode: options.getEventByCode });
  const policy = (options.loadPolicy || loadCodeClipYouTubeConnectionPolicy)({
    env: options.env || process.env,
  });
  const returnUrl = assertAllowedReturnUrl(input.returnUrl, policy);
  const { state, payload } = createCodeClipYouTubeOAuthState({
    eventCode,
    returnUrl,
    secret: policy.stateSecret,
    now: options.now,
    nonce: options.generateNonce ? options.generateNonce() : undefined,
  });
  await (options.recordOAuthState)(payload, { queryClient: options.queryClient });
  return {
    ok: true,
    provider: "youtube",
    authorizationUrl: buildCodeClipYouTubeAuthorizationUrl({ policy, state }),
    expiresAt: payload.expiresAt,
  };
}

async function ensurePendingSubscription({ eventCode, binding, queryClient, options = {} }) {
  const existing = await (
    options.getOpenSubscriptionByProviderAccountId ||
    getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId
  )(binding.providerAccountId, { queryClient });
  if (existing) return { created: false, subscription: existing };

  const created = await (
    options.createPendingSubscription || createPendingCodeClipYouTubeWebSubSubscription
  )(
    {
      callbackId: buildCallbackId(binding.providerAccountId),
      providerAccountId: binding.providerAccountId,
      topic: buildTopic(binding.providerAccountId),
      metadata: {
        eventCode,
        bindingId: binding.id,
        requestedBy: "creator_oauth",
      },
    },
    { queryClient }
  );
  await (options.recordSubscriptionAudit || recordCodeClipYouTubeWebSubSubscriptionAudit)(
    {
      callbackId: created.callbackId,
      providerAccountId: binding.providerAccountId,
      eventCode,
      action: "subscription_requested",
      mode: "subscribe",
      resultCode: "subscription_pending",
      retryable: false,
      metadata: {
        resultingStatus: created.status,
      },
    },
    { queryClient }
  );
  return { created: true, subscription: created };
}

async function completeCodeClipYouTubeConnection(input = {}, options = {}) {
  const policy = (options.loadPolicy || loadCodeClipYouTubeConnectionPolicy)({
    env: options.env || process.env,
  });
  let statePayload;
  try {
    statePayload = verifyCodeClipYouTubeOAuthState(input.state, {
      secret: policy.stateSecret,
      now: options.now,
    });
  } catch (error) {
    if (error instanceof CodeClipYouTubeOAuthStateError) {
      throw connectionError(error.code, error.message);
    }
    throw error;
  }
  const consumed = await options.consumeOAuthState(statePayload, {
    queryClient: options.queryClient,
  });
  if (!consumed?.consumed) {
    if (consumed?.reason === "replayed") {
      throw connectionError("youtube_oauth_replayed", "YouTube OAuth state was already used");
    }
    if (consumed?.reason === "expired") {
      throw connectionError("youtube_oauth_state_expired", "YouTube OAuth state has expired");
    }
    throw connectionError("youtube_oauth_state_invalid", "YouTube OAuth state is invalid");
  }

  if (input.error) {
    throw connectionError("youtube_authorization_denied", "YouTube authorization was denied");
  }

  const event = await requireCodeClipEpisode(statePayload.eventCode, {
    getEventByCode: options.getEventByCode,
  });
  const tokenResult = await (options.exchangeCode || exchangeCodeClipYouTubeAuthorizationCode)({
    code: input.code,
    policy,
    fetchImpl: options.fetchImpl,
  });
  const channel = await (options.fetchChannel || fetchAuthenticatedYouTubeChannel)({
    accessToken: tokenResult.accessToken,
    policy,
    fetchImpl: options.fetchImpl,
  });

  return options.runTransaction(async ({ queryClient }) => {
    const bindingResult = await (options.createBinding || createCodeClipProviderAccountBinding)(
      {
        eventCode: statePayload.eventCode,
        provider: "youtube",
        channel: "youtube",
        providerAccountId: channel.channelId,
        displayName: channel.displayName,
        createdBy: "creator_oauth",
        metadata: {
          source: "youtube_oauth",
          thumbnailUrl: channel.thumbnailUrl || null,
        },
      },
      {
        queryClient,
        getEventByCode: async (candidateEventCode) =>
          String(candidateEventCode || "").trim() === statePayload.eventCode ? event : null,
      }
    );

    if (bindingResult.created) {
      await (options.appendBindingAudit || appendCodeClipProviderAccountBindingAuditEvent)(
        {
          binding: bindingResult.row,
          action: "created",
          actorType: "operator_key",
          actorId: null,
          beforeState: null,
          afterState: cloneState(toAuditState(bindingResult.row)),
          metadata: { source: "youtube_oauth" },
        },
        { queryClient }
      );
    }

    const subscriptionResult = await ensurePendingSubscription({
      eventCode: statePayload.eventCode,
      binding: bindingResult.row,
      queryClient,
      options,
    });

    return {
      ok: true,
      provider: "youtube",
      eventCode: statePayload.eventCode,
      returnUrl: statePayload.returnUrl,
      bindingCreated: Boolean(bindingResult.created),
      subscriptionCreated: Boolean(subscriptionResult.created),
      connection: toConnectionStatus({
        binding: bindingResult.row,
        subscription: subscriptionResult.subscription,
        requested: true,
      }),
    };
  }, options.queryClient);
}

async function getCodeClipYouTubeConnectionStatus(input = {}, options = {}) {
  const eventCode = normalizeEventCode(input.eventCode);
  await requireCodeClipEpisode(eventCode, { getEventByCode: options.getEventByCode });
  const bindings = await options.listBindingsForEvent(eventCode, {
    includeDisabled: true,
    queryClient: options.queryClient,
  });
  const binding = (bindings || []).find(
    (row) => row.provider === "youtube" && row.channel === "youtube"
  ) || null;
  if (!binding) return { ok: true, eventCode, connection: toConnectionStatus() };
  const subscription = await (
    options.getOpenSubscriptionByProviderAccountId ||
    getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId
  )(binding.providerAccountId, { queryClient: options.queryClient });
  return {
    ok: true,
    eventCode,
    connection: toConnectionStatus({ binding, subscription, requested: true }),
  };
}

function mapConnectionError(error) {
  if (error instanceof CodeClipYouTubeConnectionError) return error;
  if (error instanceof CodeClipYouTubeConnectionPolicyError) {
    return connectionError(error.code, "YouTube OAuth is unavailable");
  }
  if (error instanceof CodeClipYouTubeOAuthClientError) {
    return connectionError(error.code, "YouTube connection unavailable");
  }
  if (error instanceof CodeClipProviderAccountBindingError) {
    if (error.code === "PROVIDER_ACCOUNT_BINDING_CONFLICT") {
      return connectionError("youtube_binding_conflict", "YouTube channel is already connected", error.details);
    }
    if (error.code === "CODECLIP_EVENT_NOT_FOUND") {
      return connectionError("youtube_episode_not_found", "Episode not found");
    }
    if (error.code === "INVALID_PROVIDER_BINDING") {
      return connectionError("youtube_connection_unavailable", "YouTube connection unavailable");
    }
  }
  return connectionError("youtube_connection_unavailable", "YouTube connection unavailable");
}

module.exports = {
  CodeClipYouTubeConnectionError,
  completeCodeClipYouTubeConnection,
  getCodeClipYouTubeConnectionStatus,
  mapConnectionError,
  startCodeClipYouTubeConnection,
};
