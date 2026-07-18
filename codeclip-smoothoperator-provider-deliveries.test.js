const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const deliveryModulePath = require.resolve("./verticals/codeclip/smoothoperator-provider-deliveries");
const {
  CodeClipSmoothOperatorProviderDeliveryError,
  getCodeClipSmoothOperatorProviderDelivery,
  listCodeClipSmoothOperatorProviderDeliveries,
  pickPublicResponseSummary,
  toPublicDeliveryDetail,
  toPublicDeliverySummary,
} = require(deliveryModulePath);

const queryClient = { name: "smoothoperator-provider-delivery-route-pool", query: async () => ({ rows: [] }) };
const routeCalls = [];
let routeError = null;
let routeListResult = null;
let routeDetailResult = null;

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

require.cache[deliveryModulePath] = {
  id: deliveryModulePath,
  filename: deliveryModulePath,
  loaded: true,
  exports: {
    CodeClipSmoothOperatorProviderDeliveryError,
    listCodeClipSmoothOperatorProviderDeliveries: async (filters, options) => {
      routeCalls.push(["list", filters, options]);
      if (routeError) throw routeError;
      return routeListResult;
    },
    getCodeClipSmoothOperatorProviderDelivery: async (deliveryId, options) => {
      routeCalls.push(["detail", deliveryId, options]);
      if (routeError) throw routeError;
      return routeDetailResult;
    },
  },
};

process.env.CODECLIP_ADMIN_KEY = "smoothoperator-delivery-admin-secret";
const { app } = require("./server");

function delivery(overrides = {}) {
  return {
    id: 42,
    provider: "youtube",
    channel: "youtube",
    providerAccountId: "UCsmoothOperatorDeliveryRaw123456789",
    eventCode: "CC-DELIVERY",
    externalMessageId: "youtube:UCsmoothOperatorDeliveryRaw123456789:video-raw-id:published",
    verificationState: "verified",
    processingState: "completed",
    attemptCount: 1,
    corePersistenceState: "committed",
    completionState: "completed",
    responseStatus: 202,
    publicResponseJson: {
      ok: true,
      accepted: true,
      status: "completed",
      code: "runtime_completed",
      processing: "processed",
      error: "none",
      payload: { secret: "payload-secret" },
      rawBody: "<feed></feed>",
      headers: { authorization: "Bearer admin-secret" },
      signature: "sha256=signature",
      topic: "https://www.youtube.com/feeds/videos.xml?channel_id=raw",
      secret: "derived-secret",
      providerSecret: "provider-secret",
      xml: "<xml />",
      responseBody: "raw response",
      redisKey: "redis:key",
      metadata: { hidden: true },
    },
    terminalState: true,
    retryEligible: false,
    resultCode: "runtime_completed",
    failureCode: null,
    receivedAt: "2026-07-18T05:00:00.000Z",
    lastAttemptAt: "2026-07-18T05:00:01.000Z",
    completedAt: "2026-07-18T05:00:02.000Z",
    createdAt: "2026-07-18T05:00:00.000Z",
    updatedAt: "2026-07-18T05:00:02.000Z",
    payload: { raw: true },
    rawBody: "<feed></feed>",
    headers: { "x-hub-signature": "sha256=signature" },
    signature: "sha256=signature",
    topic: "https://www.youtube.com/feeds/videos.xml?channel_id=raw",
    secret: "root-secret",
    providerSecret: "provider-secret",
    xml: "<entry></entry>",
    responseBody: "raw body",
    redisKey: "redis:key",
    metadata: { raw: "metadata" },
    ...overrides,
  };
}

function resetRoute() {
  routeCalls.length = 0;
  routeError = null;
  routeListResult = {
    ok: true,
    vertical: "codeclip",
    surface: "smoothoperator",
    generatedAt: "2026-07-18T05:10:00.000Z",
    count: 1,
    items: [toPublicDeliverySummary(delivery())],
  };
  routeDetailResult = {
    ok: true,
    vertical: "codeclip",
    surface: "smoothoperator",
    generatedAt: "2026-07-18T05:10:00.000Z",
    delivery: toPublicDeliveryDetail(delivery()),
  };
}

function callApp({ method = "GET", path, adminKey = "smoothoperator-delivery-admin-secret" }) {
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

function assertNoSensitiveLeak(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of [
    "UCsmoothOperatorDeliveryRaw123456789",
    "video-raw-id",
    "payload-secret",
    "rawBody",
    "headers",
    "signature",
    "topic",
    "root-secret",
    "derived-secret",
    "provider-secret",
    "<feed>",
    "<entry>",
    "responseBody",
    "redis:key",
    "metadata",
    "publicResponseJson",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("SmoothOperator provider delivery list returns public-safe summaries", async () => {
  const calls = [];
  const response = await listCodeClipSmoothOperatorProviderDeliveries(
    {
      provider: "youtube",
      eventCode: "CC-DELIVERY",
      category: "completed",
      terminal: "true",
      retryEligible: "false",
      limit: "50",
    },
    {
      queryClient,
      generatedAt: "2026-07-18T05:10:00.000Z",
      listDeliveries: async (filters, client) => {
        calls.push([filters, client]);
        return [delivery()];
      },
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.count, 1);
  assert.equal(response.items[0].deliveryId, 42);
  assert.equal(response.items[0].category, "completed");
  assert.equal(response.items[0].providerAccountIdMasked.endsWith("6789"), true);
  assert.equal(response.items[0].externalMessageIdMasked.endsWith("shed"), true);
  assert.equal(response.items[0].terminal, true);
  assert.equal(response.items[0].retryEligible, false);
  assert.equal(response.items[0].resultCode, "runtime_completed");
  assert.equal(response.items[0].failureCode, null);
  assert.equal(calls[0][1], queryClient);
  assert.equal(Object.prototype.hasOwnProperty.call(response, "limit"), false);
  assertNoSensitiveLeak(response);
});

test("SmoothOperator provider delivery detail returns lifecycle and allowlisted response summary", async () => {
  const response = await getCodeClipSmoothOperatorProviderDelivery("42", {
    queryClient,
    getDeliveryById: async (deliveryId, client) => {
      assert.equal(deliveryId, "42");
      assert.equal(client, queryClient);
      return delivery();
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery.deliveryId, 42);
  assert.equal(response.delivery.attempts, 1);
  assert.deepEqual(response.delivery.lifecycle, {
    verification: "verified",
    processing: "completed",
    persistence: "committed",
    completion: "completed",
    terminal: true,
    retryEligible: false,
  });
  assert.deepEqual(Object.keys(response.delivery.publicResponse.summary).sort(), [
    "accepted",
    "code",
    "error",
    "ok",
    "processing",
    "status",
  ]);
  assertNoSensitiveLeak(response);
});

test("SmoothOperator provider delivery serializer preserves nullable booleans", () => {
  const falseSummary = toPublicDeliverySummary(delivery({
    terminalState: false,
    retryEligible: false,
    corePersistenceState: "not_started",
    processingState: "received",
    completionState: "not_completed",
    publicResponseJson: null,
  }));
  const falseDetail = toPublicDeliveryDetail(delivery({
    terminalState: false,
    retryEligible: false,
    corePersistenceState: "not_started",
    processingState: "received",
    completionState: "not_completed",
    publicResponseJson: null,
  }));
  const nullDetail = toPublicDeliveryDetail({
    id: 9,
    provider: "youtube",
    providerAccountId: "UCsafeAccount123456789",
    eventCode: "CC-NULL",
    externalMessageId: "external-safe",
  });

  assert.equal(falseSummary.terminal, false);
  assert.equal(falseSummary.retryEligible, false);
  assert.equal(falseDetail.lifecycle.terminal, false);
  assert.equal(falseDetail.lifecycle.retryEligible, false);
  assert.equal(nullDetail.terminal, null);
  assert.equal(nullDetail.retryEligible, null);
  assert.equal(nullDetail.lifecycle.terminal, null);
  assert.equal(nullDetail.lifecycle.retryEligible, null);
});

test("SmoothOperator provider delivery public response summary is explicitly allowlisted", () => {
  const summary = pickPublicResponseSummary(delivery().publicResponseJson);
  assert.deepEqual(summary, {
    ok: true,
    accepted: true,
    status: "completed",
    code: "runtime_completed",
    processing: "processed",
    error: "none",
  });
});

test("SmoothOperator provider delivery response never leaks forbidden fields", () => {
  const detail = toPublicDeliveryDetail(delivery());
  assertNoSensitiveLeak(detail);
});

test("SmoothOperator provider delivery rejects invalid filters and delivery IDs with explicit error codes", async () => {
  const invalid = new Error("bad request");
  invalid.code = "CODECLIP_PROVIDER_DELIVERY_INVALID_REQUEST";

  await assert.rejects(
    listCodeClipSmoothOperatorProviderDeliveries(
      { limit: "50abc" },
      {
        queryClient,
        listDeliveries: async () => {
          throw invalid;
        },
      }
    ),
    (error) => error.code === "invalid_filter"
  );
  await assert.rejects(
    getCodeClipSmoothOperatorProviderDelivery("12abc", {
      queryClient,
      getDeliveryById: async () => {
        throw invalid;
      },
    }),
    (error) => error.code === "invalid_delivery_id"
  );
});

test("provider delivery repository list filters are scoped, strict, and newest-first", async () => {
  const calls = [];
  await originalDb.listCodeClipProviderDeliveries(
    {
      provider: "YouTube",
      providerAccountId: "UCdeliveryFilter123456789",
      eventCode: "CC-FILTER",
      category: "processing",
      terminal: false,
      retryEligible: "false",
      limit: "250",
    },
    {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    }
  );

  assert.match(calls[0].sql, /FROM codeclip_provider_deliveries/);
  assert.match(calls[0].sql, /provider = \$1/);
  assert.match(calls[0].sql, /provider_account_id = \$2/);
  assert.match(calls[0].sql, /event_code = \$3/);
  assert.match(calls[0].sql, /terminal_state = \$4/);
  assert.match(calls[0].sql, /retry_eligible = \$5/);
  assert.match(calls[0].sql, /processing_state = 'processing'/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(calls[0].params, [
    "youtube",
    "UCdeliveryFilter123456789",
    "CC-FILTER",
    false,
    false,
    200,
  ]);
});

test("provider delivery repository rejects non-decimal limits and delivery IDs", async () => {
  await assert.rejects(
    originalDb.listCodeClipProviderDeliveries(
      { limit: "50abc" },
      { query: async () => ({ rows: [] }) }
    ),
    (error) => error.code === "CODECLIP_PROVIDER_DELIVERY_INVALID_REQUEST"
  );
  await assert.rejects(
    originalDb.getCodeClipProviderDeliveryById(
      "12abc",
      { query: async () => ({ rows: [] }) }
    ),
    (error) => error.code === "CODECLIP_PROVIDER_DELIVERY_INVALID_REQUEST"
  );
});

test("provider delivery category filters mirror JS operational classification predicates", () => {
  const predicates = {
    completed: originalDb.buildCodeClipProviderDeliveryCategoryPredicate("completed"),
    committedIncomplete: originalDb.buildCodeClipProviderDeliveryCategoryPredicate("committed_incomplete"),
    processing: originalDb.buildCodeClipProviderDeliveryCategoryPredicate("processing"),
    failedPrecommit: originalDb.buildCodeClipProviderDeliveryCategoryPredicate("failed_precommit"),
    unknown: originalDb.buildCodeClipProviderDeliveryCategoryPredicate("unknown"),
  };

  assert.equal(originalDb.classifyCodeClipProviderDeliveryOperationalState(delivery()), "completed");
  assert.match(predicates.completed, /core_persistence_state = 'committed'/);
  assert.match(predicates.completed, /completion_state = 'completed'/);
  assert.match(predicates.completed, /processing_state = 'completed'/);
  assert.doesNotMatch(predicates.completed, /processing_state = 'processing'/);
  assert.doesNotMatch(predicates.completed, /processing_state = 'failed'/);

  assert.equal(
    originalDb.classifyCodeClipProviderDeliveryOperationalState(delivery({
      completionState: "not_completed",
    })),
    "committed_incomplete"
  );
  assert.match(predicates.committedIncomplete, /core_persistence_state = 'committed'/);
  assert.match(predicates.committedIncomplete, /NOT COALESCE/);
  assert.match(predicates.committedIncomplete, /completion_state = 'completed'/);
  assert.doesNotMatch(predicates.committedIncomplete, /processing_state = 'processing'/);

  assert.equal(
    originalDb.classifyCodeClipProviderDeliveryOperationalState(delivery({
      corePersistenceState: "not_started",
      processingState: "processing",
      completionState: "not_completed",
      terminalState: false,
      retryEligible: true,
      publicResponseJson: null,
    })),
    "processing"
  );
  assert.match(predicates.processing, /processing_state = 'processing'/);
  assert.match(predicates.processing, /core_persistence_state IS DISTINCT FROM 'committed'/);
  assert.doesNotMatch(predicates.processing, /completion_state = 'completed'/);
  assert.doesNotMatch(predicates.processing, /processing_state = 'failed'/);

  assert.equal(
    originalDb.classifyCodeClipProviderDeliveryOperationalState(delivery({
      corePersistenceState: "not_started",
      processingState: "failed",
      completionState: "not_completed",
      terminalState: false,
      retryEligible: true,
      publicResponseJson: null,
    })),
    "failed_precommit"
  );
  assert.match(predicates.failedPrecommit, /processing_state = 'failed'/);
  assert.match(predicates.failedPrecommit, /completion_state IS DISTINCT FROM 'completed'/);
  assert.doesNotMatch(predicates.failedPrecommit, /response_status BETWEEN 200 AND 299/);
  assert.doesNotMatch(predicates.failedPrecommit, /processing_state = 'processing'/);

  assert.equal(
    originalDb.classifyCodeClipProviderDeliveryOperationalState(delivery({
      corePersistenceState: "not_started",
      processingState: "received",
      completionState: "not_completed",
      terminalState: false,
      retryEligible: false,
      publicResponseJson: null,
    })),
    "unknown"
  );
  assert.match(predicates.unknown, /NOT COALESCE/);
  assert.match(predicates.unknown, /processing_state = 'processing'/);
  assert.match(predicates.unknown, /processing_state = 'failed'/);
  assert.match(predicates.unknown, /response_status BETWEEN 200 AND 299/);
});

test("SmoothOperator provider delivery routes require admin key", async () => {
  resetRoute();
  const missing = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries",
    adminKey: null,
  });
  const wrong = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries/42",
    adminKey: "wrong",
  });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(routeCalls.length, 0);
});

test("SmoothOperator provider delivery routes return list and detail with no-store", async () => {
  resetRoute();
  const list = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries?provider=youtube&eventCode=CC-DELIVERY&category=completed&terminal=true&retryEligible=false&limit=50",
  });
  const detail = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries/42",
  });

  assert.equal(list.status, 200);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.equal(detail.status, 200);
  assert.equal(detail.headers["cache-control"], "no-store");
  assert.equal(routeCalls[0][0], "list");
  assert.equal(routeCalls[0][1].retryEligible, "false");
  assert.equal(routeCalls[0][2].queryClient, queryClient);
  assert.equal(routeCalls[1][0], "detail");
  assert.equal(routeCalls[1][1], "42");
  assert.equal(routeCalls[1][2].queryClient, queryClient);
  assertNoSensitiveLeak(list.text);
  assertNoSensitiveLeak(detail.text);
});

test("SmoothOperator provider delivery routes map invalid, not found, and database errors safely", async () => {
  resetRoute();
  routeError = new CodeClipSmoothOperatorProviderDeliveryError("invalid_filter", "bad filter");
  const invalid = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries?limit=bad",
  });

  resetRoute();
  routeError = new CodeClipSmoothOperatorProviderDeliveryError("delivery_not_found", "missing");
  const missing = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries/999",
  });

  resetRoute();
  routeError = new Error("database password leaked");
  const unavailable = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-deliveries",
  });

  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_filter");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "delivery_not_found");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, {
    ok: false,
    error: "SmoothOperator provider delivery inspection unavailable",
    code: "delivery_unavailable",
  });
  assertNoSensitiveLeak(invalid.text);
  assertNoSensitiveLeak(missing.text);
  assertNoSensitiveLeak(unavailable.text);
});

test("existing provider delivery summary route still rejects missing admin key", async () => {
  resetRoute();
  const response = await callApp({
    path: "/internal/codeclip/provider-deliveries/summary",
    adminKey: null,
  });

  assert.equal(response.status, 401);
});
