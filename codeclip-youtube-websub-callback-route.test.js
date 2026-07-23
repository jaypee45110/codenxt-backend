const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

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

const { app, handleCodeClipYouTubeWebSubVerificationRoute } = require("./server");

const YOUTUBE_WEBSUB_CALLBACK_ROUTE = "/api/codeclip/providers/youtube/websub/:callbackId";
const SENSITIVE_GET_CALLBACK_ID = "get-callback-observability-1234567890";
const SENSITIVE_GET_CHALLENGE = "hidden-route-challenge-123";
const SENSITIVE_GET_VERIFY_TOKEN = "hidden-route-token-456";
const SENSITIVE_GET_AUTHORIZATION = "Bearer get-auth-secret-789";
const SENSITIVE_GET_COOKIE = "session=get-cookie-secret-012";
const SENSITIVE_GET_REQUEST_ID = "get-request-id-secret-345";

function captureStructuredLogs() {
  const originalLog = console.log;
  const entries = [];
  console.log = (...args) => {
    entries.push(args);
  };
  return {
    entries,
    restore() {
      console.log = originalLog;
    },
  };
}

function getIngressLogPayloads(entries) {
  return entries
    .map((args) => args.find((value) => value && typeof value === "object"))
    .filter((payload) => payload?.eventName === "codeclip_youtube_websub_ingress");
}

function assertMaskedCallbackId(value, fullCallbackId) {
  assert.equal(typeof value, "string");
  assert.notEqual(value, fullCallbackId);
  assert.match(value, /\.\.\./);
}

function assertNoSensitiveIngressFields(logs) {
  const text = JSON.stringify(logs);
  for (const forbidden of [
    SENSITIVE_GET_CALLBACK_ID,
    SENSITIVE_GET_CHALLENGE,
    SENSITIVE_GET_VERIFY_TOKEN,
    SENSITIVE_GET_AUTHORIZATION,
    "get-auth-secret-789",
    SENSITIVE_GET_COOKIE,
    "get-cookie-secret-012",
    SENSITIVE_GET_REQUEST_ID,
    "hub.challenge",
    "hub.verify_token",
    "authorization",
    "cookie",
    "requestId",
    "UCrouteLeakChannel1234567890",
    "forced GET failure with sensitive details",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function assertVerificationIngressLogs(logs, {
  statusCode,
  outcome,
  contentType = null,
  contentLength = 0,
}) {
  assert.equal(logs.length, 2);
  assert.equal(logs[0].phase, "ingress_received");
  assert.equal(logs[1].phase, "ingress_completed");
  assert.equal(logs[0].method, "GET");
  assert.equal(logs[1].method, "GET");
  assert.equal(logs[0].route, YOUTUBE_WEBSUB_CALLBACK_ROUTE);
  assert.equal(logs[1].route, YOUTUBE_WEBSUB_CALLBACK_ROUTE);
  assert.equal(logs[0].contentType, contentType);
  assert.equal(logs[1].contentType, contentType);
  assert.equal(logs[0].contentLength, contentLength);
  assert.equal(logs[1].contentLength, contentLength);
  assertMaskedCallbackId(logs[0].callbackId, SENSITIVE_GET_CALLBACK_ID);
  assertMaskedCallbackId(logs[1].callbackId, SENSITIVE_GET_CALLBACK_ID);
  assert.equal(logs[1].completion, "finish");
  assert.equal(logs[1].statusCode, statusCode);
  assert.equal(logs[1].outcome, outcome);
  assertNoSensitiveIngressFields(logs);
}

function callApp({
  method = "GET",
  path,
  headers: requestHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "localhost",
      "content-length": "0",
      authorization: SENSITIVE_GET_AUTHORIZATION,
      cookie: SENSITIVE_GET_COOKIE,
      "x-request-id": SENSITIVE_GET_REQUEST_ID,
      ...requestHeaders,
    };

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => {
      res.headers[String(name).toLowerCase()] = value;
    };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => {
      delete res.headers[String(name).toLowerCase()];
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      res.emit("finish");
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: parsed,
      });
    };

    app.handle(req, res, reject);
  });
}

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

test("YouTube WebSub GET ingress logs sanitized accepted verification", { concurrency: false }, async () => {
  resetCallbackStub({
    accepted: true,
    httpStatus: 200,
    challenge: SENSITIVE_GET_CHALLENGE,
    mode: "subscribe",
    callbackId: SENSITIVE_GET_CALLBACK_ID,
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_GET_CALLBACK_ID}` +
        "?hub.mode=subscribe" +
        "&hub.topic=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fchannel_id%3DUCrouteLeakChannel1234567890" +
        `&hub.challenge=${encodeURIComponent(SENSITIVE_GET_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_GET_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 200);
    assert.equal(response.text, SENSITIVE_GET_CHALLENGE);
    assertVerificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 200,
      outcome: "accepted",
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub GET ingress logs sanitized rejected verification", { concurrency: false }, async () => {
  resetCallbackStub({
    accepted: false,
    httpStatus: 400,
    mode: null,
    callbackId: null,
    reasonCode: "MODE_INVALID",
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_GET_CALLBACK_ID}` +
        "?hub.mode=invalid" +
        `&hub.challenge=${encodeURIComponent(SENSITIVE_GET_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_GET_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "MODE_INVALID");
    assertVerificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 400,
      outcome: "rejected",
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub GET ingress logs sanitized route exception", { concurrency: false }, async () => {
  resetCallbackStub(null);
  callbackError = new Error("forced GET failure with sensitive details");
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_GET_CALLBACK_ID}` +
        "?hub.mode=subscribe" +
        `&hub.challenge=${encodeURIComponent(SENSITIVE_GET_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_GET_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, "INTERNAL_ERROR");
    assertVerificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 500,
      outcome: "failed",
    });
  } finally {
    capture.restore();
  }
});
