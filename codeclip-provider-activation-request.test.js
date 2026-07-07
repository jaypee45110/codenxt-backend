const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCodeClipProviderActivationRequest,
} = require("./verticals/codeclip/provider-activation-request");

function validProviderInput(overrides = {}) {
  return {
    ok: true,
    eventCode: "CC-1",
    keyword: "CLIP",
    messageId: "message-1",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function missingEventCodeProviderInput(overrides = {}) {
  return {
    ok: false,
    eventCode: "",
    keyword: "CLIP",
    messageId: "message-1",
    warnings: [],
    errors: [{ code: "EVENT_CODE_REQUIRED" }],
    ...overrides,
  };
}

function codeClipEvent(overrides = {}) {
  return {
    id: "event-1",
    code: "CC-1",
    vertical: "codeclip",
    activationKeyword: "CLIP",
    activationChannels: ["sms"],
    ...overrides,
  };
}

test("codeClip provider activation request preserves eventCode path", () => {
  const event = codeClipEvent();
  const result = buildCodeClipProviderActivationRequest({
    provider: " SMS ",
    normalizedProviderInput: validProviderInput(),
    body: {},
    events: [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "sms");
  assert.equal(result.eventCode, "CC-1");
  assert.equal(result.keyword, "CLIP");
  assert.equal(result.messageId, "message-1");
  assert.equal(result.event, event);
  assert.deepEqual(result.idempotency, {
    provider: "sms",
    eventCode: "CC-1",
    messageId: "message-1",
  });
});

test("codeClip provider activation request resolves event from provider activation keyword", () => {
  const event = codeClipEvent({
    code: "CC-ACTIVATION",
    activationKeyword: "OPEN",
  });
  const result = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput({
      keyword: "open",
      messageId: "message-activation",
    }),
    body: {},
    events: [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.eventCode, "CC-ACTIVATION");
  assert.equal(result.keyword, "open");
  assert.equal(result.messageId, "message-activation");
  assert.equal(result.event, event);
  assert.deepEqual(result.idempotency, {
    provider: "sms",
    eventCode: "CC-ACTIVATION",
    messageId: "message-activation",
  });
});

test("codeClip provider activation request returns no match", () => {
  const result = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput({
      keyword: "WOW",
    }),
    body: {},
    events: [codeClipEvent()],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "NO_MATCH",
  });
});

test("codeClip provider activation request returns ambiguous match", () => {
  const result = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput({
      keyword: "CLIP",
    }),
    body: {},
    events: [
      codeClipEvent({ id: "event-1" }),
      codeClipEvent({ id: "event-2" }),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "AMBIGUOUS_MATCH",
  });
});

test("codeClip provider activation request uses providerAccountId", () => {
  const event = codeClipEvent({
    providerAccountIds: ["account-1"],
  });

  const missingAccount = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput(),
    body: {},
    events: [event],
  });
  assert.deepEqual(missingAccount, {
    ok: false,
    reason: "NO_MATCH",
  });

  const matchedAccount = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput(),
    body: {
      providerAccountId: " account-1 ",
    },
    events: [event],
  });
  assert.equal(matchedAccount.ok, true);
  assert.equal(matchedAccount.event, event);
  assert.equal(matchedAccount.providerAccountId, " account-1 ");
});

test("codeClip provider activation request never matches other verticals", () => {
  const result = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: missingEventCodeProviderInput(),
    body: {},
    events: [
      codeClipEvent({
        vertical: "codepod",
      }),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "NO_MATCH",
  });
});

test("codeClip provider activation request rejects invalid provider input", () => {
  const result = buildCodeClipProviderActivationRequest({
    provider: "sms",
    normalizedProviderInput: {
      ok: false,
      eventCode: "",
      keyword: "",
      messageId: "message-1",
      warnings: [],
      errors: [{ code: "KEYWORD_REQUIRED" }],
    },
    body: {},
    events: [codeClipEvent()],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "KEYWORD_REQUIRED",
  });
});
