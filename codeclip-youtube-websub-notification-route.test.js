const test = require("node:test");
const assert = require("node:assert/strict");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const notificationModulePath = require.resolve(
  "./verticals/codeclip/youtube-websub-notification"
);

const queryClient = { name: "codeclip-youtube-websub-notification-route-test-pool" };
const notificationCalls = [];
let notificationResult = null;
let notificationError = null;

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

require.cache[notificationModulePath] = {
  id: notificationModulePath,
  filename: notificationModulePath,
  loaded: true,
  exports: {
    processCodeClipYouTubeWebSubNotification: async (input, options) => {
      notificationCalls.push({ input, options });
      if (notificationError) throw notificationError;
      return notificationResult;
    },
  },
};

const { handleCodeClipYouTubeWebSubNotificationRoute } = require("./server");

async function callHandler({
  callbackId = "callback-route",
  headers = {},
  rawBody = Buffer.from("<feed/>"),
} = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
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

  await handleCodeClipYouTubeWebSubNotificationRoute(
    {
      params: { callbackId },
      headers,
      body: rawBody,
      codeClipRawBody: rawBody,
    },
    response
  );

  return response;
}

function resetNotificationStub(result) {
  notificationCalls.length = 0;
  notificationError = null;
  notificationResult = result;
}

function assertNoLeakedNotificationData(responseText) {
  for (const forbidden of [
    "subscription",
    "topic",
    "providerAccountId",
    "leaseExpiresAt",
    "UCrouteLeakChannel1234567890",
    "<feed",
    "x-hub-signature",
  ]) {
    assert.equal(responseText.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("YouTube WebSub POST route returns public-safe accepted JSON", async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: {
      ok: true,
      accepted: true,
      status: "processed",
      processed: 1,
      subscription: { providerAccountId: "UCrouteLeakChannel1234567890" },
    },
  });

  const response = await callHandler({
    callbackId: "callback-post",
    headers: {
      "content-type": "application/atom+xml",
      "x-hub-signature": "sha256=hidden",
    },
    rawBody: Buffer.from("<feed><entry/></feed>"),
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.jsonBody, {
    ok: true,
    accepted: true,
    status: "processed",
    processed: 1,
  });
  assertNoLeakedNotificationData(response.body);
});

test("YouTube WebSub POST route forwards callbackId, headers, raw body, and database pool", async () => {
  const rawBody = Buffer.from("<feed><entry/></feed>");
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });

  const response = await callHandler({
    callbackId: "forward-callback",
    headers: {
      "content-type": "text/xml",
      "x-hub-signature": "sha256=hidden",
    },
    rawBody,
  });

  assert.equal(response.statusCode, 202);
  assert.equal(notificationCalls.length, 1);
  assert.equal(notificationCalls[0].input.callbackId, "forward-callback");
  assert.equal(notificationCalls[0].input.headers["content-type"], "text/xml");
  assert.equal(notificationCalls[0].input.rawBody, rawBody);
  assert.equal(notificationCalls[0].options.queryClient, queryClient);
});

test("YouTube WebSub POST route returns allowlisted rejection JSON", async () => {
  resetNotificationStub({
    httpStatus: 401,
    payload: {
      ok: false,
      error: "YouTube WebSub notification rejected",
      code: "signature_invalid",
      subscription: { providerAccountId: "UCrouteLeakChannel1234567890" },
      topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteLeakChannel1234567890",
      leaseExpiresAt: "2026-07-19T10:00:00.000Z",
    },
  });

  const response = await callHandler({
    callbackId: "callback-reject",
    rawBody: Buffer.from("<feed><entry/></feed>"),
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub notification rejected",
    code: "signature_invalid",
  });
  assertNoLeakedNotificationData(response.body);
});

test("YouTube WebSub POST route returns public-safe 500 for unexpected exception", async () => {
  resetNotificationStub(null);
  notificationError = new Error("forced failure with UCrouteLeakChannel1234567890");

  const response = await callHandler({
    callbackId: "callback-exception",
    rawBody: Buffer.from("<feed><entry/></feed>"),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.jsonBody, {
    ok: false,
    error: "YouTube WebSub notification unavailable",
    code: "INTERNAL_ERROR",
  });
  assertNoLeakedNotificationData(response.body);
});
