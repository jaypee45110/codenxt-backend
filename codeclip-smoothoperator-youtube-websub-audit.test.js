const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const auditModulePath = require.resolve("./verticals/codeclip/smoothoperator-youtube-websub-audit");
const {
  CodeClipSmoothOperatorYouTubeWebSubAuditError,
  getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit,
} = require(auditModulePath);
const {
  listCodeClipYouTubeWebSubSubscriptionAudit,
} = require("./verticals/codeclip/youtube-websub-subscriptions");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const queryClient = { name: "smoothoperator-youtube-audit-route-pool", query: async () => ({ rows: [] }) };
const routeCalls = [];
let routeError = null;
let routeResult = null;

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

require.cache[auditModulePath] = {
  id: auditModulePath,
  filename: auditModulePath,
  loaded: true,
  exports: {
    CodeClipSmoothOperatorYouTubeWebSubAuditError,
    getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit: async (callbackId, options) => {
      routeCalls.push([callbackId, options]);
      if (routeError) throw routeError;
      return routeResult;
    },
  },
};

process.env.CODECLIP_ADMIN_KEY = "smoothoperator-audit-admin-secret";
const { app } = require("./server");

function subscription(overrides = {}) {
  return {
    id: 8,
    vertical: "codeclip",
    callbackId: "yt_audit_cb",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: "UCsmoothOperatorRawChannel123456789",
    topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsmoothOperatorRawChannel123456789",
    status: "active",
    pendingMode: null,
    secretVersion: "v1",
    leaseExpiresAt: "2026-07-28T04:05:29.000Z",
    lastVerifiedAt: "2026-07-18T04:05:29.000Z",
    createdAt: "2026-07-18T04:00:00.000Z",
    updatedAt: "2026-07-18T04:05:29.000Z",
    ...overrides,
  };
}

function auditRows() {
  return [
    {
      id: 12,
      vertical: "codeclip",
      provider: "youtube",
      callbackId: "yt_audit_cb",
      providerAccountId: "UCsmoothOperatorRawChannel123456789",
      eventCode: "CC-YOUTUBE-AUDIT",
      action: "hub_request_accepted",
      mode: "subscribe",
      resultCode: "hub_request_accepted",
      hubHttpStatus: 204,
      retryable: false,
      metadata: {
        operationSource: "operator_key",
        previousStatus: "pending_subscribe",
        resultingStatus: "active",
        reason: "raw database error with root-secret",
        secret: "derived-secret",
        body: "<feed></feed>",
        signature: "sha256=abc",
      },
      createdAt: "2026-07-18T04:05:29.000Z",
    },
    {
      id: 11,
      vertical: "codeclip",
      provider: "youtube",
      callbackId: "yt_audit_cb",
      providerAccountId: "UCsmoothOperatorRawChannel123456789",
      eventCode: "CC-YOUTUBE-AUDIT",
      action: "subscription_requested",
      mode: "subscribe",
      resultCode: "subscription_pending",
      hubHttpStatus: null,
      retryable: false,
      metadata: {
        operationSource: "operator_key",
        requestedLeaseSeconds: 864000,
        resultingStatus: "pending_subscribe",
      },
      createdAt: "2026-07-18T04:04:59.000Z",
    },
  ];
}

function resetRoute(result = {}) {
  routeCalls.length = 0;
  routeError = null;
  routeResult = {
    ok: true,
    vertical: "codeclip",
    surface: "smoothoperator",
    provider: "youtube",
    channel: "youtube",
    generatedAt: "2026-07-18T04:06:00.000Z",
    subscription: {
      callbackId: "yt_audit_cb",
      provider: "youtube",
      channel: "youtube",
      providerAccountIdMasked: "************************6789",
      status: "active",
    },
    audit: {
      count: 1,
      items: [{ id: 12, action: "hub_request_accepted", resultCode: "hub_request_accepted" }],
    },
    ...result,
  };
}

function callApp({ method = "GET", path, adminKey = "smoothoperator-audit-admin-secret" }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    req.method = method;
    req.url = path;
    req.headers = { host: "localhost" };
    if (adminKey !== null) req.headers["x-admin-key"] = adminKey;

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
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: text ? JSON.parse(text) : null,
      });
    };

    app.handle(req, res, reject);
  });
}

function assertNoSensitiveLeak(text) {
  for (const forbidden of [
    "UCsmoothOperatorRawChannel123456789",
    "root-secret",
    "derived-secret",
    "admin-secret",
    "sha256=abc",
    "<feed>",
    "raw database error",
    "topic",
    "secretVersion",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("SmoothOperator YouTube WebSub audit builds public-safe subscription history", async () => {
  const calls = [];
  const response = await getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit(
    "yt_audit_cb",
    {
      queryClient,
      generatedAt: "2026-07-18T04:06:00.000Z",
      getSubscriptionByCallbackId: async (callbackId, options) => {
        calls.push(["get", callbackId, options]);
        return subscription();
      },
      listAudit: async (filters, options) => {
        calls.push(["listAudit", filters, options]);
        return auditRows();
      },
    }
  );
  const text = JSON.stringify(response);

  assert.equal(response.ok, true);
  assert.equal(response.surface, "smoothoperator");
  assert.equal(response.subscription.callbackId, "yt_audit_cb");
  assert.equal(response.subscription.status, "active");
  assert.equal(response.subscription.providerAccountIdMasked.endsWith("6789"), true);
  assert.equal(response.audit.count, 2);
  assert.deepEqual(response.audit.items.map((item) => item.id), [12, 11]);
  assert.equal(response.audit.items[0].operation, "verification");
  assert.equal(response.audit.items[0].previousStatus, "pending_subscribe");
  assert.equal(response.audit.items[0].newStatus, "active");
  assert.equal(response.audit.items[0].actorType, "operator");
  assert.deepEqual(response.audit.items[0].metadata, {
    operationSource: "operator_key",
    previousStatus: "pending_subscribe",
    resultingStatus: "active",
  });
  assert.equal(calls[0][0], "get");
  assert.equal(calls[1][0], "listAudit");
  assert.deepEqual(calls[1][1], { callbackId: "yt_audit_cb" });
  assertNoSensitiveLeak(text);
});

test("SmoothOperator YouTube WebSub audit returns stable empty history", async () => {
  const response = await getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit(
    "yt_audit_empty",
    {
      queryClient,
      getSubscriptionByCallbackId: async () => subscription({ callbackId: "yt_audit_empty" }),
      listAudit: async () => [],
    }
  );

  assert.equal(response.subscription.callbackId, "yt_audit_empty");
  assert.deepEqual(response.audit, { count: 0, items: [] });
});

test("SmoothOperator YouTube WebSub audit rejects unknown callback IDs", async () => {
  await assert.rejects(
    getCodeClipSmoothOperatorYouTubeWebSubSubscriptionAudit("yt_missing", {
      queryClient,
      getSubscriptionByCallbackId: async () => null,
      listAudit: async () => {
        throw new Error("should not list audit");
      },
    }),
    (error) => error.code === "subscription_not_found"
  );
});

test("YouTube WebSub subscription audit repository is scoped and newest-first", async () => {
  const queries = [];
  await listCodeClipYouTubeWebSubSubscriptionAudit(
    { callbackId: "yt_audit_cb", limit: 25 },
    {
      queryClient: {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      },
    }
  );

  assert.match(queries[0].sql, /FROM codeclip_youtube_websub_subscription_audit/);
  assert.match(queries[0].sql, /vertical = 'codeclip'/);
  assert.match(queries[0].sql, /provider = 'youtube'/);
  assert.match(queries[0].sql, /callback_id = \$1/);
  assert.match(queries[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(queries[0].params, ["yt_audit_cb", 25]);
});

test("SmoothOperator YouTube WebSub audit route requires admin key", async () => {
  resetRoute();
  const missing = await callApp({
    path: "/internal/codeclip/smoothoperator/youtube-websub/subscriptions/yt_audit_cb/audit",
    adminKey: null,
  });
  const wrong = await callApp({
    path: "/internal/codeclip/smoothoperator/youtube-websub/subscriptions/yt_audit_cb/audit",
    adminKey: "wrong",
  });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(routeCalls.length, 0);
});

test("SmoothOperator YouTube WebSub audit route returns public-safe history", async () => {
  resetRoute();
  const response = await callApp({
    path: "/internal/codeclip/smoothoperator/youtube-websub/subscriptions/yt_audit_cb/audit",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.ok, true);
  assert.equal(response.body.subscription.callbackId, "yt_audit_cb");
  assert.equal(routeCalls[0][0], "yt_audit_cb");
  assert.equal(routeCalls[0][1].queryClient, queryClient);
  assertNoSensitiveLeak(response.text);
});

test("SmoothOperator YouTube WebSub audit route maps unknown callbacks to 404", async () => {
  resetRoute();
  routeError = new CodeClipSmoothOperatorYouTubeWebSubAuditError(
    "subscription_not_found",
    "not found"
  );
  const response = await callApp({
    path: "/internal/codeclip/smoothoperator/youtube-websub/subscriptions/yt_missing/audit",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    ok: false,
    error: "YouTube WebSub audit unavailable",
    code: "subscription_not_found",
  });
  assertNoSensitiveLeak(response.text);
});

test("SmoothOperator YouTube WebSub audit route maps repository errors to 503", async () => {
  resetRoute();
  routeError = new Error("database password leaked");
  const response = await callApp({
    path: "/internal/codeclip/smoothoperator/youtube-websub/subscriptions/yt_audit_cb/audit",
  });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: "YouTube WebSub audit unavailable",
    code: "audit_unavailable",
  });
  assertNoSensitiveLeak(response.text);
});

test("existing YouTube WebSub status route still rejects missing admin key", async () => {
  resetRoute();
  const response = await callApp({
    path: "/internal/codeclip/youtube-websub/subscriptions",
    adminKey: null,
  });

  assert.equal(response.status, 401);
});
