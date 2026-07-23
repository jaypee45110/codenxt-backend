const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCodeClipYouTubeWebSubSubscriptionOperation,
  renewCodeClipYouTubeWebSubSubscriptionOperation,
  unsubscribeCodeClipYouTubeWebSubSubscriptionOperation,
  listCodeClipYouTubeWebSubSubscriptionStatuses,
  getCodeClipYouTubeWebSubSubscriptionStatus,
  buildTopic,
  buildCallbackUrl,
  toPublicSubscriptionStatus,
} = require("./verticals/codeclip/youtube-websub-operations");
const {
  claimCodeClipYouTubeWebSubRenewDispatch,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  markCodeClipYouTubeWebSubSubscriptionRenewalPending,
  recordCodeClipYouTubeWebSubRenewDispatchResult,
  recordCodeClipYouTubeWebSubSubscriptionAudit,
} = require("./verticals/codeclip/youtube-websub-subscriptions");

const CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_CODE = "CC-YOUTUBE-OPS";

function event(overrides = {}) {
  return {
    id: "event-youtube-ops",
    code: EVENT_CODE,
    vertical: "codeclip",
    status: "active",
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    id: "binding-1",
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
    id: "sub-1",
    vertical: "codeclip",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    callbackId: "yt_callback_1",
    topic: buildTopic(CHANNEL_ID),
    status: "pending_subscribe",
    pendingMode: "subscribe",
    secretVersion: "v1",
    metadata: { requestedLeaseSeconds: 864000 },
    activationBoundaryAt: null,
    firstActivatedVideoId: null,
    leaseStartedAt: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isSafeAttemptNumber(value) {
  return Number.isInteger(value) && value >= 0 && value < 2147483647;
}

function canClaimRenewDispatch(dispatch, nowEpochMs) {
  if (dispatch === undefined || dispatch === null) return true;
  if (typeof dispatch !== "object" || Array.isArray(dispatch)) return false;
  if (dispatch.status === "failed" && dispatch.mode === "renew") {
    return dispatch.retryEligible === true && isSafeAttemptNumber(dispatch.attemptNumber);
  }
  if (dispatch.status === "started") {
    return (
      dispatch.mode === "renew" &&
      isSafeAttemptNumber(dispatch.attemptNumber) &&
      Number.isSafeInteger(dispatch.staleAfterEpochMs) &&
      dispatch.staleAfterEpochMs >= 0 &&
      dispatch.staleAfterEpochMs <= nowEpochMs
    );
  }
  if (dispatch.mode === "subscribe" && isSafeAttemptNumber(dispatch.attemptNumber)) {
    return (
      dispatch.status === "accepted" ||
      (dispatch.status === "failed" && dispatch.retryEligible === false)
    );
  }
  // The real SQL predicate for this terminal-renew transition is covered by
  // codeclip-youtube-websub-subscriptions.test.js. This operation helper models
  // the intended repository contract so the operation control flow is explicit.
  if (dispatch.mode === "renew" && isSafeAttemptNumber(dispatch.attemptNumber)) {
    return (
      dispatch.status === "accepted" ||
      (dispatch.status === "failed" && dispatch.retryEligible === false)
    );
  }
  return false;
}

function toRepoRow(input = {}) {
  return {
    id: input.id || "sub-1",
    vertical: input.vertical || "codeclip",
    provider: input.provider || "youtube",
    channel: input.channel || "youtube",
    provider_account_id: input.providerAccountId || CHANNEL_ID,
    callback_id: input.callbackId || "yt_callback_1",
    topic: input.topic || buildTopic(CHANNEL_ID),
    status: input.status || "active",
    pending_mode: input.pendingMode ?? null,
    secret_version: input.secretVersion || "v1",
    metadata: clone(input.metadata || {}),
    activation_boundary_at: input.activationBoundaryAt || null,
    activation_boundary_video_id: input.activationBoundaryVideoId || null,
    activated_at: input.activatedAt || null,
    first_activated_video_id: input.firstActivatedVideoId || null,
    first_activated_at: input.firstActivatedAt || null,
    lease_started_at: input.leaseStartedAt || null,
    lease_expires_at: input.leaseExpiresAt || null,
    last_verified_at: input.lastVerifiedAt || null,
    created_at: input.createdAt || "2026-07-18T00:00:00.000Z",
    updated_at: input.updatedAt || "2026-07-18T00:00:00.000Z",
  };
}

function createRenewRepositoryClient(initialSubscription) {
  const calls = [];
  const rows = [toRepoRow(initialSubscription)];
  const audits = [];
  let nextAuditId = 1;

  function find(callbackId) {
    return rows.find((row) => row.callback_id === callbackId) || null;
  }

  function touch(row) {
    row.updated_at = "2026-07-23T07:46:20.447Z";
    return row;
  }

  return {
    calls,
    rows,
    audits,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/FROM codeclip_youtube_websub_subscriptions/.test(sql) && /callback_id = \$1/.test(sql)) {
        const current = find(params[0]);
        return { rows: current ? [current] : [] };
      }

      if (/INSERT INTO codeclip_youtube_websub_subscription_audit/.test(sql)) {
        const audit = {
          id: String(nextAuditId++),
          vertical: "codeclip",
          provider: "youtube",
          callback_id: params[0],
          provider_account_id: params[1],
          event_code: params[2],
          action: params[3],
          mode: params[4],
          result_code: params[5],
          hub_http_status: params[6],
          retryable: params[7],
          metadata: JSON.parse(params[8]),
          created_at: "2026-07-23T07:46:20.447Z",
        };
        audits.push(audit);
        return { rows: [audit] };
      }

      if (
        /UPDATE codeclip_youtube_websub_subscriptions/.test(sql) &&
        /status = 'pending_renewal'/.test(sql)
      ) {
        const current = find(params[0]);
        if (!current || current.status !== "active" || current.pending_mode !== null) {
          return { rows: [] };
        }
        current.status = "pending_renewal";
        current.pending_mode = "subscribe";
        return { rows: [touch(current)] };
      }

      if (
        /UPDATE codeclip_youtube_websub_subscriptions/.test(sql) &&
        /attemptNumber/.test(sql) &&
        /staleAfterEpochMs/.test(sql)
      ) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        const nowEpochMs = params[4] ?? 1_800_000_000_000;
        if (
          current.status !== "pending_renewal" ||
          current.pending_mode !== "subscribe" ||
          !canClaimRenewDispatch(current.metadata.dispatch, nowEpochMs)
        ) {
          return { rows: [] };
        }
        const previousAttemptNumber = isSafeAttemptNumber(current.metadata.dispatch?.attemptNumber)
          ? current.metadata.dispatch.attemptNumber
          : 0;
        current.metadata = {
          ...current.metadata,
          dispatch: {
            attemptId: params[1],
            attemptNumber: previousAttemptNumber + 1,
            previousAttemptCount: previousAttemptNumber,
            status: "started",
            mode: "renew",
            startedAt: "2026-07-23T07:46:20.500Z",
            staleAfterEpochMs: nowEpochMs + params[3] * 1000,
            requestedLeaseSeconds: params[2],
            retryEligible: false,
          },
        };
        return { rows: [touch(current)] };
      }

      if (
        /UPDATE codeclip_youtube_websub_subscriptions/.test(sql) &&
        /resultCode/.test(sql) &&
        /completedAt/.test(sql)
      ) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        const dispatch = current.metadata.dispatch;
        if (
          !dispatch ||
          dispatch.attemptId !== params[1] ||
          dispatch.status !== "started" ||
          dispatch.mode !== "renew"
        ) {
          return { rows: [] };
        }
        current.metadata = {
          ...current.metadata,
          dispatch: {
            ...dispatch,
            attemptId: params[1],
            status: params[2],
            mode: "renew",
            resultCode: params[3],
            hubHttpStatus: params[4],
            retryEligible: params[5],
            completedAt: "2026-07-23T07:46:21.000Z",
          },
        };
        return { rows: [touch(current)] };
      }

      return { rows: [] };
    },
  };
}

function baseOptions(overrides = {}) {
  const state = {
    auditRows: [],
    calls: [],
    created: null,
    existingByAccount: null,
    existingByCallback: null,
    event: event(),
    binding: binding(),
    claimed: null,
    recorded: null,
    hubResult: { ok: true, code: "hub_request_accepted", status: 202, mode: "subscribe" },
    ...overrides.state,
  };
  const claimDispatch = async (mode, callbackId, input) => {
    state.calls.push(["claimDispatch", mode, callbackId, input]);
    if (state.claimResult === null) return null;
    const base = state.claimResult || state.created || state.existingByAccount || state.existingByCallback || subscription({ callbackId });
    const claimed = subscription({
      ...base,
      callbackId,
      metadata: {
        ...(base.metadata || {}),
        dispatch: {
          attemptId: input.attemptId,
          attemptNumber: 1,
          status: "started",
          mode,
          startedAt: "2026-07-18T00:00:01.000Z",
          requestedLeaseSeconds: input.leaseSeconds,
          retryEligible: false,
        },
      },
    });
    state.claimed = claimed;
    return claimed;
  };
  const recordDispatch = async (mode, callbackId, input) => {
    state.calls.push(["recordDispatch", mode, callbackId, input]);
    if (state.recordResult === null) return null;
    const base = state.recordResult || state.claimed || state.created || state.existingByAccount || state.existingByCallback || subscription({ callbackId });
    const recorded = subscription({
      ...base,
      callbackId,
      metadata: {
        ...(base.metadata || {}),
        dispatch: {
          ...((base.metadata || {}).dispatch || {}),
          attemptId: input.attemptId,
          status: input.resultCode === "hub_request_accepted" ? "accepted" : "failed",
          mode,
          resultCode: input.resultCode,
          hubHttpStatus: input.hubHttpStatus,
          retryEligible: input.retryable === true,
          completedAt: "2026-07-18T00:00:02.000Z",
        },
      },
    });
    state.recorded = recorded;
    return recorded;
  };
  return {
    state,
    options: {
      env: {
        CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret",
        CODECLIP_PUBLIC_BASE_URL: "https://backend.example.test/",
      },
      queryClient: { query: async () => ({ rows: [] }) },
      runTransaction: async (work, queryClient) => {
        const snapshot = {
          auditRows: clone(state.auditRows),
          created: clone(state.created),
          existingByAccount: clone(state.existingByAccount),
          existingByCallback: clone(state.existingByCallback),
        };
        state.calls.push(["BEGIN", queryClient]);
        try {
          const result = await work({ queryClient });
          state.calls.push(["COMMIT", queryClient]);
          return result;
        } catch (error) {
          state.auditRows = snapshot.auditRows;
          state.created = snapshot.created;
          state.existingByAccount = snapshot.existingByAccount;
          state.existingByCallback = snapshot.existingByCallback;
          state.calls.push(["ROLLBACK", queryClient]);
          throw error;
        }
      },
      generateCallbackId: () => "yt_callback_1",
      generateDispatchAttemptId: () => "attempt_1",
      getEventByCode: async (eventCode) => {
        state.calls.push(["event", eventCode]);
        return state.event;
      },
      findActiveBinding: async (input) => {
        state.calls.push(["binding", input]);
        return state.binding;
      },
      getSubscriptionByProviderAccountId: async (providerAccountId) => {
        state.calls.push(["getByAccount", providerAccountId]);
        return state.existingByAccount;
      },
      getSubscriptionByCallbackId: async (callbackId) => {
        state.calls.push(["getByCallback", callbackId]);
        return state.existingByCallback;
      },
      createPendingSubscription: async (input) => {
        state.calls.push(["createPending", input]);
        state.created = subscription({
          callbackId: input.callbackId,
          providerAccountId: input.providerAccountId,
          topic: input.topic,
          metadata: input.metadata,
        });
        return state.created;
      },
      markRenewalPending: async (callbackId) => {
        state.calls.push(["renewPending", callbackId]);
        const updated = subscription({
          ...(state.existingByCallback || {}),
          callbackId,
          status: "pending_renewal",
          pendingMode: "subscribe",
          activationBoundaryAt: "2026-07-18T00:00:00.000Z",
        });
        state.existingByCallback = updated;
        return updated;
      },
      markUnsubscribePending: async (callbackId) => {
        state.calls.push(["unsubscribePending", callbackId]);
        const updated = subscription({
          ...(state.existingByCallback || {}),
          callbackId,
          status: "pending_unsubscribe",
          pendingMode: "unsubscribe",
        });
        state.existingByCallback = updated;
        return updated;
      },
      requestSubscription: async (input) => {
        state.calls.push(["hub", input]);
        return state.hubResult;
      },
      claimDispatch,
      recordDispatch,
      claimSubscribeDispatch: async (callbackId, input) => claimDispatch("subscribe", callbackId, input),
      recordSubscribeDispatchResult: async (callbackId, input) => recordDispatch("subscribe", callbackId, input),
      claimRenewDispatch: async (callbackId, input) => claimDispatch("renew", callbackId, input),
      recordRenewDispatchResult: async (callbackId, input) => recordDispatch("renew", callbackId, input),
      claimUnsubscribeDispatch: async (callbackId, input) => claimDispatch("unsubscribe", callbackId, input),
      recordUnsubscribeDispatchResult: async (callbackId, input) => recordDispatch("unsubscribe", callbackId, input),
      recoverRenewalPendingConflict: async (callbackId, input) => {
        state.calls.push(["recoverRenewalPendingConflict", callbackId, input]);
        if (state.recoverResult === null) return null;
        const current = state.existingByCallback;
        if (
          !current ||
          current.callbackId !== callbackId ||
          current.status !== "pending_renewal" ||
          current.pendingMode !== "subscribe" ||
          JSON.stringify(current.metadata?.dispatch ?? null) !==
            JSON.stringify(input.pendingSubscription?.metadata?.dispatch ?? null)
        ) {
          return null;
        }
        const restored = subscription({
          ...input.previousSubscription,
          callbackId,
          status: "active",
          pendingMode: null,
        });
        state.existingByCallback = restored;
        return restored;
      },
      recordAudit: async (input) => {
        state.calls.push(["audit", input]);
        if (
          state.auditError &&
          (!state.auditErrorAction || state.auditErrorAction === input.action)
        ) {
          throw state.auditError;
        }
        state.auditRows.push(input);
        return input;
      },
      listSubscriptions: async () => [subscription()],
      ...overrides.options,
    },
  };
}

test("YouTube WebSub create validates episode and binding, creates pending record, then calls hub", async () => {
  const { state, options } = baseOptions();
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation(
    {
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
      leaseSeconds: 864000,
      topic: "https://attacker.example.test/",
      callbackId: "operator-controlled",
    },
    options
  );
  const createCall = state.calls.find((call) => call[0] === "createPending")[1];
  const hubCall = state.calls.find((call) => call[0] === "hub")[1];

  assert.equal(result.ok, true);
  assert.equal(result.code, "subscription_pending");
  assert.equal(result.bindingId, "binding-1");
  assert.equal(result.dispatchClaimed, true);
  assert.equal(result.subscription.status, "pending_subscribe");
  assert.equal(result.subscription.lastOperation.status, "accepted");
  assert.equal(createCall.callbackId, "yt_callback_1");
  assert.equal(createCall.topic, buildTopic(CHANNEL_ID));
  assert.equal(createCall.metadata.requestedLeaseSeconds, 864000);
  const claimCall = state.calls.find((call) => call[0] === "claimDispatch");
  const recordCall = state.calls.find((call) => call[0] === "recordDispatch");
  assert.equal(claimCall[1], "subscribe");
  assert.equal(claimCall[2], "yt_callback_1");
  assert.equal(claimCall[3].attemptId, "attempt_1");
  assert.equal(claimCall[3].leaseSeconds, 864000);
  assert.equal(recordCall[1], "subscribe");
  assert.equal(recordCall[2], "yt_callback_1");
  assert.equal(recordCall[3].attemptId, "attempt_1");
  assert.equal(recordCall[3].resultCode, "hub_request_accepted");
  assert.equal(recordCall[3].retryable, false);
  assert.equal(hubCall.mode, "subscribe");
  assert.equal(hubCall.operationMode, "subscribe");
  assert.equal(hubCall.attemptId, claimCall[3].attemptId);
  assert.equal(hubCall.attemptNumber, 1);
  assert.equal(hubCall.callbackUrl, buildCallbackUrl("https://backend.example.test", "yt_callback_1"));
  assert.equal(hubCall.topic, buildTopic(CHANNEL_ID));
  assert.equal(hubCall.leaseSeconds, 864000);
  assert.equal(typeof hubCall.secret, "string");
  assert.equal(hubCall.secret.includes("root-secret"), false);
  assert.equal(JSON.stringify(result).includes("root-secret"), false);
  assert.equal(JSON.stringify(result).includes(hubCall.secret), false);
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "subscription_requested",
    "hub_request_accepted",
  ]);
  assert.equal(state.auditRows[0].eventCode, EVENT_CODE);
  assert.equal(state.auditRows[0].metadata.requestedLeaseSeconds, 864000);
  assert.equal(JSON.stringify(state.auditRows).includes("root-secret"), false);
  assert.equal(JSON.stringify(state.auditRows).includes(hubCall.secret), false);
  assert.deepEqual(
    state.calls
      .filter((call) => ["BEGIN", "createPending", "audit", "COMMIT", "hub"].includes(call[0]))
      .map((call) => call[0]),
    ["BEGIN", "createPending", "audit", "COMMIT", "hub", "audit"]
  );
});

test("YouTube WebSub public status serializes operator state, expiry and last operation without secrets", () => {
  const result = toPublicSubscriptionStatus(subscription({
    status: "active",
    pendingMode: null,
    secretVersion: "v99",
    leaseStartedAt: "2026-07-18T00:00:00.000Z",
    leaseExpiresAt: "2026-07-22T00:00:00.000Z",
    metadata: {
      requestedLeaseSeconds: 864000,
      dispatch: {
        mode: "subscribe",
        status: "accepted",
        resultCode: "hub_request_accepted",
        hubHttpStatus: 202,
        retryEligible: false,
        attemptNumber: 2,
        startedAt: "2026-07-18T00:01:00.000Z",
        completedAt: "2026-07-18T00:01:01.000Z",
        secret: "derived-secret",
      },
    },
  }), { now: new Date("2026-07-18T12:00:00.000Z") });

  assert.equal(result.secretVersion, undefined);
  assert.equal(result.operatorStatus, "active");
  assert.equal(result.recommendedAction, null);
  assert.equal(result.leaseSeconds, 345600);
  assert.equal(result.expiresInSeconds, 302400);
  assert.deepEqual(result.lastOperation, {
    mode: "subscribe",
    status: "accepted",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
    attemptNumber: 2,
    startedAt: "2026-07-18T00:01:00.000Z",
    completedAt: "2026-07-18T00:01:01.000Z",
  });
  assert.equal(JSON.stringify(result).includes("v99"), false);
  assert.equal(JSON.stringify(result).includes("derived-secret"), false);
});

test("YouTube WebSub public status maps pending, expiring, expired, disabled and failed states", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  assert.equal(toPublicSubscriptionStatus(subscription(), { now }).operatorStatus, "pending_activation");
  assert.equal(
    toPublicSubscriptionStatus(subscription({
      status: "active",
      pendingMode: null,
      leaseStartedAt: "2026-07-18T00:00:00.000Z",
      leaseExpiresAt: "2026-07-19T00:00:00.000Z",
    }), { now }).operatorStatus,
    "needs_renewal"
  );
  assert.equal(toPublicSubscriptionStatus(subscription({ status: "expired" }), { now }).operatorStatus, "expired");
  assert.equal(toPublicSubscriptionStatus(subscription({ status: "unsubscribed" }), { now }).operatorStatus, "disabled");
  assert.equal(toPublicSubscriptionStatus(subscription({ status: "failed" }), { now }).operatorStatus, "error");
});

test("YouTube WebSub create fails before database and hub when root secret or base URL is missing", async () => {
  const missingSecret = baseOptions({
    options: { env: { CODECLIP_PUBLIC_BASE_URL: "https://backend.example.test" } },
  });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, missingSecret.options),
    (error) => error.code === "authentication_unavailable"
  );
  assert.deepEqual(missingSecret.state.calls, []);

  const missingBase = baseOptions({
    options: { env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" } },
  });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, missingBase.options),
    (error) => error.code === "public_base_url_unavailable"
  );
  assert.deepEqual(missingBase.state.calls, []);
});

test("YouTube WebSub create rejects ineligible episode, missing binding and binding mismatch", async () => {
  const ineligible = baseOptions({ state: { event: event({ activationChannels: ["instagram"] }) } });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, ineligible.options),
    (error) => error.code === "episode_not_eligible"
  );

  const missingBinding = baseOptions({ state: { binding: null } });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, missingBinding.options),
    (error) => error.code === "binding_not_found"
  );

  const mismatch = baseOptions({ state: { binding: binding({ eventCode: "CC-OTHER" }) } });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, mismatch.options),
    (error) => error.code === "binding_episode_mismatch"
  );
});

test("YouTube WebSub create treats active duplicate subscription as existing", async () => {
  const { state, options } = baseOptions({
    state: { existingByAccount: subscription({ status: "active", pendingMode: null }) },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "subscription_already_exists");
  assert.equal(result.bindingId, "binding-1");
  assert.equal(result.subscription.status, "active");
  assert.equal(state.calls.some((call) => call[0] === "createPending"), false);
  assert.equal(state.calls.some((call) => call[0] === "claimDispatch"), false);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
});

test("YouTube WebSub create reuses existing pending subscription and dispatches with bindingId", async () => {
  const existing = subscription({ callbackId: "yt_existing_pending", status: "pending_subscribe" });
  const { state, options } = baseOptions({
    state: { existingByAccount: existing },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "subscription_pending");
  assert.equal(result.bindingId, "binding-1");
  assert.equal(result.dispatchClaimed, true);
  assert.equal(result.subscription.callbackId, "yt_existing_pending");
  assert.equal(state.calls.some((call) => call[0] === "createPending"), false);
  assert.equal(state.calls.filter((call) => call[0] === "claimDispatch").length, 1);
  assert.equal(state.calls.filter((call) => call[0] === "hub").length, 1);
  assert.equal(state.calls.filter((call) => call[0] === "recordDispatch").length, 1);
});

test("YouTube WebSub create returns idempotent pending response when dispatch claim is not won", async () => {
  const existing = subscription({
    callbackId: "yt_existing_busy",
    status: "pending_subscribe",
    metadata: {
      requestedLeaseSeconds: 864000,
      dispatch: {
        attemptId: "attempt_busy",
        status: "started",
        mode: "subscribe",
        retryEligible: false,
      },
    },
  });
  const { state, options } = baseOptions({
    state: {
      existingByAccount: existing,
      claimResult: null,
    },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "subscription_pending");
  assert.equal(result.bindingId, "binding-1");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(result.subscription.callbackId, "yt_existing_busy");
  assert.equal(state.calls.filter((call) => call[0] === "claimDispatch").length, 1);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.equal(state.calls.some((call) => call[0] === "recordDispatch"), false);
});

test("YouTube WebSub outbound subscribe failure leaves local status pending and retryable", async () => {
  const { state, options } = baseOptions({
    state: {
      hubResult: { ok: false, code: "hub_request_timeout", status: 0, mode: "subscribe" },
    },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, false);
  assert.equal(result.code, "hub_request_timeout");
  assert.equal(result.status, "pending_subscribe");
  assert.equal(result.retryable, true);
  assert.equal(state.created.status, "pending_subscribe");
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "subscription_requested",
    "hub_request_failed",
  ]);
  assert.equal(state.auditRows[1].retryable, true);
  assert.equal(state.auditRows[1].resultCode, "hub_request_timeout");
  const recordCall = state.calls.find((call) => call[0] === "recordDispatch");
  assert.equal(recordCall[1], "subscribe");
  assert.equal(recordCall[3].resultCode, "hub_request_timeout");
  assert.equal(recordCall[3].retryable, true);
  assert.equal(result.subscription.lastOperation.status, "failed");
  assert.equal(result.subscription.lastOperation.retryEligible, true);
});

test("YouTube WebSub non-retryable subscribe failure records non-retryable failed dispatch", async () => {
  const { state, options } = baseOptions({
    state: {
      hubResult: {
        ok: false,
        code: "hub_request_rejected",
        status: 400,
        retryable: false,
        mode: "subscribe",
      },
    },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, false);
  assert.equal(result.code, "hub_request_rejected");
  assert.equal(result.retryable, false);
  const recordCall = state.calls.find((call) => call[0] === "recordDispatch");
  assert.equal(recordCall[1], "subscribe");
  assert.equal(recordCall[3].attemptId, "attempt_1");
  assert.equal(recordCall[3].resultCode, "hub_request_rejected");
  assert.equal(recordCall[3].hubHttpStatus, 400);
  assert.equal(recordCall[3].retryable, false);
  assert.equal(result.subscription.lastOperation.status, "failed");
  assert.equal(result.subscription.lastOperation.retryEligible, false);
});

test("YouTube WebSub retryable failed and stale started pending subscriptions can be claimed and resent", async () => {
  for (const dispatch of [
    {
      attemptId: "attempt_failed",
      attemptNumber: 1,
      status: "failed",
      mode: "subscribe",
      retryEligible: true,
      resultCode: "hub_request_timeout",
    },
    {
      attemptId: "attempt_stale",
      attemptNumber: 1,
      status: "started",
      mode: "subscribe",
      retryEligible: false,
      staleAfterEpochMs: 1,
    },
  ]) {
    const existing = subscription({
      callbackId: `yt_${dispatch.attemptId}`,
      status: "pending_subscribe",
      metadata: { requestedLeaseSeconds: 864000, dispatch },
    });
    const { state, options } = baseOptions({
      state: { existingByAccount: existing },
    });
    const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, options);

    assert.equal(result.ok, true);
    assert.equal(result.dispatchClaimed, true);
    assert.equal(result.bindingId, "binding-1");
    assert.equal(state.calls.filter((call) => call[0] === "claimDispatch").length, 1);
    assert.equal(state.calls.filter((call) => call[0] === "hub").length, 1);
    assert.equal(state.calls.filter((call) => call[0] === "recordDispatch").length, 1);
  }
});

test("YouTube WebSub dispatch result tolerates callback race to active state", async () => {
  const activeAfterCallback = subscription({
    status: "active",
    pendingMode: null,
    leaseStartedAt: "2026-07-18T00:00:00.000Z",
    leaseExpiresAt: "2026-07-28T00:00:00.000Z",
  });
  const { state, options } = baseOptions({
    state: { recordResult: activeAfterCallback },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, true);
  assert.equal(result.bindingId, "binding-1");
  assert.equal(result.status, "active");
  assert.equal(result.subscription.status, "active");
  assert.equal(result.subscription.lastOperation.status, "accepted");
});

test("YouTube WebSub subscription_requested audit failure rolls back pending create before hub", async () => {
  const { state, options } = baseOptions({
    state: {
      auditError: new Error("audit unavailable"),
      auditErrorAction: "subscription_requested",
    },
  });

  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, options),
    (error) => error.message === "audit unavailable"
  );

  assert.equal(state.created, null);
  assert.deepEqual(state.auditRows, []);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.deepEqual(
    state.calls
      .filter((call) => ["BEGIN", "createPending", "audit", "ROLLBACK"].includes(call[0]))
      .map((call) => call[0]),
    ["BEGIN", "createPending", "audit", "ROLLBACK"]
  );
});

test("YouTube WebSub renewal_requested audit failure rolls back pending renewal before hub", async () => {
  const original = subscription({ status: "active", pendingMode: null });
  const { state, options } = baseOptions({
    state: {
      existingByCallback: original,
      auditError: new Error("audit unavailable"),
      auditErrorAction: "renewal_requested",
    },
  });

  await assert.rejects(
    () => renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, options),
    (error) => error.message === "audit unavailable"
  );

  assert.equal(state.existingByCallback.status, "active");
  assert.equal(state.existingByCallback.pendingMode, null);
  assert.deepEqual(state.auditRows, []);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.deepEqual(
    state.calls
      .filter((call) => ["BEGIN", "renewPending", "audit", "ROLLBACK"].includes(call[0]))
      .map((call) => call[0]),
    ["BEGIN", "renewPending", "audit", "ROLLBACK"]
  );
});

test("YouTube WebSub unsubscribe_requested audit failure rolls back pending unsubscribe before hub", async () => {
  const original = subscription({ status: "active", pendingMode: null });
  const { state, options } = baseOptions({
    state: {
      existingByCallback: original,
      auditError: new Error("audit unavailable"),
      auditErrorAction: "unsubscribe_requested",
    },
  });

  await assert.rejects(
    () => unsubscribeCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, options),
    (error) => error.message === "audit unavailable"
  );

  assert.equal(state.existingByCallback.status, "active");
  assert.equal(state.existingByCallback.pendingMode, null);
  assert.deepEqual(state.auditRows, []);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.deepEqual(
    state.calls
      .filter((call) => ["BEGIN", "unsubscribePending", "audit", "ROLLBACK"].includes(call[0]))
      .map((call) => call[0]),
    ["BEGIN", "unsubscribePending", "audit", "ROLLBACK"]
  );
});

test("YouTube WebSub post-hub audit failure does not mask accepted or failed hub result", async () => {
  const accepted = baseOptions({
    state: {
      auditError: new Error("audit write failed"),
      auditErrorAction: "hub_request_accepted",
    },
  });
  const acceptedResult = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, accepted.options);
  assert.equal(acceptedResult.ok, true);
  assert.equal(acceptedResult.code, "subscription_pending");
  assert.equal(accepted.state.calls.some((call) => call[0] === "hub"), true);

  const failed = baseOptions({
    state: {
      auditError: new Error("audit write failed"),
      auditErrorAction: "hub_request_failed",
      hubResult: { ok: false, code: "hub_request_failed", status: 503, mode: "subscribe" },
    },
  });
  const failedResult = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, failed.options);
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.code, "hub_request_failed");
  assert.equal(failedResult.retryable, true);
  assert.equal(failed.state.calls.some((call) => call[0] === "hub"), true);
});

test("YouTube WebSub concrete open unique conflict is idempotent only with open row", async () => {
  const concreteConflict = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "codeclip_youtube_websub_subscriptions_open_account_uidx",
  });
  let openLookupCount = 0;
  const { state, options } = baseOptions({
    options: {
      getOpenSubscriptionByProviderAccountId: async () => {
        openLookupCount += 1;
        return openLookupCount === 1 ? null : subscription({ status: "active" });
      },
      createPendingSubscription: async () => {
        throw concreteConflict;
      },
    },
  });
  const result = await createCodeClipYouTubeWebSubSubscriptionOperation({
    eventCode: EVENT_CODE,
    providerAccountId: CHANNEL_ID,
  }, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "subscription_already_exists");
  assert.equal(result.subscription.status, "active");
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
});

test("YouTube WebSub unique conflict handling does not mask unrelated or unresolved errors", async () => {
  const otherConstraint = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "some_other_unique_constraint",
  });
  const other = baseOptions({
    options: {
      createPendingSubscription: async () => {
        throw otherConstraint;
      },
    },
  });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, other.options),
    otherConstraint
  );

  const messageOnly = new Error("unique index failed");
  const messageCase = baseOptions({
    options: {
      createPendingSubscription: async () => {
        throw messageOnly;
      },
    },
  });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, messageCase.options),
    messageOnly
  );

  const concreteConflict = Object.assign(new Error("duplicate"), {
    code: "23505",
    constraint: "codeclip_youtube_websub_subscriptions_open_account_uidx",
  });
  const noOpenRow = baseOptions({
    state: { existingByAccount: subscription({ status: "expired" }) },
    options: {
      createPendingSubscription: async () => {
        throw concreteConflict;
      },
    },
  });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubSubscriptionOperation({
      eventCode: EVENT_CODE,
      providerAccountId: CHANNEL_ID,
    }, noOpenRow.options),
    concreteConflict
  );
});

test("YouTube WebSub renew preserves boundary and keeps status pending until challenge", async () => {
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        activationBoundaryAt: "2026-07-18T00:00:00.000Z",
      }),
    },
  });
  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    { leaseSeconds: 1000 },
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.subscription.status, "pending_renewal");
  assert.equal(result.subscription.activationBoundaryAt, "2026-07-18T00:00:00.000Z");
  assert.equal(state.calls.find((call) => call[0] === "hub")[1].mode, "subscribe");
  assert.equal(state.calls.find((call) => call[0] === "claimDispatch")[1], "renew");
  assert.equal(state.calls.find((call) => call[0] === "recordDispatch")[1], "renew");
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "renewal_requested",
    "hub_request_accepted",
  ]);
  assert.deepEqual(state.auditRows.map((row) => row.mode), ["renew", "renew"]);
});

test("YouTube WebSub renew accepts production active state with real audit mode validation", async () => {
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        activationBoundaryAt: "2026-07-21T11:13:50.828Z",
        leaseStartedAt: "2026-07-21T11:13:50.828Z",
        leaseExpiresAt: "2026-07-31T11:13:50.828Z",
        metadata: {
          dispatch: {
            mode: "subscribe",
            status: "accepted",
            resultCode: "hub_request_accepted",
            attemptNumber: 1,
          },
        },
      }),
    },
  });
  options.recordAudit = async (input) => {
    state.calls.push(["realAudit", input]);
    const audit = await recordCodeClipYouTubeWebSubSubscriptionAudit(input, {
      queryClient: {
        query: async (_sql, params) => ({
          rows: [{
            id: String(state.auditRows.length + 1),
            vertical: "codeclip",
            provider: "youtube",
            callback_id: params[0],
            provider_account_id: params[1],
            event_code: params[2],
            action: params[3],
            mode: params[4],
            result_code: params[5],
            hub_http_status: params[6],
            retryable: params[7],
            metadata: JSON.parse(params[8]),
            created_at: "2026-07-21T11:13:51.000Z",
          }],
        }),
      },
    });
    state.auditRows.push(audit);
    return audit;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.dispatchClaimed, true);
  assert.equal(state.calls.some((call) => call[0] === "renewPending"), true);
  assert.equal(state.calls.some((call) => call[0] === "claimDispatch" && call[1] === "renew"), true);
  assert.equal(state.calls.find((call) => call[0] === "hub")[1].mode, "subscribe");

  const realAuditCalls = state.calls.filter((call) => call[0] === "realAudit");
  assert.equal(realAuditCalls.length, 2);
  assert.equal(realAuditCalls[0][1].action, "renewal_requested");
  assert.equal(realAuditCalls[0][1].mode, "renew");
  assert.equal(realAuditCalls[1][1].action, "hub_request_accepted");
  assert.equal(realAuditCalls[1][1].mode, "renew");
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "renewal_requested",
    "hub_request_accepted",
  ]);
  assert.deepEqual(state.auditRows.map((row) => row.mode), ["renew", "renew"]);
  assert.deepEqual(
    state.calls
      .filter((call) => ["BEGIN", "renewPending", "realAudit", "COMMIT", "claimDispatch", "hub"].includes(call[0]))
      .map((call) => call[0]),
    ["BEGIN", "renewPending", "realAudit", "COMMIT", "claimDispatch", "hub", "realAudit"]
  );
});

test("YouTube WebSub ordinary renew after terminal subscribe dispatch claims and sends hub request", async () => {
  const previousDispatch = {
    attemptId: "attempt_subscribe_accepted",
    attemptNumber: 1,
    status: "accepted",
    mode: "subscribe",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
  };
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        leaseStartedAt: "2026-07-21T11:13:50.828Z",
        leaseExpiresAt: "2026-07-31T11:13:50.828Z",
        metadata: { dispatch: previousDispatch },
      }),
    },
  });
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    const claimed = subscription({
      ...state.existingByCallback,
      callbackId,
      status: "pending_renewal",
      pendingMode: "subscribe",
      metadata: {
        ...(state.existingByCallback.metadata || {}),
        dispatch: {
          attemptId: input.attemptId,
          attemptNumber: 2,
          previousAttemptCount: 1,
          status: "started",
          mode: "renew",
          startedAt: "2026-07-18T00:00:01.000Z",
          requestedLeaseSeconds: input.leaseSeconds,
          retryEligible: false,
        },
      },
    });
    state.claimed = claimed;
    return claimed;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.status, "pending_renewal");
  assert.equal(result.subscription.status, "pending_renewal");
  assert.equal(result.subscription.pendingMode, "subscribe");
  assert.equal(result.dispatchClaimed, true);
  const claimCall = state.calls.find((call) => call[0] === "claimDispatch" && call[1] === "renew");
  const hubCall = state.calls.find((call) => call[0] === "hub");
  assert.equal(state.calls.filter((call) => call[0] === "claimDispatch" && call[1] === "renew").length, 1);
  assert.equal(state.calls.filter((call) => call[0] === "hub").length, 1);
  assert.equal(hubCall[1].operationMode, "renew");
  assert.equal(hubCall[1].mode, "subscribe");
  assert.equal(hubCall[1].attemptId, claimCall[3].attemptId);
  assert.equal(hubCall[1].attemptNumber, 2);
});

test("YouTube WebSub ordinary renew after terminal renew dispatch claims attempt 3 and sends hub request", async () => {
  const repo = createRenewRepositoryClient(subscription({
    status: "active",
    pendingMode: null,
    leaseStartedAt: "2026-07-22T10:12:08.423Z",
    leaseExpiresAt: "2026-08-01T10:12:08.423Z",
    metadata: {
      bindingId: "4",
      dispatch: {
        attemptId: "attempt_previous_renew_accepted",
        attemptNumber: 2,
        previousAttemptCount: 1,
        status: "accepted",
        mode: "renew",
        resultCode: "hub_request_accepted",
        hubHttpStatus: 202,
        retryEligible: false,
        startedAt: "2026-07-22T10:12:08.198404+00:00",
        completedAt: "2026-07-22T10:12:08.449115+00:00",
        requestedLeaseSeconds: 864000,
      },
    },
  }));
  const { state, options } = baseOptions({
    options: {
      queryClient: repo,
      runTransaction: async (work) => {
        state.calls.push(["BEGIN", repo]);
        const result = await work({ queryClient: repo });
        state.calls.push(["COMMIT", repo]);
        return result;
      },
      generateDispatchAttemptId: () => "attempt_renew_3",
      getSubscriptionByCallbackId: async (callbackId, input) => {
        state.calls.push(["getByCallback", callbackId, input]);
        return getCodeClipYouTubeWebSubSubscriptionByCallbackId(callbackId, {
          queryClient: repo,
        });
      },
      markRenewalPending: async (callbackId) => {
        state.calls.push(["renewPending", callbackId]);
        return markCodeClipYouTubeWebSubSubscriptionRenewalPending(callbackId, {
          queryClient: repo,
        });
      },
      claimRenewDispatch: async (callbackId, input) => {
        state.calls.push(["claimDispatch", "renew", callbackId, input]);
        return claimCodeClipYouTubeWebSubRenewDispatch(callbackId, {
          ...input,
          queryClient: repo,
        });
      },
      recordRenewDispatchResult: async (callbackId, input) => {
        state.calls.push(["recordDispatch", "renew", callbackId, input]);
        return recordCodeClipYouTubeWebSubRenewDispatchResult(callbackId, {
          ...input,
          queryClient: repo,
        });
      },
      recordAudit: async (input) => {
        state.calls.push(["realAudit", input]);
        return recordCodeClipYouTubeWebSubSubscriptionAudit(input, {
          queryClient: repo,
        });
      },
    },
  });

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  const claimCall = state.calls.find((call) => call[0] === "claimDispatch" && call[1] === "renew");
  const hubCalls = state.calls.filter((call) => call[0] === "hub");
  const hubCall = hubCalls[0]?.[1];

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.status, "pending_renewal");
  assert.equal(result.dispatchClaimed, true);
  assert.equal(hubCalls.length, 1);
  assert.equal(hubCall.operationMode, "renew");
  assert.equal(hubCall.mode, "subscribe");
  assert.equal(hubCall.attemptId, claimCall[3].attemptId);
  assert.equal(hubCall.attemptId, "attempt_renew_3");
  assert.equal(hubCall.attemptNumber, 3);
  assert.equal(state.calls.filter((call) => call[0] === "recordDispatch" && call[1] === "renew").length, 1);
  assert.equal(repo.rows[0].metadata.dispatch.mode, "renew");
  assert.equal(repo.rows[0].metadata.dispatch.status, "accepted");
  assert.equal(repo.rows[0].metadata.dispatch.attemptId, "attempt_renew_3");
  assert.equal(repo.rows[0].metadata.dispatch.attemptNumber, 3);
});

test("YouTube WebSub renew resumes production pending renewal after terminal subscribe dispatch", async () => {
  const previousDispatch = {
    attemptId: "attempt_subscribe_accepted",
    attemptNumber: 1,
    status: "accepted",
    mode: "subscribe",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
  };
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "pending_renewal",
        pendingMode: "subscribe",
        leaseStartedAt: "2026-07-21T11:13:50.828Z",
        leaseExpiresAt: "2026-07-31T11:13:50.828Z",
        metadata: { dispatch: previousDispatch },
      }),
    },
  });

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.status, "pending_renewal");
  assert.equal(result.dispatchClaimed, true);
  assert.equal(state.calls.some((call) => call[0] === "renewPending"), false);
  assert.equal(state.calls.filter((call) => call[0] === "claimDispatch" && call[1] === "renew").length, 1);
  assert.equal(state.calls.filter((call) => call[0] === "hub").length, 1);
});

test("YouTube WebSub renew recovers its own active-to-pending transition when claim is not won", async () => {
  const previousDispatch = {
    attemptId: "attempt_previous_renew_accepted",
    attemptNumber: 2,
    previousAttemptCount: 1,
    status: "accepted",
    mode: "renew",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
    requestedLeaseSeconds: 864000,
  };
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        leaseStartedAt: "2026-07-22T10:12:08.423Z",
        leaseExpiresAt: "2026-08-01T10:12:08.423Z",
        metadata: { dispatch: previousDispatch },
      }),
    },
  });
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    return null;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "subscription_state_conflict");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.equal(state.existingByCallback.status, "active");
  assert.equal(state.existingByCallback.pendingMode, null);
  assert.equal(state.existingByCallback.leaseExpiresAt, "2026-08-01T10:12:08.423Z");
  assert.deepEqual(state.existingByCallback.metadata.dispatch, previousDispatch);
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "renewal_requested",
    "renewal_conflict_recovered",
  ]);
});

test("YouTube WebSub renew does not recover pending state it did not create", async () => {
  const previousDispatch = {
    attemptId: "attempt_previous_renew_accepted",
    attemptNumber: 2,
    previousAttemptCount: 1,
    status: "accepted",
    mode: "renew",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
    requestedLeaseSeconds: 864000,
  };
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "pending_renewal",
        pendingMode: "subscribe",
        leaseStartedAt: "2026-07-22T10:12:08.423Z",
        leaseExpiresAt: "2026-08-01T10:12:08.423Z",
        metadata: { dispatch: previousDispatch },
      }),
    },
  });
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    return null;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "subscription_state_conflict");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(state.calls.some((call) => call[0] === "renewPending"), false);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.equal(state.existingByCallback.status, "pending_renewal");
  assert.equal(state.existingByCallback.pendingMode, "subscribe");
  assert.deepEqual(state.existingByCallback.metadata.dispatch, previousDispatch);
});

test("YouTube WebSub renew does not audit or recover when guarded transition is overtaken", async () => {
  const previousDispatch = {
    attemptId: "attempt_previous_renew_accepted",
    attemptNumber: 2,
    previousAttemptCount: 1,
    status: "accepted",
    mode: "renew",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryEligible: false,
    requestedLeaseSeconds: 864000,
  };
  const otherOwnerDispatch = {
    attemptId: "attempt_other_owner",
    attemptNumber: 3,
    previousAttemptCount: 2,
    status: "started",
    mode: "renew",
    staleAfterEpochMs: 1_800_000_060_000,
    retryEligible: false,
  };
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        leaseStartedAt: "2026-07-22T10:12:08.423Z",
        leaseExpiresAt: "2026-08-01T10:12:08.423Z",
        metadata: { dispatch: previousDispatch },
      }),
    },
  });
  options.markRenewalPending = async (callbackId) => {
    state.calls.push(["renewPending", callbackId]);
    state.existingByCallback = subscription({
      ...state.existingByCallback,
      status: "pending_renewal",
      pendingMode: "subscribe",
      metadata: { dispatch: otherOwnerDispatch },
    });
    return null;
  };
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    return null;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "subscription_state_conflict");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(state.calls.some((call) => call[0] === "renewPending"), true);
  assert.equal(
    state.calls.some((call) => call[0] === "recoverRenewalPendingConflict"),
    false
  );
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
  assert.equal(state.existingByCallback.status, "pending_renewal");
  assert.equal(state.existingByCallback.pendingMode, "subscribe");
  assert.deepEqual(state.existingByCallback.metadata.dispatch, otherOwnerDispatch);
  assert.equal(state.auditRows.some((row) => row.action === "renewal_conflict_recovered"), false);
  assert.equal(state.auditRows.some((row) => row.action === "renewal_requested"), false);
});

test("YouTube WebSub renew returns conflict when claim is missing without active same-attempt dispatch", async () => {
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "active",
        pendingMode: null,
        metadata: {
          dispatch: {
            attemptId: "attempt_subscribe_accepted",
            attemptNumber: 1,
            status: "accepted",
            mode: "subscribe",
            resultCode: "hub_request_accepted",
            retryEligible: false,
          },
        },
      }),
    },
  });
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    return null;
  };

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, options);

  assert.equal(result.ok, false);
  assert.equal(result.code, "subscription_state_conflict");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
});

test("YouTube WebSub renew treats same non-stale started attempt as idempotent", async () => {
  const { state, options } = baseOptions({
    state: {
      existingByCallback: subscription({
        status: "pending_renewal",
        pendingMode: "subscribe",
        metadata: {
          dispatch: {
            attemptId: "attempt_1",
            attemptNumber: 2,
            status: "started",
            mode: "renew",
            staleAfterEpochMs: 1_800_000_060_000,
            retryEligible: false,
          },
        },
      }),
    },
  });
  options.claimRenewDispatch = async (callbackId, input) => {
    state.calls.push(["claimDispatch", "renew", callbackId, input]);
    return null;
  };
  options.dispatchNowEpochMs = 1_800_000_000_000;

  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "renewal_pending");
  assert.equal(result.dispatchClaimed, false);
  assert.equal(result.subscription.lastOperation.mode, "renew");
  assert.equal(result.subscription.lastOperation.status, "started");
  assert.equal(result.subscription.lastOperation.attemptNumber, 2);
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
});

test("YouTube WebSub renew rejects missing claim for different, stale, or malformed started dispatch", async (t) => {
  const cases = [
    {
      name: "different renew attempt",
      dispatch: {
        attemptId: "attempt_other",
        attemptNumber: 2,
        status: "started",
        mode: "renew",
        staleAfterEpochMs: 1_800_000_060_000,
        retryEligible: false,
      },
    },
    {
      name: "stale renew attempt",
      dispatch: {
        attemptId: "attempt_1",
        attemptNumber: 2,
        status: "started",
        mode: "renew",
        staleAfterEpochMs: 1_799_999_999_999,
        retryEligible: false,
      },
    },
    {
      name: "malformed renew attempt",
      dispatch: {
        attemptId: "attempt_1",
        status: "started",
        mode: "renew",
        retryEligible: false,
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { state, options } = baseOptions({
        state: {
          existingByCallback: subscription({
            status: "pending_renewal",
            pendingMode: "subscribe",
            metadata: { dispatch: item.dispatch },
          }),
        },
      });
      options.claimRenewDispatch = async (callbackId, input) => {
        state.calls.push(["claimDispatch", "renew", callbackId, input]);
        return null;
      };
      options.dispatchNowEpochMs = 1_800_000_000_000;

      const result = await renewCodeClipYouTubeWebSubSubscriptionOperation(
        "yt_callback_1",
        {},
        options
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "subscription_state_conflict");
      assert.equal(result.dispatchClaimed, false);
      assert.equal(state.calls.some((call) => call[0] === "hub"), false);
    });
  }
});

test("YouTube WebSub renew duplicate, retry, stale and failure dispatch states are handled", async () => {
  const activeClaim = baseOptions({
    state: {
      existingByCallback: subscription({ status: "pending_renewal", pendingMode: "subscribe" }),
      claimResult: null,
    },
  });
  const activeClaimResult = await renewCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    activeClaim.options
  );
  assert.equal(activeClaimResult.ok, false);
  assert.equal(activeClaimResult.code, "subscription_state_conflict");
  assert.equal(activeClaimResult.dispatchClaimed, false);
  assert.equal(activeClaim.state.calls.some((call) => call[0] === "hub"), false);

  for (const dispatch of [
    { status: "failed", mode: "renew", retryEligible: true, attemptNumber: 1 },
    { status: "started", mode: "renew", retryEligible: false, attemptNumber: 1, staleAfterEpochMs: 1 },
  ]) {
    const retryable = baseOptions({
      state: {
        existingByCallback: subscription({
          status: "pending_renewal",
          pendingMode: "subscribe",
          metadata: { dispatch },
        }),
      },
    });
    const result = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, retryable.options);
    assert.equal(result.ok, true);
    assert.equal(result.dispatchClaimed, true);
    assert.equal(retryable.state.calls.filter((call) => call[0] === "hub").length, 1);
  }

  const retryableFailure = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      hubResult: { ok: false, code: "hub_request_timeout", status: 0, mode: "subscribe" },
    },
  });
  const retryableResult = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, retryableFailure.options);
  assert.equal(retryableResult.ok, false);
  assert.equal(retryableResult.retryable, true);
  assert.equal(retryableFailure.state.calls.find((call) => call[0] === "recordDispatch")[1], "renew");
  assert.equal(retryableFailure.state.calls.find((call) => call[0] === "recordDispatch")[3].retryable, true);

  const rejectedFailure = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      hubResult: { ok: false, code: "hub_request_rejected", status: 400, retryable: false, mode: "subscribe" },
    },
  });
  const rejectedResult = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, rejectedFailure.options);
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.retryable, false);
  assert.equal(rejectedFailure.state.calls.find((call) => call[0] === "recordDispatch")[3].retryable, false);
});

test("YouTube WebSub renew callback race preserves active state and lastOperation mode", async () => {
  const activeAfterCallback = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      recordResult: subscription({
        status: "active",
        pendingMode: null,
        leaseStartedAt: "2026-07-18T00:00:00.000Z",
        leaseExpiresAt: "2026-07-28T00:00:00.000Z",
      }),
    },
  });
  const result = await renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, activeAfterCallback.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(result.subscription.status, "active");
  assert.equal(result.subscription.lastOperation.mode, "renew");
  assert.equal(result.subscription.lastOperation.status, "accepted");
});

test("YouTube WebSub renew rejects pending unsubscribe lifecycle", async () => {
  const { options } = baseOptions({
    state: { existingByCallback: subscription({ status: "pending_unsubscribe", pendingMode: "unsubscribe" }) },
  });
  await assert.rejects(
    () => renewCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, options),
    (error) => error.code === "subscription_state_conflict"
  );
});

test("YouTube WebSub unsubscribe marks pending and leaves binding lifecycle untouched", async () => {
  const { state, options } = baseOptions({
    state: { existingByCallback: subscription({ status: "active", pendingMode: null }) },
  });
  const result = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "unsubscribe_pending");
  assert.equal(result.subscription.status, "pending_unsubscribe");
  const hubCall = state.calls.find((call) => call[0] === "hub");
  const claimCall = state.calls.find((call) => call[0] === "claimDispatch");
  assert.equal(hubCall[1].mode, "unsubscribe");
  assert.equal(hubCall[1].operationMode, "unsubscribe");
  assert.equal(hubCall[1].attemptId, claimCall[3].attemptId);
  assert.equal(hubCall[1].attemptNumber, 1);
  assert.equal(claimCall[1], "unsubscribe");
  assert.equal(state.calls.find((call) => call[0] === "recordDispatch")[1], "unsubscribe");
  assert.equal(state.calls.some((call) => call[0] === "binding"), false);
  assert.deepEqual(state.auditRows.map((row) => row.action), [
    "unsubscribe_requested",
    "hub_request_accepted",
  ]);
  assert.deepEqual(state.auditRows.map((row) => row.mode), ["unsubscribe", "unsubscribe"]);
});

test("YouTube WebSub unsubscribe duplicate, retry, stale and failure dispatch states are handled", async () => {
  const activeClaim = baseOptions({
    state: {
      existingByCallback: subscription({ status: "pending_unsubscribe", pendingMode: "unsubscribe" }),
      claimResult: null,
    },
  });
  const activeClaimResult = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation(
    "yt_callback_1",
    {},
    activeClaim.options
  );
  assert.equal(activeClaimResult.ok, true);
  assert.equal(activeClaimResult.code, "unsubscribe_pending");
  assert.equal(activeClaimResult.dispatchClaimed, false);
  assert.equal(activeClaim.state.calls.some((call) => call[0] === "hub"), false);

  for (const dispatch of [
    { status: "failed", mode: "unsubscribe", retryEligible: true, attemptNumber: 1 },
    { status: "started", mode: "unsubscribe", retryEligible: false, attemptNumber: 1, staleAfterEpochMs: 1 },
  ]) {
    const retryable = baseOptions({
      state: {
        existingByCallback: subscription({
          status: "pending_unsubscribe",
          pendingMode: "unsubscribe",
          metadata: { dispatch },
        }),
      },
    });
    const result = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, retryable.options);
    assert.equal(result.ok, true);
    assert.equal(result.dispatchClaimed, true);
    assert.equal(retryable.state.calls.filter((call) => call[0] === "hub").length, 1);
  }

  const retryableFailure = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      hubResult: { ok: false, code: "hub_request_timeout", status: 0, mode: "unsubscribe" },
    },
  });
  const retryableResult = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, retryableFailure.options);
  assert.equal(retryableResult.ok, false);
  assert.equal(retryableResult.retryable, true);
  assert.equal(retryableFailure.state.calls.find((call) => call[0] === "recordDispatch")[1], "unsubscribe");
  assert.equal(retryableFailure.state.calls.find((call) => call[0] === "recordDispatch")[3].retryable, true);

  const rejectedFailure = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      hubResult: { ok: false, code: "hub_request_rejected", status: 400, retryable: false, mode: "unsubscribe" },
    },
  });
  const rejectedResult = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, rejectedFailure.options);
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.retryable, false);
  assert.equal(rejectedFailure.state.calls.find((call) => call[0] === "recordDispatch")[3].retryable, false);
});

test("YouTube WebSub unsubscribe callback race preserves terminal state and lastOperation mode", async () => {
  const unsubscribedAfterCallback = baseOptions({
    state: {
      existingByCallback: subscription({ status: "active", pendingMode: null }),
      recordResult: subscription({ status: "unsubscribed", pendingMode: null }),
    },
  });
  const result = await unsubscribeCodeClipYouTubeWebSubSubscriptionOperation("yt_callback_1", {}, unsubscribedAfterCallback.options);
  assert.equal(result.ok, true);
  assert.equal(result.status, "unsubscribed");
  assert.equal(result.subscription.status, "unsubscribed");
  assert.equal(result.subscription.lastOperation.mode, "unsubscribe");
  assert.equal(result.subscription.lastOperation.status, "accepted");
});

test("YouTube WebSub status helpers return public-safe subscription fields", async () => {
  const { options } = baseOptions({
    state: { existingByCallback: subscription({ status: "active", pendingMode: null }) },
  });
  const list = await listCodeClipYouTubeWebSubSubscriptionStatuses({}, options);
  const item = await getCodeClipYouTubeWebSubSubscriptionStatus("yt_callback_1", options);

  assert.equal(list.length, 1);
  assert.equal(item.callbackId, "yt_callback_1");
  assert.equal(item.secret, undefined);
  assert.equal(item.rootSecret, undefined);
  assert.equal(item.providerAccountId, CHANNEL_ID);
});
