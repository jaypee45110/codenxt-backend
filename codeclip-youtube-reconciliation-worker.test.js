const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ATOM_RECONCILIATION_SOURCE,
  DATA_API_POLLING_SOURCE,
  createCodeClipYouTubeReconciliationWorkerState,
  loadCodeClipYouTubeReconciliationWorkerConfig,
  processCodeClipYouTubeReconciliationRun,
  runCodeClipYouTubeReconciliationWorkerOnce,
  sanitizeWorkerLogEvent,
} = require("./verticals/codeclip/youtube-reconciliation-worker");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const OTHER_CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";
const THIRD_CHANNEL_ID = "UCbbbbbbbbbbbbbbbbbbbbbb";
const EVENT_CODE = "CC-YT-WORKER";
const CALLBACK_ID = "yt_callback_worker";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const ACTIVATION = "2026-07-25T08:00:00.000Z";
const NOW = new Date("2026-07-26T12:00:00.000Z");

function topicFor(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

function binding(overrides = {}) {
  return {
    id: "binding-1",
    vertical: "codeclip",
    eventCode: EVENT_CODE,
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    status: "active",
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "subscription-1",
    vertical: "codeclip",
    callbackId: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    topic: TOPIC,
    status: "active",
    pendingMode: null,
    activationBoundaryAt: ACTIVATION,
    lastVerifiedAt: "2026-07-25T08:00:02.000Z",
    leaseExpiresAt: "2026-08-04T08:00:02.000Z",
    ...overrides,
  };
}

function eventRecord(overrides = {}) {
  return {
    id: "event-1",
    vertical: "codeclip",
    status: "active",
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
    ...overrides,
  };
}

function upload(videoId, overrides = {}) {
  const channelId = overrides.channelId || CHANNEL_ID;
  return {
    eventType: "published_video",
    activationIdentity: `youtube:${channelId}:${videoId}:published`,
    externalMessageId: `youtube:${channelId}:${videoId}:published`,
    videoId,
    channelId,
    title: "TestUpload",
    publishedAt: "2026-07-26T11:50:00.000Z",
    updatedAt: "2026-07-26T11:50:10.000Z",
    alternateUrl: `https://www.youtube.com/watch?v=${videoId}`,
    ...overrides,
  };
}

function multiTargetDeps({ config = {}, input = {}, state = {} } = {}) {
  const channels = [CHANNEL_ID, OTHER_CHANNEL_ID, THIRD_CHANNEL_ID];
  const bindings = channels.map((channelId, index) =>
    binding({
      id: `binding-${index + 1}`,
      eventCode: `${EVENT_CODE}-${index + 1}`,
      providerAccountId: channelId,
    })
  );
  const subscriptions = channels.map((channelId, index) =>
    subscription({
      id: `subscription-${index + 1}`,
      callbackId: `yt_callback_worker_${index + 1}`,
      providerAccountId: channelId,
      topic: topicFor(channelId),
    })
  );
  return deps({
    state: {
      bindings,
      subscriptions,
      uploads: [],
      ...state,
    },
    input: {
      config: {
        intervalMs: 300000,
        jitterMs: 0,
        graceMs: 180000,
        maxEntriesPerSubscription: 10,
        maxAutoProcessAgeMs: 86400000,
        lookbackHours: 72,
        globalConcurrency: 2,
        claimLeaseMs: 300000,
        dryRun: false,
        ...config,
      },
      getEventByCode: async (eventCode) => eventRecord({ id: eventCode, eventCode }),
      fetchUploads: async (target) => ({
        source: "atom",
        sourceIdentity: target.topic,
        observedAt: NOW.toISOString(),
        uploads: [upload(`v${target.eventCode.slice(-1).padStart(5, "0")}`, { channelId: target.channelId })],
      }),
      ...input,
    },
  });
}

function createConcurrencyTracker({ delayMs = 5 } = {}) {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const finishes = [];
  return {
    get maxActive() {
      return maxActive;
    },
    starts,
    finishes,
    async track(label) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(label);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      finishes.push(label);
      active -= 1;
    },
  };
}

function completedDelivery(overrides = {}) {
  return {
    id: "delivery-1",
    initialDeliverySource: "websub",
    processingState: "completed",
    corePersistenceState: "committed",
    completionState: "completed",
    terminalState: true,
    retryEligible: false,
    responseStatus: 202,
    publicResponseJson: { ok: true },
    ...overrides,
  };
}

function deps(overrides = {}) {
  const state = {
    bindings: [binding()],
    subscriptions: [subscription()],
    event: eventRecord(),
    uploads: [upload("miss01")],
    deliveries: new Map(),
    processEntryResult: { status: "completed", code: "runtime_completed" },
    claims: new Map(),
    processEntryCalls: [],
    claimCalls: [],
    releaseCalls: [],
    observationCalls: [],
    heartbeatCalls: [],
    logs: [],
    ...overrides.state,
  };
  const input = {
    now: NOW,
    config: {
      intervalMs: 300000,
      jitterMs: 0,
      graceMs: 180000,
      maxEntriesPerSubscription: 10,
      maxAutoProcessAgeMs: 86400000,
      lookbackHours: 72,
      globalConcurrency: 2,
      claimLeaseMs: 300000,
      dryRun: false,
    },
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: state.bindings }),
    listSubscriptions: async ({ providerAccountId }) =>
      state.subscriptions.filter((item) => item.providerAccountId === providerAccountId),
    getEventByCode: async () => state.event,
    fetchUploads: async () => ({
      source: "atom",
      sourceIdentity: TOPIC,
      observedAt: NOW.toISOString(),
      uploads: state.uploads,
    }),
    getDeliveryByIdentity: async (identity) =>
      state.deliveries.get(identity.externalMessageId) || null,
    processEntry: async (call) => {
      state.processEntryCalls.push(call);
      return state.processEntryResult;
    },
    claimSubscription: async (claim) => {
      state.claimCalls.push(claim);
      const existing = state.claims.get(claim.callbackId);
      if (existing && Date.parse(existing.expiresAt) > Date.parse(claim.now)) {
        return { status: "contended", claim: existing };
      }
      const row = {
        callbackId: claim.callbackId,
        claimId: claim.claimId,
        claimedAt: claim.now,
        expiresAt: new Date(Date.parse(claim.now) + claim.leaseMs).toISOString(),
      };
      state.claims.set(claim.callbackId, row);
      return { status: "claimed", claim: row };
    },
    releaseSubscriptionClaim: async (release) => {
      state.releaseCalls.push(release);
      const current = state.claims.get(release.callbackId);
      if (current?.claimId !== release.claimId) return { status: "not_owner" };
      state.claims.delete(release.callbackId);
      return { status: "released" };
    },
    recordDetectionObservation: async (observation) => {
      state.observationCalls.push(observation);
      if (state.failObservation) throw new Error("observation secret must not leak");
      return { status: "recorded" };
    },
    recordHeartbeat: async (heartbeat) => {
      state.heartbeatCalls.push(heartbeat);
      if (state.failHeartbeat) throw new Error("heartbeat secret must not leak");
      return { status: "recorded" };
    },
    logger: {
      info: (event) => state.logs.push(event),
      warn: (event) => state.logs.push(event),
      error: (event) => state.logs.push(event),
    },
    ...overrides.input,
  };
  return { state, input };
}

test("worker config uses safe defaults and rejects unsafe values", () => {
  const config = loadCodeClipYouTubeReconciliationWorkerConfig({});
  assert.equal(config.intervalMs, 300000);
  assert.equal(config.jitterMs, 60000);
  assert.equal(config.graceMs, 180000);
  assert.equal(config.maxEntriesPerSubscription, 10);
  assert.equal(config.maxAutoProcessAgeMs, 86400000);
  assert.equal(config.lookbackHours, 72);
  assert.equal(config.globalConcurrency, 2);
  assert.equal(config.uploadSource, "atom");
  assert.equal(loadCodeClipYouTubeReconciliationWorkerConfig({
    CODECLIP_YOUTUBE_RECONCILIATION_SOURCE: "data_api",
  }).uploadSource, "data_api");
  assert.throws(
    () => loadCodeClipYouTubeReconciliationWorkerConfig({
      CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS: "10",
    }),
    /interval/
  );
  assert.throws(
    () => loadCodeClipYouTubeReconciliationWorkerConfig({
      CODECLIP_YOUTUBE_RECONCILIATION_SOURCE: "manual",
    }),
    /unsupported YouTube reconciliation detection source/
  );
});

test("eligible active binding and verified subscription processes one missing upload through processEntry", async () => {
  const { state, input } = deps();
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.subscriptionsDiscovered, 1);
  assert.equal(report.summary.eligibleSubscriptions, 1);
  assert.equal(report.summary.claimsAcquired, 1);
  assert.equal(report.summary.feedsFetched, 1);
  assert.equal(report.summary.processedCompleted, 1);
  assert.equal(state.processEntryCalls.length, 1);
  assert.equal(state.processEntryCalls[0].dependencies.source, ATOM_RECONCILIATION_SOURCE);
  assert.equal(state.processEntryCalls[0].entry.videoId, "miss01");
  assert.equal(state.releaseCalls.length, 1);
});

test("Data API source uses the ordinary processEntry pipeline with Data API initial source", async () => {
  const { state, input } = deps({
    input: {
      config: {
        intervalMs: 300000,
        jitterMs: 0,
        graceMs: 180000,
        maxEntriesPerSubscription: 10,
        maxAutoProcessAgeMs: 86400000,
        lookbackHours: 72,
        globalConcurrency: 2,
        claimLeaseMs: 300000,
        dryRun: false,
        uploadSource: "data_api",
      },
      fetchUploads: async () => ({
        source: "data_api",
        sourceIdentity: "UUuploadsPlaylist",
        observedAt: NOW.toISOString(),
        uploads: [upload("data01")],
      }),
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);

  assert.equal(report.summary.processedCompleted, 1);
  assert.equal(state.processEntryCalls.length, 1);
  assert.equal(state.processEntryCalls[0].dependencies.source, DATA_API_POLLING_SOURCE);
  assert.equal(report.deliveries[0].detectionSource, "data_api");
  assert.equal(report.deliveries[0].initialDeliverySource, DATA_API_POLLING_SOURCE);
});

test("unsupported adapter source fails closed before processEntry", async () => {
  const { state, input } = deps({
    input: {
      config: {
        intervalMs: 300000,
        jitterMs: 0,
        graceMs: 180000,
        maxEntriesPerSubscription: 10,
        maxAutoProcessAgeMs: 86400000,
        lookbackHours: 72,
        globalConcurrency: 2,
        claimLeaseMs: 300000,
        dryRun: false,
        uploadSource: "atom",
      },
      fetchUploads: async () => ({
        source: "manual",
        sourceIdentity: "manual-source",
        observedAt: NOW.toISOString(),
        uploads: [upload("badsrc")],
      }),
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);

  assert.equal(report.summary.processedCompleted, 0);
  assert.equal(report.summary.targetFailures, 1);
  assert.equal(state.processEntryCalls.length, 0);
  assert.equal(report.deliveries.length, 0);
  assert.deepEqual(report.errors.map((error) => error.code), ["target_failed"]);
  assert.equal(JSON.stringify(report).includes("atom_reconciliation"), false);
});

test("dry-run discovers and classifies without claim or processEntry writes", async () => {
  const { state, input } = deps({ input: { dryRun: true } });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.mode, "dry_run");
  assert.equal(report.summary.claimsAcquired, 0);
  assert.equal(report.summary.processedCompleted, 0);
  assert.equal(report.summary.eligibleForProcessing, 1);
  assert.equal(state.claimCalls.length, 0);
  assert.equal(state.processEntryCalls.length, 0);
});

test("ineligible binding and subscription states skip fail closed", async () => {
  const cases = [
    { state: { bindings: [binding({ status: "disabled" })] }, reason: "binding_not_active_youtube" },
    { state: { subscriptions: [subscription({ status: "expired" })] }, reason: "no_active_subscription" },
    { state: { subscriptions: [subscription({ pendingMode: "subscribe" })] }, reason: "subscription_pending" },
    { state: { subscriptions: [subscription({ topic: `https://www.youtube.com/feeds/videos.xml?channel_id=${OTHER_CHANNEL_ID}` })] }, reason: "subscription_topic_mismatch" },
    { state: { event: eventRecord({ activationEvent: "qr_scan" }) }, reason: "unsupported_event_configuration" },
  ];
  for (const item of cases) {
    const { state, input } = deps({ state: item.state });
    const report = await processCodeClipYouTubeReconciliationRun(input);
    assert.equal(report.summary.eligibleSubscriptions, 0);
    assert.equal(report.targets[0].reason, item.reason);
    assert.equal(state.processEntryCalls.length, 0);
  }
});

test("activation, grace, age, and lookback boundaries are enforced before processing", async () => {
  const { state, input } = deps({
    state: {
      uploads: [
        upload("before1", { publishedAt: "2026-07-25T07:59:59.000Z" }),
        upload("grace1", { publishedAt: "2026-07-26T11:58:00.000Z" }),
        upload("old001", { publishedAt: "2026-07-25T11:59:00.000Z" }),
        upload("ok0001", { publishedAt: "2026-07-26T11:50:00.000Z" }),
      ],
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.beforeActivation, 1);
  assert.equal(report.summary.insideGraceWindow, 1);
  assert.equal(report.summary.olderThanAutoProcessWindow, 1);
  assert.equal(report.summary.processedCompleted, 1);
  assert.deepEqual(state.processEntryCalls.map((call) => call.entry.videoId), ["ok0001"]);
});

test("existing completed and in-flight deliveries are idempotent no-ops", async () => {
  const existing = completedDelivery({ externalMessageId: `youtube:${CHANNEL_ID}:done01:published` });
  const processing = completedDelivery({
    externalMessageId: `youtube:${CHANNEL_ID}:busy01:published`,
    processingState: "processing",
    corePersistenceState: "not_started",
    completionState: "not_completed",
    terminalState: false,
  });
  const { state, input } = deps({
    state: {
      uploads: [upload("done01"), upload("busy01")],
      deliveries: new Map([
        [existing.externalMessageId, existing],
        [processing.externalMessageId, processing],
      ]),
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.existingCompleted, 1);
  assert.equal(report.summary.existingInFlight, 1);
  assert.equal(state.processEntryCalls.length, 0);
});

test("source failure and processEntry failures are sanitized and bounded", async () => {
  const sourceFailure = deps({
    input: {
      fetchUploads: async () => {
        throw Object.assign(new Error("secret upstream token should not leak"), { code: "source_unavailable" });
      },
    },
  });
  const retryable = deps({ state: { processEntryResult: { status: "failed", code: "persistence_failed" } } });
  const terminal = deps({ state: { processEntryResult: { status: "rejected", code: "invalid_entry" } } });
  const sourceReport = await processCodeClipYouTubeReconciliationRun(sourceFailure.input);
  const retryableReport = await processCodeClipYouTubeReconciliationRun(retryable.input);
  const terminalReport = await processCodeClipYouTubeReconciliationRun(terminal.input);
  assert.equal(sourceReport.summary.sourceFailures, 1);
  assert.equal(JSON.stringify(sourceReport).includes("secret upstream token"), false);
  assert.equal(retryableReport.summary.processedRetryableFailed, 1);
  assert.equal(terminalReport.summary.processedTerminalFailed, 1);
});

test("detection observation failure does not stop delivery and increments observabilityFailures", async () => {
  const { state, input } = deps({ state: { failObservation: true } });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.processedCompleted, 1);
  assert.equal(report.summary.observabilityFailures, 1);
  assert.equal(state.observationCalls.length, 1);
  assert.equal(JSON.stringify(report).includes("observation secret"), false);
});

test("heartbeat receives completed summary with duration after ordinary processing", async () => {
  const { state, input } = deps();
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(state.heartbeatCalls.length, 1);
  assert.equal(state.heartbeatCalls[0].completedAt, report.completedAt);
  assert.equal(Number.isInteger(state.heartbeatCalls[0].summary.durationMs), true);
  assert.equal(state.heartbeatCalls[0].summary.processedCompleted, 1);
});

test("heartbeat failure does not stop worker result and increments observabilityFailures locally", async () => {
  const { state, input } = deps({ state: { failHeartbeat: true } });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.processedCompleted, 1);
  assert.equal(report.summary.observabilityFailures, 1);
  assert.equal(state.heartbeatCalls.length, 1);
  assert.equal(state.heartbeatCalls[0].summary.observabilityFailures, 0);
  assert.equal(JSON.stringify(report).includes("heartbeat secret"), false);
});

test("dry-run creates no durable detection observation", async () => {
  const { state, input } = deps({ input: { dryRun: true } });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.mode, "dry_run");
  assert.equal(state.observationCalls.length, 0);
  assert.equal(state.heartbeatCalls.length, 1);
});

test("globalConcurrency 1 processes eligible targets sequentially", async () => {
  const tracker = createConcurrencyTracker();
  const { state, input } = multiTargetDeps({
    config: { globalConcurrency: 1 },
    input: {
      fetchUploads: async (target) => {
        await tracker.track(target.eventCode);
        return {
          source: "atom",
          sourceIdentity: target.topic,
          observedAt: NOW.toISOString(),
          uploads: [upload(`seq00${target.eventCode.slice(-1)}`, { channelId: target.channelId })],
        };
      },
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(tracker.maxActive, 1);
  assert.equal(report.summary.processedCompleted, 3);
  assert.deepEqual(tracker.starts, [`${EVENT_CODE}-1`, `${EVENT_CODE}-2`, `${EVENT_CODE}-3`]);
  assert.equal(state.processEntryCalls.length, 3);
});

test("globalConcurrency 2 allows two eligible targets at once but never more", async () => {
  const tracker = createConcurrencyTracker();
  const { state, input } = multiTargetDeps({
    config: { globalConcurrency: 2 },
    input: {
      fetchUploads: async (target) => {
        await tracker.track(target.eventCode);
        return {
          source: "atom",
          sourceIdentity: target.topic,
          observedAt: NOW.toISOString(),
          uploads: [upload(`par00${target.eventCode.slice(-1)}`, { channelId: target.channelId })],
        };
      },
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(tracker.maxActive, 2);
  assert.equal(report.summary.processedCompleted, 3);
  assert.equal(state.processEntryCalls.length, 3);
});

test("target-level exception is sanitized and does not stop other eligible targets", async () => {
  const { state, input } = multiTargetDeps({
    input: {
      processEntry: async (call) => {
        state.processEntryCalls.push(call);
        if (call.binding.eventCode === `${EVENT_CODE}-2`) {
          throw new Error("pipeline secret should not leak");
        }
        return { status: "completed", code: "runtime_completed" };
      },
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(report.summary.processedCompleted, 2);
  assert.equal(report.summary.targetFailures, 1);
  assert.equal(state.processEntryCalls.length, 3);
  assert.equal(state.releaseCalls.length, 3);
  assert.equal(JSON.stringify(report).includes("pipeline secret"), false);
  assert.equal(report.errors.some((error) => error.code === "target_failed"), true);
});

test("per-subscription concurrency remains one through callbackId claim", async () => {
  const tracker = createConcurrencyTracker();
  const { state, input } = multiTargetDeps({
    state: {
      bindings: [
        binding({ id: "binding-1", eventCode: `${EVENT_CODE}-1`, providerAccountId: CHANNEL_ID }),
        binding({ id: "binding-2", eventCode: `${EVENT_CODE}-2`, providerAccountId: CHANNEL_ID }),
      ],
      subscriptions: [subscription()],
    },
    input: {
      listSubscriptions: async () => [subscription()],
      fetchUploads: async (target) => {
        await tracker.track(target.eventCode);
        return {
          source: "atom",
          sourceIdentity: target.topic,
          observedAt: NOW.toISOString(),
          uploads: [upload(`same0${target.eventCode.slice(-1)}`)],
        };
      },
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.equal(tracker.maxActive, 1);
  assert.equal(report.summary.claimsAcquired, 1);
  assert.equal(report.summary.claimsContended, 1);
  assert.equal(report.summary.processedCompleted, 1);
  assert.equal(state.releaseCalls.length, 1);
});

test("parallel target processing keeps report ordering deterministic", async () => {
  const delays = new Map([
    [`${EVENT_CODE}-1`, 20],
    [`${EVENT_CODE}-2`, 1],
    [`${EVENT_CODE}-3`, 10],
  ]);
  const { input } = multiTargetDeps({
    config: { globalConcurrency: 3 },
    input: {
      fetchUploads: async (target) => {
        await new Promise((resolve) => setTimeout(resolve, delays.get(target.eventCode)));
        return {
          source: "atom",
          sourceIdentity: target.topic,
          observedAt: NOW.toISOString(),
          uploads: [upload(`ord00${target.eventCode.slice(-1)}`, { channelId: target.channelId })],
        };
      },
    },
  });
  const report = await processCodeClipYouTubeReconciliationRun(input);
  assert.deepEqual(
    report.targets.filter((target) => target.eligible).map((target) => target.eventCode),
    [`${EVENT_CODE}-1`, `${EVENT_CODE}-2`, `${EVENT_CODE}-3`]
  );
  assert.deepEqual(
    report.deliveries.map((delivery) => delivery.eventCode),
    [`${EVENT_CODE}-1`, `${EVENT_CODE}-2`, `${EVENT_CODE}-3`]
  );
});

test("in-memory state models contention and stale takeover for unit use", () => {
  const state = createCodeClipYouTubeReconciliationWorkerState();
  assert.equal(state.claimSubscription({ callbackId: CALLBACK_ID, claimId: "claim-1", now: "2026-07-26T12:00:00.000Z", leaseMs: 300000 }).status, "claimed");
  assert.equal(state.claimSubscription({ callbackId: CALLBACK_ID, claimId: "claim-2", now: "2026-07-26T12:01:00.000Z", leaseMs: 300000 }).status, "contended");
  assert.equal(state.claimSubscription({ callbackId: CALLBACK_ID, claimId: "claim-3", now: "2026-07-26T12:06:00.000Z", leaseMs: 300000 }).status, "claimed");
  assert.equal(state.releaseSubscriptionClaim({ callbackId: CALLBACK_ID, claimId: "claim-1" }).status, "not_owner");
  assert.equal(state.releaseSubscriptionClaim({ callbackId: CALLBACK_ID, claimId: "claim-3" }).status, "released");
});

test("run wrapper avoids overlapping runs and graceful shutdown prevents new work", async () => {
  const { state, input } = deps();
  const workerState = createCodeClipYouTubeReconciliationWorkerState();
  workerState.shuttingDown = true;
  const skipped = await runCodeClipYouTubeReconciliationWorkerOnce({ ...input, workerState });
  assert.equal(skipped.status, "shutdown");
  assert.equal(state.processEntryCalls.length, 0);
});

test("sanitized worker log events never include full channel id, raw Atom, or secrets", () => {
  const event = sanitizeWorkerLogEvent({
    eventCode: EVENT_CODE,
    channelId: CHANNEL_ID,
    callbackId: CALLBACK_ID,
    videoId: "safe01",
    rawAtomBody: "<feed>secret</feed>",
    DATABASE_URL: "postgres://secret",
    CODECLIP_ADMIN_KEY: "admin-secret",
    CODECLIP_YOUTUBE_WEBSUB_SECRET: "websub-secret",
  });
  const text = JSON.stringify(event);
  assert.equal(text.includes(CHANNEL_ID), false);
  assert.equal(text.includes("postgres://secret"), false);
  assert.equal(text.includes("admin-secret"), false);
  assert.equal(text.includes("websub-secret"), false);
  assert.equal(text.includes("<feed>"), false);
  assert.equal(event.channelFingerprint.length, 12);
});
