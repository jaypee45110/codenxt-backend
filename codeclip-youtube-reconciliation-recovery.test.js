const assert = require("node:assert/strict");
const test = require("node:test");

const {
  executeCodeClipYouTubeReconciliationRecovery,
  dryRunCodeClipYouTubeReconciliationRecovery,
} = require("./verticals/codeclip/youtube-reconciliation-recovery");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const OTHER_CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_CODE = "CT-80410";
const VIDEO_ID = "LdSe5-sM5e0";
const NOW = new Date("2026-07-26T08:00:00.000Z");
const ACTIVATION_BOUNDARY = "2026-07-25T05:41:55.185Z";
const PUBLISHED_AT = "2026-07-25T08:46:01.000Z";
const EXTERNAL_MESSAGE_ID = `youtube:${CHANNEL_ID}:${VIDEO_ID}:published`;
const ADMIN_SECRET = "operator-admin-secret";

function candidate(overrides = {}) {
  return {
    provider: "youtube",
    channelId: CHANNEL_ID,
    videoId: VIDEO_ID,
    eventCode: EVENT_CODE,
    externalMessageId: EXTERNAL_MESSAGE_ID,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    id: "4",
    vertical: "codeclip",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    eventCode: EVENT_CODE,
    status: "active",
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "3",
    callbackId: "yt_recovery_cb",
    vertical: "codeclip",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    topic: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    status: "active",
    pendingMode: null,
    activationBoundaryAt: ACTIVATION_BOUNDARY,
    activationBoundaryVideoId: null,
    ...overrides,
  };
}

function eventRecord(overrides = {}) {
  return {
    id: "event-id",
    code: EVENT_CODE,
    vertical: "codeclip",
    status: "active",
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
    ...overrides,
  };
}

function upload(overrides = {}) {
  return {
    eventType: "published_video",
    activationIdentity: `youtube:${CHANNEL_ID}:${VIDEO_ID}:published`,
    externalMessageId: EXTERNAL_MESSAGE_ID,
    videoId: VIDEO_ID,
    channelId: CHANNEL_ID,
    title: "SideBySideTest",
    publishedAt: PUBLISHED_AT,
    updatedAt: "2026-07-25T08:47:27.000Z",
    alternateUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    ...overrides,
  };
}

function deps(overrides = {}) {
  const { state: stateOverrides = {}, ...rest } = overrides;
  const state = {
    writes: [],
    audit: [],
    delivery: null,
    sourceUploads: [upload()],
    bindingRows: [binding()],
    subscriptions: [subscription()],
    event: eventRecord(),
    processEntryResult: { status: "completed", code: "runtime_completed" },
    ...stateOverrides,
  };
  return {
    state,
    queryClient: { query: async () => ({ rows: [] }) },
    adminSecret: ADMIN_SECRET,
    now: NOW,
    listBindings: async () => ({ items: state.bindingRows }),
    listSubscriptions: async () => state.subscriptions,
    getEventByCode: async () => state.event,
    fetchUploads: async () => ({
      source: "atom",
      sourceIdentity: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      observedAt: NOW.toISOString(),
      uploads: state.sourceUploads,
    }),
    getDeliveryByIdentity: async () => state.delivery,
    processEntry: async (input) => {
      state.writes.push(input);
      return state.processEntryResult;
    },
    audit: (event) => state.audit.push(event),
    ...rest,
  };
}

function auditText(input) {
  return JSON.stringify(input.state.audit);
}

test("dry-run approves a valid missing candidate and performs no writes", async () => {
  const input = deps();
  const result = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), input);

  assert.equal(result.ok, true);
  assert.equal(result.status, "eligible");
  assert.equal(result.eligible, true);
  assert.equal(typeof result.confirmationToken, "string");
  assert.equal(Object.hasOwn(result, "confirmation"), false);
  assert.equal(result.candidate.externalMessageId, EXTERNAL_MESSAGE_ID);
  assert.equal(input.state.writes.length, 0);
  assert.equal(input.state.audit.at(-1).action, "dry_run_approved");
});

test("execute catches unexpected processEntry exceptions and audits sanitized failure", async () => {
  const input = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), input);
  const throwingInput = deps({
    processEntry: async () => {
      throw new Error("raw database stack secret should not leak");
    },
  });

  const result = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    throwingInput
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "execution_failed");
  assert.doesNotMatch(JSON.stringify(result), /raw database stack|confirmationToken|snapshot|operator-admin-secret/);
  assert.equal(throwingInput.state.audit.at(-1).action, "execute_failed");
  assert.doesNotMatch(auditText(throwingInput), /raw database stack|confirmationToken|snapshot|operator-admin-secret|UCvwiNkgNuGuizjo33NZhzPg/);
});

test("revalidation dependency exceptions are sanitized and prevent writes", async () => {
  const bindingFailure = deps({
    listBindings: async () => {
      throw new Error("postgres binding secret should not leak");
    },
  });
  const bindingResult = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), bindingFailure);
  assert.equal(bindingResult.ok, false);
  assert.equal(bindingResult.status, "revalidation_failed");
  assert.equal(Object.hasOwn(bindingResult, "confirmationToken"), false);
  assert.equal(bindingFailure.state.writes.length, 0);
  assert.equal(bindingFailure.state.audit.at(-1).action, "dry_run_rejected");
  assert.doesNotMatch(JSON.stringify(bindingResult), /postgres binding secret/);
  assert.doesNotMatch(auditText(bindingFailure), /postgres binding secret|UCvwiNkgNuGuizjo33NZhzPg/);

  const sourceFailure = deps({
    fetchUploads: async () => {
      throw new Error("youtube upstream response should not leak");
    },
  });
  const sourceResult = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), sourceFailure);
  assert.equal(sourceResult.ok, false);
  assert.equal(sourceResult.status, "source_unavailable");
  assert.equal(Object.hasOwn(sourceResult, "confirmationToken"), false);
  assert.equal(sourceFailure.state.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(sourceResult), /youtube upstream response/);

  const deliveryFailure = deps({
    getDeliveryByIdentity: async () => {
      throw new Error("ledger lookup stack should not leak");
    },
  });
  const deliveryDryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), deps());
  const deliveryResult = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: deliveryDryRun.confirmationToken, confirm: true },
    deliveryFailure
  );
  assert.equal(deliveryResult.ok, false);
  assert.equal(deliveryResult.status, "revalidation_failed");
  assert.equal(deliveryFailure.state.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(deliveryResult), /ledger lookup stack/);
});

test("dry-run rejects binding, subscription, feed, activation, identity, and delivery conflicts", async () => {
  const cases = [
    [deps({ state: { bindingRows: [] } }), "binding_not_found"],
    [deps({ state: { bindingRows: [binding({ status: "disabled" })] } }), "binding_not_active"],
    [deps({ state: { subscriptions: [subscription({ status: "expired" })] } }), "subscription_not_active"],
    [deps({ state: { sourceUploads: [] } }), "video_not_found"],
    [deps({ state: { sourceUploads: [upload({ publishedAt: "2026-07-25T05:41:55.000Z" })] } }), "before_activation_boundary"],
    [deps({ state: { bindingRows: [binding({ eventCode: "WRONG" })] } }), "binding_not_found"],
    [deps(), "identity_mismatch", candidate({ channelId: OTHER_CHANNEL_ID })],
    [deps(), "identity_mismatch", candidate({ externalMessageId: "youtube:bad" })],
    [deps({ state: { delivery: { processingState: "completed", corePersistenceState: "committed", completionState: "completed", terminalState: true } } }), "already_delivered"],
    [deps({ state: { delivery: { processingState: "processing", corePersistenceState: "not_started", completionState: "not_completed", terminalState: false } } }), "in_flight"],
  ];

  for (const [input, expected, body = candidate()] of cases) {
    const result = await dryRunCodeClipYouTubeReconciliationRecovery(body, input);
    assert.equal(result.ok, false);
    assert.equal(result.status, expected);
    assert.equal(input.state.writes.length, 0);
  }
});

test("confirmation token is bound, tamper-resistant, and expires", async () => {
  const input = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), input);

  const wrongCandidate = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate({ videoId: "uf0IPCAiRqY", externalMessageId: `youtube:${CHANNEL_ID}:uf0IPCAiRqY:published` }), confirmationToken: dryRun.confirmationToken, confirm: true },
    deps({
      state: {
        sourceUploads: [
          upload(),
          upload({
            videoId: "uf0IPCAiRqY",
            activationIdentity: `youtube:${CHANNEL_ID}:uf0IPCAiRqY:published`,
            externalMessageId: `youtube:${CHANNEL_ID}:uf0IPCAiRqY:published`,
          }),
        ],
      },
    })
  );
  assert.equal(wrongCandidate.status, "stale_confirmation");

  const tampered = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: `${dryRun.confirmationToken.slice(0, -1)}x`, confirm: true },
    input
  );
  assert.equal(tampered.status, "stale_confirmation");

  const expiredDryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), {
    ...deps(),
    now: new Date("2026-07-26T07:00:00.000Z"),
    tokenTtlSeconds: 1,
  });
  const expired = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: expiredDryRun.confirmationToken, confirm: true },
    input
  );
  assert.equal(expired.status, "stale_confirmation");
});

test("confirmation fails closed without operator secret", async () => {
  const result = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), {
    ...deps(),
    adminSecret: "",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "operator_secret_unavailable");
});

test("execute fails closed without operator secret and writes nothing", async () => {
  const input = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), input);
  const executeInput = deps({ adminSecret: "" });
  const result = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    executeInput
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "operator_secret_unavailable");
  assert.equal(executeInput.state.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /confirmationToken|snapshot|operator-admin-secret/);
});

test("execute revalidates, uses the ordinary provider pipeline once, and maps replay/failure states", async () => {
  const input = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), input);
  const executed = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    input
  );

  assert.equal(executed.ok, true);
  assert.equal(executed.status, "execution_completed");
  assert.equal(input.state.writes.length, 1);
  assert.equal(input.state.writes[0].entry.externalMessageId, EXTERNAL_MESSAGE_ID);
  assert.equal(input.state.writes[0].dependencies.source, "operator_reconciliation_recovery");
  assert.equal(input.state.audit.map((entry) => entry.action).includes("execute_completed"), true);

  const replayInput = deps({ state: { delivery: { processingState: "completed", corePersistenceState: "committed", completionState: "completed", terminalState: true } } });
  const replay = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    replayInput
  );
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replayInput.state.writes.length, 0);

  const failedInput = deps({ state: { processEntryResult: { status: "failed", code: "persistence_failed" } } });
  const failedDryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), failedInput);
  const failed = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: failedDryRun.confirmationToken, confirm: true },
    failedInput
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "execution_failed");
});

test("execute revalidation prevents stale writes and handles duplicate/in-flight states", async () => {
  const initial = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), initial);

  const staleSource = deps({ state: { sourceUploads: [] } });
  const stale = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    staleSource
  );
  assert.equal(stale.status, "video_not_found");
  assert.equal(staleSource.state.writes.length, 0);

  const duplicateInput = deps({ state: { processEntryResult: { status: "duplicate", code: "duplicate_entry" } } });
  const duplicateDryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), duplicateInput);
  const duplicate = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: duplicateDryRun.confirmationToken, confirm: true },
    duplicateInput
  );
  assert.equal(duplicate.status, "idempotent_replay");
  assert.equal(duplicateInput.state.writes.length, 1);

  const inFlightInput = deps({ state: { delivery: { processingState: "processing", corePersistenceState: "not_started", completionState: "not_completed", terminalState: false } } });
  const inFlight = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    inFlightInput
  );
  assert.equal(inFlight.status, "in_flight");
  assert.equal(inFlightInput.state.writes.length, 0);
});

test("execute rejects stale binding and subscription changes before processEntry", async () => {
  const initial = deps();
  const dryRun = await dryRunCodeClipYouTubeReconciliationRecovery(candidate(), initial);

  const inactiveBinding = deps({ state: { bindingRows: [binding({ status: "disabled" })] } });
  const bindingResult = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    inactiveBinding
  );
  assert.equal(bindingResult.status, "binding_not_active");
  assert.equal(inactiveBinding.state.writes.length, 0);

  const inactiveSubscription = deps({ state: { subscriptions: [subscription({ status: "expired" })] } });
  const subscriptionResult = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    inactiveSubscription
  );
  assert.equal(subscriptionResult.status, "subscription_not_active");
  assert.equal(inactiveSubscription.state.writes.length, 0);

  const mismatchedSubscription = deps({ state: { subscriptions: [subscription({ topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa" })] } });
  const mismatchResult = await executeCodeClipYouTubeReconciliationRecovery(
    { ...candidate(), confirmationToken: dryRun.confirmationToken, confirm: true },
    mismatchedSubscription
  );
  assert.equal(mismatchResult.status, "subscription_scope_mismatch");
  assert.equal(mismatchedSubscription.state.writes.length, 0);
});
