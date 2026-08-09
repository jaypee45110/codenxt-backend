const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const redisModulePath = require.resolve("./redis");
const serverModulePath = require.resolve("./server");
const originalDb = require(dbModulePath);
const originalRedisCacheEntry = require.cache[redisModulePath];
const { createRedisStub } = require("./test-helpers/redis-stub");
const {
  updateCodeClipEventActivationConfig,
} = originalDb;

const ADMIN_KEY = "episode-activation-admin-key";

function campaignRow({
  eventCode = "CC-ACTIVATION",
  vertical = "codeclip",
  activationMethod = "keyword",
  activationChannels = ["sms"],
  activationEvent = "",
  name = "codeClip activation test",
} = {}) {
  return {
    id: `event-${eventCode}`,
    vertical,
    event_code: eventCode,
    name,
    status: "active",
    start_at: "2099-01-01T10:00:00.000Z",
    unlock_at: "2099-01-01T10:00:00.000Z",
    end_at: "2099-01-01T11:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    raw_event: {
      id: `event-${eventCode}`,
      code: eventCode,
      vertical,
      name,
      status: "active",
      startAt: "2099-01-01T10:00:00.000Z",
      unlockAt: "2099-01-01T10:00:00.000Z",
      endAt: "2099-01-01T11:00:00.000Z",
      activationMethod,
      activationChannels,
      activationEvent,
      preservedField: "must-stay",
    },
  };
}

function createQueryClient(row, { updateRows = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT \* FROM campaigns WHERE event_code = \$1 LIMIT 1/.test(sql)) {
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE campaigns/.test(sql)) {
        if (updateRows === 0) return { rows: [] };
        const updated = {
          ...row,
          updated_at: "2026-07-21T01:00:00.000Z",
          raw_event: {
            ...row.raw_event,
            activationMethod: params[1],
            activationChannels: JSON.parse(params[2]),
            activationEvent: params[3],
          },
        };
        return { rows: [updated] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("repository updates only codeClip activation config and preserves identity", async () => {
  const row = campaignRow();
  const client = createQueryClient(row);
  const result = await updateCodeClipEventActivationConfig(
    "CC-ACTIVATION",
    {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    },
    { queryClient: client }
  );

  assert.equal(result.status, "updated");
  assert.equal(result.changed, true);
  assert.equal(result.row.id, row.id);
  assert.equal(result.row.event_code, "CC-ACTIVATION");
  assert.equal(result.row.raw_event.preservedField, "must-stay");
  assert.equal(result.row.raw_event.activationMethod, "provider");
  assert.deepEqual(result.row.raw_event.activationChannels, ["youtube"]);
  assert.equal(result.row.raw_event.activationEvent, "published_video");
  assert.equal(client.calls.filter((call) => /UPDATE campaigns/.test(call.sql)).length, 1);
  assert.match(client.calls[1].sql, /WHERE event_code = \$1\s+AND vertical = 'codeclip'/);
  assert.deepEqual(client.calls[1].params, [
    "CC-ACTIVATION",
    "provider",
    JSON.stringify(["youtube"]),
    "published_video",
  ]);
});

test("repository accepts TikTok provider published video activation config", async () => {
  const row = campaignRow();
  const client = createQueryClient(row);
  const result = await updateCodeClipEventActivationConfig(
    "CC-ACTIVATION",
    {
      activationMethod: "provider",
      activationChannels: ["tiktok"],
      activationEvent: "published_video",
    },
    { queryClient: client }
  );

  assert.equal(result.status, "updated");
  assert.equal(result.changed, true);
  assert.equal(result.row.raw_event.activationMethod, "provider");
  assert.deepEqual(result.row.raw_event.activationChannels, ["tiktok"]);
  assert.equal(result.row.raw_event.activationEvent, "published_video");
  assert.deepEqual(client.calls[1].params, [
    "CC-ACTIVATION",
    "provider",
    JSON.stringify(["tiktok"]),
    "published_video",
  ]);
});


test("repository is idempotent and fails closed without one-row confirmation", async () => {
  const unchangedRow = campaignRow({
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
  });
  const unchangedClient = createQueryClient(unchangedRow);
  const unchanged = await updateCodeClipEventActivationConfig(
    "CC-ACTIVATION",
    {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    },
    { queryClient: unchangedClient }
  );

  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.changed, false);
  assert.equal(unchangedClient.calls.filter((call) => /UPDATE campaigns/.test(call.sql)).length, 0);

  const failedClient = createQueryClient(campaignRow(), { updateRows: 0 });
  await assert.rejects(
    updateCodeClipEventActivationConfig(
      "CC-ACTIVATION",
      {
        activationMethod: "provider",
        activationChannels: ["youtube"],
        activationEvent: "published_video",
      },
      { queryClient: failedClient }
    ),
    (error) => error.code === "WRITE_CONFIRMATION_FAILED"
  );
});

const routeState = {
  campaigns: new Map(),
  updateCalls: [],
  failUpdate: false,
  redis: createRedisStub(),
};

function resetRouteState() {
  routeState.campaigns.clear();
  routeState.updateCalls.length = 0;
  routeState.failUpdate = false;
  routeState.redis = createRedisStub();
}

async function getCampaignByCode(eventCode) {
  return routeState.campaigns.get(eventCode) || null;
}

async function updateRouteActivation(eventCode, activationConfig) {
  routeState.updateCalls.push({ eventCode, activationConfig });
  if (routeState.failUpdate) {
    const error = new Error("forced activation update failure");
    error.code = "WRITE_CONFIRMATION_FAILED";
    throw error;
  }
  const row = routeState.campaigns.get(eventCode);
  if (!row) return { status: "not_found", changed: false, row: null };
  const vertical = String(row.vertical || row.raw_event?.vertical || "").toLowerCase();
  if (vertical !== "codeclip") {
    return { status: "wrong_vertical", changed: false, row };
  }
  const previous = {
    activationMethod: row.raw_event.activationMethod,
    activationChannels: row.raw_event.activationChannels,
    activationEvent: row.raw_event.activationEvent,
  };
  const changed = JSON.stringify(previous) !== JSON.stringify(activationConfig);
  if (changed) {
    row.raw_event = {
      ...row.raw_event,
      ...activationConfig,
    };
    row.updated_at = "2026-07-21T02:00:00.000Z";
  }
  return {
    status: changed ? "updated" : "unchanged",
    changed,
    row,
    previousActivationConfig: previous,
    activationConfig,
  };
}

function installRouteDbStub() {
  delete require.cache[serverModulePath];
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      ...originalDb,
      pool: { query: async () => ({ rows: [] }) },
      getCampaignByCode,
      updateCodeClipEventActivationConfig: updateRouteActivation,
      testDbConnection: async () => null,
      ensureCodePodGoldXtraRedemptionsTable: async () => null,
      ensureCodePodKeywordInteractionsTable: async () => null,
      ensureCodeClipProviderAccountBindingsTable: async () => null,
      ensureCodeClipProviderAccountBindingAuditTable: async () => null,
      ensureCodeClipProviderDeliveriesTable: async () => null,
      ensureCodeClipYouTubeWebSubSubscriptionsTable: async () => null,
      ensureCodeClipYouTubeOAuthStatesTable: async () => null,
      ensureCampaignsTable: async () => null,
      ensureEventScansTable: async () => null,
      ensureEventRegistrationsTable: async () => null,
    },
  };
  require.cache[redisModulePath] = {
    id: redisModulePath,
    filename: redisModulePath,
    loaded: true,
    exports: routeState.redis,
  };
  return require("./server").app;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withServer(options = {}, run) {
  if (typeof options === "function") {
    run = options;
    options = {};
  }
  const adminKey = Object.hasOwn(options, "adminKey") ? options.adminKey : ADMIN_KEY;
  const redisUrl = Object.hasOwn(options, "redisUrl") ? options.redisUrl : undefined;
  resetRouteState();
  const originalAdminKey = process.env.CODECLIP_ADMIN_KEY;
  const originalRedisUrl = process.env.REDIS_URL;
  restoreEnv("CODECLIP_ADMIN_KEY", adminKey);
  restoreEnv("REDIS_URL", redisUrl);
  const app = installRouteDbStub();
  try {
    await run(app);
  } finally {
    restoreEnv("CODECLIP_ADMIN_KEY", originalAdminKey);
    restoreEnv("REDIS_URL", originalRedisUrl);
    delete require.cache[serverModulePath];
    delete require.cache[dbModulePath];
    delete require.cache[redisModulePath];
    require.cache[dbModulePath] = {
      id: dbModulePath,
      filename: dbModulePath,
      loaded: true,
      exports: originalDb,
    };
    if (originalRedisCacheEntry) {
      require.cache[redisModulePath] = originalRedisCacheEntry;
    }
  }
}

function headers(adminKey = ADMIN_KEY) {
  return {
    "content-type": "application/json",
    "x-admin-key": adminKey,
  };
}

async function patchActivation(baseUrl, eventCode, body, requestHeaders = headers()) {
  return callApp(baseUrl, {
    method: "PATCH",
    path: `/internal/codeclip/events/${eventCode}/activation`,
    body,
    headers: requestHeaders,
  });
}

function callApp(app, { method = "GET", path, body = null, headers: requestHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "localhost",
      ...requestHeaders,
      "content-length": Buffer.byteLength(payload),
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

test("activation update route requires codeClip admin key and fails closed without config", async () => {
  await withServer(async (baseUrl) => {
    routeState.campaigns.set("CC-AUTH", campaignRow({ eventCode: "CC-AUTH" }));
    const missing = await patchActivation(
      baseUrl,
      "CC-AUTH",
      {
        activationMethod: "provider",
        activationChannels: ["youtube"],
        activationEvent: "published_video",
      },
      { "content-type": "application/json" }
    );
    const wrong = await patchActivation(
      baseUrl,
      "CC-AUTH",
      {
        activationMethod: "provider",
        activationChannels: ["youtube"],
        activationEvent: "published_video",
      },
      headers("wrong")
    );

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(routeState.updateCalls.length, 0);
  });

  await withServer({ adminKey: undefined }, async (baseUrl) => {
    const response = await patchActivation(
      baseUrl,
      "CC-AUTH",
      {
        activationMethod: "provider",
        activationChannels: ["youtube"],
        activationEvent: "published_video",
      },
      headers("anything")
    );
    assert.equal(response.status, 503);
    assert.equal(routeState.updateCalls.length, 0);
  });
});

test("activation update route validates contract and rejects non-codeClip rows", async () => {
  await withServer(async (baseUrl) => {
    routeState.campaigns.set("CP-NOT-CLIP", campaignRow({ eventCode: "CP-NOT-CLIP", vertical: "codepod" }));
    routeState.campaigns.set("CC-VALIDATE", campaignRow({ eventCode: "CC-VALIDATE" }));
    const valid = {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    };

    const unknown = await patchActivation(baseUrl, "CC-MISSING", valid);
    const wrongVertical = await patchActivation(baseUrl, "CP-NOT-CLIP", valid);
    const missingFields = await patchActivation(baseUrl, "CC-VALIDATE", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
    });
    const unknownField = await patchActivation(baseUrl, "CC-VALIDATE", {
      ...valid,
      status: "active",
    });
    const eventCodeBody = await patchActivation(baseUrl, "CC-VALIDATE", {
      ...valid,
      eventCode: "OTHER",
    });
    const invalidCombo = await patchActivation(baseUrl, "CC-VALIDATE", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "video_updated",
    });
    const publishedNoYoutube = await patchActivation(baseUrl, "CC-VALIDATE", {
      activationMethod: "both",
      activationChannels: ["sms"],
      activationEvent: "published_video",
    });
    const validTikTok = await patchActivation(baseUrl, "CC-VALIDATE", {
      activationMethod: "provider",
      activationChannels: ["tiktok"],
      activationEvent: "published_video",
    });

    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "EPISODE_NOT_FOUND");
    assert.equal(wrongVertical.status, 409);
    assert.equal(wrongVertical.body.error.code, "EPISODE_VERTICAL_CONFLICT");
    assert.equal(missingFields.status, 400);
    assert.equal(unknownField.status, 400);
    assert.equal(eventCodeBody.status, 400);
    assert.equal(invalidCombo.status, 400);
    assert.equal(invalidCombo.body.error.code, "UNSUPPORTED_PROVIDER_ACTIVATION_EVENT");
    assert.equal(publishedNoYoutube.status, 400);
    assert.equal(publishedNoYoutube.body.error.code, "UNSUPPORTED_PROVIDER_ACTIVATION_CHANNEL");
    assert.equal(validTikTok.status, 200);
    assert.equal(validTikTok.body.event.activationMethod, "provider");
    assert.deepEqual(validTikTok.body.event.activationChannels, ["tiktok"]);
    assert.equal(validTikTok.body.event.activationEvent, "published_video");
    assert.equal(routeState.updateCalls.length, 1);
  });
});

test("activation update route updates only activation config and is idempotent", async () => {
  await withServer(async (baseUrl) => {
    const row = campaignRow({ eventCode: "CC-UPDATE" });
    routeState.campaigns.set("CC-UPDATE", row);
    const body = {
      activationMethod: " provider ",
      activationChannels: [" YouTube ", "youtube"],
      activationEvent: " Published_Video ",
    };

    const first = await patchActivation(baseUrl, "CC-UPDATE", body);
    const second = await patchActivation(baseUrl, "CC-UPDATE", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.changed, true);
    assert.deepEqual(first.body.event, {
      eventCode: "CC-UPDATE",
      vertical: "codeclip",
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
      updatedAt: "2026-07-21T02:00:00.000Z",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.changed, false);
    assert.equal(row.id, "event-CC-UPDATE");
    assert.equal(row.event_code, "CC-UPDATE");
    assert.equal(row.raw_event.preservedField, "must-stay");
    assert.equal(routeState.updateCalls.length, 2);
    assert.equal(first.text.includes(ADMIN_KEY), false);
    assert.equal(first.text.includes("secret"), false);
  });
});

test("event readback overlays codeClip activation config from PostgreSQL over stale Redis meta", async () => {
  await withServer({ redisUrl: "redis://codeclip-activation-readback-test" }, async (baseUrl) => {
    const row = campaignRow({
      eventCode: "CC-CACHED",
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
      name: "codeClip cached activation readback",
    });
    routeState.campaigns.set("CC-CACHED", row);
    routeState.redis.strings.set("eventcode:codeclip:CC-CACHED", "event-CC-CACHED");
    routeState.redis.hashes.set("event:event-CC-CACHED:meta", {
      id: "event-CC-CACHED",
      code: "CC-CACHED",
      vertical: "codeclip",
      name: "codeClip cached activation readback",
      status: "active",
      startAt: "2099-01-01T10:00:00.000Z",
      unlockAt: "2099-01-01T10:00:00.000Z",
      endAt: "2099-01-01T11:00:00.000Z",
      activationMethod: "keyword",
      activationChannels: JSON.stringify(["sms"]),
      activationEvent: "",
      preservedField: "cached-public-field",
    });

    const response = await callApp(baseUrl, {
      path: "/event/CC-CACHED?vertical=codeclip",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.id, "event-CC-CACHED");
    assert.equal(response.body.code, "CC-CACHED");
    assert.equal(response.body.name, "codeClip cached activation readback");
    assert.equal(response.body.status, "active");
    assert.equal(response.body.startAt, "2099-01-01T10:00:00.000Z");
    assert.equal(response.body.unlockAt, "2099-01-01T10:00:00.000Z");
    assert.equal(response.body.endAt, "2099-01-01T11:00:00.000Z");
    assert.equal(response.body.activationMethod, "provider");
    assert.deepEqual(response.body.activationChannels, ["youtube"]);
    assert.equal(response.body.activationEvent, "published_video");
    assert.equal(response.body.preservedField, undefined);
    assert.equal(routeState.updateCalls.length, 0);
    assert.equal(routeState.redis.calls.some((call) => call.method === "set" || call.method === "hset"), false);
  });
});

test("activation patch is reflected by subsequent event readback without mutating unrelated state", async () => {
  await withServer({ redisUrl: "redis://codeclip-activation-readback-test" }, async (baseUrl) => {
    const row = campaignRow({
      eventCode: "CC-PATCH-READBACK",
      name: "codeClip patch readback",
    });
    routeState.campaigns.set("CC-PATCH-READBACK", row);
    routeState.redis.strings.set("eventcode:codeclip:CC-PATCH-READBACK", "event-CC-PATCH-READBACK");
    routeState.redis.hashes.set("event:event-CC-PATCH-READBACK:meta", {
      id: "event-CC-PATCH-READBACK",
      code: "CC-PATCH-READBACK",
      vertical: "codeclip",
      name: "codeClip patch readback",
      status: "active",
      startAt: "2099-01-01T10:00:00.000Z",
      unlockAt: "2099-01-01T10:00:00.000Z",
      endAt: "2099-01-01T11:00:00.000Z",
      activationMethod: "keyword",
      activationChannels: JSON.stringify(["sms"]),
      activationEvent: "",
    });

    const first = await patchActivation(baseUrl, "CC-PATCH-READBACK", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });
    const second = await patchActivation(baseUrl, "CC-PATCH-READBACK", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });
    const readback = await callApp(baseUrl, {
      path: "/event/CC-PATCH-READBACK?vertical=codeclip",
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.changed, false);
    assert.equal(readback.status, 200);
    assert.equal(readback.body.id, "event-CC-PATCH-READBACK");
    assert.equal(readback.body.code, "CC-PATCH-READBACK");
    assert.equal(readback.body.name, "codeClip patch readback");
    assert.equal(readback.body.status, "active");
    assert.equal(readback.body.startAt, "2099-01-01T10:00:00.000Z");
    assert.equal(readback.body.unlockAt, "2099-01-01T10:00:00.000Z");
    assert.equal(readback.body.endAt, "2099-01-01T11:00:00.000Z");
    assert.equal(readback.body.activationMethod, "provider");
    assert.deepEqual(readback.body.activationChannels, ["youtube"]);
    assert.equal(readback.body.activationEvent, "published_video");
    assert.equal(row.id, "event-CC-PATCH-READBACK");
    assert.equal(row.event_code, "CC-PATCH-READBACK");
    assert.equal(row.raw_event.preservedField, "must-stay");
    assert.equal(routeState.updateCalls.length, 2);
    assert.equal(routeState.redis.calls.some((call) => call.method === "set" || call.method === "hset"), false);
  });
});

test("event readback falls back to PostgreSQL when codeClip cache entry is absent or malformed", async () => {
  await withServer({ redisUrl: "redis://codeclip-activation-readback-test" }, async (baseUrl) => {
    const absent = campaignRow({
      eventCode: "CC-NO-CACHE",
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });
    const malformed = campaignRow({
      eventCode: "CC-MALFORMED-CACHE",
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });
    routeState.campaigns.set("CC-NO-CACHE", absent);
    routeState.campaigns.set("CC-MALFORMED-CACHE", malformed);
    routeState.redis.strings.set("eventcode:codeclip:CC-MALFORMED-CACHE", "event-CC-MALFORMED-CACHE");
    routeState.redis.hashes.set("event:event-CC-MALFORMED-CACHE:meta", {
      activationMethod: "keyword",
      activationChannels: JSON.stringify(["sms"]),
      activationEvent: "",
    });

    const noCache = await callApp(baseUrl, {
      path: "/event/CC-NO-CACHE?vertical=codeclip",
    });
    const malformedCache = await callApp(baseUrl, {
      path: "/event/CC-MALFORMED-CACHE?vertical=codeclip",
    });

    for (const response of [noCache, malformedCache]) {
      assert.equal(response.status, 200);
      assert.equal(response.body.activationMethod, "provider");
      assert.deepEqual(response.body.activationChannels, ["youtube"]);
      assert.equal(response.body.activationEvent, "published_video");
      assert.equal(response.body.preservedField, undefined);
    }
    assert.equal(routeState.updateCalls.length, 0);
    assert.equal(routeState.redis.calls.some((call) => call.method === "set" || call.method === "hset"), false);
  });
});

test("activation update route fails closed on repository write failure", async () => {
  await withServer(async (baseUrl) => {
    routeState.campaigns.set("CC-FAIL", campaignRow({ eventCode: "CC-FAIL" }));
    routeState.failUpdate = true;
    const response = await patchActivation(baseUrl, "CC-FAIL", {
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "ACTIVATION_UPDATE_UNAVAILABLE");
    assert.equal(routeState.campaigns.get("CC-FAIL").raw_event.activationMethod, "keyword");
  });
});
