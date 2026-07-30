const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH = path.join(
  __dirname,
  "verticals/codeclip/meta-messenger-outbound-dispatch.js"
);

function loadOrchestration() {
  delete require.cache[require.resolve("./verticals/codeclip/meta-messenger-outbound-dispatch")];
  return require("./verticals/codeclip/meta-messenger-outbound-dispatch");
}

function baseOutboundRow(overrides = {}) {
  return {
    id: 7,
    vertical: "codeclip",
    provider: "meta",
    channel: "messenger",
    outboundType: "reward_link",
    eventCode: "CC-B11-2E",
    bindingId: "binding-1",
    providerAccountId: "page-123456789",
    recipientId: "psid-987654321",
    externalInboundMessageId: "mid-inbound-1",
    inboundDeliveryId: "delivery-1",
    interactionId: "interaction-1",
    idempotencyKey: "codeclip:meta:messenger:outbound:page-123456789:mid-inbound-1:reward_link",
    deliverableType: "reward_link",
    deliverable: {
      type: "reward_link",
      rewardTier: "clip",
      url: "https://rewards.example/clip-123",
      metadata: {
        displayTier: "Clip",
        title: "Backstage clip",
        rewardType: "video",
      },
    },
    intent: {},
    status: "pending",
    attemptCount: 0,
    retryEligible: true,
    terminal: false,
    lastErrorCode: null,
    lastErrorMetadata: null,
    claimedAt: null,
    sentAt: null,
    failedAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function claimedRow(attemptId = "attempt-1", attemptCount = 1) {
  return baseOutboundRow({
    status: "claimed",
    attemptCount,
    retryEligible: false,
    terminal: false,
    lastErrorMetadata: { attemptId },
    claimedAt: "2026-07-30T01:00:00.000Z",
  });
}

function assertNoAttemptNumber(result) {
  assert.equal(Object.hasOwn(result, "attemptNumber"), false);
}

function assertSecretFree(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /secret-token|page-access-token|Bearer secret|Authorization|PAGE_ACCESS/i
  );
}

test("module exports dispatch orchestration without worker or persistence coupling", () => {
  const mod = loadOrchestration();
  assert.equal(typeof mod.dispatchCodeClipMetaMessengerOutbound, "function");
  assert.equal(typeof mod.mapMetaMessengerTransportResultToDispatchRecord, "function");
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /setInterval|while\s*\(|scanPending|claimNext/);
  assert.doesNotMatch(source, /require\(["'].*redis["']\)/i);
  assert.doesNotMatch(source, /require\(["'].*\/db["']\)/);
});

test("new claim disposition claimed then sent end-to-end with one fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  const rowAfterClaim = claimedRow("attempt-1", 1);
  const rowAfterSent = {
    ...rowAfterClaim,
    status: "sent",
    terminal: true,
    retryEligible: false,
    sentAt: "2026-07-30T01:01:00.000Z",
  };

  let fetchCount = 0;
  let claimArgs = null;
  let recordArgs = null;
  let resolverArgs = null;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: { query: async () => ({ rows: [] }) },
    resolvePageAccessCredentials: async (args) => {
      resolverArgs = args;
      return {
        ok: true,
        pageAccessToken: "secret-token-value",
        graphApiVersion: "v19.0",
      };
    },
    claimDispatch: async (input) => {
      claimArgs = input;
      return {
        ok: true,
        status: "claimed",
        claimed: true,
        existing: false,
        row: rowAfterClaim,
      };
    },
    recordDispatchResult: async (input) => {
      recordArgs = input;
      return {
        ok: true,
        status: "sent",
        outcome: "sent",
        recorded: true,
        existing: false,
        row: rowAfterSent,
      };
    },
    buildRequest: (input) => ({
      ok: true,
      request: {
        method: "POST",
        url: `https://graph.facebook.com/${input.graphApiVersion}/${input.providerAccountId}/messages`,
        headers: { "Content-Type": "application/json" },
        body: {
          recipient: { id: input.recipientId },
          messaging_type: "RESPONSE",
          message: { text: "Backstage clip\nhttps://rewards.example/clip-123" },
        },
        timeoutMs: 10_000,
        safeMeta: {},
      },
    }),
    executeSend: async () => {
      fetchCount += 1;
      return {
        ok: true,
        outcome: "sent",
        provider: "meta",
        channel: "messenger",
        httpStatus: 200,
        providerMessageId: "mid.provider-1",
        retryable: false,
        terminal: true,
        failureCode: null,
        safeMetadata: { durationMs: 12 },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "sent");
  assert.equal(result.claimDisposition, "claimed");
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.attemptId, "attempt-1");
  assert.equal(result.providerAccepted, true);
  assert.equal(result.dispatchRecorded, true);
  assert.equal(result.retryable, false);
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.providerMessageId, "mid.provider-1");
  assert.equal(fetchCount, 1);
  assert.equal(claimArgs.attemptId, "attempt-1");
  assert.equal(claimArgs.outboundId, 7);
  assert.equal(recordArgs.attemptId, "attempt-1");
  assert.equal(recordArgs.attemptNumber, 1);
  assert.equal(recordArgs.outcome, "sent");
  assert.equal(Object.hasOwn(recordArgs, "providerMessageId"), false);
  assert.equal(resolverArgs.providerAccountId, "page-123456789");
  assertSecretFree(result);
});

test("existing claim disposition is visible and may continue recovery send", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  const row = claimedRow("attempt-1", 2);
  let fetchCount = 0;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "existing",
      claimed: false,
      existing: true,
      row,
    }),
    recordDispatchResult: async (input) => ({
      ok: true,
      status: "sent",
      outcome: "sent",
      recorded: true,
      row: { ...row, status: "sent", terminal: true, sentAt: "2026-07-30T02:00:00.000Z" },
    }),
    buildRequest: () => ({
      ok: true,
      request: {
        method: "POST",
        url: "https://graph.facebook.com/v19.0/page-123456789/messages",
        headers: { "Content-Type": "application/json" },
        body: { recipient: { id: "psid" }, messaging_type: "RESPONSE", message: { text: "x" } },
        timeoutMs: 10_000,
      },
    }),
    executeSend: async () => {
      fetchCount += 1;
      return {
        ok: true,
        outcome: "sent",
        provider: "meta",
        channel: "messenger",
        httpStatus: 200,
        providerMessageId: "mid.existing",
        retryable: false,
        terminal: true,
        failureCode: null,
        safeMetadata: {},
      };
    },
  });

  assert.equal(result.claimDisposition, "existing");
  assert.equal(result.attemptNumber, 2);
  assert.equal(result.outcome, "sent");
  assert.equal(fetchCount, 1);
  assert.notEqual(result.claimDisposition, "claimed");
});

test("not_acquired claim skips credentials builder transport and record", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;
  let resolverCalled = false;
  let buildCalled = false;
  let recordCalled = false;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-other",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => {
      resolverCalled = true;
      return { ok: true, pageAccessToken: "x", graphApiVersion: "v19.0" };
    },
    claimDispatch: async () => ({
      ok: false,
      status: "conflict",
      reason: "ACTIVE_CLAIM_NOT_STALE",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async () => {
      recordCalled = true;
      return { ok: true };
    },
    buildRequest: () => {
      buildCalled = true;
      return { ok: true, request: {} };
    },
    executeSend: async () => {
      fetchCount += 1;
      return { ok: true, outcome: "sent", providerMessageId: "mid" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "claim_conflict");
  assert.equal(result.claimDisposition, "not_acquired");
  assertNoAttemptNumber(result);
  assert.equal(result.attemptId, "attempt-other");
  assert.equal(result.providerAccepted, false);
  assert.equal(result.dispatchRecorded, false);
  assert.equal(fetchCount, 0);
  assert.equal(resolverCalled, false);
  assert.equal(buildCalled, false);
  assert.equal(recordCalled, false);
});

test("already sent and terminal claims are not_acquired without fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();

  for (const reason of ["DISPATCH_NOT_CLAIMABLE"]) {
    let fetchCount = 0;
    const result = await dispatchCodeClipMetaMessengerOutbound({
      outboundId: 7,
      attemptId: "attempt-1",
      staleAfterSeconds: 300,
      queryClient: {},
      resolvePageAccessCredentials: async () => ({
        ok: true,
        pageAccessToken: "secret",
        graphApiVersion: "v19.0",
      }),
      claimDispatch: async () => ({
        ok: false,
        status: "conflict",
        reason,
        details: { status: "sent" },
        row: baseOutboundRow({ status: "sent", attemptCount: 1, terminal: true, retryEligible: false }),
      }),
      executeSend: async () => {
        fetchCount += 1;
        return { ok: true, outcome: "sent", providerMessageId: "mid" };
      },
    });
    assert.equal(result.claimDisposition, "not_acquired", reason);
    assertNoAttemptNumber(result);
    assert.equal(fetchCount, 0, reason);
  }
});

test("credentials missing records terminal failure without fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;
  let recordArgs = null;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: false,
      reason: "CREDENTIALS_UNAVAILABLE",
      retryable: false,
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "claimed",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async (input) => {
      recordArgs = input;
      return {
        ok: true,
        status: "failed",
        outcome: "terminal_failed",
        recorded: true,
        row: { ...claimedRow("attempt-1", 1), status: "terminal_failed", terminal: true },
      };
    },
    executeSend: async () => {
      fetchCount += 1;
      return { ok: true, outcome: "sent", providerMessageId: "mid" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "credentials_failed");
  assert.equal(result.claimDisposition, "claimed");
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.dispatchRecorded, true);
  assert.equal(result.providerAccepted, false);
  assert.equal(fetchCount, 0);
  assert.equal(recordArgs.outcome, "terminal_failed");
  assert.equal(recordArgs.failureCode, "credentials_unavailable");
  assert.equal(Object.hasOwn(recordArgs, "providerMessageId"), false);
  assertSecretFree(result);
});

test("resolver throw records retryable credentials failure without fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;
  let recordArgs = null;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => {
      throw new Error("vault down");
    },
    claimDispatch: async () => ({
      ok: true,
      status: "claimed",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async (input) => {
      recordArgs = input;
      return {
        ok: true,
        status: "failed",
        outcome: "retryable_failed",
        recorded: true,
        row: { ...claimedRow("attempt-1", 1), status: "retryable_failed", retryEligible: true },
      };
    },
    executeSend: async () => {
      fetchCount += 1;
      return { ok: true, outcome: "sent", providerMessageId: "mid" };
    },
  });

  assert.equal(result.outcome, "credentials_failed");
  assert.equal(result.retryable, true);
  assert.equal(fetchCount, 0);
  assert.equal(recordArgs.outcome, "retryable_failed");
  assert.equal(recordArgs.failureCode, "credentials_resolver_error");
});

test("builder failure records terminal without fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;
  let recordArgs = null;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "claimed",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async (input) => {
      recordArgs = input;
      return {
        ok: true,
        status: "failed",
        outcome: "terminal_failed",
        recorded: true,
        row: { ...claimedRow("attempt-1", 1), status: "terminal_failed", terminal: true },
      };
    },
    buildRequest: () => ({ ok: false, reason: "DELIVERABLE_TYPE_UNSUPPORTED" }),
    executeSend: async () => {
      fetchCount += 1;
      return { ok: true, outcome: "sent", providerMessageId: "mid" };
    },
  });

  assert.equal(result.outcome, "builder_failed");
  assert.equal(result.claimDisposition, "claimed");
  assert.equal(fetchCount, 0);
  assert.equal(recordArgs.outcome, "terminal_failed");
  assert.equal(recordArgs.failureCode, "deliverable_type_unsupported");
});

test("transport retryable and terminal failures are recorded with allowlisted metadata", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();

  async function runTransport(outcome, failureCode, safeMetadata) {
    let recordArgs = null;
    const result = await dispatchCodeClipMetaMessengerOutbound({
      outboundId: 7,
      attemptId: "attempt-1",
      staleAfterSeconds: 300,
      queryClient: {},
      resolvePageAccessCredentials: async () => ({
        ok: true,
        pageAccessToken: "secret-token-value",
        graphApiVersion: "v19.0",
      }),
      claimDispatch: async () => ({
        ok: true,
        status: "claimed",
        row: claimedRow("attempt-1", 1),
      }),
      recordDispatchResult: async (input) => {
        recordArgs = input;
        return {
          ok: true,
          status: "failed",
          outcome,
          recorded: true,
          row: {
            ...claimedRow("attempt-1", 1),
            status: outcome,
            retryEligible: outcome === "retryable_failed",
            terminal: outcome !== "retryable_failed",
          },
        };
      },
      buildRequest: () => ({
        ok: true,
        request: {
          method: "POST",
          url: "https://graph.facebook.com/v19.0/page/messages",
          headers: { "Content-Type": "application/json" },
          body: { recipient: { id: "x" }, messaging_type: "RESPONSE", message: { text: "t" } },
          timeoutMs: 1000,
        },
      }),
      executeSend: async () => ({
        ok: false,
        outcome,
        provider: "meta",
        channel: "messenger",
        httpStatus: outcome === "retryable_failed" ? 429 : 400,
        providerMessageId: null,
        retryable: outcome === "retryable_failed",
        terminal: outcome !== "retryable_failed",
        failureCode,
        safeMetadata,
      }),
    });
    return { result, recordArgs };
  }

  const retryable = await runTransport("retryable_failed", "graph_rate_limited", {
    httpStatus: 429,
    retryAfterSeconds: 30,
    durationMs: 5,
    metaErrorCode: 4,
  });
  assert.equal(retryable.result.outcome, "retryable_failed");
  assert.equal(retryable.result.dispatchRecorded, true);
  assert.equal(retryable.recordArgs.outcome, "retryable_failed");
  assert.equal(retryable.recordArgs.failureCode, "graph_rate_limited");
  assert.equal(retryable.recordArgs.failureMetadata.retryAfterSeconds, 30);
  assert.equal(Object.hasOwn(retryable.recordArgs, "providerMessageId"), false);

  const terminal = await runTransport("terminal_failed", "graph_success_unconfirmed", {
    durationMs: 3,
  });
  assert.equal(terminal.result.outcome, "terminal_failed");
  assert.equal(terminal.recordArgs.failureCode, "graph_success_unconfirmed");
  assert.equal(terminal.result.providerAccepted, false);
});

test("provider success with record failure durable-holds via provider_sent_unconfirmed without second send", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;
  const recordCalls = [];

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "existing",
      row: claimedRow("attempt-1", 3),
    }),
    recordDispatchResult: async (input) => {
      recordCalls.push(input);
      if (input.outcome === "sent") {
        return {
          ok: false,
          status: "conflict",
          reason: "DISPATCH_RECORD_RACE",
          row: claimedRow("attempt-1", 3),
        };
      }
      assert.equal(input.outcome, "provider_sent_unconfirmed");
      assert.equal(Object.hasOwn(input, "providerMessageId"), false);
      return {
        ok: true,
        status: "provider_sent_unconfirmed",
        outcome: "provider_sent_unconfirmed",
        recorded: true,
        row: {
          ...claimedRow("attempt-1", 3),
          status: "provider_sent_unconfirmed",
          retryEligible: false,
          terminal: false,
          nextAttemptAt: null,
          lastErrorCode: "provider_sent_unconfirmed",
        },
      };
    },
    buildRequest: () => ({
      ok: true,
      request: {
        method: "POST",
        url: "https://graph.facebook.com/v19.0/page/messages",
        headers: { "Content-Type": "application/json" },
        body: { recipient: { id: "x" }, messaging_type: "RESPONSE", message: { text: "t" } },
        timeoutMs: 1000,
      },
    }),
    executeSend: async () => {
      fetchCount += 1;
      return {
        ok: true,
        outcome: "sent",
        provider: "meta",
        channel: "messenger",
        httpStatus: 200,
        providerMessageId: "mid.unconfirmed",
        retryable: false,
        terminal: true,
        failureCode: null,
        safeMetadata: { durationMs: 9 },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "provider_sent_record_unconfirmed");
  assert.equal(result.claimDisposition, "existing");
  assert.equal(result.attemptNumber, 3);
  assert.equal(result.providerAccepted, true);
  assert.equal(result.dispatchRecorded, false);
  assert.equal(result.durableHold, true);
  assert.equal(result.retryable, false);
  assert.equal(result.manualReviewRequired, false);
  assert.equal(result.providerMessageId, "mid.unconfirmed");
  assert.equal(fetchCount, 1);
  assert.equal(recordCalls.length, 2);
  assert.equal(result.row.status, "provider_sent_unconfirmed");
  assertSecretFree(result);
});

test("provider success with sent and unconfirmed record both failing sets durableHold false", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "claimed",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async () => ({
      ok: false,
      status: "conflict",
      reason: "DISPATCH_RECORD_RACE",
    }),
    buildRequest: () => ({
      ok: true,
      request: {
        method: "POST",
        url: "https://graph.facebook.com/v19.0/page/messages",
        headers: { "Content-Type": "application/json" },
        body: { recipient: { id: "x" }, messaging_type: "RESPONSE", message: { text: "t" } },
        timeoutMs: 1000,
      },
    }),
    executeSend: async () => {
      fetchCount += 1;
      return {
        ok: true,
        outcome: "sent",
        provider: "meta",
        channel: "messenger",
        httpStatus: 200,
        providerMessageId: "mid.x",
        retryable: false,
        terminal: true,
        failureCode: null,
        safeMetadata: {},
      };
    },
  });

  assert.equal(result.outcome, "provider_sent_record_unconfirmed");
  assert.equal(result.durableHold, false);
  assert.equal(result.manualReviewRequired, true);
  assert.equal(fetchCount, 1);
});

test("record conflict on non-success path does not resend", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    queryClient: {},
    resolvePageAccessCredentials: async () => ({
      ok: true,
      pageAccessToken: "secret-token-value",
      graphApiVersion: "v19.0",
    }),
    claimDispatch: async () => ({
      ok: true,
      status: "claimed",
      row: claimedRow("attempt-1", 1),
    }),
    recordDispatchResult: async () => ({
      ok: false,
      status: "conflict",
      reason: "DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH",
    }),
    buildRequest: () => ({
      ok: true,
      request: {
        method: "POST",
        url: "https://graph.facebook.com/v19.0/page/messages",
        headers: { "Content-Type": "application/json" },
        body: { recipient: { id: "x" }, messaging_type: "RESPONSE", message: { text: "t" } },
        timeoutMs: 1000,
      },
    }),
    executeSend: async () => {
      fetchCount += 1;
      return {
        ok: false,
        outcome: "retryable_failed",
        provider: "meta",
        channel: "messenger",
        httpStatus: 0,
        providerMessageId: null,
        retryable: true,
        terminal: false,
        failureCode: "graph_network_error",
        safeMetadata: {},
      };
    },
  });

  assert.equal(result.outcome, "record_conflict");
  assert.equal(result.dispatchRecorded, false);
  assert.equal(result.providerAccepted, false);
  assert.equal(fetchCount, 1);
});

test("mapper never forwards providerMessageId into dispatch record payload", () => {
  const { mapMetaMessengerTransportResultToDispatchRecord } = loadOrchestration();
  const mapped = mapMetaMessengerTransportResultToDispatchRecord({
    ok: true,
    outcome: "sent",
    httpStatus: 200,
    providerMessageId: "mid.secretish",
    failureCode: null,
    safeMetadata: { durationMs: 1 },
  });
  assert.equal(mapped.outcome, "sent");
  assert.equal(Object.hasOwn(mapped, "providerMessageId"), false);
  assert.equal(Object.hasOwn(mapped, "failureCode"), false);

  const failed = mapMetaMessengerTransportResultToDispatchRecord({
    ok: false,
    outcome: "retryable_failed",
    httpStatus: 429,
    providerMessageId: null,
    failureCode: "graph_rate_limited",
    safeMetadata: {
      retryAfterSeconds: 10,
      durationMs: 2,
      metaErrorCode: 4,
      recipientId: "should-strip",
      rawBody: "should-strip",
    },
  });
  assert.equal(failed.outcome, "retryable_failed");
  assert.equal(failed.failureCode, "graph_rate_limited");
  assert.equal(failed.failureMetadata.retryAfterSeconds, 10);
  assert.equal(Object.hasOwn(failed.failureMetadata, "recipientId"), false);
  assert.equal(Object.hasOwn(failed.failureMetadata, "rawBody"), false);
  assert.equal(Object.hasOwn(failed, "providerMessageId"), false);
});

test("missing required dependencies fail closed without fetch", async () => {
  const { dispatchCodeClipMetaMessengerOutbound } = loadOrchestration();
  let fetchCount = 0;

  const result = await dispatchCodeClipMetaMessengerOutbound({
    outboundId: 7,
    attemptId: "attempt-1",
    staleAfterSeconds: 300,
    // no queryClient, no resolver
    claimDispatch: async () => {
      throw new Error("should not claim");
    },
    executeSend: async () => {
      fetchCount += 1;
      return { ok: true, outcome: "sent", providerMessageId: "mid" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.claimDisposition, "not_acquired");
  assertNoAttemptNumber(result);
  assert.equal(fetchCount, 0);
});
