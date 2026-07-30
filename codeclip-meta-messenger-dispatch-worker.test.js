const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH = path.join(
  __dirname,
  "verticals/codeclip/meta-messenger-dispatch-worker.js"
);
const SCRIPT_PATH = path.join(
  __dirname,
  "scripts/codeclip-meta-messenger-dispatch-worker.js"
);

function loadWorker() {
  delete require.cache[require.resolve("./verticals/codeclip/meta-messenger-dispatch-worker")];
  return require("./verticals/codeclip/meta-messenger-dispatch-worker");
}

function dispatchResult(partial = {}) {
  return {
    ok: false,
    outcome: "failed",
    claimDisposition: "not_acquired",
    outboundId: 1,
    attemptId: "attempt-1",
    providerAccepted: false,
    dispatchRecorded: false,
    durableHold: false,
    retryable: false,
    manualReviewRequired: false,
    providerMessageId: null,
    failureCode: null,
    ...partial,
  };
}

function assertNoSecretLeak(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-token|pageAccessToken|Bearer |PAGE_ACCESS/i);
  assert.doesNotMatch(serialized, /https:\/\/rewards\.example/);
}

test("worker module has no import side effects and no direct Graph fetch or SQL", () => {
  const mod = loadWorker();
  assert.equal(typeof mod.runCodeClipMetaMessengerDispatchCycle, "function");
  assert.equal(typeof mod.loadCodeClipMetaMessengerDispatchWorkerConfig, "function");
  assert.equal(typeof mod.classifyDispatchResultForSummary, "function");
  assert.equal(typeof mod.sanitizeMetaMessengerDispatchWorkerLogEvent, "function");

  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /graph\.facebook\.com/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\.query\s*\(/);
  assert.doesNotMatch(source, /SELECT |UPDATE |INSERT /i);
});

test("cycle with empty selection returns zero counts without dispatch", async () => {
  const { runCodeClipMetaMessengerDispatchCycle } = loadWorker();
  let dispatchCalls = 0;
  const cycle = await runCodeClipMetaMessengerDispatchCycle({
    limit: 5,
    concurrency: 1,
    staleAfterSeconds: 300,
    now: "2026-07-30T12:00:00.000Z",
    queryClient: {},
    resolvePageAccessCredentials: () => {
      throw new Error("should not resolve");
    },
    selectCandidates: async () => ({ ok: true, ids: [] }),
    dispatchOutbound: async () => {
      dispatchCalls += 1;
      return dispatchResult();
    },
  });

  assert.equal(cycle.ok, true);
  assert.equal(dispatchCalls, 0);
  assert.equal(cycle.summary.selected, 0);
  assert.equal(cycle.summary.processed, 0);
  assert.equal(cycle.summary.sent, 0);
  assert.deepEqual(cycle.items, []);
  assertNoSecretLeak(cycle);
});

test("cycle summary is derived only from dispatch result objects not database rows", async () => {
  const { runCodeClipMetaMessengerDispatchCycle, classifyDispatchResultForSummary } = loadWorker();

  assert.equal(classifyDispatchResultForSummary(dispatchResult({ outcome: "sent", ok: true })), "sent");
  assert.equal(
    classifyDispatchResultForSummary(dispatchResult({ outcome: "retryable_failed" })),
    "retryable_failed"
  );
  assert.equal(
    classifyDispatchResultForSummary(dispatchResult({ outcome: "terminal_failed" })),
    "terminal_failed"
  );
  assert.equal(
    classifyDispatchResultForSummary(dispatchResult({ outcome: "claim_conflict" })),
    "claim_conflict"
  );
  assert.equal(
    classifyDispatchResultForSummary(
      dispatchResult({ outcome: "provider_sent_record_unconfirmed", durableHold: true })
    ),
    "provider_sent_record_unconfirmed"
  );
  assert.equal(
    classifyDispatchResultForSummary(dispatchResult({ outcome: "credentials_failed" })),
    "credentials_failed"
  );

  const rowPoison = {
    id: 99,
    status: "sent",
    terminal: true,
    pageAccessToken: "secret-token-should-never-appear",
  };

  const cycle = await runCodeClipMetaMessengerDispatchCycle({
    limit: 10,
    concurrency: 1,
    staleAfterSeconds: 300,
    now: "2026-07-30T12:00:00.000Z",
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    selectCandidates: async () => ({ ok: true, ids: [1, 2, 3] }),
    createAttemptId: (() => {
      let n = 0;
      return () => `attempt-${++n}`;
    })(),
    dispatchOutbound: async ({ outboundId, attemptId }) => {
      if (outboundId === 1) {
        return dispatchResult({
          ok: true,
          outcome: "sent",
          outboundId,
          attemptId,
          claimDisposition: "claimed",
          attemptNumber: 1,
          providerAccepted: true,
          dispatchRecorded: true,
          row: rowPoison,
        });
      }
      if (outboundId === 2) {
        return dispatchResult({
          outcome: "retryable_failed",
          outboundId,
          attemptId,
          claimDisposition: "claimed",
          attemptNumber: 1,
          dispatchRecorded: true,
          retryable: true,
          failureCode: "graph_timeout",
          row: { status: "retryable_failed", pageAccessToken: "secret-token-2" },
        });
      }
      return dispatchResult({
        outcome: "provider_sent_record_unconfirmed",
        outboundId,
        attemptId,
        claimDisposition: "existing",
        attemptNumber: 2,
        providerAccepted: true,
        durableHold: true,
        manualReviewRequired: false,
        providerMessageId: "mid.x",
        row: { status: "provider_sent_unconfirmed", pageAccessToken: "secret-token-3" },
      });
    },
  });

  assert.equal(cycle.ok, true);
  assert.equal(cycle.summary.selected, 3);
  assert.equal(cycle.summary.processed, 3);
  assert.equal(cycle.summary.sent, 1);
  assert.equal(cycle.summary.retryableFailed, 1);
  assert.equal(cycle.summary.providerSentRecordUnconfirmed, 1);
  assert.equal(cycle.summary.terminalFailed, 0);
  assert.equal(cycle.summary.claimConflicts, 0);
  assert.equal(cycle.items.length, 3);
  for (const item of cycle.items) {
    assert.equal(Object.hasOwn(item, "row"), false);
    assert.equal(Object.hasOwn(item, "pageAccessToken"), false);
    assert.equal(Object.hasOwn(item, "providerMessageId"), false);
  }
  assertNoSecretLeak(cycle);
  assertNoSecretLeak(cycle.summary);
});

test("cycle forwards limit and now to selection and generates one attemptId per outbound", async () => {
  const { runCodeClipMetaMessengerDispatchCycle } = loadWorker();
  const selectArgs = [];
  const dispatchArgs = [];
  let attemptSeq = 0;

  await runCodeClipMetaMessengerDispatchCycle({
    limit: 7,
    concurrency: 1,
    staleAfterSeconds: 120,
    now: "2026-07-30T15:00:00.000Z",
    timeoutMs: 5000,
    queryClient: { marker: true },
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    selectCandidates: async (input) => {
      selectArgs.push(input);
      return { ok: true, ids: [10, 11] };
    },
    createAttemptId: () => `att-${++attemptSeq}`,
    dispatchOutbound: async (input) => {
      dispatchArgs.push(input);
      return dispatchResult({
        ok: true,
        outcome: "sent",
        outboundId: input.outboundId,
        attemptId: input.attemptId,
        claimDisposition: "claimed",
        attemptNumber: 1,
        providerAccepted: true,
        dispatchRecorded: true,
      });
    },
  });

  assert.equal(selectArgs.length, 1);
  assert.equal(selectArgs[0].limit, 7);
  assert.equal(selectArgs[0].now, "2026-07-30T15:00:00.000Z");
  assert.equal(dispatchArgs.length, 2);
  assert.equal(dispatchArgs[0].outboundId, 10);
  assert.equal(dispatchArgs[0].attemptId, "att-1");
  assert.equal(dispatchArgs[0].staleAfterSeconds, 120);
  assert.equal(dispatchArgs[0].timeoutMs, 5000);
  assert.equal(typeof dispatchArgs[0].resolvePageAccessCredentials, "function");
  assert.equal(dispatchArgs[1].attemptId, "att-2");
});

test("selection failure is cycle-level failure without dispatch", async () => {
  const { runCodeClipMetaMessengerDispatchCycle } = loadWorker();
  let dispatchCalls = 0;
  const cycle = await runCodeClipMetaMessengerDispatchCycle({
    limit: 5,
    concurrency: 1,
    staleAfterSeconds: 300,
    now: "2026-07-30T12:00:00.000Z",
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret",
      graphApiVersion: "v19.0",
    }),
    selectCandidates: async () => ({ ok: false, reason: "REPOSITORY_ERROR" }),
    dispatchOutbound: async () => {
      dispatchCalls += 1;
      return dispatchResult();
    },
  });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.failureCode, "selection_failed");
  assert.equal(dispatchCalls, 0);
});

test("per-row dispatch outcomes are counted independently and concurrency stays bounded", async () => {
  const { runCodeClipMetaMessengerDispatchCycle } = loadWorker();
  let inFlight = 0;
  let maxInFlight = 0;

  const cycle = await runCodeClipMetaMessengerDispatchCycle({
    limit: 10,
    concurrency: 2,
    staleAfterSeconds: 300,
    now: "2026-07-30T12:00:00.000Z",
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    selectCandidates: async () => ({ ok: true, ids: [1, 2, 3, 4] }),
    createAttemptId: (() => {
      let n = 0;
      return () => `a-${++n}`;
    })(),
    dispatchOutbound: async ({ outboundId }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (outboundId === 1) {
        return dispatchResult({
          outcome: "claim_conflict",
          claimDisposition: "not_acquired",
          outboundId,
        });
      }
      if (outboundId === 2) {
        return dispatchResult({
          outcome: "credentials_failed",
          claimDisposition: "claimed",
          attemptNumber: 1,
          outboundId,
          dispatchRecorded: true,
        });
      }
      if (outboundId === 3) {
        return dispatchResult({
          outcome: "terminal_failed",
          claimDisposition: "claimed",
          attemptNumber: 1,
          outboundId,
          dispatchRecorded: true,
        });
      }
      return dispatchResult({
        ok: true,
        outcome: "sent",
        claimDisposition: "claimed",
        attemptNumber: 1,
        outboundId,
        providerAccepted: true,
        dispatchRecorded: true,
      });
    },
  });

  assert.equal(cycle.ok, true);
  assert.equal(cycle.summary.selected, 4);
  assert.equal(cycle.summary.processed, 4);
  assert.equal(cycle.summary.claimConflicts, 1);
  assert.equal(cycle.summary.credentialsFailed, 1);
  assert.equal(cycle.summary.terminalFailed, 1);
  assert.equal(cycle.summary.sent, 1);
  assert.ok(maxInFlight <= 2);
});

test("loadConfig validates credentials JSON at startup and never embeds tokens", () => {
  const { loadCodeClipMetaMessengerDispatchWorkerConfig } = loadWorker();

  const bad = loadCodeClipMetaMessengerDispatchWorkerConfig({
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_ENABLED: "1",
    CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON: "{",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "CREDENTIAL_CONFIG_INVALID");
  assertNoSecretLeak(bad);

  const good = loadCodeClipMetaMessengerDispatchWorkerConfig({
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_ENABLED: "1",
    CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON: JSON.stringify({
      pages: {
        "page-1": {
          pageAccessToken: "secret-token-page-1",
          graphApiVersion: "v19.0",
        },
      },
    }),
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_LIMIT: "3",
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_CONCURRENCY: "1",
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_INTERVAL_MS: "15000",
  });
  assert.equal(good.ok, true);
  assert.equal(good.config.enabled, true);
  assert.equal(good.config.limit, 3);
  assert.equal(good.config.concurrency, 1);
  assert.equal(good.config.intervalMs, 15000);
  assert.equal(typeof good.config.resolvePageAccessCredentials, "function");
  assertNoSecretLeak(good.config);
  assert.equal(Object.hasOwn(good.config, "pageAccessToken"), false);

  const disabled = loadCodeClipMetaMessengerDispatchWorkerConfig({
    CODECLIP_META_MESSENGER_DISPATCH_WORKER_ENABLED: "0",
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.config.enabled, false);
});

test("sanitize strips secrets from log events", () => {
  const { sanitizeMetaMessengerDispatchWorkerLogEvent } = loadWorker();
  const cleaned = sanitizeMetaMessengerDispatchWorkerLogEvent({
    outcome: "sent",
    pageAccessToken: "secret-token-value",
    authorization: "Bearer secret",
    recipientId: "psid-should-go",
    deliverable: { url: "https://rewards.example/x" },
    outboundId: 9,
  });
  assert.equal(cleaned.outboundId, 9);
  assert.equal(cleaned.outcome, "sent");
  assert.equal(Object.hasOwn(cleaned, "pageAccessToken"), false);
  assert.equal(Object.hasOwn(cleaned, "authorization"), false);
  assert.equal(Object.hasOwn(cleaned, "recipientId"), false);
  assert.equal(Object.hasOwn(cleaned, "deliverable"), false);
  assertNoSecretLeak(cleaned);
});

test("CLI script exists and does not start worker on require", () => {
  assert.equal(fs.existsSync(SCRIPT_PATH), true);
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /require\.main === module/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /SIGINT/);
  assert.doesNotMatch(source, /graph\.facebook\.com/);
});
