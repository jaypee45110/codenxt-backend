const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipYouTubeWebSubHubError,
  YOUTUBE_WEBSUB_HUB_URL,
  requestSubscription,
} = require("./verticals/codeclip/youtube-websub-hub-client");

const CALLBACK_URL = "https://backend.example.test/api/codeclip/providers/youtube/websub/yt_cb";
const TOPIC = "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa";

function createFetch(status = 202) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status };
  };
  return { calls, fetchImpl };
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
