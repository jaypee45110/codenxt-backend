/**
 * Creator-facing TikTok connect/status (thin layer over existing OAuth).
 *
 * - Authorization: caller must already enforce Episode dashboardAccessKey.
 * - OAuth start/callback/credential/binding: existing tiktok/oauth-connection.
 * - No admin key. No tokens/open_id/ciphertext in responses.
 * - Creator connect is sandbox-only unless explicitly configured later.
 */

const {
  listCodeClipProviderAccountBindingsForEvent,
} = require("../provider-account-bindings");
const {
  findCodeClipProviderCredential,
  inspectCodeClipProviderCredentialUsability,
} = require("../provider-credentials");
const {
  findCodeClipProviderPollSource,
} = require("../provider-poll-sources");
const {
  startCodeClipTikTokOAuthConnection,
  CodeClipTikTokOAuthConnectionError,
} = require("./oauth-connection");

const PROVIDER = "tiktok";
const CHANNEL = "tiktok";
const VERTICAL = "codeclip";
const VIDEO_LIST_SCOPE = "video.list";
const BASIC_SCOPE = "user.info.basic";

class CodeClipTikTokCreatorConnectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokCreatorConnectError";
    this.code = code;
    this.details =
      details && typeof details === "object" && !Array.isArray(details)
        ? { ...details }
        : {};
  }
}

function creatorError(code, message, details = {}) {
  return new CodeClipTikTokCreatorConnectError(code, message, details);
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw creatorError(
      "DATABASE_UNAVAILABLE",
      "TikTok creator connect requires a query client"
    );
  }
  return queryClient;
}

function normalizeEventCode(value) {
  const eventCode = String(value || "").trim();
  if (!eventCode || eventCode.length > 120) {
    throw creatorError("INVALID_EVENT", "eventCode is invalid", {
      fieldName: "eventCode",
    });
  }
  return eventCode;
}

/**
 * Creator connect is sandbox-only for foundation safety.
 * Production is never selectable from the browser.
 */
function resolveCreatorEnvironment(env = process.env) {
  const flag = String(env.CODECLIP_TIKTOK_CREATOR_ALLOW_PRODUCTION || "")
    .trim()
    .toLowerCase();
  // Explicit opt-in reserved for a future production phase — still not used yet.
  if (flag === "1" || flag === "true" || flag === "yes") {
    // Foundation task still forces sandbox to avoid production credential creation.
    return "sandbox";
  }
  return "sandbox";
}

function scopeFlags(scopes) {
  const list = Array.isArray(scopes) ? scopes.map((s) => String(s)) : [];
  return {
    userInfoBasic: list.includes(BASIC_SCOPE),
    videoList: list.includes(VIDEO_LIST_SCOPE),
  };
}

function pickTikTokBinding(bindings) {
  const rows = Array.isArray(bindings) ? bindings : [];
  return (
    rows.find(
      (item) =>
        String(item.provider || "").toLowerCase() === PROVIDER &&
        String(item.channel || "").toLowerCase() === CHANNEL &&
        String(item.status || "").toLowerCase() === "active"
    ) ||
    rows.find(
      (item) =>
        String(item.provider || "").toLowerCase() === PROVIDER &&
        String(item.channel || "").toLowerCase() === CHANNEL
    ) ||
    null
  );
}

/**
 * Creator-safe connection status (no open_id / tokens / ciphertext).
 */
function isActivePollSource(pollSource) {
  return (
    pollSource &&
    String(pollSource.status || "").toLowerCase() === "active"
  );
}

function toCreatorSafeTikTokConnectionStatus({
  eventCode,
  environment,
  binding,
  credential,
  usability,
  pollSource,
} = {}) {
  const scopes = scopeFlags(credential?.scopes);
  const reauth =
    credential?.reauthorizationRequired === true ||
    credential?.status === "reauthorization_required" ||
    usability?.reauthorizationRequired === true;
  const pollingReady = Boolean(isActivePollSource(pollSource));

  let status = "not_connected";
  if (binding && String(binding.status || "").toLowerCase() === "active") {
    if (reauth || credential?.status === "expired") {
      status = "reauthorization_required";
    } else if (
      credential &&
      (credential.status === "active" || credential.status === "refresh_needed")
    ) {
      // Fully connected only when sandbox poll source is active.
      status = pollingReady ? "connected" : "setup_pending";
    } else if (credential && ["disabled", "revoked"].includes(credential.status)) {
      status = "error";
    } else if (!credential) {
      status = "reauthorization_required";
    } else {
      status = "error";
    }
  } else if (binding && String(binding.status || "").toLowerCase() === "disabled") {
    status = "not_connected";
  }

  const displayName =
    typeof binding?.displayName === "string" && binding.displayName.trim()
      ? binding.displayName.trim().slice(0, 120)
      : null;

  return {
    ok: true,
    vertical: VERTICAL,
    provider: PROVIDER,
    channel: CHANNEL,
    eventCode,
    connection: {
      status,
      environment,
      reauthorizationRequired: Boolean(reauth) || status === "reauthorization_required",
      capabilities: {
        videoList: scopes.videoList === true,
        userInfoBasic: scopes.userInfoBasic === true,
      },
      displayName,
      pollingReady,
    },
  };
}

/**
 * Start TikTok OAuth for a creator-authorized Episode (sandbox).
 * Reuses startCodeClipTikTokOAuthConnection.
 */
async function startCodeClipTikTokCreatorConnect(
  input = {},
  options = {}
) {
  const queryClient = requireQueryClient(options.queryClient);
  const env = options.env || process.env;
  const eventCode = normalizeEventCode(input.eventCode);
  const returnUrl = input.returnUrl;
  const environment = resolveCreatorEnvironment(env);

  try {
    const result = await startCodeClipTikTokOAuthConnection(
      {
        eventCode,
        environment,
        returnUrl,
        // Creator self-service needs video.list for polling readiness.
        requestedScopes: input.requestedScopes || [
          "user.info.basic",
          "video.list",
        ],
        actor: { type: "system", id: "tiktok_creator_connect" },
        disableAutoAuth: input.disableAutoAuth,
        now: input.now,
      },
      {
        queryClient,
        env,
        getEventByCode:
          options.getEventByCode ||
          (async () => {
            throw creatorError(
              "DATABASE_UNAVAILABLE",
              "event lookup is unavailable"
            );
          }),
      }
    );

    return {
      ok: true,
      provider: PROVIDER,
      eventCode,
      environment,
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    throw mapCreatorConnectError(error);
  }
}

/**
 * Authoritative creator status for Checkout (sandbox slice).
 */
async function getCodeClipTikTokCreatorConnectionStatus(
  input = {},
  options = {}
) {
  const queryClient = requireQueryClient(options.queryClient);
  const eventCode = normalizeEventCode(input.eventCode);
  const env = options.env || process.env;
  const environment = resolveCreatorEnvironment(env);
  const now =
    options.now instanceof Date
      ? options.now
      : options.now
        ? new Date(options.now)
        : new Date();

  const listBindingsForEvent =
    options.listBindingsForEvent || listCodeClipProviderAccountBindingsForEvent;
  const findCredential =
    options.findCredential || findCodeClipProviderCredential;
  const inspectUsability =
    options.inspectUsability || inspectCodeClipProviderCredentialUsability;
  const findPollSource =
    options.findPollSource || findCodeClipProviderPollSource;

  const bindings = await listBindingsForEvent(eventCode, {
    includeDisabled: true,
    queryClient,
  });
  const binding = pickTikTokBinding(bindings);

  let credential = null;
  let usability = null;
  let pollSource = null;
  if (binding?.providerAccountId) {
    credential = await findCredential(
      {
        provider: PROVIDER,
        providerAccountId: binding.providerAccountId,
        environment,
      },
      { queryClient, now }
    );
    if (credential?.id) {
      usability = await inspectUsability(
        { id: credential.id, now },
        { queryClient }
      );
    }
    pollSource = await findPollSource(
      {
        provider: PROVIDER,
        environment,
        providerAccountId: binding.providerAccountId,
      },
      { queryClient }
    );
  }

  return toCreatorSafeTikTokConnectionStatus({
    eventCode,
    environment,
    binding,
    credential,
    usability,
    pollSource,
  });
}

function mapCreatorConnectError(error) {
  if (error instanceof CodeClipTikTokCreatorConnectError) return error;
  if (error instanceof CodeClipTikTokOAuthConnectionError) {
    const code = error.code;
    if (code === "TIKTOK_CONFIG_NOT_AVAILABLE") {
      return creatorError(
        "TIKTOK_NOT_CONFIGURED",
        "TikTok is not configured",
        error.details
      );
    }
    if (code === "INVALID_CALLBACK" && error.details?.fieldName === "returnUrl") {
      return creatorError("INVALID_RETURN_URL", "returnUrl is invalid", error.details);
    }
    if (code === "INVALID_CALLBACK" && error.details?.fieldName === "eventCode") {
      return creatorError("INVALID_EVENT", "event is invalid", error.details);
    }
    if (code === "DATABASE_UNAVAILABLE" || code === "DATABASE_ERROR") {
      return creatorError(code, "database unavailable", error.details);
    }
    return creatorError(
      "TIKTOK_AUTHORIZATION_FAILED",
      "TikTok authorization could not be started",
      { reason: code }
    );
  }
  return creatorError(
    "TIKTOK_CONNECTION_UNAVAILABLE",
    "TikTok connection is unavailable"
  );
}

function mapCreatorConnectHttpStatus(code) {
  if (
    [
      "INVALID_EVENT",
      "INVALID_RETURN_URL",
      "TIKTOK_AUTHORIZATION_FAILED",
      "TIKTOK_NOT_CONFIGURED",
    ].includes(code)
  ) {
    return 400;
  }
  if (code === "EVENT_NOT_FOUND" || code === "creator_episode_not_found") {
    return 404;
  }
  if (
    code === "UNAUTHORIZED" ||
    code === "creator_connection_unauthorized"
  ) {
    return 401;
  }
  if (
    code === "FORBIDDEN" ||
    code === "creator_connection_forbidden"
  ) {
    return 403;
  }
  if (code === "BINDING_CONFLICT" || code === "TIKTOK_ACCOUNT_CONFLICT") {
    return 409;
  }
  return 503;
}

module.exports = {
  CodeClipTikTokCreatorConnectError,
  getCodeClipTikTokCreatorConnectionStatus,
  mapCreatorConnectError,
  mapCreatorConnectHttpStatus,
  resolveCreatorEnvironment,
  startCodeClipTikTokCreatorConnect,
  toCreatorSafeTikTokConnectionStatus,
};
