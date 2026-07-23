const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

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

const { app, handleCodeClipYouTubeWebSubNotificationRoute } = require("./server");

const YOUTUBE_WEBSUB_CALLBACK_ROUTE = "/api/codeclip/providers/youtube/websub/:callbackId";
const SENSITIVE_POST_CALLBACK_ID = "post-callback-observability-1234567890";
const SENSITIVE_UNKNOWN_CALLBACK_ID = "unknown-callback-observability-1234567890";
const SENSITIVE_XML_BODY =
  "<feed><entry><yt:videoId>yt-video-secret-999</yt:videoId><yt:channelId>yt-channel-secret-888</yt:channelId><title>payload secret marker</title></entry></feed>";
const SENSITIVE_SIGNATURE = "sha256=signature-secret-777";
const SENSITIVE_AUTHORIZATION = "Bearer auth-secret-666";
const SENSITIVE_COOKIE = "session=cookie-secret-555";
const SENSITIVE_CHALLENGE = "post-hub-challenge-secret-444";
const SENSITIVE_VERIFY_TOKEN = "post-hub-token-secret-333";
const SENSITIVE_REQUEST_ID = "request-id-secret-222";
const SENSITIVE_CORRELATION_ID = "correlation-id-secret-111";
const SENSITIVE_RAILWAY_REQUEST_ID = "railway-request-id-secret-000";

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
    SENSITIVE_POST_CALLBACK_ID,
    SENSITIVE_UNKNOWN_CALLBACK_ID,
    SENSITIVE_XML_BODY,
    "yt-video-secret-999",
    "yt-channel-secret-888",
    "payload secret marker",
    SENSITIVE_SIGNATURE,
    "signature-secret-777",
    SENSITIVE_AUTHORIZATION,
    "auth-secret-666",
    SENSITIVE_COOKIE,
    "cookie-secret-555",
    SENSITIVE_CHALLENGE,
    SENSITIVE_VERIFY_TOKEN,
    "hub.challenge",
    "hub.verify_token",
    "authorization",
    "cookie",
    "x-hub-signature",
    "request-id-secret-222",
    "correlation-id-secret-111",
    "railway-request-id-secret-000",
    "requestId",
    "forced notification failure with sensitive details",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function assertNotificationIngressLogs(logs, {
  callbackId = SENSITIVE_POST_CALLBACK_ID,
  statusCode,
  outcome,
  contentType = "application/atom+xml",
  contentLength = Buffer.byteLength(SENSITIVE_XML_BODY),
}) {
  assert.equal(logs.length, 2);
  assert.equal(logs[0].phase, "ingress_received");
  assert.equal(logs[1].phase, "ingress_completed");
  assert.equal(logs[0].method, "POST");
  assert.equal(logs[1].method, "POST");
  assert.equal(logs[0].route, YOUTUBE_WEBSUB_CALLBACK_ROUTE);
  assert.equal(logs[1].route, YOUTUBE_WEBSUB_CALLBACK_ROUTE);
  assert.equal(logs[0].contentType, contentType);
  assert.equal(logs[1].contentType, contentType);
  assert.equal(logs[0].contentLength, contentLength);
  assert.equal(logs[1].contentLength, contentLength);
  assertMaskedCallbackId(logs[0].callbackId, callbackId);
  assertMaskedCallbackId(logs[1].callbackId, callbackId);
  assert.equal(logs[1].statusCode, statusCode);
  assert.equal(logs[1].outcome, outcome);
  assertNoSensitiveIngressFields(logs);
}

function callApp({
  method = "POST",
  path,
  body = Buffer.from(SENSITIVE_XML_BODY),
  headers: requestHeaders = {},
  emitCloseAfterFinish = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
    const req = Readable.from(payload.length > 0 ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "localhost",
      "content-type": "application/atom+xml; charset=utf-8",
      "content-length": String(payload.length),
      "x-hub-signature": SENSITIVE_SIGNATURE,
      "x-request-id": SENSITIVE_REQUEST_ID,
      "x-correlation-id": SENSITIVE_CORRELATION_ID,
      "x-railway-request-id": SENSITIVE_RAILWAY_REQUEST_ID,
      authorization: SENSITIVE_AUTHORIZATION,
      cookie: SENSITIVE_COOKIE,
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
      if (emitCloseAfterFinish) res.emit("close");
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

function callAppClosedBeforeFinish({
  path = `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}`,
  headers: requestHeaders = {},
  markEndedBeforeClose = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = new Readable({
      read() {},
    });
    req.method = "POST";
    req.url = path;
    req.headers = {
      host: "localhost",
      "content-type": "application/atom+xml; charset=utf-8",
      "content-length": String(Buffer.byteLength(SENSITIVE_XML_BODY)),
      "x-hub-signature": SENSITIVE_SIGNATURE,
      "x-request-id": SENSITIVE_REQUEST_ID,
      "x-correlation-id": SENSITIVE_CORRELATION_ID,
      "x-railway-request-id": SENSITIVE_RAILWAY_REQUEST_ID,
      authorization: SENSITIVE_AUTHORIZATION,
      cookie: SENSITIVE_COOKIE,
      ...requestHeaders,
    };

    const res = new Writable({
      write(_chunk, _encoding, callback) {
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
    res.end = () => {};
    if (markEndedBeforeClose) {
      Object.defineProperty(res, "writableEnded", {
        configurable: true,
        value: true,
      });
      assert.equal(res.writableEnded, true);
    }

    app.handle(req, res, reject);
    setImmediate(() => {
      res.emit("close");
      req.destroy();
      setImmediate(resolve);
    });
  });
}

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

test("YouTube WebSub POST ingress logs sanitized accepted notification", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true, status: "processed", processed: 1 },
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, {
      ok: true,
      accepted: true,
      status: "processed",
      processed: 1,
    });
    assertNotificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 202,
      outcome: "accepted",
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs sanitized parser rejection", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });
  const tooLargeBody = Buffer.concat([
    Buffer.from(SENSITIVE_XML_BODY),
    Buffer.alloc(270 * 1024, "x"),
  ]);
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
      body: tooLargeBody,
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.code, "body_too_large");
    assert.equal(notificationCalls.length, 0);
    assertNotificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 413,
      outcome: "rejected",
      contentLength: tooLargeBody.length,
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs sanitized unknown callback rejection", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 404,
    payload: {
      ok: false,
      error: "YouTube WebSub notification rejected",
      code: "subscription_not_found",
      subscription: { providerAccountId: "UCrouteLeakChannel1234567890" },
    },
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_UNKNOWN_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      ok: false,
      error: "YouTube WebSub notification rejected",
      code: "subscription_not_found",
    });
    assertNotificationIngressLogs(getIngressLogPayloads(capture.entries), {
      callbackId: SENSITIVE_UNKNOWN_CALLBACK_ID,
      statusCode: 404,
      outcome: "rejected",
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs sanitized route exception", { concurrency: false }, async () => {
  resetNotificationStub(null);
  notificationError = new Error("forced notification failure with sensitive details");
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      ok: false,
      error: "YouTube WebSub notification unavailable",
      code: "INTERNAL_ERROR",
    });
    assertNotificationIngressLogs(getIngressLogPayloads(capture.entries), {
      statusCode: 500,
      outcome: "failed",
    });
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs premature close as aborted", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });
  const capture = captureStructuredLogs();
  try {
    await callAppClosedBeforeFinish({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
    });

    const logs = getIngressLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].phase, "ingress_received");
    assert.equal(logs[1].phase, "ingress_completed");
    assert.equal(logs[1].completion, "close");
    assert.equal(logs[1].statusCode, null);
    assert.equal(logs[1].outcome, "aborted");
    assertNoSensitiveIngressFields(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs close before finish as aborted after end was marked", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });
  const capture = captureStructuredLogs();
  try {
    await callAppClosedBeforeFinish({
      path:
        `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}` +
        `?hub.challenge=${encodeURIComponent(SENSITIVE_CHALLENGE)}` +
        `&hub.verify_token=${encodeURIComponent(SENSITIVE_VERIFY_TOKEN)}`,
      markEndedBeforeClose: true,
    });

    const logs = getIngressLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].phase, "ingress_received");
    assert.equal(logs[1].phase, "ingress_completed");
    assert.equal(logs[1].completion, "close");
    assert.equal(logs[1].statusCode, null);
    assert.equal(logs[1].outcome, "aborted");
    assertNoSensitiveIngressFields(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress logs one completion for finish followed by close", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path: `/api/codeclip/providers/youtube/websub/${SENSITIVE_POST_CALLBACK_ID}`,
      emitCloseAfterFinish: true,
    });

    assert.equal(response.status, 202);
    const logs = getIngressLogPayloads(capture.entries);
    assert.equal(logs.filter((log) => log.phase === "ingress_received").length, 1);
    assert.equal(logs.filter((log) => log.phase === "ingress_completed").length, 1);
    assert.equal(logs.find((log) => log.phase === "ingress_completed").completion, "finish");
    assertNoSensitiveIngressFields(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub POST ingress masks short callback IDs", { concurrency: false }, async () => {
  resetNotificationStub({
    httpStatus: 202,
    payload: { ok: true, accepted: true },
  });
  const capture = captureStructuredLogs();
  try {
    const response = await callApp({
      path: "/api/codeclip/providers/youtube/websub/abc",
    });

    assert.equal(response.status, 202);
    const logs = getIngressLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertMaskedCallbackId(logs[0].callbackId, "abc");
    assertMaskedCallbackId(logs[1].callbackId, "abc");
    assertNoSensitiveIngressFields(logs);
  } finally {
    capture.restore();
  }
});
