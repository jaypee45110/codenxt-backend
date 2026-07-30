const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  persistMetaMessengerRewardOutboundIntent,
} = require("./verticals/codeclip/meta-messenger-outbound-runtime");

const CREATED_AT = "2026-07-30T00:00:00.000Z";
const TX_CLIENT = { id: "tx", query: async () => ({ rows: [] }) };

function baseContext(overrides = {}) {
  return {
    providerAccountId: "Page-ABC",
    recipientId: "Psid-XYZ",
    eventCode: "CC-B112B",
    bindingId: "binding-1",
    inboundDeliveryId: "delivery-1",
    externalInboundMessageId: "Mid-ABC-123",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function baseInteraction(overrides = {}) {
  return {
    tier: "clip",
    rewardAssignments: {
      clip: {
        assigned: true,
        tier: "clip",
        displayTier: "Clip",
        title: "Reward clip",
        type: "video",
        contentUrl: "https://rewards.example/clip",
      },
    },
    ...overrides,
  };
}

function assertNoTransportFields(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /messaging_type/);
  assert.doesNotMatch(serialized, /accessToken|access_token/);
  assert.doesNotMatch(serialized, /Authorization/);
  assert.doesNotMatch(serialized, /Bearer/);
  assert.doesNotMatch(serialized, /graph\.facebook|graph\.meta/i);
}

function assertExpectedIntent(intent) {
  assert.equal(intent.provider, "meta");
  assert.equal(intent.channel, "messenger");
  assert.equal(intent.outboundType, "reward_link");
  assert.equal(intent.providerAccountId, "Page-ABC");
  assert.equal(intent.recipientId, "Psid-XYZ");
  assert.equal(intent.eventCode, "CC-B112B");
  assert.equal(intent.bindingId, "binding-1");
  assert.equal(intent.inboundDeliveryId, "delivery-1");
  assert.equal(intent.externalInboundMessageId, "Mid-ABC-123");
  assert.equal(intent.interactionId, "interaction-row-1");
  assert.equal(intent.createdAt, CREATED_AT);
  assert.deepEqual(intent.deliverable, {
    type: "reward_link",
    rewardTier: "clip",
    url: "https://rewards.example/clip",
    metadata: {
      displayTier: "Clip",
      title: "Reward clip",
      rewardType: "video",
    },
  });
  assert.equal(
    intent.idempotencyKey,
    "codeclip:meta:messenger:outbound:Page-ABC:Mid-ABC-123:reward_link"
  );
  assertNoTransportFields(intent);
}

test("skips without outbound context", async () => {
  const result = await persistMetaMessengerRewardOutboundIntent({
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
    createOrGetOutbound: async () => {
      throw new Error("repository should not be called");
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "OUTBOUND_CONTEXT_MISSING");
});

test("skips NO_DELIVERABLE_REWARD without repository write", async () => {
  let repositoryCalled = false;
  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction({ rewardAssignments: {} }),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
    createOrGetOutbound: async () => {
      repositoryCalled = true;
      throw new Error("repository should not be called");
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "NO_DELIVERABLE_REWARD");
  assert.equal(repositoryCalled, false);
});

test("invalid builder result fails closed before repository write", async () => {
  let repositoryCalled = false;
  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction({
      rewardAssignments: {
        clip: {
          assigned: true,
          tier: "clip",
          displayTier: "Clip",
          title: "Bad URL",
          type: "video",
          contentUrl: "http://rewards.example/clip",
        },
      },
    }),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
    createOrGetOutbound: async () => {
      repositoryCalled = true;
      throw new Error("repository should not be called");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.critical, true);
  assert.equal(result.reason, "REWARD_URL_INVALID");
  assert.equal(repositoryCalled, false);
});

test("created repository result commits minimal outbound result with same transaction queryClient", async () => {
  const queryClient = TX_CLIENT;
  const calls = [];

  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient,
    createOrGetOutbound: async (intent, receivedQueryClient) => {
      calls.push({ intent, queryClient: receivedQueryClient });
      return { ok: true, status: "created", row: { id: "outbound-row-1" } };
    },
  });

  assert.deepEqual(result, {
    status: "committed",
    outboundStatus: "created",
    outboundId: "outbound-row-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queryClient, queryClient);
  assertExpectedIntent(calls[0].intent);
});

test("existing repository result commits minimal outbound result", async () => {
  const calls = [];

  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
    createOrGetOutbound: async (intent) => {
      calls.push(intent);
      return { ok: true, status: "existing", row: { id: "outbound-row-1" } };
    },
  });

  assert.deepEqual(result, {
    status: "committed",
    outboundStatus: "existing",
    outboundId: "outbound-row-1",
  });
  assert.equal(calls.length, 1);
  assertExpectedIntent(calls[0]);
});

test("missing queryClient fails closed for deliverable outbound", async () => {
  let repositoryCalled = false;
  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    createOrGetOutbound: async () => {
      repositoryCalled = true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.critical, true);
  assert.equal(result.reason, "QUERY_CLIENT_REQUIRED");
  assert.equal(repositoryCalled, false);
});

test("missing repository dependency fails closed for deliverable outbound", async () => {
  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.critical, true);
  assert.equal(result.reason, "OUTBOUND_REPOSITORY_REQUIRED");
});

test("immutable conflict and repository failure are critical failures", async () => {
  for (const repositoryResult of [
    { ok: false, status: "conflict", reason: "IDEMPOTENCY_IMMUTABLE_CONFLICT" },
    { ok: false, status: "failed", reason: "REPOSITORY_ERROR", error: new Error("db failed") },
  ]) {
    const result = await persistMetaMessengerRewardOutboundIntent({
      outboundContext: baseContext(),
      interaction: baseInteraction(),
      persistedInteraction: { id: "interaction-row-1" },
      queryClient: TX_CLIENT,
      createOrGetOutbound: async () => repositoryResult,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.critical, true);
    assert.equal(result.reason, repositoryResult.reason);
  }
});

test("thrown repository error is converted to controlled critical failure", async () => {
  const error = new Error("repository threw");
  const result = await persistMetaMessengerRewardOutboundIntent({
    outboundContext: baseContext(),
    interaction: baseInteraction(),
    persistedInteraction: { id: "interaction-row-1" },
    queryClient: TX_CLIENT,
    createOrGetOutbound: async () => {
      throw error;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.critical, true);
  assert.equal(result.reason, "OUTBOUND_REPOSITORY_ERROR");
  assert.equal(result.error, error);
});

test("runtime module contains no Graph, fetch, Redis, or Messenger transport payload", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/meta-messenger-outbound-runtime.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /\bfetch\b/);
  assert.doesNotMatch(source, /\bhttp\b|\bhttps\b/);
  assert.doesNotMatch(source, /graph\.facebook|graph\.meta/i);
  assert.doesNotMatch(source, /Redis|redis/);
  assert.doesNotMatch(source, /messaging_type/);
  assert.doesNotMatch(source, /Authorization|Bearer|ACCESS_TOKEN|PAGE_ACCESS/);
});
