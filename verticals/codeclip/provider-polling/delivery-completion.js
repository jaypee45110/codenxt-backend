/**
 * Provider-polling delivery completion.
 *
 * TikTok is the first supported poll-only provider. Completion consumes the
 * durable detection metadata snapshot and never calls provider HTTP.
 */

const database = require("../../../db");
const codeClipService = require("../service");
const {
  findActiveCodeClipProviderAccountBinding,
} = require("../provider-account-bindings");
const {
  eventMatchesBoundProviderEventActivation,
} = require("../provider-activation");
const {
  getCodeClipProviderPollingCompletionInput,
} = require("./detection-metadata");

const SUPPORTED_PROVIDER = "tiktok";
const SUPPORTED_SOURCE = "provider_polling";
const TIKTOK_PUBLISHED_VIDEO_EVENT = "published_video";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

class CodeClipProviderPollingDeliveryCompletionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollingDeliveryCompletionError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function completionError(code, message, details = {}) {
  const safe = {};
  for (const key of ["fieldName", "reason", "stage"]) {
    if (details?.[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 80);
    }
  }
  return new CodeClipProviderPollingDeliveryCompletionError(code, message, safe);
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw completionError("INVALID_COMPLETION_INPUT", "completion limit is invalid", {
      fieldName: "limit",
    });
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeProvider(value = SUPPORTED_PROVIDER) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider !== SUPPORTED_PROVIDER) {
    throw completionError("UNSUPPORTED_PROVIDER", "provider is not supported", {
      fieldName: "provider",
    });
  }
  return provider;
}

function normalizeEnvironment(value) {
  if (value === undefined || value === null || value === "") return null;
  const environment = String(value || "").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw completionError("INVALID_COMPLETION_INPUT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return environment;
}

function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw completionError("INVALID_COMPLETION_INPUT", "now is invalid", {
      fieldName: "now",
    });
  }
  return date.toISOString();
}

function safeLog(logger, level, event, fields = {}) {
  if (!logger || typeof logger[level] !== "function") return;
  logger[level](event, {
    provider: fields.provider || SUPPORTED_PROVIDER,
    environment: fields.environment || null,
    source: SUPPORTED_SOURCE,
    status: fields.status || null,
    code: fields.code || null,
    stage: fields.stage || null,
    count: fields.count ?? undefined,
    durationMs: fields.durationMs ?? undefined,
  });
}

async function listClaimableProviderPollingDeliveries({
  provider,
  limit,
  queryClient,
}) {
  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_provider_deliveries
      WHERE provider = $1
        AND initial_delivery_source = $2
        AND verification_state = 'verified'
        AND processing_state = 'processing'
        AND core_persistence_state = 'not_started'
        AND completion_state = 'not_completed'
        AND terminal_state IS FALSE
      ORDER BY created_at ASC, id ASC
      LIMIT $3
    `,
    [provider, SUPPORTED_SOURCE, limit]
  );
  return result.rows || [];
}

function mapDeliveryRow(row = {}) {
  return {
    ...row,
    providerAccountId: row.providerAccountId || row.provider_account_id,
    eventCode: row.eventCode || row.event_code,
    eventId: row.eventId || row.event_id,
    externalMessageId: row.externalMessageId || row.external_message_id,
    initialDeliverySource:
      row.initialDeliverySource || row.initial_delivery_source,
    providerDetectionMetadata:
      row.providerDetectionMetadata || row.provider_detection_metadata || null,
    corePersistenceState:
      row.corePersistenceState || row.core_persistence_state,
    completionState: row.completionState || row.completion_state,
    processingState: row.processingState || row.processing_state,
    terminalState: row.terminalState ?? row.terminal_state,
  };
}

async function resolvePollSourceContext(
  { provider, providerAccountId, environment },
  { queryClient }
) {
  const params = [provider, providerAccountId];
  const environmentPredicate = environment ? `AND environment = $3` : "";
  if (environment) params.push(environment);
  const result = await queryClient.query(
    `
      SELECT environment, status
      FROM codeclip_provider_poll_sources
      WHERE vertical = 'codeclip'
        AND provider = $1
        AND provider_account_id = $2
        ${environmentPredicate}
      ORDER BY status = 'active' DESC, updated_at DESC, id DESC
      LIMIT 1
    `,
    params
  );
  return result.rows?.[0] || null;
}

function buildDeliveryIdentity(delivery) {
  return {
    provider: delivery.provider,
    providerAccountId: delivery.providerAccountId,
    eventCode: delivery.eventCode,
    externalMessageId: delivery.externalMessageId,
  };
}

async function updateDelivery(identity, updates, queryClient, updateState) {
  const result = await updateState(identity, updates, queryClient);
  if (!result || result.status !== "updated") {
    throw completionError("DELIVERY_STATE_UPDATE_FAILED", "delivery state update failed");
  }
  return result.row;
}

async function claimDeliveryForCompletion({ delivery, now, queryClient }) {
  const result = await queryClient.query(
    `
      UPDATE codeclip_provider_deliveries
      SET core_persistence_state = 'processing',
          last_attempt_at = $5::timestamptz,
          updated_at = NOW()
      WHERE provider = $1
        AND provider_account_id = $2
        AND event_code = $3
        AND external_message_id = $4
        AND initial_delivery_source = 'provider_polling'
        AND verification_state = 'verified'
        AND processing_state = 'processing'
        AND core_persistence_state = 'not_started'
        AND completion_state = 'not_completed'
        AND terminal_state IS FALSE
      RETURNING *
    `,
    [
      delivery.provider,
      delivery.providerAccountId,
      delivery.eventCode,
      delivery.externalMessageId,
      now,
    ]
  );
  return result.rows?.[0] ? mapDeliveryRow(result.rows[0]) : null;
}

async function markTerminalFailure({
  delivery,
  code,
  responseStatus = 422,
  now,
  queryClient,
  updateState,
}) {
  return updateDelivery(
    buildDeliveryIdentity(delivery),
    {
      processingState: "failed",
      corePersistenceState:
        delivery.corePersistenceState === "processing" ? "failed" : "not_started",
      completionState: "not_completed",
      responseStatus,
      publicResponseJson: { ok: false, code },
      errorClass: code,
      retryEligible: false,
      terminalState: true,
      lastAttemptAt: now,
    },
    queryClient,
    updateState
  );
}

async function markRetryableFailure({
  delivery,
  code,
  now,
  queryClient,
  updateState,
}) {
  return updateDelivery(
    buildDeliveryIdentity(delivery),
    {
      processingState: "failed",
      corePersistenceState: "failed",
      completionState: "not_completed",
      responseStatus: 503,
      publicResponseJson: { ok: false, code },
      errorClass: code,
      retryEligible: true,
      terminalState: false,
      lastAttemptAt: now,
    },
    queryClient,
    updateState
  );
}

function buildTikTokProviderEvent({ delivery, metadata }) {
  return {
    provider: SUPPORTED_PROVIDER,
    channel: "tiktok",
    activationEvent: TIKTOK_PUBLISHED_VIDEO_EVENT,
    providerEventId: delivery.externalMessageId,
    videoId: metadata.providerContentId,
    externalMessageId: delivery.externalMessageId,
    publishedAt: metadata.publishedAt,
    canonicalUrl: metadata.canonicalUrl || "",
  };
}

async function completeOneProviderPollingDelivery(
  deliveryInput = {},
  options = {}
) {
  const {
    queryClient = database.pool,
    getEventByCode = database.getCampaignByCode,
    findActiveBinding = findActiveCodeClipProviderAccountBinding,
    createProviderEventInteraction = codeClipService.createProviderEventInteraction,
    persistCodeClipCoreInteraction = codeClipService.persistCodeClipCoreInteraction,
    saveCodeClipInteraction = database.saveCodeClipInteraction,
    saveCodeClipRewardAssignments = database.saveCodeClipRewardAssignments,
    saveCodeClipXtraRedemption = database.saveCodeClipXtraRedemption,
    runCodeClipCorePersistenceTransaction =
      database.withCodeClipCorePersistenceTransaction,
    updateDeliveryState = database.updateCodeClipProviderDeliveryState,
    claimDelivery = claimDeliveryForCompletion,
    logger,
    now,
    environment,
  } = options;

  if (!queryClient || typeof queryClient.query !== "function") {
    throw completionError("DATABASE_UNAVAILABLE", "query client is required");
  }

  const completionNow = normalizeNow(now);
  const requestedEnvironment = normalizeEnvironment(environment);
  const delivery = mapDeliveryRow(deliveryInput);
  const identity = buildDeliveryIdentity(delivery);
  safeLog(logger, "info", "provider_polling_delivery_selected", {
    environment: requestedEnvironment,
    status: "selected",
  });

  if (
    delivery.provider !== SUPPORTED_PROVIDER ||
    delivery.initialDeliverySource !== SUPPORTED_SOURCE ||
    delivery.processingState !== "processing" ||
    delivery.corePersistenceState !== "not_started" ||
    delivery.completionState !== "not_completed" ||
    delivery.terminalState !== false
  ) {
    return { ok: true, status: "skipped", code: "not_eligible" };
  }

  const completionInput = getCodeClipProviderPollingCompletionInput(delivery);
  if (!completionInput.ok) {
    await markTerminalFailure({
      delivery,
      code: completionInput.code,
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    safeLog(logger, "warn", "provider_polling_completion_input_insufficient", {
      environment: requestedEnvironment,
      status: "terminal_failed",
      code: completionInput.code,
      stage: "metadata",
    });
    return { ok: false, status: "terminal_failed", code: completionInput.code };
  }

  const sourceContext = await resolvePollSourceContext(
    {
      provider: SUPPORTED_PROVIDER,
      providerAccountId: delivery.providerAccountId,
      environment: requestedEnvironment,
    },
    { queryClient }
  );
  if (!sourceContext && requestedEnvironment) {
    return { ok: true, status: "skipped", code: "environment_mismatch" };
  }
  if (!sourceContext || sourceContext.status !== "active") {
    await markTerminalFailure({
      delivery,
      code: "INVALID_EVENT_MAPPING",
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    return { ok: false, status: "terminal_failed", code: "INVALID_EVENT_MAPPING" };
  }
  const effectiveEnvironment = sourceContext.environment;

  const binding = await findActiveBinding(
    {
      provider: SUPPORTED_PROVIDER,
      providerAccountId: delivery.providerAccountId,
    },
    { queryClient }
  );
  if (!binding || binding.eventCode !== delivery.eventCode || binding.channel !== "tiktok") {
    await markTerminalFailure({
      delivery,
      code: "INVALID_EVENT_MAPPING",
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    return { ok: false, status: "terminal_failed", code: "INVALID_EVENT_MAPPING" };
  }

  const eventRecord = await getEventByCode(delivery.eventCode);
  const event = eventRecord?.raw_event || eventRecord;
  if (
    !event ||
    String(event.vertical || "").trim().toLowerCase() !== "codeclip" ||
    !eventMatchesBoundProviderEventActivation(event, {
      provider: SUPPORTED_PROVIDER,
      channel: "tiktok",
      activationEvent: TIKTOK_PUBLISHED_VIDEO_EVENT,
    })
  ) {
    await markTerminalFailure({
      delivery,
      code: "INVALID_EVENT_MAPPING",
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    return { ok: false, status: "terminal_failed", code: "INVALID_EVENT_MAPPING" };
  }

  const claimed = await claimDelivery({ delivery, now: completionNow, queryClient });
  if (!claimed) {
    return { ok: true, status: "skipped", code: "already_claimed" };
  }

  safeLog(logger, "info", "provider_polling_core_persistence_started", {
    environment: effectiveEnvironment,
    status: "processing",
    stage: "core_persistence",
  });

  let interaction;
  try {
    interaction = createProviderEventInteraction({
      event,
      eventCode: delivery.eventCode,
      eventId: delivery.eventId || eventRecord?.id || event?.id || null,
      providerEvent: buildTikTokProviderEvent({
        delivery,
        metadata: completionInput.completionInput,
      }),
      occurredAt: completionInput.completionInput.publishedAt,
    });

    await persistCodeClipCoreInteraction({
      interaction,
      saveCodeClipInteraction,
      saveCodeClipRewardAssignments,
      saveCodeClipXtraRedemption,
      runCodeClipCorePersistenceTransaction,
      logPrefix: "codeClip TikTok provider-polling",
    });

    interaction.persistenceDecision = codeClipService.buildPersistenceDecision(
      interaction.persistenceStatus
    );
  } catch (_error) {
    await markRetryableFailure({
      delivery,
      code: "CORE_PERSISTENCE_FAILED",
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    safeLog(logger, "warn", "provider_polling_delivery_retryable_failure", {
      environment: effectiveEnvironment,
      status: "retryable_failed",
      code: "CORE_PERSISTENCE_FAILED",
      stage: "core_persistence",
    });
    return { ok: false, status: "retryable_failed", code: "CORE_PERSISTENCE_FAILED" };
  }

  if (!interaction.persistenceDecision?.ok) {
    await markRetryableFailure({
      delivery,
      code: "CORE_PERSISTENCE_FAILED",
      now: completionNow,
      queryClient,
      updateState: updateDeliveryState,
    });
    return { ok: false, status: "retryable_failed", code: "CORE_PERSISTENCE_FAILED" };
  }

  await updateDelivery(
    identity,
    {
      corePersistenceState: "committed",
      processingState: "completed",
      completionState: "completed",
      responseStatus: 202,
      publicResponseJson: {
        ok: true,
        accepted: true,
        status: "processed",
      },
      errorClass: null,
      retryEligible: false,
      terminalState: true,
      completedAt: completionNow,
      lastAttemptAt: completionNow,
    },
    queryClient,
    updateDeliveryState
  );

  safeLog(logger, "info", "provider_polling_delivery_completed", {
    environment: effectiveEnvironment,
    status: "completed",
    stage: "completion",
  });

  return {
    ok: true,
    status: "completed",
    code: "COMPLETED",
    environment: effectiveEnvironment,
  };
}

async function runCodeClipProviderPollingDeliveryCompletionCycle(
  input = {},
  options = {}
) {
  const queryClient = options.queryClient || database.pool;
  if (!queryClient || typeof queryClient.query !== "function") {
    throw completionError("DATABASE_UNAVAILABLE", "query client is required");
  }
  const provider = normalizeProvider(input.provider || SUPPORTED_PROVIDER);
  const environment = normalizeEnvironment(input.environment);
  const limit = normalizeLimit(input.limit);
  const logger = options.logger;
  const startedAt = Date.now();

  const deliveries = (
    options.listDeliveries
      ? await options.listDeliveries({ provider, limit, environment }, { queryClient })
      : await listClaimableProviderPollingDeliveries({ provider, limit, queryClient })
  ).map(mapDeliveryRow);

  const summary = {
    ok: true,
    provider,
    environment,
    selected: 0,
    completed: 0,
    skipped: 0,
    retryableFailed: 0,
    terminalFailed: 0,
    results: [],
  };

  for (const delivery of deliveries) {
    const sourceContext = await resolvePollSourceContext(
      {
        provider,
        providerAccountId: delivery.providerAccountId,
        environment,
      },
      { queryClient }
    );
    if (!sourceContext || sourceContext.status !== "active") {
      summary.skipped += 1;
      continue;
    }
    summary.selected += 1;
    const result = await completeOneProviderPollingDelivery(delivery, {
      ...options,
      queryClient,
      logger,
      environment: sourceContext.environment,
    });
    summary.results.push({ status: result.status, code: result.code });
    if (result.status === "completed") summary.completed += 1;
    else if (result.status === "retryable_failed") summary.retryableFailed += 1;
    else if (result.status === "terminal_failed") summary.terminalFailed += 1;
    else summary.skipped += 1;
  }

  safeLog(logger, "info", "provider_polling_delivery_completion_cycle_completed", {
    environment,
    status: "completed",
    count: summary.selected,
    durationMs: Date.now() - startedAt,
  });

  return summary;
}

module.exports = {
  CodeClipProviderPollingDeliveryCompletionError,
  completeOneProviderPollingDelivery,
  runCodeClipProviderPollingDeliveryCompletionCycle,
};
