const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OUTBOUND_STATUSES,
  buildMetaMessengerOutboundIdempotencyKey,
  buildMetaMessengerRewardOutboundIntent,
  createMetaMessengerOutboundStatus,
  selectRewardLinkDeliverable,
  toPublicMetaMessengerOutboundStatus,
  transitionMetaMessengerOutboundStatus,
  validateMetaMessengerOutboundIntent,
} = require("./verticals/codeclip/meta-messenger-outbound");

const MODULE_PATH = path.join(__dirname, "verticals/codeclip/meta-messenger-outbound.js");
const CREATED_AT = "2026-07-29T00:00:00.000Z";

function validRewardResult(overrides = {}) {
  return {
    tier: "clip",
    rewards: {
      clip: {
        assigned: true,
        displayTier: "Clip",
        title: "Backstage clip",
        type: "video",
        contentUrl: "https://rewards.example/clip-123",
        ...overrides.reward,
      },
    },
    ...overrides.result,
  };
}

function validIntentInput(overrides = {}) {
  return {
    providerAccountId: "page-123456789",
    recipientId: "psid-987654321",
    eventCode: "CC-B11",
    bindingId: "binding-1",
    inboundDeliveryId: "delivery-1",
    externalInboundMessageId: "mid-abc-123",
    interactionId: "interaction-1",
    createdAt: CREATED_AT,
    result: validRewardResult(),
    ...overrides,
  };
}

function buildValidIntent(overrides = {}) {
  const result = buildMetaMessengerRewardOutboundIntent(validIntentInput(overrides));
  assert.equal(result.ok, true);
  return result.intent;
}

test("builds a valid Meta Messenger outbound intent", () => {
  const intent = buildValidIntent();

  assert.equal(intent.provider, "meta");
  assert.equal(intent.channel, "messenger");
  assert.equal(intent.providerAccountId, "page-123456789");
  assert.equal(intent.recipientId, "psid-987654321");
  assert.equal(intent.eventCode, "CC-B11");
  assert.equal(intent.bindingId, "binding-1");
  assert.equal(intent.inboundDeliveryId, "delivery-1");
  assert.equal(intent.externalInboundMessageId, "mid-abc-123");
  assert.equal(intent.interactionId, "interaction-1");
  assert.equal(intent.outboundType, "reward_link");
  assert.equal(intent.createdAt, CREATED_AT);
  assert.equal(
    intent.idempotencyKey,
    "codeclip:meta:messenger:outbound:page-123456789:mid-abc-123:reward_link"
  );
  assert.deepEqual(validateMetaMessengerOutboundIntent(intent), { ok: true });
});

test("builds a structured deliverable without rendered text or Graph payload", () => {
  const intent = buildValidIntent();

  assert.deepEqual(intent.deliverable, {
    type: "reward_link",
    rewardTier: "clip",
    url: "https://rewards.example/clip-123",
    metadata: {
      displayTier: "Clip",
      title: "Backstage clip",
      rewardType: "video",
    },
  });
  assert.equal(Object.hasOwn(intent, "text"), false);
  assert.equal(Object.hasOwn(intent, "payload"), false);
  assert.equal(JSON.stringify(intent).includes("messaging_type"), false);
  assert.equal(JSON.stringify(intent).includes("\"recipient\""), false);
  assert.equal(JSON.stringify(intent).includes("\"message\""), false);
});

test("rejects missing PSID", () => {
  const result = buildMetaMessengerRewardOutboundIntent(validIntentInput({ recipientId: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RECIPIENT_ID_REQUIRED");
});

test("rejects missing Page ID", () => {
  const result = buildMetaMessengerRewardOutboundIntent(validIntentInput({ providerAccountId: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROVIDER_ACCOUNT_ID_REQUIRED");
});

test("rejects missing eventCode", () => {
  const result = buildMetaMessengerRewardOutboundIntent(validIntentInput({ eventCode: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EVENT_CODE_REQUIRED");
});

test("rejects missing inbound identity", () => {
  const result = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({ externalInboundMessageId: "", inboundDeliveryId: "" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INBOUND_IDENTITY_REQUIRED");
});

test("builder rejects missing external inbound message ID even when inboundDeliveryId exists", () => {
  const result = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({
      externalInboundMessageId: "",
      inboundDeliveryId: "delivery-1",
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INBOUND_IDENTITY_REQUIRED");
});

test("validator rejects missing external inbound message ID", () => {
  const intent = buildValidIntent();
  intent.externalInboundMessageId = "";
  intent.inboundDeliveryId = "delivery-1";
  intent.idempotencyKey = "";

  const result = validateMetaMessengerOutboundIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INBOUND_IDENTITY_REQUIRED");
});

test("validator rejects manipulated idempotency key", () => {
  const intent = buildValidIntent();
  intent.idempotencyKey = "codeclip:meta:messenger:outbound:page-123456789:mid-other:reward_link";

  const result = validateMetaMessengerOutboundIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "IDEMPOTENCY_KEY_MISMATCH");
});

test("validator accepts correctly built intent", () => {
  assert.deepEqual(validateMetaMessengerOutboundIntent(buildValidIntent()), { ok: true });
});

test("builds deterministic idempotency key", () => {
  const first = buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId: "page-123456789",
    externalInboundMessageId: "mid-abc-123",
    outboundType: "reward_link",
  });
  const second = buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId: "page-123456789",
    externalInboundMessageId: "mid-abc-123",
    outboundType: "reward_link",
  });

  assert.equal(first, second);
  assert.equal(first, "codeclip:meta:messenger:outbound:page-123456789:mid-abc-123:reward_link");
});

test("different inbound message IDs produce different idempotency keys", () => {
  const first = buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId: "page-123456789",
    externalInboundMessageId: "mid-1",
    outboundType: "reward_link",
  });
  const second = buildMetaMessengerOutboundIdempotencyKey({
    providerAccountId: "page-123456789",
    externalInboundMessageId: "mid-2",
    outboundType: "reward_link",
  });

  assert.notEqual(first, second);
});

test("provider identifiers are case-sensitive in deterministic idempotency keys", () => {
  const upper = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({
      providerAccountId: "Page-ABC",
      recipientId: "PSID-XYZ",
      externalInboundMessageId: "Mid-ABC",
    })
  );
  const lower = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({
      providerAccountId: "page-abc",
      recipientId: "psid-xyz",
      externalInboundMessageId: "mid-abc",
    })
  );

  assert.equal(upper.ok, true);
  assert.equal(lower.ok, true);
  assert.equal(
    upper.intent.idempotencyKey,
    "codeclip:meta:messenger:outbound:Page-ABC:Mid-ABC:reward_link"
  );
  assert.equal(
    lower.intent.idempotencyKey,
    "codeclip:meta:messenger:outbound:page-abc:mid-abc:reward_link"
  );
  assert.notEqual(upper.intent.idempotencyKey, lower.intent.idempotencyKey);
  assert.equal(upper.intent.providerAccountId, "Page-ABC");
  assert.equal(upper.intent.recipientId, "PSID-XYZ");
  assert.equal(upper.intent.externalInboundMessageId, "Mid-ABC");
});

test("provider identifiers are trimmed before idempotency key construction", () => {
  const result = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({
      providerAccountId: " Page-ABC ",
      recipientId: " PSID-XYZ ",
      externalInboundMessageId: " Mid-ABC ",
      bindingId: " binding-1 ",
      inboundDeliveryId: " delivery-1 ",
      interactionId: " interaction-1 ",
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.intent.providerAccountId, "Page-ABC");
  assert.equal(result.intent.recipientId, "PSID-XYZ");
  assert.equal(result.intent.externalInboundMessageId, "Mid-ABC");
  assert.equal(
    result.intent.idempotencyKey,
    "codeclip:meta:messenger:outbound:Page-ABC:Mid-ABC:reward_link"
  );
});

test("same input gives same semantic intent when createdAt is explicit", () => {
  const first = buildMetaMessengerRewardOutboundIntent(validIntentInput());
  const second = buildMetaMessengerRewardOutboundIntent(validIntentInput());

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.intent, second.intent);
});

test("accepts valid HTTPS reward URL", () => {
  const result = selectRewardLinkDeliverable(validRewardResult());
  assert.equal(result.ok, true);
  assert.equal(result.deliverable.url, "https://rewards.example/clip-123");
});

test("rejects HTTP reward URL", () => {
  const result = selectRewardLinkDeliverable(
    validRewardResult({ reward: { contentUrl: "http://rewards.example/clip-123" } })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REWARD_URL_INVALID");
});

test("rejects reward URL with credentials", () => {
  const result = selectRewardLinkDeliverable(
    validRewardResult({ reward: { contentUrl: "https://user:pass@rewards.example/clip-123" } })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REWARD_URL_INVALID");
});

test("missing or unassigned reward gives NO_DELIVERABLE_REWARD", () => {
  assert.equal(selectRewardLinkDeliverable({ tier: "clip", rewards: {} }).reason, "NO_DELIVERABLE_REWARD");
  assert.equal(
    selectRewardLinkDeliverable(validRewardResult({ reward: { assigned: false } })).reason,
    "NO_DELIVERABLE_REWARD"
  );
  assert.equal(
    selectRewardLinkDeliverable(validRewardResult({ reward: { contentUrl: "" } })).reason,
    "NO_DELIVERABLE_REWARD"
  );
});

test("invalid reward URL returns explicit error", () => {
  const result = buildMetaMessengerRewardOutboundIntent(
    validIntentInput({
      result: validRewardResult({ reward: { contentUrl: "not-a-url" } }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REWARD_URL_INVALID");
});

test("allows valid status transitions", () => {
  const created = createMetaMessengerOutboundStatus(buildValidIntent());
  assert.equal(created.ok, true);
  assert.equal(created.status.status, OUTBOUND_STATUSES.PENDING);
  assert.equal(created.status.retryEligible, true);
  assert.equal(created.status.terminal, false);

  const claimed = transitionMetaMessengerOutboundStatus(created.status, {
    status: OUTBOUND_STATUSES.CLAIMED,
    attemptCount: 1,
    updatedAt: "2026-07-29T00:01:00.000Z",
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status.status, OUTBOUND_STATUSES.CLAIMED);
  assert.equal(claimed.status.retryEligible, false);
  assert.equal(claimed.status.terminal, false);
  assert.equal(claimed.status.attemptCount, 1);

  const retryable = transitionMetaMessengerOutboundStatus(claimed.status, {
    status: OUTBOUND_STATUSES.RETRYABLE_FAILED,
    attemptCount: 1,
    nextAttemptAt: "2026-07-29T00:05:00.000Z",
    failureCode: "GRAPH_TIMEOUT",
    updatedAt: "2026-07-29T00:02:00.000Z",
  });
  assert.equal(retryable.ok, true);
  assert.equal(retryable.status.retryEligible, true);
  assert.equal(retryable.status.terminal, false);
  assert.equal(retryable.status.nextAttemptAt, "2026-07-29T00:05:00.000Z");
  assert.equal(retryable.status.failureCode, "GRAPH_TIMEOUT");

  const reclaimed = transitionMetaMessengerOutboundStatus(retryable.status, {
    status: OUTBOUND_STATUSES.CLAIMED,
    attemptCount: 2,
    updatedAt: "2026-07-29T00:05:00.000Z",
  });
  assert.equal(reclaimed.ok, true);

  const sent = transitionMetaMessengerOutboundStatus(reclaimed.status, {
    status: OUTBOUND_STATUSES.SENT,
    attemptCount: 2,
    providerMessageId: "provider-mid-123456",
    updatedAt: "2026-07-29T00:06:00.000Z",
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status.status, OUTBOUND_STATUSES.SENT);
  assert.equal(sent.status.retryEligible, false);
  assert.equal(sent.status.terminal, true);
  assert.equal(sent.status.providerMessageId, "provider-mid-123456");
});

test("rejects invalid status transitions and attempt counts", () => {
  const created = createMetaMessengerOutboundStatus(buildValidIntent()).status;

  assert.equal(
    transitionMetaMessengerOutboundStatus(created, { status: OUTBOUND_STATUSES.SENT }).reason,
    "OUTBOUND_STATUS_TRANSITION_INVALID"
  );
  assert.equal(
    transitionMetaMessengerOutboundStatus(created, {
      status: OUTBOUND_STATUSES.CLAIMED,
      attemptCount: -1,
    }).reason,
    "ATTEMPT_COUNT_INVALID"
  );
  assert.equal(
    transitionMetaMessengerOutboundStatus(created, {
      status: OUTBOUND_STATUSES.CLAIMED,
      attemptCount: 1.5,
    }).reason,
    "ATTEMPT_COUNT_INVALID"
  );
});

test("terminal status cannot be reopened", () => {
  const created = createMetaMessengerOutboundStatus(buildValidIntent()).status;
  const failed = transitionMetaMessengerOutboundStatus(created, {
    status: OUTBOUND_STATUSES.TERMINAL_FAILED,
    attemptCount: 1,
    failureCode: "NO_DELIVERABLE_REWARD",
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.status.terminal, true);
  assert.equal(failed.status.retryEligible, false);

  const reopened = transitionMetaMessengerOutboundStatus(failed.status, {
    status: OUTBOUND_STATUSES.RETRYABLE_FAILED,
    attemptCount: 2,
  });
  assert.equal(reopened.ok, false);
  assert.equal(reopened.reason, "OUTBOUND_STATUS_TRANSITION_INVALID");
});

test("public status does not leak raw identifiers", () => {
  const created = createMetaMessengerOutboundStatus(buildValidIntent()).status;
  const claimed = transitionMetaMessengerOutboundStatus(created, {
    status: OUTBOUND_STATUSES.CLAIMED,
    attemptCount: 1,
  });
  const delivered = transitionMetaMessengerOutboundStatus(claimed.status, {
    status: OUTBOUND_STATUSES.SENT,
    attemptCount: 1,
    providerMessageId: "provider-mid-123456",
  });
  const publicStatus = toPublicMetaMessengerOutboundStatus(delivered.status);
  const serialized = JSON.stringify(publicStatus);

  assert.equal(serialized.includes("page-123456789"), false);
  assert.equal(serialized.includes("psid-987654321"), false);
  assert.equal(serialized.includes("mid-abc-123"), false);
  assert.equal(serialized.includes("provider-mid-123456"), false);
  assert.equal(
    serialized.includes("codeclip:meta:messenger:outbound:page-123456789:mid-abc-123:reward_link"),
    false
  );
  assert.equal(publicStatus.providerAccountIdMasked.endsWith("6789"), true);
  assert.equal(publicStatus.recipientIdMasked.endsWith("4321"), true);
  assert.equal(publicStatus.externalInboundMessageIdMasked.endsWith("-123"), true);
  assert.equal(publicStatus.providerMessageIdMasked.endsWith("3456"), true);
  assert.match(publicStatus.idempotencyKeyFingerprint, /^[0-9a-f]{16}$/);
});

test("module performs no network calls", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("network should not be called");
  };

  const result = buildMetaMessengerRewardOutboundIntent(validIntentInput());
  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
});

test("module contains no Graph API URL, network client, token, auth, or Messenger send payload handling", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");

  assert.doesNotMatch(source, /\bfetch\b/);
  assert.doesNotMatch(source, /node:http|node:https|require\(["']http["']\)|require\(["']https["']\)/);
  assert.doesNotMatch(source, /graph\.facebook/i);
  assert.doesNotMatch(source, /graph\.meta/i);
  assert.doesNotMatch(source, /PAGE_ACCESS/);
  assert.doesNotMatch(source, /ACCESS_TOKEN/);
  assert.doesNotMatch(source, /Authorization/);
  assert.doesNotMatch(source, /Bearer/);
  assert.doesNotMatch(source, /messaging_type/);
});
