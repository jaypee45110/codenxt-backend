const test = require("node:test");
const assert = require("node:assert/strict");

const codePod = require("./verticals/codepod");
const {
  adaptCodePodProviderKeyword,
} = require("./verticals/codepod/provider-adapter");

test("codePod provider adapter propagates envelope errors", () => {
  assert.deepEqual(
    adaptCodePodProviderKeyword({
      eventCode: "CP-ADAPTER",
      keyword: "LISTEN",
    }),
    {
      ok: false,
      reason: "PROVIDER_REQUIRED",
      envelope: null,
      keywordEntry: null,
    }
  );
});

test("codePod provider adapter builds canonical keyword input and safe metadata", () => {
  const result = adaptCodePodProviderKeyword({
    provider: " Internal ",
    eventCode: " CP-ADAPTER ",
    keyword: " ListenNow ",
    messageId: " message-adapter-1 ",
    providerAccountId: " account-adapter-1 ",
    senderId: " sender-adapter-1 ",
    recipientId: " recipient-adapter-1 ",
    channel: " message ",
    receivedAt: " 2026-07-09T00:02:00.000Z ",
    metadata: {
      source: "unit",
      nested: {
        campaign: "podcast-launch",
        rawBody: "ignored-metadata-value",
      },
      token: "ignored-token-value",
      signature: "ignored-signature-value",
    },
    rawBody: "ignored-raw-value",
    headers: { authorization: "ignored-header-value" },
    ip: "192.0.2.1",
    secret: "ignored-secret-value",
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "internal");
  assert.deepEqual(result.keywordEntry, {
    eventCode: "CP-ADAPTER",
    keyword: "ListenNow",
    messageId: "message-adapter-1",
    provider: "internal",
    providerAccountId: "account-adapter-1",
    receivedAt: "2026-07-09T00:02:00.000Z",
  });
  assert.deepEqual(result.providerMetadata, {
    senderId: "sender-adapter-1",
    recipientId: "recipient-adapter-1",
    channel: "message",
    metadata: {
      source: "unit",
      nested: {
        campaign: "podcast-launch",
      },
    },
  });

  const serialized = JSON.stringify(result);
  for (const ignoredValue of [
    "ignored-metadata-value",
    "ignored-token-value",
    "ignored-signature-value",
    "ignored-raw-value",
    "ignored-header-value",
    "192.0.2.1",
    "ignored-secret-value",
  ]) {
    assert.equal(serialized.includes(ignoredValue), false);
  }
});

test("codePod provider adapter feeds keyword AudienceEntry and runtime chain", () => {
  const adapted = adaptCodePodProviderKeyword({
    provider: " internal ",
    eventCode: " CP-ADAPTER-RUNTIME ",
    keyword: " PLAY ",
    messageId: " message-adapter-runtime ",
    providerAccountId: " account-adapter-runtime ",
    receivedAt: "2026-07-09T00:03:00.000Z",
  });
  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry(
    adapted.keywordEntry
  );
  const chain = codePod.service.buildCodePodRuntimeChain({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.audienceEntry.vertical, "codepod");
  assert.equal(normalized.audienceEntry.provider, "internal");
  assert.equal(normalized.audienceEntry.keyword, "PLAY");
  assert.equal(chain.interaction.vertical, "codepod");
  assert.equal(chain.interaction.interactionType, "keyword");
  assert.equal(chain.interaction.provider, "internal");
  assert.equal(chain.routingOutcome.routingOutcome, "MATCH");
  assert.equal(chain.rewardAssignmentSnapshot.rewardDomain, "deferred");
  assert.equal(chain.rewardAssignmentSnapshot.assignmentStatus, "not_assigned");
  assert.equal(chain.persistenceSnapshot.persistenceAction, "none");
  assert.equal(chain.persistenceSnapshot.persisted, false);
});
