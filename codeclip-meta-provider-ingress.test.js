const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createRedisStub } = require("./test-helpers/redis-stub");

const previousRedisUrl = process.env.REDIS_URL;
const previousMetaSecret = process.env.CODECLIP_META_WEBHOOK_SECRET;
const previousPostLimit = process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT;
const previousPreLimit = process.env.CODECLIP_META_PROVIDER_PRE_RATE_LIMIT;

process.env.REDIS_URL = "redis://codeclip-meta-provider-test";
process.env.CODECLIP_META_WEBHOOK_SECRET = "codeclip-meta-route-secret";
process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT = "2";
process.env.CODECLIP_META_PROVIDER_PRE_RATE_LIMIT = "100";

const redis = createRedisStub();
const redisModulePath = require.resolve("./redis");
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: redis,
};

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const providerDeliveries = new Map();
const providerDeliveryCalls = [];

function providerDeliveryKey(identity = {}) {
  return [
    String(identity.provider || "").trim().toLowerCase(),
    String(identity.providerAccountId || identity.provider_account_id || "").trim(),
    String(identity.eventCode || identity.event_code || "").trim(),
    String(identity.externalMessageId || identity.external_message_id || "").trim(),
  ].join("|");
}

function resetProviderDeliveryLedger() {
  providerDeliveries.clear();
  providerDeliveryCalls.length = 0;
  createCodeClipProviderDeliveryStub.fail = false;
  updateCodeClipProviderDeliveryStateStub.fail = false;
}

function createProviderDeliveryRow(delivery = {}) {
  return {
    provider: String(delivery.provider || "").trim().toLowerCase(),
    providerAccountId: String(delivery.providerAccountId || "").trim(),
    eventCode: String(delivery.eventCode || "").trim(),
    eventId: delivery.eventId || null,
    externalMessageId: String(delivery.externalMessageId || "").trim(),
    idempotencyKey: delivery.idempotencyKey || null,
    payloadFingerprint: delivery.payloadFingerprint || null,
    verificationState: delivery.verificationState || "verified",
    processingState: delivery.processingState || "processing",
    attemptCount: 1,
    corePersistenceState: delivery.corePersistenceState || "not_started",
    completionState: delivery.completionState || "not_completed",
    responseStatus: null,
    publicResponseJson: null,
    errorClass: null,
    retryEligible: false,
    terminalState: false,
  };
}

async function createCodeClipProviderDeliveryStub(delivery = {}) {
  providerDeliveryCalls.push({ method: "create", delivery });
  if (createCodeClipProviderDeliveryStub.fail) {
    return {
      status: "failed",
      created: false,
      existing: false,
      row: null,
      error: new Error("forced provider delivery create failure"),
    };
  }

  const key = providerDeliveryKey(delivery);
  const existing = providerDeliveries.get(key);
  if (existing) {
    return { status: "existing", created: false, existing: true, row: existing };
  }

  const row = createProviderDeliveryRow(delivery);
  providerDeliveries.set(key, row);
  return { status: "created", created: true, existing: false, row };
}

async function updateCodeClipProviderDeliveryStateStub(identity = {}, updates = {}) {
  providerDeliveryCalls.push({ method: "update", identity, updates });
  if (updateCodeClipProviderDeliveryStateStub.fail) {
    return {
      status: "failed",
      row: null,
      error: new Error("forced provider delivery update failure"),
    };
  }

  const row = providerDeliveries.get(providerDeliveryKey(identity));
  if (!row) return { status: "not_found", row: null };

  Object.assign(row, updates);
  return { status: "updated", row };
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    createCodeClipProviderDelivery: createCodeClipProviderDeliveryStub,
    updateCodeClipProviderDeliveryState: updateCodeClipProviderDeliveryStateStub,
  },
};

const { after } = require("node:test");
const { app } = require("./server");
const codeClipVertical = require("./verticals/codeclip");
const {
  buildProviderKeywordIdempotencyKey,
  getProviderKeywordResponseKey,
} = require("./verticals/codeclip/provider-idempotency");

after(() => {
  restoreEnv("REDIS_URL", previousRedisUrl);
  restoreEnv("CODECLIP_META_WEBHOOK_SECRET", previousMetaSecret);
  restoreEnv("CODECLIP_META_PROVIDER_POST_RATE_LIMIT", previousPostLimit);
  restoreEnv("CODECLIP_META_PROVIDER_PRE_RATE_LIMIT", previousPreLimit);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withTestServer(run) {
  resetProviderDeliveryLedger();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
    listeningServer.on("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function committedPersistenceInternal() {
  return {
    persistenceStatus: {
      interaction: { attempted: true, ok: true, error: null, committed: true },
      rewardAssignments: { attempted: false, ok: null, error: null, skipped: true },
      clipXtraRedemption: { attempted: false, ok: null, error: null, skipped: true },
    },
    persistenceDecision: { ok: true, severity: "ok", failedSteps: [], criticalFailures: [] },
  };
}

function criticalPersistenceInternal() {
  return {
    persistenceStatus: {
      interaction: { attempted: true, ok: false, error: "forced failure", committed: false },
      rewardAssignments: { attempted: false, ok: null, error: null, skipped: true },
      clipXtraRedemption: { attempted: false, ok: null, error: null, skipped: true },
    },
    persistenceDecision: {
      ok: false,
      severity: "critical",
      failedSteps: ["interaction"],
      criticalFailures: ["interaction"],
    },
    persistenceAction: {
      action: "continue_with_internal_error_marker",
      reason: "persistence_critical",
    },
    persistenceGuaranteePolicy: {
      severity: "critical",
      reason: "persistence_critical",
    },
  };
}

function signMetaBody(rawBody, secret = process.env.CODECLIP_META_WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function metaHeaders(rawBody) {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${signMetaBody(rawBody)}`,
  };
}

function metaBody({ messageId, accountId, senderId = "sender-1", text = " vip " }) {
  return JSON.stringify({
    entry: [
      {
        id: accountId,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: accountId },
            message: {
              mid: messageId,
              text,
            },
          },
        ],
      },
    ],
  });
}

async function createCodeClipMetaEvent(baseUrl, { accountId, keyword = "VIP" }) {
  const code = `CC-META-${Date.now()}-${Math.random().toString(16).slice(2)}`.toUpperCase();
  const response = await fetch(`${baseUrl}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vertical: "codeclip",
      code,
      name: "codeClip Meta provider ingress test",
      startAt: "2099-01-01T10:00:00.000Z",
      unlockAt: "2099-01-01T10:00:00.000Z",
      endAt: "2099-01-01T11:00:00.000Z",
      activationMethod: "keyword",
      activationKeyword: keyword,
      activationChannels: ["Messenger"],
      providerAccountIds: [accountId],
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip",
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  return code;
}

function assertNoProviderInternals(payload) {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const term of [
    "secret",
    "signature",
    "rawbody",
    "x-hub-signature-256",
    "verificationmode",
    "audienceentry",
    "audienceintent",
    "routingoutcome",
    "rewardassignmentsnapshot",
    "internal",
    "persistencedecision",
    "persistenceaction",
    "persistenceguaranteepolicy",
    "sql",
    "database",
    "codepod",
    "codetone",
  ]) {
    assert.equal(serialized.includes(term), false);
  }
}

async function withPatchedKeywordRuntime(handler, run) {
  const originalHandler = codeClipVertical.service.handleCodeClipKeywordEntry;
  codeClipVertical.service.handleCodeClipKeywordEntry = handler;

  try {
    await run();
  } finally {
    codeClipVertical.service.handleCodeClipKeywordEntry = originalHandler;
  }
}

test("signed Meta request reaches existing codeClip provider runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-valid-${Date.now()}`;
    const keyword = `VALID-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-valid-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeInput = null;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeInput = input;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {
        success: true,
        eventCode: code,
        messageId: runtimeInput.messageId,
      });
      assert.equal(runtimeInput.eventCode, code);
      assert.equal(runtimeInput.keyword, keyword);
      assert.match(runtimeInput.messageId, /^meta-valid-/);
      assertNoProviderInternals(payload);

      const delivery = Array.from(providerDeliveries.values()).find(
        (row) => row.externalMessageId === runtimeInput.messageId
      );
      assert.ok(delivery);
      assert.equal(delivery.provider, "meta");
      assert.equal(delivery.providerAccountId, accountId);
      assert.equal(delivery.eventCode, code);
      assert.equal(delivery.processingState, "completed");
      assert.equal(delivery.corePersistenceState, "committed");
      assert.equal(delivery.completionState, "completed");
      assert.equal(delivery.responseStatus, 200);
      assert.deepEqual(delivery.publicResponseJson, payload);
      assert.equal(
        delivery.payloadFingerprint,
        crypto.createHash("sha256").update(rawBody).digest("hex")
      );
    });
  });
});

test("invalid Meta signature does not create a durable provider delivery", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-invalid-signature-${Date.now()}`;
    const keyword = `BADSIG-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-invalid-signature-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      ok: false,
      error: "Invalid provider keyword payload",
    });
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
    assertNoProviderInternals(payload);
  });
});

test("completed duplicate Meta delivery reuses stored public response", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-duplicate-${Date.now()}`;
    const keyword = `DUPLICATE-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-duplicate-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const firstPayload = await first.json();
      const secondPayload = await second.json();

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(secondPayload, firstPayload);
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
      assert.equal(
        providerDeliveryCalls.filter((call) => call.method === "create").length,
        2
      );
      assert.ok(
        providerDeliveryCalls.some(
          (call) =>
            call.method === "update" &&
            call.updates.completionState === "completed" &&
            call.updates.publicResponseJson
        )
      );
    });
  });
});

test("Redis replay has priority when durable PostgreSQL replay also exists", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-redis-priority-${Date.now()}`;
    const keyword = `REDISPRIORITY-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-redis-priority-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const firstPayload = await first.json();
      assert.equal(first.status, 200);

      const delivery = providerDeliveries.get(providerDeliveryKey({
        provider: "meta",
        providerAccountId: accountId,
        eventCode: code,
        externalMessageId: messageId,
      }));
      assert.ok(delivery);
      delivery.publicResponseJson = { shouldNotReplay: true };
      delivery.responseStatus = 202;

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 200);
      assert.deepEqual(secondPayload, firstPayload);
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
    });
  });
});

test("Redis replay without durable committed core state fails closed", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-replay-no-commit-${Date.now()}`;
    const keyword = `REPLAYNOCOMMIT-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-replay-no-commit-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });

    await withPatchedKeywordRuntime(async (input) => ({
      httpStatus: 200,
      payload: {
        success: true,
        eventCode: input.eventCode,
        messageId: input.messageId,
      },
      internal: committedPersistenceInternal(),
    }), async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      assert.equal(first.status, 200);

      const delivery = providerDeliveries.get(providerDeliveryKey({
        provider: "meta",
        providerAccountId: accountId,
        eventCode: code,
        externalMessageId: messageId,
      }));
      assert.ok(delivery);
      delivery.corePersistenceState = "processing";
      delivery.completionState = "not_completed";

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 503);
      assert.deepEqual(secondPayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assertNoProviderInternals(secondPayload);
      assert.notDeepEqual(secondPayload, await first.json().catch(() => null));
    });
  });
});

test("durable completed delivery without Redis replay returns PostgreSQL replay and repairs cache", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-completed-no-replay-${Date.now()}`;
    const keyword = `COMPLETEDREPLAY-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-completed-no-replay-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    const originalPostLimit = process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT;
    let runtimeCalls = 0;

    process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT = "3";
    try {
      await withPatchedKeywordRuntime(async (input) => {
        runtimeCalls += 1;
        return {
          httpStatus: 200,
          payload: {
            success: true,
            eventCode: input.eventCode,
            messageId: input.messageId,
          },
          internal: committedPersistenceInternal(),
        };
      }, async () => {
        const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
          method: "POST",
          headers: metaHeaders(rawBody),
          body: rawBody,
        });
        const firstPayload = await first.json();
        assert.equal(first.status, 200);
        assert.equal(runtimeCalls, 1);

        await redis.del(getProviderKeywordResponseKey(idempotencyKey));
        assert.equal(await redis.get(getProviderKeywordResponseKey(idempotencyKey)), null);

        const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
          method: "POST",
          headers: metaHeaders(rawBody),
          body: rawBody,
        });
        const secondPayload = await second.json();

        assert.equal(second.status, 200);
        assert.deepEqual(secondPayload, firstPayload);
        assert.equal(runtimeCalls, 1);
        assertNoProviderInternals(secondPayload);
        assert.deepEqual(
          JSON.parse(await redis.get(getProviderKeywordResponseKey(idempotencyKey))),
          firstPayload
        );

        const third = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
          method: "POST",
          headers: metaHeaders(rawBody),
          body: rawBody,
        });
        const thirdPayload = await third.json();

        assert.equal(third.status, 200);
        assert.deepEqual(thirdPayload, firstPayload);
        assert.equal(runtimeCalls, 1);
      });
    } finally {
      if (originalPostLimit === undefined) {
        delete process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT;
      } else {
        process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT = originalPostLimit;
      }
    }
  });
});

test("durable committed but incomplete delivery without Redis replay fails closed", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-commit-not-completed-${Date.now()}`;
    const keyword = `NOTCOMPLETED-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-commit-not-completed-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      assert.equal(first.status, 200);

      const delivery = providerDeliveries.get(providerDeliveryKey({
        provider: "meta",
        providerAccountId: accountId,
        eventCode: code,
        externalMessageId: messageId,
      }));
      assert.ok(delivery);
      delivery.completionState = "not_completed";
      delivery.terminalState = false;
      await redis.del(getProviderKeywordResponseKey(idempotencyKey));

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 503);
      assert.deepEqual(secondPayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
    });
  });
});

test("durable completed delivery without public response fails closed", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-completed-no-payload-${Date.now()}`;
    const keyword = `NOPAYLOAD-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-completed-no-payload-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      assert.equal(first.status, 200);

      const delivery = providerDeliveries.get(providerDeliveryKey({
        provider: "meta",
        providerAccountId: accountId,
        eventCode: code,
        externalMessageId: messageId,
      }));
      assert.ok(delivery);
      delivery.publicResponseJson = null;
      await redis.del(getProviderKeywordResponseKey(idempotencyKey));

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 503);
      assert.deepEqual(secondPayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
    });
  });
});

test("durable completed delivery with invalid response status fails closed", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-completed-bad-status-${Date.now()}`;
    const keyword = `BADSTATUS-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-completed-bad-status-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 200,
        payload: {
          success: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      assert.equal(first.status, 200);

      const delivery = providerDeliveries.get(providerDeliveryKey({
        provider: "meta",
        providerAccountId: accountId,
        eventCode: code,
        externalMessageId: messageId,
      }));
      assert.ok(delivery);
      delivery.responseStatus = "200";
      await redis.del(getProviderKeywordResponseKey(idempotencyKey));

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 503);
      assert.deepEqual(secondPayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
    });
  });
});

test("durable completed delivery replays stored non-200 2xx status", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-completed-202-${Date.now()}`;
    const keyword = `REPLAY202-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-completed-202-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    let runtimeCalls = 0;

    await withPatchedKeywordRuntime(async (input) => {
      runtimeCalls += 1;
      return {
        httpStatus: 202,
        payload: {
          accepted: true,
          eventCode: input.eventCode,
          messageId: input.messageId,
        },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const firstPayload = await first.json();
      assert.equal(first.status, 202);

      await redis.del(getProviderKeywordResponseKey(idempotencyKey));

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 202);
      assert.deepEqual(secondPayload, firstPayload);
      assert.equal(runtimeCalls, 1);
      assertNoProviderInternals(secondPayload);
    });
  });
});

test("Meta post-verification rate limit is provider-account scoped", async () => {
  await withTestServer(async (baseUrl) => {
    const accountA = `page-rate-a-${Date.now()}`;
    const accountB = `page-rate-b-${Date.now()}`;
    const keywordA = `RATEA-${Date.now()}`;
    const keywordB = `RATEB-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId: accountA, keyword: keywordA });
    await createCodeClipMetaEvent(baseUrl, { accountId: accountB, keyword: keywordB });

    await withPatchedKeywordRuntime(async (input) => ({
      httpStatus: 200,
      payload: {
        success: true,
        eventCode: input.eventCode,
        messageId: input.messageId,
      },
      internal: committedPersistenceInternal(),
    }), async () => {
      for (const senderId of ["sender-a", "sender-b"]) {
        const rawBody = metaBody({
          messageId: `meta-rate-a-${senderId}-${Date.now()}`,
          accountId: accountA,
          senderId,
          text: keywordA,
        });
        const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
          method: "POST",
          headers: metaHeaders(rawBody),
          body: rawBody,
        });
        assert.equal(response.status, 200);
      }

      const limitedBody = metaBody({
        messageId: `meta-rate-a-third-${Date.now()}`,
        accountId: accountA,
        senderId: "sender-c",
        text: keywordA,
      });
      const limited = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(limitedBody),
        body: limitedBody,
      });
      const limitedPayload = await limited.json();

      assert.equal(limited.status, 429);
      assert.deepEqual(limitedPayload, {
        ok: false,
        error: "Too many requests. Please try again shortly.",
      });
      assertNoProviderInternals(limitedPayload);

      const accountBBody = metaBody({
        messageId: `meta-rate-b-${Date.now()}`,
        accountId: accountB,
        text: keywordB,
      });
      const accountBResponse = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(accountBBody),
        body: accountBBody,
      });

      assert.equal(accountBResponse.status, 200);
    });
  });
});

test("verified Meta payload without provider account is rejected before runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      messageId: `meta-missing-account-${Date.now()}`,
      text: "VIP",
      sender: { id: "sender-only" },
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      ok: false,
      error: "Invalid provider keyword payload",
    });
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
    assertNoProviderInternals(payload);
  });
});

test("Meta payload without matching activation does not create a durable provider delivery", async () => {
  await withTestServer(async (baseUrl) => {
    const boundAccountId = `page-bound-${Date.now()}`;
    const unboundAccountId = `page-unbound-${Date.now()}`;
    const keyword = `UNBOUND-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId: boundAccountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-unbound-${Date.now()}`,
      accountId: unboundAccountId,
      text: `NO-MATCH-${Date.now()}`,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(payload, {
      ok: false,
      error: "Event not found",
      reason: "NO_MATCH",
    });
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
    assertNoProviderInternals(payload);
  });
});

test("durable provider delivery create failure stops live Meta before runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-ledger-create-fail-${Date.now()}`;
    const keyword = `LEDGERFAIL-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-ledger-create-fail-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeCalled = false;
    createCodeClipProviderDeliveryStub.fail = true;

    await withPatchedKeywordRuntime(async () => {
      runtimeCalled = true;
      return {
        httpStatus: 200,
        payload: { success: true },
        internal: committedPersistenceInternal(),
      };
    }, async () => {
      const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const payload = await response.json();

      assert.equal(response.status, 503);
      assert.deepEqual(payload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assert.equal(runtimeCalled, false);
      assertNoProviderInternals(payload);
    });
  });
});

test("live Meta critical persistence failure returns public-safe 503 without completion", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-critical-${Date.now()}`;
    const keyword = `CRITICAL-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `meta-critical-${Date.now()}`;
    const rawBody = metaBody({
      messageId,
      accountId,
      text: keyword,
    });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    const originalHandler = codeClipVertical.service.handleCodeClipKeywordEntry;

    codeClipVertical.service.handleCodeClipKeywordEntry = async () => ({
      httpStatus: 200,
      payload: {
        success: true,
        eventCode: code,
        messageId,
        persistenceDecision: { severity: "critical" },
        internal: { leaked: true },
      },
      internal: criticalPersistenceInternal(),
    });

    try {
      const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const firstPayload = await first.json();

      assert.equal(first.status, 503);
      assert.deepEqual(firstPayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
      });
      assertNoProviderInternals(firstPayload);
      assert.equal(await redis.get(getProviderKeywordResponseKey(idempotencyKey)), null);
      assert.equal(await redis.get(idempotencyKey), "processing");

      const duplicate = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const duplicatePayload = await duplicate.json();

      assert.equal(duplicate.status, 202);
      assert.deepEqual(duplicatePayload, {
        ok: false,
        duplicate: true,
        status: "processing",
        eventCode: code,
        messageId,
      });
      assertNoProviderInternals(duplicatePayload);
      assert.equal(await redis.get(getProviderKeywordResponseKey(idempotencyKey)), null);
    } finally {
      codeClipVertical.service.handleCodeClipKeywordEntry = originalHandler;
      await redis.del(idempotencyKey);
      await redis.del(getProviderKeywordResponseKey(idempotencyKey));
    }
  });
});

test("non-live provider flow is not failed closed by critical internal persistence metadata", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `test-provider-${Date.now()}`;
    const keyword = `TESTLIVE-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const messageId = `test-provider-critical-${Date.now()}`;
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "test",
      eventCode: code,
      messageId,
    });
    const originalHandler = codeClipVertical.service.handleCodeClipKeywordEntry;

    codeClipVertical.service.handleCodeClipKeywordEntry = async () => ({
      httpStatus: 200,
      payload: {
        success: true,
        eventCode: code,
        messageId,
      },
      internal: {
        persistenceDecision: {
          ok: false,
          severity: "critical",
          failedSteps: ["interaction"],
          criticalFailures: ["interaction"],
        },
      },
    });

    try {
      const response = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codeclip-test-signature": "valid",
        },
        body: JSON.stringify({
          eventCode: code,
          text: keyword,
          messageId,
          providerAccountId: accountId,
        }),
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(payload, {
        success: true,
        eventCode: code,
        messageId,
      });
      assertNoProviderInternals(payload);
      assert.deepEqual(
        JSON.parse(await redis.get(getProviderKeywordResponseKey(idempotencyKey))),
        payload
      );
    } finally {
      codeClipVertical.service.handleCodeClipKeywordEntry = originalHandler;
      await redis.del(idempotencyKey);
      await redis.del(getProviderKeywordResponseKey(idempotencyKey));
    }
  });
});
