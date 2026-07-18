const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const smoothOperatorModulePath = require.resolve(
  "./verticals/codeclip/smoothoperator-provider-operations"
);

const queryClient = {
  name: "smoothoperator-provider-operations-pool",
  fail: false,
  calls: [],
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (this.fail) {
      throw new Error("database failure SELECT raw-secret-account-123456");
    }
    if (/FROM codeclip_provider_account_bindings/.test(sql) && /GROUP BY provider\s+ORDER BY provider/.test(sql)) {
      return { rows: [{ provider: "youtube", count: 1 }] };
    }
    if (/FROM codeclip_provider_account_bindings/.test(sql) && /GROUP BY provider, channel/.test(sql)) {
      return { rows: [{ provider: "youtube", channel: "youtube", count: 1 }] };
    }
    if (/FROM codeclip_provider_account_bindings/.test(sql) && /GROUP BY status/.test(sql)) {
      return { rows: [{ status: "active", count: 1 }] };
    }
    if (/SELECT \*/.test(sql) && /FROM codeclip_provider_account_bindings/.test(sql)) {
      return {
        rows: [{
          id: "7",
          vertical: "codeclip",
          event_code: "CC-ROUTE",
          provider: "youtube",
          channel: "youtube",
          provider_account_id: "UCsensitiveChannelIdentifier1234",
          status: "active",
          display_name: "Route binding",
          created_by: "operator_key",
          metadata: {},
          created_at: "2026-07-18T05:00:00.000Z",
          updated_at: "2026-07-18T05:05:00.000Z",
          disabled_at: null,
        }],
      };
    }
    if (/COUNT\(\*\) AS total/.test(sql) && /FROM codeclip_provider_deliveries/.test(sql)) {
      return {
        rows: [{
          total: 0,
          completed: 0,
          committed_incomplete: 0,
          processing: 0,
          failed_precommit: 0,
          unknown: 0,
          oldest_committed_incomplete_at: null,
          oldest_processing_at: null,
          latest_completed_at: null,
        }],
      };
    }
    if (/FROM codeclip_youtube_websub_subscriptions/.test(sql)) {
      return {
        rows: [{
          id: "3",
          vertical: "codeclip",
          callback_id: "yt_route",
          provider: "youtube",
          channel: "youtube",
          provider_account_id: "UCsensitiveChannelIdentifier1234",
          topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsensitiveChannelIdentifier1234",
          status: "active",
          pending_mode: null,
          secret_version: "v1",
          activation_boundary_at: "2026-07-18T04:05:29.000Z",
          activation_boundary_video_id: null,
          activated_at: "2026-07-18T04:05:29.000Z",
          first_activated_video_id: null,
          first_activated_at: null,
          lease_started_at: "2026-07-18T04:05:29.000Z",
          lease_expires_at: "2026-07-28T04:05:29.000Z",
          last_verified_at: "2026-07-18T04:05:29.000Z",
          metadata: {},
          created_at: "2026-07-18T04:04:00.000Z",
          updated_at: "2026-07-18T04:05:29.000Z",
        }],
      };
    }
    return { rows: [] };
  },
};

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

process.env.CODECLIP_ADMIN_KEY = "smoothoperator-admin-secret";
const { app } = require("./server");
const {
  buildCodeClipSmoothOperatorProviderOperationsOverview,
} = require(smoothOperatorModulePath);

function resetRouteStub() {
  queryClient.calls.length = 0;
  queryClient.fail = false;
}

function callApp({ method = "GET", path, adminKey = "smoothoperator-admin-secret" }) {
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

function assertNoSensitiveProviderData(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "raw-secret-account-123456",
    "UCsensitiveChannelIdentifier1234",
    "smoothoperator-admin-secret",
    "root-secret",
    "derived-secret",
    "hub.secret",
    "X-Hub-Signature",
    "<feed",
    "rawXml",
    "providerPayload",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("SmoothOperator provider operations overview aggregates bindings, deliveries, subscriptions, and capabilities", async () => {
  const fixedNow = new Date("2026-07-18T06:00:00.000Z");
  const overview = await buildCodeClipSmoothOperatorProviderOperationsOverview({
    queryClient,
    now: fixedNow,
    getRegisteredProviders: () => ["meta", "sms", "test", "youtube"],
    getBindingSupportedChannels: () => ({
      meta: ["instagram", "messenger", "whatsapp"],
      sms: ["sms"],
      youtube: ["youtube"],
    }),
    getBindingOperationsSummary: async (_filters, options) => {
      assert.equal(options.queryClient, queryClient);
      return {
        counts: {
          total: 3,
          byProvider: { meta: 1, youtube: 2 },
          byChannel: { "meta:instagram": 1, "youtube:youtube": 2 },
          byStatus: { active: 2, disabled: 1 },
        },
        latestLimit: 10,
        latest: [
          {
            id: "10",
            vertical: "codeclip",
            eventCode: "CC-YOUTUBE",
            provider: "youtube",
            channel: "youtube",
            providerAccountId: "UCsensitiveChannelIdentifier1234",
            status: "active",
            displayName: "Internal channel",
            createdAt: "2026-07-18T05:00:00.000Z",
            updatedAt: "2026-07-18T05:05:00.000Z",
            disabledAt: null,
          },
        ],
      };
    },
    getProviderDeliveryOperationalSummary: async (client) => {
      assert.equal(client, queryClient);
      return {
        total: 4,
        completed: 2,
        committedIncomplete: 1,
        processing: 1,
        failedPrecommit: 0,
        unknown: 0,
        attentionRequired: true,
        attentionReasons: ["committed_incomplete"],
      };
    },
    listYouTubeSubscriptionStatuses: async (_filters, options) => {
      assert.equal(options.queryClient, queryClient);
      return [
        {
          callbackId: "yt_active",
          providerAccountId: "UCsensitiveChannelIdentifier1234",
          topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsensitiveChannelIdentifier1234",
          status: "active",
          leaseExpiresAt: "2026-07-28T04:05:29.000Z",
        },
        {
          callbackId: "yt_pending",
          providerAccountId: "UCotherSensitiveChannel1234567",
          status: "pending_renewal",
        },
      ];
    },
  });

  assert.equal(overview.ok, true);
  assert.equal(overview.vertical, "codeclip");
  assert.equal(overview.surface, "smoothoperator");
  assert.equal(overview.generatedAt, fixedNow.toISOString());
  assert.deepEqual(overview.scope, {
    product: "codeClip",
    vertical: "codeclip",
    audience: ["creator", "producer"],
    operationsArea: "provider_operations",
  });
  assert.deepEqual(overview.providers.registered, ["meta", "sms", "test", "youtube"]);
  assert.deepEqual(overview.providers.bindingSupportedChannels.youtube, ["youtube"]);
  assert.deepEqual(overview.providerBindings.counts.byProvider, { meta: 1, youtube: 2 });
  assert.deepEqual(overview.providerBindings.counts.byChannel, {
    "meta:instagram": 1,
    "youtube:youtube": 2,
  });
  assert.equal(overview.providerBindings.latest[0].maskedAccountId.endsWith("1234"), true);
  assert.equal(overview.providerBindings.latest[0].providerAccountId, undefined);
  assert.equal(overview.providerDeliveries.summary.completed, 2);
  assert.deepEqual(overview.youtubeWebSub.subscriptions.counts.byStatus, {
    active: 1,
    pending_renewal: 1,
  });
  assert.equal(overview.youtubeWebSub.subscriptions.counts.open, 2);
  assert.equal(overview.youtubeWebSub.subscriptions.readiness.hasActiveSubscription, true);
  assert.equal(overview.youtubeWebSub.subscriptions.readiness.pendingRenewal, true);
  assert.equal(overview.capabilities.bindingCreate, true);
  assert.equal(overview.capabilities.bindingReactivate, true);
  assert.equal(overview.capabilities.youtubeSubscriptionCreate, true);
  assert.equal(overview.capabilities.deliverySummary, true);
  assert.equal(overview.capabilities.deliveryDrilldown, false);
  assert.equal(overview.capabilities.manualReplay, false);
  assertNoSensitiveProviderData(overview);
});

test("SmoothOperator provider operations overview returns a stable empty shape", async () => {
  const overview = await buildCodeClipSmoothOperatorProviderOperationsOverview({
    queryClient,
    now: new Date("2026-07-18T06:30:00.000Z"),
    getRegisteredProviders: () => ["meta", "sms", "test", "youtube"],
    getBindingSupportedChannels: () => ({ meta: ["instagram"], sms: ["sms"], youtube: ["youtube"] }),
    getBindingOperationsSummary: async () => ({
      counts: { total: 0, byProvider: {}, byChannel: {}, byStatus: {} },
      latest: [],
      latestLimit: 10,
    }),
    getProviderDeliveryOperationalSummary: async () => ({
      total: 0,
      completed: 0,
      committedIncomplete: 0,
      processing: 0,
      failedPrecommit: 0,
      unknown: 0,
      attentionRequired: false,
      attentionReasons: [],
    }),
    listYouTubeSubscriptionStatuses: async () => [],
  });

  assert.equal(overview.providerBindings.counts.total, 0);
  assert.deepEqual(overview.providerBindings.latest, []);
  assert.equal(overview.youtubeWebSub.subscriptions.counts.total, 0);
  assert.deepEqual(overview.youtubeWebSub.subscriptions.counts.byStatus, {});
  assert.equal(overview.youtubeWebSub.subscriptions.readiness.hasActiveSubscription, false);
  assert.equal(overview.capabilities.manualReplay, false);
});

test("SmoothOperator provider operations route requires admin key", async () => {
  resetRouteStub();
  const missing = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-operations",
    adminKey: null,
  });
  const wrong = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-operations",
    adminKey: "wrong",
  });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(missing.body, { ok: false, error: "Unauthorized" });
  assert.equal(queryClient.calls.length, 0);
  assertNoSensitiveProviderData(missing.body);
});

test("SmoothOperator provider operations route returns overview with database pool", async () => {
  resetRouteStub();
  const response = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-operations",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.ok, true);
  assert.equal(response.body.vertical, "codeclip");
  assert.equal(response.body.surface, "smoothoperator");
  assert.equal(response.body.providerBindings.counts.total, 1);
  assert.equal(response.body.providerBindings.latest[0].maskedAccountId.endsWith("1234"), true);
  assert.equal(response.body.providerBindings.latest[0].providerAccountId, undefined);
  assert.equal(response.body.providerDeliveries.summary.total, 0);
  assert.equal(response.body.youtubeWebSub.subscriptions.counts.active, 1);
  assert.equal(response.body.capabilities.deliveryDrilldown, false);
  assert.equal(response.body.capabilities.manualReplay, false);
  assert.ok(queryClient.calls.some((call) => /codeclip_provider_account_bindings/.test(call.sql)));
  assertNoSensitiveProviderData(response.body);
});

test("SmoothOperator provider operations route fails public-safe when repository read fails", async () => {
  resetRouteStub();
  queryClient.fail = true;

  const response = await callApp({
    path: "/internal/codeclip/smoothoperator/provider-operations",
  });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: "SmoothOperator provider operations unavailable",
  });
  assertNoSensitiveProviderData(response.body);
});

test("existing provider delivery summary route keeps its authorization behavior", async () => {
  resetRouteStub();
  const response = await callApp({
    path: "/internal/codeclip/provider-deliveries/summary",
    adminKey: null,
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { ok: false, error: "Unauthorized" });
  assert.equal(queryClient.calls.length, 0);
});
