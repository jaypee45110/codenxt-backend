const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizeCodeClipProviderPollAdapterInput,
  normalizeCodeClipProviderPollAdapterResult,
} = require("./verticals/codeclip/provider-polling/adapter-contract");
const {
  CodeClipTikTokPollAdapterError,
  createCodeClipTikTokPollAdapter,
} = require("./verticals/codeclip/tiktok/poll-adapter");

const TOKEN = "tiktok-access-token-secret-do-not-leak";
const NOW = "2026-08-05T12:00:00.000Z";

function responsePage({ videos = [], cursor = 0, hasMore = false } = {}) {
  return {
    data: { videos, cursor, has_more: hasMore },
    error: { code: "ok", message: "", log_id: "" },
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "application/json"
          : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function captureFetch(pages) {
  const calls = [];
  const queue = Array.isArray(pages) ? pages.slice() : [pages];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    return typeof next === "function" ? next(url, init, calls) : jsonResponse(next);
  };
  return { fetchImpl, calls };
}

function input(overrides = {}) {
  return normalizeCodeClipProviderPollAdapterInput({
    provider: "tiktok",
    environment: "sandbox",
    providerAccountId: "OpenId_TikTok_Account_1",
    accessToken: TOKEN,
    checkpoint: {},
    now: NOW,
    limit: 25,
    ...overrides,
  });
}

function video(id, createTimeSec, overrides = {}) {
  return {
    id,
    create_time: createTimeSec,
    share_url: `https://www.tiktok.com/@acct/video/${encodeURIComponent(id)}`,
    title: "ignored title",
    duration: 9,
    ...overrides,
  };
}

function normalizeResult(result) {
  return normalizeCodeClipProviderPollAdapterResult(result, { provider: "tiktok" });
}

function assertNoLeak(value) {
  const text = JSON.stringify(value, (_key, v) =>
    typeof v === "function" ? "[Function]" : v
  );
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes("Authorization"), false);
  assert.equal(text.includes("raw TikTok message"), false);
}

test("public API and descriptor are exact", () => {
  const mod = require("./verticals/codeclip/tiktok/poll-adapter");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipTikTokPollAdapterError",
    "createCodeClipTikTokPollAdapter",
  ]);
  const adapter = createCodeClipTikTokPollAdapter({});
  assert.deepEqual(Object.keys(adapter).sort(), ["poll", "provider"]);
  assert.equal(adapter.provider, "tiktok");
  assert.equal(typeof adapter.poll, "function");
  assert.equal(Object.isFrozen(adapter), true);
});

test("module has no DB, credential refresh, credential repository, or console imports", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/tiktok/poll-adapter.js"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
  assert.equal(/require\(["'].*db/.test(source), false);
  assert.equal(/credential-refresh|provider-credentials|provider-account-bindings/.test(source), false);
  assert.equal(/refreshCodeClipTikTokCredential/.test(source), false);
});

test("passes generic input to Display client request with provider maxCount cap", async () => {
  for (const [limit, expected] of [[1, 1], [20, 20], [25, 20], [50, 20]]) {
    const harness = captureFetch(responsePage());
    const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl, timeoutMs: 1000 });
    const result = await adapter.poll(input({ limit }));
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(harness.calls[0].init.body).max_count, expected);
    assert.equal(JSON.parse(harness.calls[0].init.body).cursor, undefined);
    assert.equal(new URL(harness.calls[0].url).searchParams.get("fields"), "id,create_time,share_url,title,duration");
    assert.equal(harness.calls[0].url.includes(TOKEN), false);
    assert.equal(harness.calls[0].init.body.includes(TOKEN), false);
    assert.equal(harness.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("baseline first poll emits no detections and ignores historical pagination", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [video("newest", 200), video("older", 100)],
      cursor: 999,
      hasMore: true,
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(await adapter.poll(input()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.detections, []);
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:03:20.000Z",
    highWaterVideoId: "newest",
  });
  assert.equal(result.page.complete, true);
  assert.equal(Object.hasOwn(result.nextCheckpoint, "cursor"), false);
});

test("empty baseline initializes without high-water", async () => {
  const adapter = createCodeClipTikTokPollAdapter({
    fetchImpl: captureFetch(responsePage()).fetchImpl,
  });
  const result = normalizeResult(await adapter.poll(input()));
  assert.deepEqual(result.nextCheckpoint, { initialized: true });
  assert.deepEqual(result.detections, []);
  assert.equal(result.page.complete, true);
});

test("normal poll emits only newer videos oldest first and updates high-water", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [
        video("mid", 200),
        video("top", 300),
        video("old", 100),
        video("same", 100),
      ],
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "same",
        },
      })
    )
  );
  assert.deepEqual(
    result.detections.map((d) => d.providerObjectId),
    ["mid", "top"]
  );
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:05:00.000Z",
    highWaterVideoId: "top",
  });
  assert.equal(result.detections[0].source, "display_api_polling");
  assert.equal(result.detections[0].deliverySource, "provider_polling");
  assert.equal(result.detections[0].publishedAt, "1970-01-01T00:03:20.000Z");
  assert.equal(result.detections[0].detectedAt, NOW);
  assert.equal(result.detections[0].rawType, "video");
  assert.equal(Object.hasOwn(result.detections[0], "title"), false);
  assert.equal(Object.hasOwn(result.detections[0], "duration"), false);
});

test("same timestamp uses video id tie-breaker deterministically", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [video("c", 100), video("a", 100), video("b", 100)],
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "a",
        },
      })
    )
  );
  assert.deepEqual(
    result.detections.map((d) => d.providerObjectId),
    ["b", "c"]
  );
  assert.equal(result.nextCheckpoint.highWaterVideoId, "c");
});

test("normal poll starts incomplete pagination when all videos are newer", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [video("n2", 300), video("n1", 200)],
      cursor: 555,
      hasMore: true,
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "old",
        },
      })
    )
  );
  assert.equal(result.page.complete, false);
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
    highWaterVideoId: "old",
    pendingHighWaterPublishedAt: "1970-01-01T00:05:00.000Z",
    pendingHighWaterVideoId: "n2",
    cursor: 555,
  });
});

test("incomplete pagination uses cursor, preserves cutoff, then promotes pending high-water", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [video("n0", 150), video("old", 100)],
      cursor: 0,
      hasMore: false,
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "old",
          pendingHighWaterPublishedAt: "1970-01-01T00:05:00.000Z",
          pendingHighWaterVideoId: "n2",
          cursor: 555,
        },
      })
    )
  );
  assert.equal(JSON.parse(harness.calls[0].init.body).cursor, 555);
  assert.deepEqual(result.detections.map((d) => d.providerObjectId), ["n0"]);
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:05:00.000Z",
    highWaterVideoId: "n2",
  });
  assert.equal(result.page.complete, true);
});

test("incomplete pagination continues when old boundary is not reached", async () => {
  const harness = captureFetch(
    responsePage({
      videos: [video("n3", 400), video("n0", 150)],
      cursor: 777,
      hasMore: true,
    })
  );
  const adapter = createCodeClipTikTokPollAdapter({ fetchImpl: harness.fetchImpl });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "old",
          pendingHighWaterPublishedAt: "1970-01-01T00:05:00.000Z",
          pendingHighWaterVideoId: "n2",
          cursor: 555,
        },
      })
    )
  );
  assert.equal(JSON.parse(harness.calls[0].init.body).cursor, 555);
  assert.equal(result.page.complete, false);
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
    highWaterVideoId: "old",
    pendingHighWaterPublishedAt: "1970-01-01T00:06:40.000Z",
    pendingHighWaterVideoId: "n3",
    cursor: 777,
  });
});

test("empty later page completes and promotes pending high-water", async () => {
  const adapter = createCodeClipTikTokPollAdapter({
    fetchImpl: captureFetch(responsePage()).fetchImpl,
  });
  const result = normalizeResult(
    await adapter.poll(
      input({
        checkpoint: {
          initialized: true,
          highWaterPublishedAt: "1970-01-01T00:01:40.000Z",
          highWaterVideoId: "old",
          pendingHighWaterPublishedAt: "1970-01-01T00:05:00.000Z",
          pendingHighWaterVideoId: "n2",
          cursor: 555,
        },
      })
    )
  );
  assert.deepEqual(result.detections, []);
  assert.deepEqual(result.nextCheckpoint, {
    initialized: true,
    highWaterPublishedAt: "1970-01-01T00:05:00.000Z",
    highWaterVideoId: "n2",
  });
});

test("checkpoint validation fails closed", async () => {
  const adapter = createCodeClipTikTokPollAdapter({
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  for (const checkpoint of [
    { extra: true },
    { initialized: "true" },
    { initialized: true, highWaterPublishedAt: "bad", highWaterVideoId: "id" },
    { initialized: true, highWaterPublishedAt: "2026-08-05T10:00:00Z", highWaterVideoId: "id" },
    { initialized: true, highWaterPublishedAt: "2026-08-05T10:00:00.000Z" },
    { initialized: true, highWaterVideoId: "id" },
    { initialized: true, pendingHighWaterPublishedAt: "2026-08-05T10:00:00.000Z", pendingHighWaterVideoId: "id" },
    { initialized: true, cursor: 1 },
    { initialized: true, highWaterPublishedAt: "2026-08-05T10:00:00.000Z", highWaterVideoId: "id", cursor: 1 },
    { initialized: true, highWaterPublishedAt: "2026-08-05T10:00:00.000Z", highWaterVideoId: "id", pendingHighWaterPublishedAt: "2026-08-05T10:00:00.000Z", cursor: 1 },
    { initialized: true, highWaterPublishedAt: "2026-08-05T10:00:00.000Z", highWaterVideoId: "id", pendingHighWaterPublishedAt: "2026-08-05T10:00:00.000Z", pendingHighWaterVideoId: "id", cursor: "1" },
    { initialized: true, highWaterPublishedAt: { nested: true }, highWaterVideoId: "id" },
  ]) {
    await assert.rejects(
      () => adapter.poll(input({ checkpoint })),
      (error) => {
        assert.ok(error instanceof CodeClipTikTokPollAdapterError);
        assert.equal(error.code, "INVALID_CHECKPOINT");
        assert.equal(JSON.stringify(error).includes("stack"), false);
        assertNoLeak(error);
        return true;
      }
    );
  }
});

test("Display client errors map to generic adapter classifications safely", async () => {
  const cases = [
    ["access_token_invalid", "reauthorization_required"],
    ["scope_not_authorized", "reauthorization_required"],
    ["scope_permission_missed", "reauthorization_required"],
    ["rate_limit_exceeded", "rate_limited"],
    ["invalid_params", "terminal_configuration"],
    ["internal_error", "retryable"],
    ["unknown_error", "retryable"],
  ];
  for (const [tiktokCode, classification] of cases) {
    const adapter = createCodeClipTikTokPollAdapter({
      fetchImpl: captureFetch({
        error: { code: tiktokCode, message: "raw TikTok message", log_id: "log-id" },
      }).fetchImpl,
    });
    const result = normalizeResult(await adapter.poll(input()));
    assert.equal(result.ok, false);
    assert.equal(result.classification, classification);
    assertNoLeak(result);
  }

  const malformed = createCodeClipTikTokPollAdapter({
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => "text/html" },
      async text() {
        return "<html>raw TikTok message</html>";
      },
    }),
  });
  assert.equal(
    normalizeResult(await malformed.poll(input())).classification,
    "provider_malformed_response"
  );

  const network = createCodeClipTikTokPollAdapter({
    fetchImpl: async () => {
      throw new Error("native network detail");
    },
  });
  assert.equal(
    normalizeResult(await network.poll(input())).classification,
    "retryable"
  );
});

test("invalid provider input throws typed adapter error without leakage", async () => {
  const adapter = createCodeClipTikTokPollAdapter({});
  await assert.rejects(
    () => adapter.poll({ ...input(), provider: "youtube" }),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokPollAdapterError);
      assert.equal(error.code, "INVALID_ADAPTER_INPUT");
      assertNoLeak(error);
      return true;
    }
  );
});
