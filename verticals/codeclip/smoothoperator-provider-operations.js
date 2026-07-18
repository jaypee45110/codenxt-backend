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

async function buildCodeClipSmoothOperatorProviderOperationsOverview(options = {}) {
  const queryClient = requireQueryClient(options.queryClient);
  const now = options.now instanceof Date ? options.now : new Date();
  const databaseClient = options.databaseClient || database;

  const [
    bindingSummary,
    deliverySummary,
    youtubeSubscriptions,
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
  buildYouTubeSubscriptionSummary,
};
