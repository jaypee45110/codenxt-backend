const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifyCodeClipProviderChallenge,
} = require("./verticals/codeclip/provider-challenge-verification");

const VERIFY_TOKEN = "meta-verify-token";

function validChallengeInput(overrides = {}) {
  return {
    provider: "meta",
    verifyToken: VERIFY_TOKEN,
    query: {
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "challenge-value",
    },
    ...overrides,
  };
}

test("codeClip provider challenge verification accepts valid Meta challenge", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput()),
    { ok: true, challenge: "challenge-value" }
  );
});

test("codeClip provider challenge verification rejects unsupported providers", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({ provider: "sms" })),
    { ok: false, reason: "UNSUPPORTED_PROVIDER" }
  );
});

test("codeClip provider challenge verification requires configured verify token", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({ verifyToken: "" })),
    { ok: false, reason: "VERIFY_TOKEN_REQUIRED" }
  );
});

test("codeClip provider challenge verification requires subscribe mode", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({
      query: {
        "hub.mode": "unsubscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "challenge-value",
      },
    })),
    { ok: false, reason: "MODE_MISMATCH" }
  );
});

test("codeClip provider challenge verification requires query verify token", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({
      query: {
        "hub.mode": "subscribe",
        "hub.challenge": "challenge-value",
      },
    })),
    { ok: false, reason: "QUERY_VERIFY_TOKEN_REQUIRED" }
  );
});

test("codeClip provider challenge verification requires challenge", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
      },
    })),
    { ok: false, reason: "CHALLENGE_REQUIRED" }
  );
});

test("codeClip provider challenge verification rejects token mismatch without leaking token", () => {
  const result = verifyCodeClipProviderChallenge(validChallengeInput({
    query: {
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-value",
    },
  }));

  assert.deepEqual(result, { ok: false, reason: "VERIFY_TOKEN_MISMATCH" });
  assert.equal(Object.values(result).includes(VERIFY_TOKEN), false);
  assert.equal(Object.hasOwn(result, "verifyToken"), false);
});

test("codeClip provider challenge verification supports array query values", () => {
  assert.deepEqual(
    verifyCodeClipProviderChallenge(validChallengeInput({
      query: {
        "hub.mode": ["subscribe"],
        "hub.verify_token": [VERIFY_TOKEN],
        "hub.challenge": ["array-challenge"],
      },
    })),
    { ok: true, challenge: "array-challenge" }
  );
});
