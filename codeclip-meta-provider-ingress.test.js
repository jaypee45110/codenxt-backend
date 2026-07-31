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
const metaMessengerOutboundCalls = [];
const providerBindings = [];
const campaignsByCode = new Map();

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
  metaMessengerOutboundCalls.length = 0;
  providerBindings.length = 0;
  campaignsByCode.clear();
  createCodeClipProviderDeliveryStub.fail = false;
  updateCodeClipProviderDeliveryStateStub.fail = false;
  createOrGetCodeClipMetaMessengerOutboundStub.fail = false;
  providerBindingPool.failDeliveryLookup = false;
  providerBindingPool.failBindingLookup = false;
  providerBindingPool.bindingLookupCount = 0;
}

function createProviderDeliveryRow(delivery = {}) {
  const provider = String(delivery.provider || "").trim().toLowerCase();
  const eventCode = String(delivery.eventCode || "").trim();
  const externalMessageId = String(delivery.externalMessageId || "").trim();
  return {
    id: delivery.id || `${provider}-${eventCode}-${externalMessageId}`,
    provider,
    providerAccountId: String(delivery.providerAccountId || "").trim(),
    eventCode,
    eventId: delivery.eventId || null,
    externalMessageId,
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

function providerDeliverySqlRow(row = {}) {
  return {
    id: row.id || `${row.provider}-${row.eventCode}-${row.externalMessageId}`,
    provider: row.provider,
    provider_account_id: row.providerAccountId,
    event_code: row.eventCode,
    event_id: row.eventId,
    external_message_id: row.externalMessageId,
    idempotency_key: row.idempotencyKey,
    payload_fingerprint: row.payloadFingerprint,
    verification_state: row.verificationState,
    processing_state: row.processingState,
    attempt_count: row.attemptCount,
    core_persistence_state: row.corePersistenceState,
    completion_state: row.completionState,
    response_status: row.responseStatus,
    public_response_json: row.publicResponseJson,
    error_class: row.errorClass,
    retry_eligible: row.retryEligible,
    terminal_state: row.terminalState,
    received_at: row.receivedAt || "2026-07-14T00:00:00.000Z",
    last_attempt_at: row.lastAttemptAt || null,
    completed_at: row.completedAt || null,
    created_at: row.createdAt || "2026-07-14T00:00:00.000Z",
    updated_at: row.updatedAt || "2026-07-14T00:00:00.000Z",
  };
}

function createBindingRow({ eventCode, providerAccountId, status = "active", channel = "messenger" } = {}) {
  return {
    id: `binding-${providerBindings.length + 1}`,
    vertical: "codeclip",
    event_code: eventCode,
    provider: "meta",
    channel,
    provider_account_id: providerAccountId,
    status,
    display_name: null,
    created_by: "test",
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    disabled_at: status === "disabled" ? "2026-07-14T00:01:00.000Z" : null,
  };
}

function addMetaBinding({ eventCode, accountId, status = "active", channel = "messenger" }) {
  const row = createBindingRow({ eventCode, providerAccountId: accountId, status, channel });
  providerBindings.push(row);
  return row;
}

const providerBindingPool = {
  failDeliveryLookup: false,
  failBindingLookup: false,
  bindingLookupCount: 0,
  async query(sql, params = []) {
    if (
      /FROM codeclip_provider_deliveries/.test(sql) &&
      /external_message_id = \$3/.test(sql)
    ) {
      if (providerBindingPool.failDeliveryLookup) {
        throw new Error("forced provider delivery lookup failure");
      }

      return {
        rows: Array.from(providerDeliveries.values())
          .filter((row) =>
            row.provider === params[0] &&
            row.providerAccountId === params[1] &&
            row.externalMessageId === params[2]
          )
          .slice(0, 2)
          .map(providerDeliverySqlRow),
      };
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /provider_account_id = \$3/.test(sql)
    ) {
      providerBindingPool.bindingLookupCount += 1;
      if (providerBindingPool.failBindingLookup) {
        throw new Error("forced provider binding lookup failure");
      }

      return {
        rows: providerBindings
          .filter((row) =>
            row.vertical === params[0] &&
            row.provider === params[1] &&
            row.provider_account_id === params[2] &&
            row.status === "active"
          )
          .slice(0, 2),
      };
    }

    return { rows: [] };
  },
};

async function saveCampaignStub(event = {}) {
  if (event?.code) {
    campaignsByCode.set(event.code, {
      id: event.id,
      vertical: event.vertical,
      event_code: event.code,
      raw_event: event,
    });
  }
}

async function getCampaignByCodeStub(eventCode) {
  return campaignsByCode.get(eventCode) || null;
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

async function withCodeClipCorePersistenceTransactionStub(work) {
  return work({ queryClient: providerBindingPool });
}

async function saveCodeClipInteractionStub(interaction = {}) {
  return {
    id: `interaction-${interaction.eventCode}-${interaction.scanId}`,
    ...interaction,
  };
}

async function saveCodeClipRewardAssignmentsStub(snapshot = {}) {
  return Array.isArray(snapshot.assignments)
    ? snapshot.assignments.filter((assignment) => assignment?.tier)
    : [];
}

async function saveCodeClipXtraRedemptionStub(record = {}) {
  return record?.token ? { id: `clipxtra-${record.token}`, ...record } : null;
}

async function createOrGetCodeClipMetaMessengerOutboundStub(intent = {}, queryClient) {
  metaMessengerOutboundCalls.push({ intent, queryClient });
  if (createOrGetCodeClipMetaMessengerOutboundStub.fail) {
    return {
      ok: false,
      status: "failed",
      reason: "REPOSITORY_ERROR",
      error: new Error("forced outbound repository failure"),
    };
  }

  const existing = metaMessengerOutboundCalls
    .slice(0, -1)
    .find((call) => call.intent.idempotencyKey === intent.idempotencyKey);
  return {
    ok: true,
    status: existing ? "existing" : "created",
    row: { id: `outbound-${intent.idempotencyKey}` },
  };
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: providerBindingPool,
    saveCampaign: saveCampaignStub,
    getCampaignByCode: getCampaignByCodeStub,
    saveCodeClipInteraction: saveCodeClipInteractionStub,
    saveCodeClipRewardAssignments: saveCodeClipRewardAssignmentsStub,
    saveCodeClipXtraRedemption: saveCodeClipXtraRedemptionStub,
    withCodeClipCorePersistenceTransaction: withCodeClipCorePersistenceTransactionStub,
    createCodeClipProviderDelivery: createCodeClipProviderDeliveryStub,
    updateCodeClipProviderDeliveryState: updateCodeClipProviderDeliveryStateStub,
    createOrGetCodeClipMetaMessengerOutbound: createOrGetCodeClipMetaMessengerOutboundStub,
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

function metaInstagramBody({
  messageId,
  accountId,
  senderId = "ig-sender-1",
  text = " vip ",
}) {
  return JSON.stringify({
    object: "instagram",
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

function metaWhatsAppBody({
  messageId,
  phoneNumberId,
  wabaId = `waba-${phoneNumberId}`,
  senderId = "whatsapp-sender-1",
  text = " vip ",
}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: phoneNumberId,
              },
              messages: [
                {
                  from: senderId,
                  id: messageId,
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function createCodeClipMetaEvent(baseUrl, {
  accountId,
  keyword = "VIP",
  activationChannels = ["Messenger"],
  activationMethod = "keyword",
  status = "active",
  bindAccount = true,
  bindingChannel = "messenger",
  legacyProviderAccountIds = false,
  rewards = null,
} = {}) {
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
      status,
      activationMethod,
      activationKeyword: keyword,
      activationChannels,
      ...(legacyProviderAccountIds ? { providerAccountIds: [accountId] } : {}),
      rewards: rewards || {
        openClip: {
          enabled: true,
          title: "OpenClip",
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  if (bindAccount) {
    addMetaBinding({ eventCode: code, accountId, channel: bindingChannel });
  }
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

function assertProviderUnavailable(response, payload) {
  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    ok: false,
    error: "Provider keyword processing unavailable",
  });
  assertNoProviderInternals(payload);
}

function assertProviderNoMatch(response, payload) {
  assert.equal(response.status, 404);
  assert.deepEqual(payload, {
    ok: false,
    error: "Event not found",
  });
  assertNoProviderInternals(payload);
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

async function withConsoleWarnSpy(run) {
  const originalWarn = console.warn;
  const entries = [];
  console.warn = (...args) => {
    entries.push(args);
  };

  try {
    await run(entries);
  } finally {
    console.warn = originalWarn;
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

test("Meta Messenger reward flow persists outbound intent inside core persistence", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-outbound-${Date.now()}`;
    const senderId = `psid-outbound-${Date.now()}`;
    const keyword = `OUTBOUND-${Date.now()}`;
    const messageId = `meta-outbound-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip outbound",
          type: "video",
          contentUrl: "https://rewards.example/openclip-outbound",
        },
      },
    });
    const rawBody = metaBody({ messageId, accountId, senderId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assertNoProviderInternals(payload);
    assert.equal(metaMessengerOutboundCalls.length, 1);
    assert.equal(metaMessengerOutboundCalls[0].queryClient, providerBindingPool);

    const intent = metaMessengerOutboundCalls[0].intent;
    assert.equal(intent.provider, "meta");
    assert.equal(intent.channel, "messenger");
    assert.equal(intent.outboundType, "reward_link");
    assert.equal(intent.providerAccountId, accountId);
    assert.equal(intent.recipientId, senderId);
    assert.equal(intent.eventCode, code);
    assert.equal(intent.bindingId, "binding-1");
    assert.equal(intent.inboundDeliveryId, `meta-${code}-${messageId}`);
    assert.equal(intent.externalInboundMessageId, messageId);
    assert.match(String(intent.interactionId), /^interaction-/);
    assert.equal(intent.deliverable.rewardTier, "openClip");
    assert.equal(intent.deliverable.url, "https://rewards.example/openclip-outbound");
    assert.equal(
      intent.idempotencyKey,
      `codeclip:meta:messenger:outbound:${accountId}:${messageId}:reward_link`
    );
    assert.equal(JSON.stringify(intent).includes("messaging_type"), false);
    assert.equal(JSON.stringify(intent).includes("accessToken"), false);
    assert.equal(JSON.stringify(intent).includes("Authorization"), false);

    const delivery = Array.from(providerDeliveries.values()).find(
      (row) => row.externalMessageId === messageId
    );
    assert.ok(delivery);
    assert.equal(delivery.processingState, "completed");
    assert.equal(delivery.corePersistenceState, "committed");
    assert.equal(delivery.completionState, "completed");
    assert.deepEqual(
      JSON.parse(await redis.get(getProviderKeywordResponseKey(idempotencyKey))),
      payload
    );
  });
});

test("Meta Messenger outbound repository failure fails closed before Redis cache and delivery completion", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-outbound-fail-${Date.now()}`;
    const senderId = `psid-outbound-fail-${Date.now()}`;
    const keyword = `OUTBOUNDFAIL-${Date.now()}`;
    const messageId = `meta-outbound-fail-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip outbound fail",
          type: "video",
          contentUrl: "https://rewards.example/openclip-outbound-fail",
        },
      },
    });
    const rawBody = metaBody({ messageId, accountId, senderId, text: keyword });
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      provider: "meta",
      eventCode: code,
      messageId,
    });
    createOrGetCodeClipMetaMessengerOutboundStub.fail = true;

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assertProviderUnavailable(response, payload);
    assert.equal(metaMessengerOutboundCalls.length, 1);
    assert.equal(await redis.get(getProviderKeywordResponseKey(idempotencyKey)), null);

    const delivery = Array.from(providerDeliveries.values()).find(
      (row) => row.externalMessageId === messageId
    );
    assert.ok(delivery);
    assert.equal(delivery.processingState, "failed");
    assert.equal(delivery.corePersistenceState, "failed");
    assert.equal(delivery.completionState, "not_completed");
    assert.equal(delivery.retryEligible, true);
    assert.equal(delivery.terminalState, false);
  });
});

test("Meta non-Messenger binding does not create Messenger outbound", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-not-messenger-${Date.now()}`;
    const keyword = `NOMSG-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["Instagram"],
      bindingChannel: "instagram",
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip non messenger",
          type: "video",
          contentUrl: "https://rewards.example/openclip-non-messenger",
        },
      },
    });
    const rawBody = metaInstagramBody({
      messageId: `meta-not-messenger-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.eventCode, code);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Instagram-native Meta webhook routes through Instagram binding without Messenger outbound", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `ig-native-${Date.now()}`;
    const keyword = `IGNATIVE-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["Instagram"],
      bindingChannel: "instagram",
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip Instagram native",
          type: "video",
          contentUrl: "https://rewards.example/openclip-instagram-native",
        },
      },
    });
    const senderId = `ig-psid-${Date.now()}`;
    const messageId = `ig-mid-${Date.now()}`;
    const rawBody = metaInstagramBody({
      messageId,
      accountId,
      senderId,
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
      assert.equal(payload.eventCode, code);
      assert.equal(payload.messageId, messageId);
      assert.ok(runtimeInput);
      assert.equal(runtimeInput.eventCode, code);
      assert.equal(runtimeInput.messageId, messageId);
    });

    assert.equal(metaMessengerOutboundCalls.length, 0);

    const delivery = Array.from(providerDeliveries.values()).find(
      (row) => row.externalMessageId === messageId
    );
    assert.ok(delivery);
    assert.equal(delivery.provider, "meta");
    assert.equal(delivery.providerAccountId, accountId);
    assert.equal(delivery.processingState, "completed");
    assert.equal(delivery.completionState, "completed");
  });
});

test("Instagram-native Meta webhook rejects invalid signature fail-closed", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `ig-bad-sig-${Date.now()}`;
    const keyword = `IGBAD-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["Instagram"],
      bindingChannel: "instagram",
    });
    const rawBody = metaInstagramBody({
      messageId: `ig-bad-sig-mid-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta Messenger account id conflict is rejected with controlled 400", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "page-A",
          messaging: [
            {
              sender: { id: "sender-1" },
              recipient: { id: "page-B" },
              message: { mid: `mid-conflict-${Date.now()}`, text: "hello" },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta Instagram account id conflict is rejected with controlled 400", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-A",
          messaging: [
            {
              sender: { id: "ig-sender-1" },
              recipient: { id: "ig-B" },
              message: { mid: `ig-mid-conflict-${Date.now()}`, text: "hello" },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta unknown object with messaging shape is rejected with controlled 400", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "something_else",
      entry: [
        {
          id: "x-1",
          messaging: [
            {
              sender: { id: "s-1" },
              recipient: { id: "x-1" },
              message: { mid: `mid-unknown-${Date.now()}`, text: "hello" },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Instagram envelope cannot use Messenger binding with same provider account id", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `shared-acc-${Date.now()}`;
    const keyword = `SHARED-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["Messenger", "Instagram"],
      bindingChannel: "messenger",
    });

    const rawBody = metaInstagramBody({
      messageId: `ig-mismatch-${Date.now()}`,
      accountId,
      text: keyword,
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "PROVIDER_BINDING_CHANNEL_MISMATCH");
    assert.equal(metaMessengerOutboundCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
  });
});

test("Instagram echo event is acknowledged without delivery or Messenger outbound", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-echo-1",
          messaging: [
            {
              sender: { id: "ig-echo-1" },
              recipient: { id: "user-1" },
              message: {
                mid: `echo-${Date.now()}`,
                text: "hello",
                is_echo: true,
              },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "MESSAGE_IS_ECHO");
    assert.equal(providerDeliveries.size, 0);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Instagram multi messaging payload is rejected fail-closed", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-multi-1",
          messaging: [
            {
              sender: { id: "u1" },
              recipient: { id: "ig-multi-1" },
              message: { mid: "m1", text: "one" },
            },
            {
              sender: { id: "u2" },
              recipient: { id: "ig-multi-1" },
              message: { mid: "m2", text: "two" },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "MULTI_EVENT_UNSUPPORTED");
    assert.equal(providerDeliveries.size, 0);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta multi-event with valid text and echo is acknowledged without persistens", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "page-multi-echo",
          messaging: [
            {
              sender: { id: "u1" },
              recipient: { id: "page-multi-echo" },
              message: { mid: "m1", text: "keyword" },
            },
            {
              sender: { id: "page-multi-echo" },
              recipient: { id: "u1" },
              message: { mid: "m2", text: "echo", is_echo: true },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "MULTI_EVENT_UNSUPPORTED");
    assert.equal(providerDeliveries.size, 0);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta multi-event with valid and malformed items is acknowledged without persistens", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-multi-malformed",
          messaging: [
            {
              sender: { id: "u1" },
              recipient: { id: "ig-multi-malformed" },
              message: { mid: "m1", text: "one" },
            },
            {
              sender: { id: "u2" },
              recipient: { id: "ig-multi-malformed" },
              message: { text: "missing mid" },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "MULTI_EVENT_UNSUPPORTED");
    assert.equal(providerDeliveries.size, 0);
  });
});

test("Instagram image attachment without text is acknowledged as non-keyword", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-attach-1",
          messaging: [
            {
              sender: { id: "u1" },
              recipient: { id: "ig-attach-1" },
              message: {
                mid: `att-${Date.now()}`,
                attachments: [{ type: "image", payload: { url: "https://example.com/a.jpg" } }],
              },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "NON_KEYWORD_EVENT");
    assert.equal(providerDeliveries.size, 0);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Messenger envelope against Instagram binding is acknowledged as channel mismatch", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `ig-bind-${Date.now()}`;
    const keyword = `IGONLY-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["Instagram"],
      bindingChannel: "instagram",
    });
    const rawBody = JSON.stringify({
      object: "page",
      entry: [
        {
          id: accountId,
          messaging: [
            {
              sender: { id: "user-1" },
              recipient: { id: accountId },
              message: { mid: `msg-${Date.now()}`, text: keyword },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ignored, true);
    assert.equal(payload.reason, "PROVIDER_BINDING_CHANNEL_MISMATCH");
    assert.equal(providerDeliveries.size, 0);
    assert.equal(metaMessengerOutboundCalls.length, 0);
  });
});

test("Meta envelopes route through channel-specific bindings using the provider account identity", async () => {
  await withTestServer(async (baseUrl) => {
    const instagramAccountId = `ig-account-${Date.now()}`;
    const instagramKeyword = `INSTAGRAM-${Date.now()}`;
    const instagramCode = await createCodeClipMetaEvent(baseUrl, {
      accountId: instagramAccountId,
      keyword: instagramKeyword,
      activationChannels: ["Instagram"],
      bindingChannel: "instagram",
    });
    const instagramBody = metaInstagramBody({
      messageId: `meta-instagram-${Date.now()}`,
      accountId: instagramAccountId,
      text: instagramKeyword,
    });

    const whatsappPhoneNumberId = `wa-phone-${Date.now()}`;
    const whatsappWabaId = `wa-waba-${Date.now()}`;
    const whatsappKeyword = `WHATSAPP-${Date.now()}`;
    const whatsappCode = await createCodeClipMetaEvent(baseUrl, {
      accountId: whatsappPhoneNumberId,
      keyword: whatsappKeyword,
      activationChannels: ["WhatsApp"],
      bindingChannel: "whatsapp",
    });
    const whatsappBody = metaWhatsAppBody({
      messageId: `meta-whatsapp-${Date.now()}`,
      phoneNumberId: whatsappPhoneNumberId,
      wabaId: whatsappWabaId,
      text: whatsappKeyword,
    });

    const cases = [
      {
        expectedAccountId: instagramAccountId,
        expectedCode: instagramCode,
        expectedKeyword: instagramKeyword,
        rawBody: instagramBody,
      },
      {
        expectedAccountId: whatsappPhoneNumberId,
        expectedCode: whatsappCode,
        expectedKeyword: whatsappKeyword,
        rawBody: whatsappBody,
      },
    ];

    for (const item of cases) {
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
          headers: metaHeaders(item.rawBody),
          body: item.rawBody,
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(runtimeInput.eventCode, item.expectedCode);
        assert.equal(runtimeInput.keyword, item.expectedKeyword);
        assert.equal(payload.eventCode, item.expectedCode);

        const delivery = Array.from(providerDeliveries.values()).find(
          (row) => row.externalMessageId === runtimeInput.messageId
        );
        assert.ok(delivery);
        assert.equal(delivery.provider, "meta");
        assert.equal(delivery.providerAccountId, item.expectedAccountId);
        assert.equal(delivery.eventCode, item.expectedCode);
      });
    }
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
        1
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

      assert.equal(second.status, 202);
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
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "Invalid provider keyword payload");
    assert.equal(payload.reason, "UNSUPPORTED_META_OBJECT");
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

    assertProviderNoMatch(response, payload);
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
  });
});

test("Meta strict binding rejects disabled binding without legacy fallback", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-disabled-binding-${Date.now()}`;
    const keyword = `DISABLED-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      bindAccount: false,
      legacyProviderAccountIds: true,
    });
    addMetaBinding({ eventCode: code, accountId, status: "disabled" });
    const rawBody = metaBody({
      messageId: `meta-disabled-binding-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assertProviderNoMatch(response, payload);
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
  });
});

test("Meta strict binding does not route to another episode by keyword", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-bound-a-${Date.now()}`;
    const codeA = await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword: "BOUND-A",
    });
    await createCodeClipMetaEvent(baseUrl, {
      accountId: `page-bound-b-${Date.now()}`,
      keyword: "BOUND-B",
    });
    const rawBody = metaBody({
      messageId: `meta-wrong-keyword-${Date.now()}`,
      accountId,
      text: "BOUND-B",
    });
    let runtimeCalled = false;

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

      assertProviderNoMatch(response, payload);
      assert.equal(runtimeCalled, false);
      assert.equal(providerDeliveryCalls.length, 0);
      assert.equal(providerDeliveries.size, 0);
      assert.equal(
        providerBindings.find((row) => row.event_code === codeA)?.provider_account_id,
        accountId
      );
    });
  });
});

test("Meta strict binding rejects channel mismatch on bound episode", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-channel-mismatch-${Date.now()}`;
    const keyword = `CHANNEL-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, {
      accountId,
      keyword,
      activationChannels: ["sms"],
      bindingChannel: "messenger",
    });
    const rawBody = metaBody({
      messageId: `meta-channel-mismatch-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assertProviderNoMatch(response, payload);
    assert.equal(providerDeliveryCalls.length, 0);
    assert.equal(providerDeliveries.size, 0);
  });
});

test("Meta strict binding treats invalid binding event as public-safe unavailable", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-invalid-event-${Date.now()}`;
    addMetaBinding({ eventCode: `CC-MISSING-${Date.now()}`, accountId });
    const rawBody = metaBody({
      messageId: `meta-invalid-event-${Date.now()}`,
      accountId,
      text: "INVALID",
    });
    let runtimeCalled = false;

    await withConsoleWarnSpy(async (warnEntries) => {
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

        assertProviderUnavailable(response, payload);
        assert.equal(runtimeCalled, false);
        assert.equal(providerDeliveryCalls.length, 0);
        assert.equal(providerDeliveries.size, 0);
        assert.ok(warnEntries.some((entry) =>
          entry[0] === "codeClip provider delivery signal" &&
          entry[1]?.operationalEvent === "provider_account_binding_failure" &&
          entry[1]?.reason === "PROVIDER_ACCOUNT_BINDING_EVENT_INVALID"
        ));
      });
    });
  });
});

test("Meta strict binding fails closed for ambiguous active binding rows", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-ambiguous-binding-${Date.now()}`;
    const keyword = `AMBIG-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    providerBindings.push(createBindingRow({
      eventCode: code,
      providerAccountId: accountId,
      channel: "messenger",
    }));
    const rawBody = metaBody({
      messageId: `meta-ambiguous-binding-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeCalled = false;

    await withConsoleWarnSpy(async (warnEntries) => {
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

        assertProviderUnavailable(response, payload);
        assert.equal(runtimeCalled, false);
        assert.equal(providerDeliveryCalls.length, 0);
        assert.equal(providerDeliveries.size, 0);
        assert.ok(warnEntries.some((entry) =>
          entry[0] === "codeClip provider delivery signal" &&
          entry[1]?.operationalEvent === "provider_account_binding_failure" &&
          entry[1]?.reason === "PROVIDER_ACCOUNT_BINDING_AMBIGUOUS"
        ));
      });
    });
  });
});

test("Meta strict binding fails closed when binding lookup is unavailable", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-binding-fail-${Date.now()}`;
    const keyword = `BINDFAIL-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-binding-fail-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeCalled = false;
    providerBindingPool.failBindingLookup = true;

    await withConsoleWarnSpy(async (warnEntries) => {
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

        assertProviderUnavailable(response, payload);
        assert.equal(runtimeCalled, false);
        assert.equal(providerDeliveryCalls.length, 0);
        assert.equal(providerDeliveries.size, 0);
        assert.ok(warnEntries.some((entry) =>
          entry[0] === "codeClip provider delivery signal" &&
          entry[1]?.operationalEvent === "provider_account_binding_failure" &&
          entry[1]?.reason === "PROVIDER_ACCOUNT_BINDING_UNAVAILABLE"
        ));
      });
    });
  });
});

test("Meta delivery replay lookup unavailable fails closed before binding lookup", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-delivery-lookup-fail-${Date.now()}`;
    const keyword = `DELIVERYFAIL-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-delivery-lookup-fail-${Date.now()}`,
      accountId,
      text: keyword,
    });
    let runtimeCalled = false;
    providerBindingPool.failDeliveryLookup = true;

    await withConsoleWarnSpy(async (warnEntries) => {
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

        assertProviderUnavailable(response, payload);
        assert.equal(runtimeCalled, false);
        assert.equal(providerDeliveryCalls.length, 0);
        assert.equal(providerDeliveries.size, 0);
        assert.equal(
          warnEntries.some((entry) =>
            entry[0] === "codeClip provider delivery signal" &&
            entry[1]?.operationalEvent === "provider_account_binding_failure"
          ),
          false
        );
      });
    });
  });
});

test("Meta payload eventCode cannot override provider account binding", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-payload-override-${Date.now()}`;
    const keyword = `OVERRIDE-${Date.now()}`;
    const boundCode = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const payloadCode = await createCodeClipMetaEvent(baseUrl, {
      accountId: `page-payload-other-${Date.now()}`,
      keyword,
    });
    const body = JSON.parse(metaBody({
      messageId: `meta-payload-override-${Date.now()}`,
      accountId,
      text: keyword,
    }));
    body.eventCode = payloadCode;
    const requestBody = JSON.stringify(body);
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
        headers: metaHeaders(requestBody),
        body: requestBody,
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(runtimeInput.eventCode, boundCode);
      assert.notEqual(runtimeInput.eventCode, payloadCode);
      assert.equal(payload.eventCode, boundCode);
      assertNoProviderInternals(payload);
    });
  });
});

test("Meta replay after rebinding returns original committed response without runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-rebinding-replay-${Date.now()}`;
    const keywordA = `REPLAYA-${Date.now()}`;
    const keywordB = `REPLAYB-${Date.now()}`;
    const codeA = await createCodeClipMetaEvent(baseUrl, { accountId, keyword: keywordA });
    const codeB = await createCodeClipMetaEvent(baseUrl, {
      accountId: `page-rebinding-other-${Date.now()}`,
      keyword: keywordB,
    });
    const messageId = `meta-rebinding-replay-${Date.now()}`;
    const rawBody = metaBody({ messageId, accountId, text: keywordA });
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
      const bindingLookupsAfterFirst = providerBindingPool.bindingLookupCount;

      assert.equal(first.status, 200);
      assert.equal(firstPayload.eventCode, codeA);
      assert.equal(runtimeCalls, 1);
      assert.equal(bindingLookupsAfterFirst, 1);

      for (const binding of providerBindings) {
        if (binding.provider_account_id === accountId) {
          binding.status = "disabled";
        }
      }
      addMetaBinding({ eventCode: codeB, accountId });

      const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      const secondPayload = await second.json();

      assert.equal(second.status, 200);
      assert.deepEqual(secondPayload, firstPayload);
      assert.equal(secondPayload.eventCode, codeA);
      assert.equal(runtimeCalls, 1);
      assert.equal(providerBindingPool.bindingLookupCount, bindingLookupsAfterFirst);
    });
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

      assert.equal(duplicate.status, 503);
      assert.deepEqual(duplicatePayload, {
        ok: false,
        error: "Provider keyword processing unavailable",
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
