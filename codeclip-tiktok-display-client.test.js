const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CodeClipTikTokDisplayClientError,
  listCodeClipTikTokVideos,
} = require("./verticals/codeclip/tiktok/display-client");

const ENDPOINT = "https://open.tiktokapis.com/v2/video/list/";
const ACCESS_TOKEN = "display-access-token-secret-do-not-leak";
const TIKTOK_MESSAGE = "raw TikTok message must not leak";
const LOG_ID = "tiktok-log-id-secret";

function jsonResponse(body, { status = 200, headers = {}, asText } = {}) {
  const text =
    asText !== undefined
      ? asText
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const headerMap = new Map(
    Object.entries({
      "content-type": "application/json; charset=utf-8",
      ...headers,
    }).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

function streamResponse(text, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(text)];
  return {
    status,
    headers: {
      get(name) {
        const values = {
          "content-type": "application/json",
          ...headers,
        };
        return values[String(name).toLowerCase()] ?? null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (!chunks.length) return { done: true };
            return { done: false, value: chunks.shift() };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

function successBody(overrides = {}) {
  return {
    data: {
      videos: [
        {
          id: " Video_ID_CaseSensitive ",
          create_time: 1712345678,
          share_url: "https://www.tiktok.com/@acct/video/123#frag",
          title: " A public TikTok video ",
          duration: 12,
          view_count: 999,
        },
      ],
      cursor: 1234567890,
      has_more: false,
      extra_data: "ignored",
      ...overrides.data,
    },
    error: {
      code: "ok",
      message: "",
      log_id: "",
      ...overrides.error,
    },
    unknown: "ignored",
  };
}

function captureFetch(responseFactory = () => jsonResponse(successBody())) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responseFactory(url, init, calls);
  };
  return { fetchImpl, calls };
}

async function assertRejectsCode(fn, code, extras = []) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof CodeClipTikTokDisplayClientError);
    assert.equal(error.code, code);
    assertNoLeakage(error, extras);
    return true;
  });
}

function assertNoLeakage(error, extras = []) {
  const blob = [
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
    JSON.stringify(error?.details),
    String(error?.message),
  ].join("\n");
  for (const forbidden of [
    ACCESS_TOKEN,
    `Bearer ${ACCESS_TOKEN}`,
    TIKTOK_MESSAGE,
    LOG_ID,
    "raw body should not appear",
    "native fetch failure secret",
    JSON.stringify({ max_count: 20 }),
    ...extras,
  ]) {
    assert.equal(blob.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("public API is exact", () => {
  const mod = require("./verticals/codeclip/tiktok/display-client");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipTikTokDisplayClientError",
    "listCodeClipTikTokVideos",
  ]);
});

test("module has no console usage", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/tiktok/display-client.js"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
});

test("sends exact default request shape and normalizes full valid page", async () => {
  const { fetchImpl, calls } = captureFetch();
  const result = await listCodeClipTikTokVideos(
    { accessToken: ACCESS_TOKEN },
    { fetchImpl }
  );

  assert.deepEqual(result, {
    videos: [
      {
        id: "Video_ID_CaseSensitive",
        createTimeSec: 1712345678,
        shareUrl: "https://www.tiktok.com/@acct/video/123",
        title: "A public TikTok video",
        duration: 12,
      },
    ],
    cursor: 1234567890,
    hasMore: false,
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, ENDPOINT);
  assert.equal(url.search, "?fields=id%2Ccreate_time%2Cshare_url%2Ctitle%2Cduration");
  assert.deepEqual([...url.searchParams.keys()], ["fields"]);
  assert.equal(url.searchParams.get("fields"), "id,create_time,share_url,title,duration");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { max_count: 20 });
  assert.equal(calls[0].url.includes(ACCESS_TOKEN), false);
  assert.equal(calls[0].init.body.includes(ACCESS_TOKEN), false);
  assert.ok(calls[0].init.signal);
});

test("supports maxCount bounds and cursor inclusion", async () => {
  for (const maxCount of [1, 20]) {
    const { fetchImpl, calls } = captureFetch();
    await listCodeClipTikTokVideos(
      { accessToken: ACCESS_TOKEN, maxCount, cursor: 1234567890 },
      { fetchImpl }
    );
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      max_count: maxCount,
      cursor: 1234567890,
    });
  }
});

test("omits cursor when undefined and accepts zero cursor", async () => {
  const first = captureFetch();
  await listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, first);
  assert.equal(Object.hasOwn(JSON.parse(first.calls[0].init.body), "cursor"), false);

  const second = captureFetch();
  await listCodeClipTikTokVideos(
    { accessToken: ACCESS_TOKEN, cursor: 0 },
    second
  );
  assert.equal(JSON.parse(second.calls[0].init.body).cursor, 0);
});

test("normalizes custom fields with trim, dedupe, and deterministic order", async () => {
  const { fetchImpl, calls } = captureFetch();
  await listCodeClipTikTokVideos(
    {
      accessToken: ACCESS_TOKEN,
      fields: [" create_time ", "id", "id", "duration"],
    },
    { fetchImpl }
  );
  assert.equal(
    new URL(calls[0].url).searchParams.get("fields"),
    "id,create_time,duration"
  );
});

test("input validation fails closed before HTTP", async () => {
  const invalidCases = [
    [{}, "ACCESS_TOKEN_REQUIRED"],
    [{ accessToken: "" }, "ACCESS_TOKEN_REQUIRED"],
    [{ accessToken: "x", maxCount: 0 }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: 21 }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: "20" }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: 1.5 }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: null }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: true }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: NaN }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: Infinity }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", maxCount: 1n }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: -1 }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: "1" }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: 1.2 }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: NaN }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: Infinity }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", cursor: 1n }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: "id" }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: [] }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: ["id"] }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: ["create_time"] }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: ["id", "create_time", "view_count"] }, "INVALID_DISPLAY_REQUEST"],
    [{ accessToken: "x", fields: ["id", "create_time", 1] }, "INVALID_DISPLAY_REQUEST"],
  ];

  for (const [input, code] of invalidCases) {
    let called = false;
    await assertRejectsCode(
      () =>
        listCodeClipTikTokVideos(input, {
          fetchImpl: async () => {
            called = true;
            throw new Error("should not fetch");
          },
        }),
      code
    );
    assert.equal(called, false);
  }
});

test("invalid fetch dependency fails closed", async () => {
  await assertRejectsCode(
    () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, { fetchImpl: null }),
    "TIKTOK_DISPLAY_REQUEST_FAILED"
  );
});

test("empty page and has_more true are valid success responses", async () => {
  const empty = captureFetch(() =>
    jsonResponse(successBody({ data: { videos: [], cursor: 0, has_more: false } }))
  );
  assert.deepEqual(
    await listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, empty),
    { videos: [], cursor: 0, hasMore: false }
  );

  const hasMore = captureFetch(() =>
    jsonResponse(successBody({ data: { cursor: 999, has_more: true } }))
  );
  const result = await listCodeClipTikTokVideos(
    { accessToken: ACCESS_TOKEN },
    hasMore
  );
  assert.equal(result.cursor, 999);
  assert.equal(result.hasMore, true);
});

test("optional invalid share URL and duration normalize to null; long title is bounded", async () => {
  const longTitle = ` ${"x".repeat(200)} `;
  const { fetchImpl } = captureFetch(() =>
    jsonResponse(
      successBody({
        data: {
          videos: [
            {
              id: "id1",
              create_time: 1,
              share_url: "http://not-https.example/video",
              title: longTitle,
              duration: -1,
            },
          ],
        },
      })
    )
  );
  const result = await listCodeClipTikTokVideos(
    { accessToken: ACCESS_TOKEN },
    { fetchImpl }
  );
  assert.equal(result.videos[0].shareUrl, null);
  assert.equal(result.videos[0].duration, null);
  assert.equal(result.videos[0].title.length, 150);
});

test("duplicate video IDs keep first; conflicting duplicate fails closed", async () => {
  const duplicate = captureFetch(() =>
    jsonResponse(
      successBody({
        data: {
          videos: [
            { id: "same", create_time: 2, title: "first" },
            { id: "same", create_time: 2, title: "second" },
          ],
        },
      })
    )
  );
  const result = await listCodeClipTikTokVideos(
    { accessToken: ACCESS_TOKEN },
    duplicate
  );
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].title, "first");

  const conflict = captureFetch(() =>
    jsonResponse(
      successBody({
        data: {
          videos: [
            { id: "same", create_time: 2 },
            { id: "same", create_time: 3 },
          ],
        },
      })
    )
  );
  await assertRejectsCode(
    () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, conflict),
    "INVALID_TIKTOK_DISPLAY_RESPONSE"
  );
});

test("malformed videos and success shape fail closed", async () => {
  for (const data of [
    { videos: [{ create_time: 1 }], cursor: 0, has_more: false },
    { videos: [{ id: " ", create_time: 1 }], cursor: 0, has_more: false },
    { videos: [{ id: "id", create_time: "1" }], cursor: 0, has_more: false },
    { videos: [], cursor: "0", has_more: false },
    { videos: [], cursor: 0, has_more: "false" },
    { videos: {}, cursor: 0, has_more: false },
  ]) {
    const { fetchImpl } = captureFetch(() => jsonResponse(successBody({ data })));
    await assertRejectsCode(
      () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, { fetchImpl }),
      "INVALID_TIKTOK_DISPLAY_RESPONSE"
    );
  }
});

test("maps TikTok errors and HTTP status codes safely", async () => {
  const cases = [
    [400, "invalid_params", "INVALID_DISPLAY_REQUEST"],
    [401, "anything", "ACCESS_TOKEN_INVALID"],
    [200, "access_token_invalid", "ACCESS_TOKEN_INVALID"],
    [200, "scope_not_authorized", "TIKTOK_SCOPE_NOT_AUTHORIZED"],
    [200, "scope_permission_missed", "TIKTOK_SCOPE_NOT_AUTHORIZED"],
    [200, "rate_limit_exceeded", "TIKTOK_RATE_LIMITED"],
    [429, "anything", "TIKTOK_RATE_LIMITED"],
    [200, "internal_error", "TIKTOK_SERVICE_UNAVAILABLE"],
    [500, "anything", "TIKTOK_SERVICE_UNAVAILABLE"],
    [418, "unknown_error", "TIKTOK_DISPLAY_REQUEST_FAILED"],
  ];

  for (const [status, tiktokCode, clientCode] of cases) {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(
        {
          error: { code: tiktokCode, message: TIKTOK_MESSAGE, log_id: LOG_ID },
        },
        { status }
      )
    );
    await assertRejectsCode(
      () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, { fetchImpl }),
      clientCode
    );
  }
});

test("transport failures, timeout, abort, and redirects are safe", async () => {
  await assertRejectsCode(
    () =>
      listCodeClipTikTokVideos(
        { accessToken: ACCESS_TOKEN },
        {
          fetchImpl: async () => {
            throw new Error("native fetch failure secret");
          },
        }
      ),
    "TIKTOK_DISPLAY_REQUEST_FAILED"
  );

  await assertRejectsCode(
    () =>
      listCodeClipTikTokVideos(
        { accessToken: ACCESS_TOKEN },
        {
          timeoutMs: 1000,
          fetchImpl: async (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                const error = new Error("aborted native detail");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }
      ),
    "TIKTOK_DISPLAY_REQUEST_FAILED"
  );

  await assertRejectsCode(
    () =>
      listCodeClipTikTokVideos(
        { accessToken: ACCESS_TOKEN },
        {
          fetchImpl: async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          },
        }
      ),
    "TIKTOK_DISPLAY_REQUEST_FAILED"
  );

  const redirect = captureFetch(() => jsonResponse("", { status: 302 }));
  await assertRejectsCode(
    () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, redirect),
    "TIKTOK_DISPLAY_REQUEST_FAILED"
  );
});

test("response parsing rejects malformed JSON, wrong content type, empty and oversized bodies", async () => {
  const cases = [
    jsonResponse("not json", { asText: "not json" }),
    jsonResponse("<html>raw body should not appear</html>", {
      headers: { "content-type": "text/html" },
      asText: "<html>raw body should not appear</html>",
    }),
    jsonResponse("plain", {
      headers: { "content-type": "text/plain" },
      asText: "plain",
    }),
    jsonResponse("", { headers: { "content-type": "" }, asText: "" }),
    jsonResponse("", { asText: "" }),
    jsonResponse({}, { headers: { "content-length": String(64 * 1024 + 1) } }),
    jsonResponse("x".repeat(64 * 1024 + 1), {
      asText: "x".repeat(64 * 1024 + 1),
    }),
    streamResponse("x".repeat(64 * 1024 + 1)),
  ];

  for (const response of cases) {
    const { fetchImpl } = captureFetch(() => response);
    await assertRejectsCode(
      () => listCodeClipTikTokVideos({ accessToken: ACCESS_TOKEN }, { fetchImpl }),
      "INVALID_TIKTOK_DISPLAY_RESPONSE"
    );
  }
});
