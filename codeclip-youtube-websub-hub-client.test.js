const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipYouTubeWebSubHubError,
  YOUTUBE_WEBSUB_HUB_URL,
  requestSubscription,
} = require("./verticals/codeclip/youtube-websub-hub-client");

const CALLBACK_URL = "https://backend.example.test/api/codeclip/providers/youtube/websub/yt_cb";
const TOPIC = "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa";
const OBSERVABLE_CALLBACK_URL =
  "https://backend.example.test/api/codeclip/providers/youtube/websub/yt_observable_callback_secret_1234567890";
const OBSERVABLE_CALLBACK_PATH =
  "/api/codeclip/providers/youtube/websub/yt_observable_callback_secret_1234567890";
const EXPECTED_MASKED_CALLBACK_PATH =
  "/api/codeclip/providers/youtube/websub/yt_obs...7890";
const OBSERVABLE_TOPIC =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCobservableChannel1234567890";
const OBSERVABLE_SECRET = "derived-observability-secret-123";
const OBSERVABLE_ATTEMPT_ID = "attempt_observability_secret_1234567890";
const EXPECTED_MASKED_ATTEMPT_ID = "attempt...7890";

function createFetch(status = 202) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status };
  };
  return { calls, fetchImpl };
}

function createHeaders(headers = {}) {
  return {
    get(name) {
      const key = Object.keys(headers).find(
        (candidate) => candidate.toLowerCase() === String(name || "").toLowerCase()
      );
      return key ? headers[key] : null;
    },
  };
}

function captureHubRequestLogs({ throwOnLog = false } = {}) {
  const originalLog = console.log;
  const entries = [];
  console.log = (...args) => {
    entries.push(args);
    if (throwOnLog) {
      throw new Error("hub request logger failure with derived-observability-secret-123");
    }
  };
  return {
    entries,
    restore() {
      console.log = originalLog;
    },
  };
}

function getHubRequestLogPayloads(entries) {
  return entries
    .map((args) => args.find((value) => value && typeof value === "object"))
    .filter((payload) => payload?.eventName === "codeclip_youtube_websub_hub_request");
}

function assertSanitizedCallbackPath(value) {
  assert.equal(value, EXPECTED_MASKED_CALLBACK_PATH);
  assert.equal(value.startsWith("/api/codeclip/providers/youtube/websub/"), true);
  assert.equal(value.includes("yt_observable_callback_secret_1234567890"), false);
  assert.equal(value.includes("?"), false);
  assert.equal(value.includes("backend.example.test"), false);
  assert.equal(value.includes("https://"), false);
}

function assertNoHubRequestSecretLeak(logs) {
  const text = JSON.stringify(logs);
  for (const forbidden of [
    OBSERVABLE_SECRET,
    "hub.secret",
    "derived-observability-secret-123",
    "yt_observable_callback_secret_1234567890",
    OBSERVABLE_CALLBACK_PATH,
    OBSERVABLE_ATTEMPT_ID,
    "hub.callback=",
    "hub.mode=",
    "hub.topic=",
    "hub.verify=",
    "hub.lease_seconds=",
    "Authorization",
    "authorization",
    "Cookie",
    "cookie",
    "hub.challenge",
    "hub.verify_token",
    "challenge-secret",
    "verify-token-secret",
    "network failure with derived-observability-secret-123",
    "logger failure with derived-observability-secret-123",
    "response body secret",
    "https://evil.example.test/secret/path?token=hidden",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function assertStartedLog(log, overrides = {}) {
  assert.equal(log.eventName, "codeclip_youtube_websub_hub_request");
  assert.equal(log.phase, "request_started");
  assert.equal(typeof log.timestamp, "string");
  assert.equal(log.operationMode, overrides.operationMode || "renew");
  assert.equal(log.hubMode, overrides.hubMode || "subscribe");
  assert.equal(log.hubEndpoint, YOUTUBE_WEBSUB_HUB_URL);
  assert.equal(log.method, "POST");
  assert.equal(log.contentType, "application/x-www-form-urlencoded");
  assert.equal(log.topic, OBSERVABLE_TOPIC);
  assert.equal(log.callbackHost, "backend.example.test");
  assertSanitizedCallbackPath(log.callbackPath);
  assert.equal(log.verifyMode, "async");
  assert.equal(log.leaseSeconds, overrides.leaseSeconds ?? 864000);
  assert.equal(log.hasSecret, true);
  assert.equal(log.attemptNumber, 2);
  assert.equal(log.attemptId, EXPECTED_MASKED_ATTEMPT_ID);
}

async function requestObservableSubscription(fetchImpl, overrides = {}) {
  return requestSubscription({
    mode: "subscribe",
    operationMode: "renew",
    callbackUrl: `${OBSERVABLE_CALLBACK_URL}?hub.challenge=challenge-secret&hub.verify_token=verify-token-secret`,
    topic: OBSERVABLE_TOPIC,
    secret: OBSERVABLE_SECRET,
    leaseSeconds: 864000,
    attemptNumber: 2,
    attemptId: OBSERVABLE_ATTEMPT_ID,
    fetchImpl,
    ...overrides,
  });
}

test("YouTube WebSub hub client sends form encoded subscribe request", async () => {
  const { calls, fetchImpl } = createFetch(202);
  const result = await requestSubscription({
    mode: "subscribe",
    callbackUrl: CALLBACK_URL,
    topic: TOPIC,
    secret: "derived-secret",
    leaseSeconds: 864000,
    fetchImpl,
  });
  const body = calls[0].options.body;

  assert.deepEqual(result, {
    ok: true,
    code: "hub_request_accepted",
    status: 202,
    mode: "subscribe",
  });
  assert.equal(calls[0].url, YOUTUBE_WEBSUB_HUB_URL);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(body.get("hub.callback"), CALLBACK_URL);
  assert.equal(body.get("hub.mode"), "subscribe");
  assert.equal(body.get("hub.topic"), TOPIC);
  assert.equal(body.get("hub.verify"), "async");
  assert.equal(body.get("hub.secret"), "derived-secret");
  assert.equal(body.get("hub.lease_seconds"), "864000");
  assert.equal(JSON.stringify(result).includes("derived-secret"), false);
});

test("YouTube WebSub hub client sends unsubscribe without lease", async () => {
  const { calls, fetchImpl } = createFetch(204);
  const result = await requestSubscription({
    mode: "unsubscribe",
    callbackUrl: CALLBACK_URL,
    topic: TOPIC,
    secret: "derived-secret",
    fetchImpl,
  });
  const body = calls[0].options.body;

  assert.equal(result.ok, true);
  assert.equal(result.mode, "unsubscribe");
  assert.equal(body.get("hub.mode"), "unsubscribe");
  assert.equal(body.get("hub.verify"), "async");
  assert.equal(body.has("hub.lease_seconds"), false);
});

test("YouTube WebSub hub client maps timeout, network and non-2xx failures safely", async () => {
  const non2xx = await requestSubscription({
    mode: "subscribe",
    callbackUrl: CALLBACK_URL,
    topic: TOPIC,
    secret: "derived-secret",
    leaseSeconds: 10,
    fetchImpl: async () => ({ status: 500 }),
  });
  const network = await requestSubscription({
    mode: "subscribe",
    callbackUrl: CALLBACK_URL,
    topic: TOPIC,
    secret: "derived-secret",
    leaseSeconds: 10,
    fetchImpl: async () => {
      throw new Error("network includes derived-secret but must not leak");
    },
  });

  assert.deepEqual(non2xx, {
    ok: false,
    code: "hub_request_failed",
    status: 500,
    mode: "subscribe",
  });
  assert.deepEqual(network, {
    ok: false,
    code: "hub_request_failed",
    status: 0,
    mode: "subscribe",
  });
  assert.equal(JSON.stringify(network).includes("derived-secret"), false);
});

test("YouTube WebSub hub client rejects invalid mode and lease before fetch", async () => {
  await assert.rejects(
    () => requestSubscription({
      mode: "publish",
      callbackUrl: CALLBACK_URL,
      topic: TOPIC,
      secret: "derived-secret",
      fetchImpl: async () => ({ status: 202 }),
    }),
    CodeClipYouTubeWebSubHubError
  );
  await assert.rejects(
    () => requestSubscription({
      mode: "subscribe",
      callbackUrl: CALLBACK_URL,
      topic: TOPIC,
      secret: "derived-secret",
      fetchImpl: async () => ({ status: 202 }),
    }),
    (error) => error.code === "INVALID_HUB_REQUEST"
  );
});

test("YouTube WebSub hub client logs sanitized request_started and accepted completion", { concurrency: false }, async () => {
  const capture = captureHubRequestLogs();
  try {
    const result = await requestObservableSubscription(async () => ({
      status: 202,
      headers: createHeaders({
        "content-type": "text/plain",
        "content-length": "0",
      }),
      text: async () => "response body secret",
    }));

    assert.deepEqual(result, {
      ok: true,
      code: "hub_request_accepted",
      status: 202,
      mode: "subscribe",
    });

    const logs = getHubRequestLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertStartedLog(logs[0]);
    assert.equal(logs[1].phase, "request_completed");
    assert.equal(logs[1].completion, "finish");
    assert.equal(logs[1].statusCode, 202);
    assert.equal(logs[1].outcome, "accepted");
    assert.equal(Number.isSafeInteger(logs[1].durationMs), true);
    assert.equal(logs[1].redirected, false);
    assert.equal(logs[1].locationHost, null);
    assert.equal(logs[1].responseContentType, "text/plain");
    assert.equal(logs[1].responseContentLength, 0);
    assert.equal(logs[1].resultCode, "hub_request_accepted");
    assert.equal(logs[1].retryEligible, false);
    assert.equal(logs[1].callbackPath, logs[0].callbackPath);
    assert.equal(logs[1].attemptId, logs[0].attemptId);
    assertNoHubRequestSecretLeak(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub hub client logs sanitized non-2xx rejection", { concurrency: false }, async () => {
  const capture = captureHubRequestLogs();
  try {
    const result = await requestObservableSubscription(async () => ({
      status: 503,
      headers: createHeaders({
        "content-type": "text/html",
        "content-length": "128",
      }),
      text: async () => "response body secret",
    }));

    assert.deepEqual(result, {
      ok: false,
      code: "hub_request_failed",
      status: 503,
      mode: "subscribe",
    });

    const logs = getHubRequestLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertStartedLog(logs[0]);
    assert.equal(logs[1].phase, "request_completed");
    assert.equal(logs[1].statusCode, 503);
    assert.equal(logs[1].outcome, "rejected");
    assert.equal(logs[1].responseContentType, "text/html");
    assert.equal(logs[1].responseContentLength, 128);
    assert.equal(logs[1].resultCode, "hub_request_failed");
    assert.equal(logs[1].retryEligible, true);
    assertNoHubRequestSecretLeak(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub hub client logs sanitized redirect response without following", { concurrency: false }, async () => {
  const calls = [];
  const capture = captureHubRequestLogs();
  try {
    const result = await requestObservableSubscription(async (url, options) => {
      calls.push({ url, options });
      return {
        status: 302,
        headers: createHeaders({
          location: "https://evil.example.test/secret/path?token=hidden",
          "content-type": "text/plain",
          "content-length": "7",
        }),
      };
    });

    assert.deepEqual(result, {
      ok: false,
      code: "hub_request_failed",
      status: 302,
      mode: "subscribe",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, "manual");

    const logs = getHubRequestLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertStartedLog(logs[0]);
    assert.equal(logs[1].phase, "request_completed");
    assert.equal(logs[1].statusCode, 302);
    assert.equal(logs[1].outcome, "redirected");
    assert.equal(logs[1].redirected, true);
    assert.equal(logs[1].locationHost, "evil.example.test");
    assert.equal(logs[1].resultCode, "hub_request_failed");
    assert.equal(logs[1].retryEligible, false);
    assertNoHubRequestSecretLeak(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub hub client logs sanitized timeout failure", { concurrency: false }, async () => {
  const capture = captureHubRequestLogs();
  try {
    const result = await requestObservableSubscription(async () => {
      const error = new Error("timeout with derived-observability-secret-123");
      error.name = "AbortError";
      throw error;
    });

    assert.deepEqual(result, {
      ok: false,
      code: "hub_request_timeout",
      status: 0,
      mode: "subscribe",
    });

    const logs = getHubRequestLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertStartedLog(logs[0]);
    assert.equal(logs[1].phase, "request_failed");
    assert.equal(logs[1].outcome, "failed");
    assert.equal(Number.isSafeInteger(logs[1].durationMs), true);
    assert.equal(logs[1].errorClass, "timeout");
    assert.equal(logs[1].resultCode, "hub_request_timeout");
    assert.equal(logs[1].retryEligible, true);
    assertNoHubRequestSecretLeak(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub hub client logs sanitized network failure", { concurrency: false }, async () => {
  const capture = captureHubRequestLogs();
  try {
    const result = await requestObservableSubscription(async () => {
      throw new Error("network failure with derived-observability-secret-123");
    });

    assert.deepEqual(result, {
      ok: false,
      code: "hub_request_failed",
      status: 0,
      mode: "subscribe",
    });

    const logs = getHubRequestLogPayloads(capture.entries);
    assert.equal(logs.length, 2);
    assertStartedLog(logs[0]);
    assert.equal(logs[1].phase, "request_failed");
    assert.equal(logs[1].outcome, "failed");
    assert.equal(logs[1].errorClass, "network_error");
    assert.equal(logs[1].resultCode, "hub_request_failed");
    assert.equal(logs[1].retryEligible, true);
    assertNoHubRequestSecretLeak(logs);
  } finally {
    capture.restore();
  }
});

test("YouTube WebSub hub request logging failure does not alter accepted result", { concurrency: false }, async () => {
  const capture = captureHubRequestLogs({ throwOnLog: true });
  try {
    const result = await requestObservableSubscription(async () => ({
      status: 202,
      headers: createHeaders({ "content-type": "text/plain" }),
    }));

    assert.deepEqual(result, {
      ok: true,
      code: "hub_request_accepted",
      status: 202,
      mode: "subscribe",
    });
    assert.equal(capture.entries.length >= 2, true);
  } finally {
    capture.restore();
  }
});
