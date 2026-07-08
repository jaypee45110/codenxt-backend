const test = require("node:test");
const assert = require("node:assert/strict");

const codePod = require("./verticals/codepod");
const {
  normalizeCodePodProviderEnvelope,
} = require("./verticals/codepod/provider-envelope");

test("codePod provider envelope requires provider", () => {
  assert.deepEqual(
    normalizeCodePodProviderEnvelope({
      eventCode: "CP-PROVIDER",
      keyword: "LISTEN",
    }),
    {
      ok: false,
      reason: "PROVIDER_REQUIRED",
      envelope: null,
    }
  );
});

test("codePod provider envelope normalizes canonical provider metadata", () => {
  const result = normalizeCodePodProviderEnvelope({
    provider: " Internal ",
    eventCode: " CP-PROVIDER ",
    keyword: " ListenNow ",
    messageId: " message-1 ",
    providerAccountId: " account-1 ",
    senderId: " sender-1 ",
    recipientId: " recipient-1 ",
    channel: " message ",
    receivedAt: " 2026-07-09T00:00:00.000Z ",
    metadata: {
      source: "unit",
      nested: {
        campaign: "podcast-launch",
        rawPayload: { ignored: true },
      },
      authorization: "ignored",
      signature: "ignored",
    },
    rawBody: { ignored: true },
    headers: { ignored: true },
    ip: "127.0.0.1",
    token: "ignored",
    secret: "ignored",
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "internal");
  assert.deepEqual(result.envelope, {
    vertical: "codepod",
    provider: "internal",
    eventCode: "CP-PROVIDER",
    keyword: "ListenNow",
    messageId: "message-1",
    providerAccountId: "account-1",
    senderId: "sender-1",
    recipientId: "recipient-1",
    channel: "message",
    receivedAt: "2026-07-09T00:00:00.000Z",
    metadata: {
      source: "unit",
      nested: {
        campaign: "podcast-launch",
      },
    },
  });
});

test("codePod provider envelope feeds keyword AudienceEntry and runtime chain", () => {
  const providerEnvelope = normalizeCodePodProviderEnvelope({
    provider: " internal ",
    eventCode: " CP-PROVIDER-RUNTIME ",
    keyword: " PLAY ",
    messageId: " message-runtime-1 ",
    providerAccountId: " account-runtime-1 ",
    channel: " message ",
    receivedAt: "2026-07-09T00:01:00.000Z",
    metadata: {
      source: "foundation-test",
    },
  });

  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry(
    providerEnvelope.envelope
  );
  const chain = codePod.service.buildCodePodRuntimeChain({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.audienceEntry.vertical, "codepod");
  assert.equal(normalized.audienceEntry.provider, "internal");
  assert.equal(normalized.audienceEntry.keyword, "PLAY");
  assert.equal(normalized.audienceEntry.messageId, "message-runtime-1");
  assert.equal(chain.interaction.vertical, "codepod");
  assert.equal(chain.interaction.interactionType, "keyword");
  assert.equal(chain.interaction.provider, "internal");
  assert.equal(chain.routingOutcome.routingOutcome, "MATCH");
  assert.equal(chain.rewardAssignmentSnapshot.rewardDomain, "deferred");
  assert.equal(chain.rewardAssignmentSnapshot.assignmentStatus, "not_assigned");
  assert.equal(chain.persistenceSnapshot.persistenceAction, "none");
  assert.equal(chain.persistenceSnapshot.persisted, false);
});
