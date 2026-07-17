const test = require("node:test");
const assert = require("node:assert/strict");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const callbackModulePath = require.resolve(
  "./verticals/codeclip/youtube-websub-callback"
);

const queryClient = { name: "codeclip-youtube-websub-route-test-pool" };
const callbackCalls = [];
let callbackResult = null;
let callbackError = null;

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

require.cache[callbackModulePath] = {
  id: callbackModulePath,
  filename: callbackModulePath,
  loaded: true,
  exports: {
    verifyCodeClipYouTubeWebSubCallback: async (input, options) => {
      callbackCalls.push({ input, options });
      if (callbackError) throw callbackError;
      return callbackResult;
    },
  },
};

const { handleCodeClipYouTubeWebSubVerificationRoute } = require("./server");

async function callHandler({ callbackId, query = {} }) {
  const response = {
    statusCode: 200,
    headers: {},
    contentType: null,
    body: null,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      this.headers["content-type"] = value;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      this.body = JSON.stringify(body);
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  await handleCodeClipYouTubeWebSubVerificationRoute(
    {
      params: { callbackId },
      query,
    },
    response
  );

  return response;
}

function resetCallbackStub(result) {
  callbackCalls.length = 0;
  callbackError = null;
  callbackResult = result;
}

function assertNoLeakedCallbackData(responseText) {
  for (const forbidden of [
    "subscription",
    "topic",
    "providerAccountId",
    "leaseExpiresAt",
    "hub.topic",
    "https://www.youtube.com/feeds/videos.xml",
    "UCrouteLeakChannel1234567890",
  ]) {
    assert.equal(responseText.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("YouTube WebSub route returns plain text challenge for accepted subscribe", async () => {
  resetCallbackStub({
    accepted: true,
    httpStatus: 200,
    challenge: "subscribe-route-challenge",
    mode: "subscribe",
    callbackId: "callback-subscribe",
  });

  const response = await callHandler({
    callbackId: "callback-subscribe",
    query: {
      "hub.mode": "subscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "subscribe-route-challenge",
      "hub.lease_seconds": "86400",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] || "", /^text\/plain/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body, "subscribe-route-challenge");
});

test("YouTube WebSub route returns plain text challenge for accepted unsubscribe", async () => {
  resetCallbackStub({
    accepted: true,
    httpStatus: 200,
    challenge: "unsubscribe-route-challenge",
    mode: "unsubscribe",
    callbackId: "callback-unsubscribe",
  });

  const response = await callHandler({
    callbackId: "callback-unsubscribe",
    query: {
      "hub.mode": "unsubscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "unsubscribe-route-challenge",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] || "", /^text\/plain/);
  assert.equal(response.body, "unsubscribe-route-challenge");
});

test("YouTube WebSub route returns public-safe JSON for unknown callback", async () => {
  resetCallbackStub({
    accepted: false,
    httpStatus: 404,
    mode: "subscribe",
    callbackId: "missing-callback",
    reasonCode: "SUBSCRIPTION_NOT_FOUND",
    subscription: {
      providerAccountId: "UCrouteLeakChannel1234567890",
      topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      leaseExpiresAt: "2026-07-18T00:00:00.000Z",
    },
  });

  const response = await callHandler({
    callbackId: "missing-callback",
    query: {
      "hub.mode": "subscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "hidden-challenge",
      "hub.lease_seconds": "86400",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub verification rejected",
    code: "SUBSCRIPTION_NOT_FOUND",
  });
  assert.equal(response.body.includes("hidden-challenge"), false);
  assertNoLeakedCallbackData(response.body);
});

test("YouTube WebSub route returns public-safe JSON for invalid callbackId", async () => {
  resetCallbackStub({
    accepted: false,
    httpStatus: 400,
    mode: null,
    callbackId: null,
    reasonCode: "CALLBACK_ID_INVALID",
    subscription: {
      providerAccountId: "UCrouteLeakChannel1234567890",
      topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
    },
  });

  const response = await callHandler({
    callbackId: "invalid callback",
    query: {
      "hub.mode": "subscribe",
      "hub.challenge": "hidden-challenge",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub verification rejected",
    code: "CALLBACK_ID_INVALID",
  });
  assertNoLeakedCallbackData(response.body);
});

test("YouTube WebSub route returns 503 public-safe JSON for repository unavailable", async () => {
  resetCallbackStub({
    accepted: false,
    httpStatus: 503,
    mode: "subscribe",
    callbackId: "repository-down",
    reasonCode: "REPOSITORY_UNAVAILABLE",
    topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
    providerAccountId: "UCrouteLeakChannel1234567890",
    leaseExpiresAt: "2026-07-18T00:00:00.000Z",
  });

  const response = await callHandler({
    callbackId: "repository-down",
    query: {
      "hub.mode": "subscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "hidden-challenge",
      "hub.lease_seconds": "86400",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub verification rejected",
    code: "REPOSITORY_UNAVAILABLE",
  });
  assertNoLeakedCallbackData(response.body);
});

test("YouTube WebSub route returns public-safe 500 for unexpected callback exception", async () => {
  resetCallbackStub(null);
  callbackError = new Error("forced callback failure with UCrouteLeakChannel1234567890");

  const response = await callHandler({
    callbackId: "exception-callback",
    query: {
      "hub.mode": "subscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "hidden-challenge",
      "hub.lease_seconds": "86400",
    },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub verification unavailable",
    code: "INTERNAL_ERROR",
  });
  assertNoLeakedCallbackData(response.body);
});

test("YouTube WebSub route forwards URL callbackId, query, and database pool", async () => {
  resetCallbackStub({
    accepted: true,
    httpStatus: 200,
    challenge: "forwarding-challenge",
    mode: "subscribe",
    callbackId: "forward-callback",
  });

  const response = await callHandler({
    callbackId: "forward-callback",
    query: {
      "hub.mode": "subscribe",
      "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      "hub.challenge": "forwarding-challenge",
      "hub.lease_seconds": "86400",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "forwarding-challenge");

  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].input.callbackId, "forward-callback");
  assert.deepEqual(callbackCalls[0].input.query, {
    "hub.mode": "subscribe",
    "hub.topic": "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
    "hub.challenge": "forwarding-challenge",
    "hub.lease_seconds": "86400",
  });
  assert.equal(callbackCalls[0].options.queryClient, queryClient);
});
