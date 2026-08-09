const database = require("../../db");
const {
  getCodeClipRegisteredProviders,
} = require("./provider-registry");
const {
  getCodeClipProviderAccountBindingOperationsSummary,
  getCodeClipProviderBindingSupportedChannels,
  toPublicCodeClipProviderBinding,
} = require("./provider-account-bindings");
const {
  listCodeClipYouTubeWebSubSubscriptionStatuses,
} = require("./youtube-websub-operations");
const {
  classifyCodeClipProviderPollingSourceHealth,
  classifyCodeClipProviderPollingDeliveryHealth,
} = require("./provider-polling/health-classification");

const CODECLIP_VERTICAL = "codeclip";
const SURFACE_NAME = "smoothoperator";

const CAPABILITY_FLAGS = Object.freeze({
  bindingCreate: true,
  bindingUpdate: true,
  bindingDisable: true,
  bindingReactivate: true,
  bindingAuditRead: true,
  youtubeSubscriptionCreate: true,
  youtubeSubscriptionRenew: true,
  youtubeSubscriptionUnsubscribe: true,
  youtubeSubscriptionStatusRead: true,
  deliverySummary: true,
  deliveryDrilldown: false,
  manualReplay: false,
  deliveryRetry: false,
  tiktokStatusRead: true,
  providerPollingHealthRead: true,
});

const OPEN_YOUTUBE_SUBSCRIPTION_STATUSES = new Set([
  "pending_subscribe",
  "active",
  "pending_renewal",
  "pending_unsubscribe",
]);

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw new Error("SmoothOperator provider operations require a query client");
  }
  return queryClient;
}

function countBy(items, readKey) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(readKey(item) || "").trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeBindingSummary(summary = {}) {
  const latest = Array.isArray(summary.latest) ? summary.latest : [];
  return {
    counts: {
      total: Number(summary.counts?.total) || 0,
      byProvider: summary.counts?.byProvider || {},
      byChannel: summary.counts?.byChannel || {},
      byStatus: summary.counts?.byStatus || {},
    },
    latest: latest.map(toPublicCodeClipProviderBinding).filter(Boolean),
    latestLimit: Number(summary.latestLimit) || latest.length,
  };
}

function buildYouTubeSubscriptionSummary(subscriptions = []) {
  const items = Array.isArray(subscriptions) ? subscriptions : [];
  const byStatus = countBy(items, (item) => item.status);
  const openCount = items.filter((item) =>
    OPEN_YOUTUBE_SUBSCRIPTION_STATUSES.has(String(item.status || ""))
  ).length;

  return {
    counts: {
      total: items.length,
      byStatus,
      open: openCount,
      active: byStatus.active || 0,
    },
    readiness: {
      hasActiveSubscription: (byStatus.active || 0) > 0,
      hasOpenSubscription: openCount > 0,
      pendingChallenge: (byStatus.pending_subscribe || 0) > 0,
      pendingRenewal: (byStatus.pending_renewal || 0) > 0,
      pendingUnsubscribe: (byStatus.pending_unsubscribe || 0) > 0,
      expired: (byStatus.expired || 0) > 0,
      disabled: (byStatus.disabled || 0) > 0,
      renewalProductionVerified: false,
    },
  };
}

async function loadProviderPollingOpsSummary(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    return {
      sources: { total: 0, active: 0, paused: 0, disabled: 0, byProvider: {} },
      tiktok: {
        sandbox: { sourceCount: 0, active: 0 },
        production: { sourceCount: 0, active: 0 },
      },
      delivery: {
        providerPollingTotal: 0,
        pendingCompletionReady: 0,
        terminalFailed: 0,
      },
      health: {
        classification: "not_configured",
        reason: "unavailable",
      },
    };
  }

  const [sources, tiktokEnv, delivery] = await Promise.all([
    queryClient.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'paused')::int AS paused,
          COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled
        FROM codeclip_provider_poll_sources
        WHERE vertical = 'codeclip'
      `
    ),
    queryClient.query(
      `
        SELECT
          environment,
          COUNT(*)::int AS source_count,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          MAX(consecutive_failures)::int AS max_failures,
          BOOL_OR(last_error_code IS NOT NULL) AS has_error,
          MAX(last_success_at) AS latest_success_at,
          MAX(poll_interval_ms)::bigint AS poll_interval_ms
        FROM codeclip_provider_poll_sources
        WHERE vertical = 'codeclip'
          AND provider = 'tiktok'
        GROUP BY environment
      `
    ),
    queryClient.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE verification_state = 'verified'
              AND processing_state = 'processing'
              AND core_persistence_state = 'not_started'
              AND completion_state = 'not_completed'
              AND terminal_state IS FALSE
          )::int AS pending_completion_ready,
          COUNT(*) FILTER (
            WHERE terminal_state IS TRUE
              AND completion_state IS DISTINCT FROM 'completed'
          )::int AS terminal_failed
        FROM codeclip_provider_deliveries
        WHERE provider = 'tiktok'
          AND initial_delivery_source = 'provider_polling'
      `
    ),
  ]);

  const sourceRow = sources.rows?.[0] || {};
  const deliveryRow = delivery.rows?.[0] || {};
  const byEnv = { sandbox: null, production: null };
  for (const row of tiktokEnv.rows || []) {
    const environment = String(row.environment || "");
    byEnv[environment] = {
      sourceCount: Number(row.source_count) || 0,
      active: Number(row.active) || 0,
      health: classifyCodeClipProviderPollingSourceHealth({
        source:
          Number(row.source_count) > 0
            ? {
                status: Number(row.active) > 0 ? "active" : "paused",
                consecutiveFailures: Number(row.max_failures) || 0,
                lastErrorCode: null,
                lastSuccessAt: row.latest_success_at || null,
                pollIntervalMs: Number(row.poll_interval_ms) || 300000,
              }
            : null,
      }),
    };
  }

  const deliveryHealth = classifyCodeClipProviderPollingDeliveryHealth({
    terminalCompletionFailures: Number(deliveryRow.terminal_failed) || 0,
    pendingCompletionReady: Number(deliveryRow.pending_completion_ready) || 0,
  });

  const sandboxHealth = byEnv.sandbox?.health || {
    classification: "not_configured",
    reason: "no_poll_source",
  };

  return {
    sources: {
      total: Number(sourceRow.total) || 0,
      active: Number(sourceRow.active) || 0,
      paused: Number(sourceRow.paused) || 0,
      disabled: Number(sourceRow.disabled) || 0,
    },
    tiktok: {
      sandbox: byEnv.sandbox || { sourceCount: 0, active: 0, health: sandboxHealth },
      production: byEnv.production || {
        sourceCount: 0,
        active: 0,
        health: { classification: "not_configured", reason: "no_poll_source" },
      },
    },
    delivery: {
      providerPollingTotal: Number(deliveryRow.total) || 0,
      pendingCompletionReady: Number(deliveryRow.pending_completion_ready) || 0,
      terminalFailed: Number(deliveryRow.terminal_failed) || 0,
      health: deliveryHealth,
    },
    health: sandboxHealth,
  };
}

async function buildCodeClipSmoothOperatorProviderOperationsOverview(options = {}) {
  const queryClient = requireQueryClient(options.queryClient);
  const now = options.now instanceof Date ? options.now : new Date();
  const databaseClient = options.databaseClient || database;

  const [
    bindingSummary,
    deliverySummary,
    youtubeSubscriptions,
    providerPolling,
  ] = await Promise.all([
    (options.getBindingOperationsSummary || getCodeClipProviderAccountBindingOperationsSummary)(
      { latestLimit: options.latestBindingsLimit || 10 },
      { queryClient }
    ),
    (options.getProviderDeliveryOperationalSummary ||
      databaseClient.getCodeClipProviderDeliveryOperationalSummary)(queryClient),
    (options.listYouTubeSubscriptionStatuses || listCodeClipYouTubeWebSubSubscriptionStatuses)(
      {},
      { queryClient }
    ),
    (options.loadProviderPollingOpsSummary || loadProviderPollingOpsSummary)(queryClient),
  ]);

  return {
    ok: true,
    vertical: CODECLIP_VERTICAL,
    surface: SURFACE_NAME,
    generatedAt: now.toISOString(),
    scope: {
      product: "codeClip",
      vertical: CODECLIP_VERTICAL,
      audience: ["creator", "producer"],
      operationsArea: "provider_operations",
    },
    providers: {
      registered: (options.getRegisteredProviders || getCodeClipRegisteredProviders)(),
      bindingSupportedChannels:
        (options.getBindingSupportedChannels || getCodeClipProviderBindingSupportedChannels)(),
    },
    providerBindings: normalizeBindingSummary(bindingSummary),
    providerDeliveries: {
      summary: deliverySummary,
    },
    providerPolling,
    youtubeWebSub: {
      subscriptions: buildYouTubeSubscriptionSummary(youtubeSubscriptions),
    },
    capabilities: {
      ...CAPABILITY_FLAGS,
    },
  };
}

module.exports = {
  buildCodeClipSmoothOperatorProviderOperationsOverview,
  loadProviderPollingOpsSummary,
  buildYouTubeSubscriptionSummary,
};
