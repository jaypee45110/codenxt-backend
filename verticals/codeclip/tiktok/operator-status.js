/**
 * Read-only TikTok operator status for codeClip events.
 *
 * Safe aggregates only — no tokens, no open_id, no raw payloads.
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
  classifyCodeClipProviderPollingSourceHealth,
  classifyCodeClipProviderPollingDeliveryHealth,
} = require("../provider-polling/health-classification");

const PROVIDER = "tiktok";
const CHANNEL = "tiktok";
const VERTICAL = "codeclip";
const BASIC_SCOPE = "user.info.basic";
const VIDEO_LIST_SCOPE = "video.list";

class CodeClipTikTokOperatorStatusError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokOperatorStatusError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function statusError(code, message, details = {}) {
  return new CodeClipTikTokOperatorStatusError(code, message, details);
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw statusError(
      "DATABASE_UNAVAILABLE",
      "TikTok operator status requires a query client"
    );
  }
  return queryClient;
}

function normalizeEventCode(value) {
  if (typeof value !== "string") {
    throw statusError("INVALID_STATUS_INPUT", "eventCode is required", {
      fieldName: "eventCode",
    });
  }
  const eventCode = value.trim();
  if (!eventCode || eventCode.length > 80) {
    throw statusError("INVALID_STATUS_INPUT", "eventCode is invalid", {
      fieldName: "eventCode",
    });
  }
  return eventCode;
}

function normalizeEnvironment(value) {
  if (value === undefined || value === null || value === "") return null;
  const environment = String(value).trim().toLowerCase();
  if (environment !== "sandbox" && environment !== "production") {
    throw statusError("INVALID_STATUS_INPUT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return environment;
}

function scopeFlags(scopes) {
  const list = Array.isArray(scopes) ? scopes.map((s) => String(s)) : [];
  return {
    userInfoBasic: list.includes(BASIC_SCOPE),
    videoList: list.includes(VIDEO_LIST_SCOPE),
  };
}

function credentialHealth(credential, usability) {
  if (!credential) {
    return {
      present: false,
      status: "missing",
      expired: null,
      reauthorizationRequired: false,
      reauthorizationReason: null,
      hasAccessToken: false,
      hasRefreshToken: false,
      accessTokenExpiresAt: null,
      lastRefreshedAt: null,
      usableForProviderApi: false,
      scopes: {
        userInfoBasic: false,
        videoList: false,
      },
    };
  }

  const scopes = scopeFlags(credential.scopes);
  const reauth =
    credential.reauthorizationRequired === true ||
    credential.status === "reauthorization_required" ||
    usability?.reauthorizationRequired === true;

  let status = String(credential.status || "unknown");
  if (reauth) status = "reauthorization_required";
  else if (credential.expired === true) status = "expired";
  else if (credential.status === "active" && scopes.videoList !== true) {
    status = "refresh_needed";
  }

  return {
    present: true,
    status,
    expired: credential.expired === true,
    reauthorizationRequired: reauth,
    reauthorizationReason: credential.reauthorizationReason || null,
    hasAccessToken: credential.hasAccessToken === true,
    hasRefreshToken: credential.hasRefreshToken === true,
    accessTokenExpiresAt: credential.accessTokenExpiresAt || null,
    lastRefreshedAt: credential.lastRefreshedAt || null,
    usableForProviderApi: usability?.usableForProviderApi === true,
    scopes,
  };
}

function serializePollSource(source) {
  if (!source) return null;
  const checkpoint =
    source.checkpoint && typeof source.checkpoint === "object"
      ? source.checkpoint
      : {};
  const claimActive = Boolean(
    source.pollClaimOwner &&
      source.pollClaimExpiresAt &&
      Date.parse(source.pollClaimExpiresAt) > Date.now()
  );
  return {
    status: source.status || null,
    environment: source.environment || null,
    pollIntervalMs: Number.isFinite(source.pollIntervalMs)
      ? source.pollIntervalMs
      : null,
    nextPollAt: source.nextPollAt || null,
    lastPolledAt: source.lastPolledAt || null,
    lastSuccessAt: source.lastSuccessAt || null,
    consecutiveFailures:
      typeof source.consecutiveFailures === "number"
        ? source.consecutiveFailures
        : 0,
    lastErrorCode: source.lastErrorCode || null,
    lastDetectionsCount:
      source.lastDetectionsCount === undefined ||
      source.lastDetectionsCount === null
        ? null
        : Number(source.lastDetectionsCount),
    checkpointInitialized: checkpoint.initialized === true,
    claimActive,
    pollClaimVersion:
      typeof source.pollClaimVersion === "number"
        ? source.pollClaimVersion
        : null,
  };
}

async function loadDeliveryAggregates(
  { environment },
  { queryClient }
) {
  const params = [PROVIDER, "provider_polling"];
  let envClause = "";
  // Deliveries table has no environment column; filter via poll source join when env set.
  // Keep provider_polling aggregates scoped by matching open_id is not available safely.
  // Use provider + source only for global TikTok polling ledger health.
  void environment;

  const result = await queryClient.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE processing_state = 'processing'
        )::int AS processing,
        COUNT(*) FILTER (
          WHERE completion_state = 'completed'
            AND terminal_state IS TRUE
        )::int AS completed,
        COUNT(*) FILTER (
          WHERE retry_eligible IS TRUE
            AND terminal_state IS FALSE
            AND processing_state = 'failed'
        )::int AS retryable_failed,
        COUNT(*) FILTER (
          WHERE terminal_state IS TRUE
            AND completion_state IS DISTINCT FROM 'completed'
        )::int AS terminal_failed,
        COUNT(*) FILTER (
          WHERE verification_state = 'verified'
            AND processing_state = 'processing'
            AND core_persistence_state = 'not_started'
            AND completion_state = 'not_completed'
            AND terminal_state IS FALSE
        )::int AS pending_completion_ready,
        COUNT(*) FILTER (
          WHERE terminal_state IS TRUE
            AND error_class = 'COMPLETION_INPUT_INSUFFICIENT'
        )::int AS terminal_completion_input_insufficient,
        COUNT(*) FILTER (
          WHERE terminal_state IS TRUE
            AND error_class = 'INVALID_EVENT_MAPPING'
        )::int AS terminal_invalid_event_mapping,
        (
          SELECT error_class
          FROM codeclip_provider_deliveries
          WHERE provider = $1
            AND initial_delivery_source = $2
            AND error_class IS NOT NULL
          ORDER BY COALESCE(last_attempt_at, updated_at, created_at) DESC NULLS LAST
          LIMIT 1
        ) AS latest_error_class
      FROM codeclip_provider_deliveries
      WHERE provider = $1
        AND initial_delivery_source = $2
    `,
    params
  );
  const row = result.rows?.[0] || {};
  return {
    detectionSource: "provider_polling",
    total: Number(row.total) || 0,
    processing: Number(row.processing) || 0,
    completed: Number(row.completed) || 0,
    retryableFailed: Number(row.retryable_failed) || 0,
    terminalFailed: Number(row.terminal_failed) || 0,
    pendingCompletionReady: Number(row.pending_completion_ready) || 0,
    terminalCompletionInputInsufficient:
      Number(row.terminal_completion_input_insufficient) || 0,
    terminalInvalidEventMapping:
      Number(row.terminal_invalid_event_mapping) || 0,
    latestSafeClassification: row.latest_error_class
      ? String(row.latest_error_class).slice(0, 80)
      : null,
  };
}

async function buildEnvironmentSlice(
  {
    eventCode,
    environment,
    binding,
    now,
  },
  { queryClient, findCredential, inspectUsability, findPollSource }
) {
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
      try {
        usability = await inspectUsability(
          { id: credential.id, now },
          { queryClient }
        );
      } catch {
        usability = null;
      }
    }
    pollSource = await findPollSource(
      {
        provider: PROVIDER,
        providerAccountId: binding.providerAccountId,
        environment,
      },
      { queryClient }
    );
  }

  const sourceHealth = classifyCodeClipProviderPollingSourceHealth({
    source: pollSource,
    now,
  });

  return {
    environment,
    binding: binding
      ? {
          present: true,
          status: binding.status || null,
          channel: CHANNEL,
          // public binding serializer already masks account if used; keep status only here
        }
      : {
          present: false,
          status: null,
          channel: CHANNEL,
        },
    connection: {
      provider: PROVIDER,
      channel: CHANNEL,
      environment,
      bindingStatus: binding?.status || "missing",
      credentialStatus: credential?.status || "missing",
      scopes: scopeFlags(credential?.scopes),
    },
    credential: credentialHealth(credential, usability),
    pollingSource: serializePollSource(pollSource),
    pollingHealth: sourceHealth,
  };
}

/**
 * Build safe TikTok operator status for one event.
 *
 * When environment is omitted, returns sandbox and production slices.
 */
async function buildCodeClipTikTokOperatorStatus(
  input = {},
  options = {}
) {
  const queryClient = requireQueryClient(options.queryClient);
  const eventCode = normalizeEventCode(input.eventCode);
  const requestedEnvironment = normalizeEnvironment(input.environment);
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
  const loadDeliveries =
    options.loadDeliveryAggregates || loadDeliveryAggregates;

  const eventBindings = await listBindingsForEvent(eventCode, {
    includeDisabled: true,
    queryClient,
  });
  const binding =
    (Array.isArray(eventBindings) ? eventBindings : []).find(
      (item) =>
        String(item.provider || "").toLowerCase() === PROVIDER &&
        String(item.channel || "").toLowerCase() === CHANNEL &&
        String(item.status || "").toLowerCase() === "active"
    ) ||
    (Array.isArray(eventBindings) ? eventBindings : []).find(
      (item) =>
        String(item.provider || "").toLowerCase() === PROVIDER &&
        String(item.channel || "").toLowerCase() === CHANNEL
    ) ||
    null;

  const environments = requestedEnvironment
    ? [requestedEnvironment]
    : ["sandbox", "production"];

  const byEnvironment = {};
  for (const environment of environments) {
    byEnvironment[environment] = await buildEnvironmentSlice(
      { eventCode, environment, binding, now },
      {
        queryClient,
        findCredential,
        inspectUsability,
        findPollSource,
      }
    );
  }

  const delivery = await loadDeliveries(
    { environment: requestedEnvironment },
    { queryClient }
  );
  const deliveryHealth = classifyCodeClipProviderPollingDeliveryHealth({
    terminalCompletionFailures: delivery.terminalFailed,
    retryableFailures: delivery.retryableFailed,
    processing: delivery.processing,
    pendingCompletionReady: delivery.pendingCompletionReady,
  });

  const primary =
    byEnvironment.sandbox ||
    byEnvironment.production ||
    Object.values(byEnvironment)[0] ||
    null;

  return {
    ok: true,
    vertical: VERTICAL,
    provider: PROVIDER,
    channel: CHANNEL,
    eventCode,
    generatedAt: now.toISOString(),
    requestedEnvironment,
    environments: byEnvironment,
    delivery: {
      ...delivery,
      health: deliveryHealth,
    },
    // Convenience summary for primary/default env (sandbox first when both).
    summary: primary
      ? {
          environment: primary.environment,
          bindingPresent: primary.binding.present,
          bindingStatus: primary.binding.status,
          credentialStatus: primary.credential.status,
          scopes: primary.credential.scopes,
          pollingSourceStatus: primary.pollingSource?.status || null,
          pollingHealth: primary.pollingHealth,
          productionConfigured: Boolean(
            byEnvironment.production?.pollingSource ||
              byEnvironment.production?.credential?.present
          ),
        }
      : null,
  };
}

module.exports = {
  CodeClipTikTokOperatorStatusError,
  buildCodeClipTikTokOperatorStatus,
  classifyCodeClipProviderPollingSourceHealth,
  classifyCodeClipProviderPollingDeliveryHealth,
};
