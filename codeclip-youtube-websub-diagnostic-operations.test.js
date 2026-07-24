const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDiagnosticCallbackUrl,
  createCodeClipYouTubeWebSubDiagnosticProbeOperation,
  getCodeClipYouTubeWebSubDiagnosticProbeStatus,
  unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation,
} = require("./verticals/codeclip/youtube-websub-diagnostic-operations");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const PROBE_ID = "diag_probeOperation123";
const CALLBACK_ID = "diag_yt_callbackOperation1234";

function probe(overrides = {}) {
  return {
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    channelId: CHANNEL_ID,
    topic: TOPIC,
    status: "pending_subscribe",
    pendingMode: "subscribe",
    cleanupRequired: false,
    subscriptionMayExist: true,
    leaseExpiresAt: null,
    verifiedAt: null,
    firstVerifiedAt: null,
    lastNotificationAt: null,
    unsubscribedAt: null,
    diagnosticMetadata: {},
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function publicProbe(input = probe()) {
  return {
    probeId: input.probeId,
    callbackId: "diag_y...1234",
    provider: input.provider,
    channel: input.channel,
    channelId: input.channelId,
    topic: input.topic,
    status: input.status,
    pendingMode: input.pendingMode,
    cleanupRequired: input.cleanupRequired,
    subscriptionMayExist: input.subscriptionMayExist,
    leaseExpiresAt: input.leaseExpiresAt,
    verifiedAt: input.verifiedAt,
    firstVerifiedAt: input.firstVerifiedAt,
    lastNotificationAt: input.lastNotificationAt,
    unsubscribedAt: input.unsubscribedAt,
    notification: null,
  };
}

function baseOptions(overrides = {}) {
  const state = {
    calls: [],
    current: probe(),
    createResult: null,
    hubResult: { ok: true, code: "hub_request_accepted", status: 204, mode: "subscribe" },
    observations: {
      count: 2,
      items: [
        { videoId: "Q8yMabcVtxc", seenCount: 2, publishedAt: "2026-07-24T10:04:00.000Z" },
      ],
    },
  };
  state.createResult = { status: "created", row: state.current, public: publicProbe(state.current) };

  const options = {
    env: {
      CODECLIP_PUBLIC_BASE_URL: "https://backend.example.test/",
      CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret",
    },
    queryClient: { query: async () => ({ rows: [] }) },
    runTransaction: async (work, queryClient) => {
      state.calls.push(["tx", queryClient]);
      return work({ queryClient });
    },
    generateProbeId: () => PROBE_ID,
    generateCallbackId: () => CALLBACK_ID,
    generateDispatchAttemptId: () => "attempt_diag_1",
    createProbe: async (input, options) => {
      state.calls.push(["createProbe", input, options]);
      return state.createResult;
    },
    markSubscribeDispatched: async (input, options) => {
      state.calls.push(["subscribeDispatched", input, options]);
      state.current = {
        ...state.current,
        diagnosticMetadata: {
          lastDispatch: {
            mode: "subscribe",
            status: "started",
            attemptId: input.attemptId,
            attemptNumber: input.attemptNumber,
            leaseSeconds: input.leaseSeconds,
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
    markSubscribeAccepted: async (input, options) => {
      state.calls.push(["subscribeAccepted", input, options]);
      state.current = {
        ...state.current,
        diagnosticMetadata: {
          lastDispatch: {
            mode: "subscribe",
            status: "accepted",
            attemptId: input.attemptId,
            attemptNumber: input.attemptNumber,
            resultCode: "hub_request_accepted",
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
    markSubscribeFailed: async (input, options) => {
      state.calls.push(["subscribeFailed", input, options]);
      state.current = {
        ...state.current,
        status: "failed",
        cleanupRequired: Boolean(input.cleanupRequired),
        subscriptionMayExist: Boolean(input.subscriptionMayExist),
        failedOperation: "subscribe",
        failedReasonCode: input.reasonCode,
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
    getProbeByProbeId: async (probeId, options) => {
      state.calls.push(["getProbe", probeId, options]);
      return { row: state.current, public: publicProbe(state.current) };
    },
    getObservationSummary: async (probeId, options) => {
      state.calls.push(["observations", probeId, options]);
      return state.observations;
    },
    markUnsubscribeDispatched: async (input, options) => {
      state.calls.push(["unsubscribeDispatched", input, options]);
      state.current = {
        ...state.current,
        status: "pending_unsubscribe",
        pendingMode: "unsubscribe",
        diagnosticMetadata: {
          lastDispatch: {
            mode: "unsubscribe",
            status: "started",
            attemptId: input.attemptId,
            attemptNumber: input.attemptNumber,
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
    markUnsubscribeAccepted: async (input, options) => {
      state.calls.push(["unsubscribeAccepted", input, options]);
      state.current = {
        ...state.current,
        diagnosticMetadata: {
          lastDispatch: {
            mode: "unsubscribe",
            status: "accepted",
            attemptId: input.attemptId,
            attemptNumber: input.attemptNumber,
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
    requestSubscription: async (input) => {
      state.calls.push(["hub", input]);
      return state.hubResult;
    },
    ...overrides,
  };
  return { state, options };
}

test("diagnostic callback URL uses configured HTTPS base and diagnostic path", () => {
  assert.equal(
    buildDiagnosticCallbackUrl("https://backend.example.test/", CALLBACK_ID),
    `https://backend.example.test/api/codeclip/diagnostics/youtube/websub/${CALLBACK_ID}`
  );
  assert.throws(() => buildDiagnosticCallbackUrl("http://backend.example.test", CALLBACK_ID), /public_base_url_unavailable/);
  assert.throws(() => buildDiagnosticCallbackUrl("", CALLBACK_ID), /public_base_url_unavailable/);
});

test("diagnostic start creates probe, sends Hub subscribe to diagnostic callback, and persists accepted dispatch", async () => {
  const { state, options } = baseOptions();
  const result = await createCodeClipYouTubeWebSubDiagnosticProbeOperation(
    {
      channelId: CHANNEL_ID,
      leaseSeconds: 864000,
      callbackId: "attacker",
      callbackUrl: "https://attacker.example/callback",
      provider: "meta",
    },
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "diagnostic_subscribe_pending");
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(state.calls.find((call) => call[0] === "createProbe")[1].callbackId, CALLBACK_ID);
  const hub = state.calls.find((call) => call[0] === "hub")[1];
  assert.equal(hub.mode, "subscribe");
  assert.equal(hub.callbackUrl, `https://backend.example.test/api/codeclip/diagnostics/youtube/websub/${CALLBACK_ID}`);
  assert.equal(hub.topic, TOPIC);
  assert.equal(hub.leaseSeconds, 864000);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
  assert.equal(JSON.stringify(result).includes("root-secret"), false);
  assert.equal(JSON.stringify(result).includes(hub.secret), false);
  assert.deepEqual(state.calls.map((call) => call[0]), [
    "tx",
    "createProbe",
    "subscribeDispatched",
    "hub",
    "tx",
    "subscribeAccepted",
  ]);
});

test("diagnostic start reuses existing open probe without a duplicate Hub request", async () => {
  const { state, options } = baseOptions();
  state.createResult = { status: "existing", row: state.current, public: publicProbe(state.current) };
  const result = await createCodeClipYouTubeWebSubDiagnosticProbeOperation(
    { channelId: CHANNEL_ID },
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, "diagnostic_probe_exists");
  assert.equal(state.calls.some((call) => call[0] === "hub"), false);
});

test("diagnostic start reconciles active probe when GET verification wins the Hub 202 race", async () => {
  const { state, options } = baseOptions({
    requestSubscription: async (input) => {
      state.calls.push(["hub", input]);
      state.current = probe({
        ...state.current,
        status: "active",
        pendingMode: null,
        verifiedAt: "2026-07-24T10:00:01.000Z",
        firstVerifiedAt: "2026-07-24T10:00:01.000Z",
        leaseExpiresAt: "2026-08-03T10:00:01.000Z",
        diagnosticMetadata: {
          ...state.current.diagnosticMetadata,
          lastVerification: {
            mode: "subscribe",
            verifiedAt: "2026-07-24T10:00:01.000Z",
            leaseSeconds: 864000,
          },
        },
      });
      return state.hubResult;
    },
    markSubscribeAccepted: async (input, options) => {
      state.calls.push(["subscribeAccepted", input, options]);
      state.current = {
        ...state.current,
        diagnosticMetadata: {
          ...state.current.diagnosticMetadata,
          lastDispatch: {
            ...state.current.diagnosticMetadata.lastDispatch,
            status: "accepted",
            acceptedAt: input.acceptedAt,
            resultCode: input.resultCode,
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
  });

  const result = await createCodeClipYouTubeWebSubDiagnosticProbeOperation(
    { channelId: CHANNEL_ID, leaseSeconds: 864000 },
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, "diagnostic_subscribe_pending");
  assert.equal(result.probe.status, "active");
  assert.equal(result.probe.probeId, PROBE_ID);
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(result.probe.cleanupRequired, false);
  assert.equal(result.probe.subscriptionMayExist, true);
  assert.equal(state.calls.some((call) => call[0] === "subscribeFailed"), false);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
  assert.equal(JSON.stringify(result).includes("root-secret"), false);
});

test("diagnostic start returns recoverable cleanup risk when Hub accepted but reconciliation is unavailable", async () => {
  const { state, options } = baseOptions({
    markSubscribeAccepted: async () => {
      state.calls.push(["subscribeAccepted"]);
      const error = new Error("accepted persistence failed");
      error.name = "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError";
      error.code = "state_conflict";
      throw error;
    },
    getProbeByProbeId: async (probeId, options) => {
      state.calls.push(["getProbe", probeId, options]);
      return { row: state.current, public: publicProbe(state.current) };
    },
    markSubscribeFailed: async (input, options) => {
      state.calls.push(["subscribeFailed", input, options]);
      throw new Error("subscribe failed transition should not be used after Hub accepted");
    },
  });
  const result = await createCodeClipYouTubeWebSubDiagnosticProbeOperation(
    { channelId: CHANNEL_ID },
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "diagnostic_cleanup_required");
  assert.equal(result.probe.probeId, PROBE_ID);
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(result.probe.cleanupRequired, true);
  assert.equal(result.probe.subscriptionMayExist, true);
  assert.equal(state.calls.some((call) => call[0] === "subscribeFailed"), false);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
});

test("diagnostic start fails closed when configured base URL is missing", async () => {
  const { options } = baseOptions({ env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" } });
  await assert.rejects(
    () => createCodeClipYouTubeWebSubDiagnosticProbeOperation({ channelId: CHANNEL_ID }, options),
    { code: "public_base_url_unavailable" }
  );
});

test("diagnostic status returns masked callback and observation summary", async () => {
  const { options } = baseOptions();
  const result = await getCodeClipYouTubeWebSubDiagnosticProbeStatus(PROBE_ID, options);
  assert.equal(result.ok, true);
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(result.probe.observationCount, 2);
  assert.equal(result.probe.observations.length, 1);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
});

test("diagnostic cleanup sends unsubscribe to the same diagnostic callback", async () => {
  const active = probe({
    status: "active",
    pendingMode: null,
    verifiedAt: "2026-07-24T10:05:00.000Z",
    firstVerifiedAt: "2026-07-24T10:05:00.000Z",
    leaseExpiresAt: "2026-07-25T10:05:00.000Z",
  });
  const { state, options } = baseOptions();
  state.current = active;
  state.hubResult = { ok: true, code: "hub_request_accepted", status: 204, mode: "unsubscribe" };

  const result = await unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation(PROBE_ID, {}, options);
  assert.equal(result.ok, true);
  assert.equal(result.code, "diagnostic_unsubscribe_pending");
  const hub = state.calls.find((call) => call[0] === "hub")[1];
  assert.equal(hub.mode, "unsubscribe");
  assert.equal(hub.callbackUrl, `https://backend.example.test/api/codeclip/diagnostics/youtube/websub/${CALLBACK_ID}`);
  assert.equal(hub.topic, TOPIC);
  assert.equal(hub.leaseSeconds, undefined);
});

test("diagnostic cleanup reconciles unsubscribed probe when GET verification wins the Hub 202 race", async () => {
  const active = probe({
    status: "active",
    pendingMode: null,
    verifiedAt: "2026-07-24T10:05:00.000Z",
    firstVerifiedAt: "2026-07-24T10:05:00.000Z",
    leaseExpiresAt: "2026-07-25T10:05:00.000Z",
  });
  const { state, options } = baseOptions({
    requestSubscription: async (input) => {
      state.calls.push(["hub", input]);
      state.current = probe({
        ...state.current,
        status: "unsubscribed",
        pendingMode: null,
        cleanupRequired: false,
        subscriptionMayExist: false,
        leaseExpiresAt: null,
        unsubscribedAt: "2026-07-24T10:10:01.000Z",
        diagnosticMetadata: {
          ...state.current.diagnosticMetadata,
          lastVerification: {
            mode: "unsubscribe",
            verifiedAt: "2026-07-24T10:10:01.000Z",
          },
        },
      });
      return state.hubResult;
    },
    markUnsubscribeAccepted: async (input, options) => {
      state.calls.push(["unsubscribeAccepted", input, options]);
      state.current = {
        ...state.current,
        diagnosticMetadata: {
          ...state.current.diagnosticMetadata,
          lastDispatch: {
            ...state.current.diagnosticMetadata.lastDispatch,
            status: "accepted",
            acceptedAt: input.acceptedAt,
            resultCode: input.resultCode,
          },
        },
      };
      return { status: "updated", row: state.current, public: publicProbe(state.current) };
    },
  });
  state.current = active;
  state.hubResult = { ok: true, code: "hub_request_accepted", status: 202, mode: "unsubscribe" };

  const result = await unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation(PROBE_ID, {}, options);

  assert.equal(result.ok, true);
  assert.equal(result.code, "diagnostic_unsubscribe_pending");
  assert.equal(result.probe.status, "unsubscribed");
  assert.equal(result.probe.probeId, PROBE_ID);
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(result.probe.cleanupRequired, false);
  assert.equal(result.probe.subscriptionMayExist, false);
  assert.equal(state.calls.some((call) => call[0] === "markCleanupRequired"), false);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
  assert.equal(JSON.stringify(result).includes("root-secret"), false);
});

test("diagnostic cleanup returns recoverable pending state when Hub accepted but unsubscribe reconciliation is unavailable", async () => {
  const active = probe({
    status: "active",
    pendingMode: null,
    verifiedAt: "2026-07-24T10:05:00.000Z",
    firstVerifiedAt: "2026-07-24T10:05:00.000Z",
    leaseExpiresAt: "2026-07-25T10:05:00.000Z",
  });
  const { state, options } = baseOptions({
    markUnsubscribeAccepted: async () => {
      state.calls.push(["unsubscribeAccepted"]);
      const error = new Error("unsubscribe accepted persistence failed");
      error.name = "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError";
      error.code = "state_conflict";
      throw error;
    },
    getProbeByProbeId: async (probeId, options) => {
      state.calls.push(["getProbe", probeId, options]);
      return { row: state.current, public: publicProbe(state.current) };
    },
    markCleanupRequired: async (input, options) => {
      state.calls.push(["markCleanupRequired", input, options]);
      throw new Error("cleanup required transition should not be used after Hub accepted");
    },
  });
  state.current = active;
  state.hubResult = { ok: true, code: "hub_request_accepted", status: 202, mode: "unsubscribe" };

  const result = await unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation(PROBE_ID, {}, options);

  assert.equal(result.ok, false);
  assert.equal(result.code, "diagnostic_cleanup_pending");
  assert.equal(result.probe.probeId, PROBE_ID);
  assert.equal(result.probe.callbackId, "diag_y...1234");
  assert.equal(result.probe.status, "pending_unsubscribe");
  assert.equal(result.probe.pendingMode, "unsubscribe");
  assert.equal(result.probe.cleanupRequired, true);
  assert.equal(result.probe.subscriptionMayExist, true);
  assert.equal(state.calls.some((call) => call[0] === "markCleanupRequired"), false);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
});
