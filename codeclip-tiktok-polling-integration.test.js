const test = require("node:test");
const assert = require("node:assert/strict");

const {
  activateCodeClipTikTokPolling,
} = require("./verticals/codeclip/tiktok/polling-activation");
const {
  pollCodeClipProviderSource,
} = require("./verticals/codeclip/provider-polling/service");
const {
  ingestCodeClipProviderPollDetections,
} = require("./verticals/codeclip/provider-polling/delivery-ingest");
const {
  createCodeClipProductionPollAdapterRegistry,
} = require("./verticals/codeclip/provider-polling/production-adapter-registry");

const OPERATION_NOW = "2026-08-05T10:00:00.000Z";
const ACCOUNT_ID = "tiktok-account-integration";
const ACCESS_TOKEN = "memory-only-access-token";

function makeDisplayResponse(page) {
  const body = JSON.stringify({
    data: {
      videos: page.videos || [],
      cursor: page.cursor || 0,
      has_more: page.hasMore === true,
    },
    error: { code: "ok", message: "", log_id: "" },
  });
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const normalized = String(name || "").toLowerCase();
        if (normalized === "content-type") return "application/json; charset=utf-8";
        if (normalized === "content-length") return String(Buffer.byteLength(body));
        return null;
      },
    },
    async text() {
      return body;
    },
  };
}

function makeFetchQueue(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push({
        url: String(url),
        body: options.body,
        headers: options.headers,
      });
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return makeDisplayResponse(page || { videos: [] });
    },
  };
}

function makeRuntimeStore() {
  const state = {
    calls: [],
    events: [{ event_code: "CC-TIKTOK", vertical: "codeclip" }],
    bindings: [
      {
        id: 10,
        vertical: "codeclip",
        event_code: "CC-TIKTOK",
        provider: "tiktok",
        channel: "tiktok",
        provider_account_id: ACCOUNT_ID,
        status: "active",
        updated_at: "2026-08-05T09:00:00.000Z",
        created_at: "2026-08-05T09:00:00.000Z",
      },
    ],
    credentials: [
      {
        id: 20,
        vertical: "codeclip",
        provider: "tiktok",
        environment: "sandbox",
        account_lookup_key: ACCOUNT_ID,
        provider_account_id: ACCOUNT_ID,
        status: "active",
        token_type: "bearer",
        scopes: ["video.list"],
        has_access_token: true,
        has_refresh_token: true,
        access_token_expires_at: "2026-08-05T12:00:00.000Z",
        encryption_key_version: 1,
        reauthorization_reason: null,
        metadata: {},
        created_at: "2026-08-05T09:00:00.000Z",
        updated_at: "2026-08-05T09:00:00.000Z",
      },
    ],
    sources: [],
    deliveries: [],
    nextSourceId: 100,
    nextDeliveryId: 500,
  };

  function sourceRow(overrides = {}) {
    return {
      id: overrides.id || state.nextSourceId++,
      vertical: "codeclip",
      provider: overrides.provider || "tiktok",
      environment: overrides.environment || "sandbox",
      account_lookup_key: overrides.account_lookup_key || ACCOUNT_ID,
      provider_account_id: overrides.provider_account_id || ACCOUNT_ID,
      status: overrides.status || "active",
      poll_interval_ms: overrides.poll_interval_ms ?? 300_000,
      next_poll_at: overrides.next_poll_at ?? OPERATION_NOW,
      last_polled_at: overrides.last_polled_at ?? null,
      checkpoint: overrides.checkpoint || {},
      poll_claim_owner: overrides.poll_claim_owner ?? null,
      poll_claimed_at: overrides.poll_claimed_at ?? null,
      poll_claim_expires_at: overrides.poll_claim_expires_at ?? null,
      poll_claim_version: overrides.poll_claim_version ?? 0,
      consecutive_failures: overrides.consecutive_failures ?? 0,
      last_error_code: overrides.last_error_code ?? null,
      last_success_at: overrides.last_success_at ?? null,
      last_detection_at: overrides.last_detection_at ?? null,
      last_attempt_duration_ms: overrides.last_attempt_duration_ms ?? null,
      last_detections_count: overrides.last_detections_count ?? null,
      created_at: overrides.created_at || "2026-08-05T09:00:00.000Z",
      updated_at: overrides.updated_at || "2026-08-05T09:00:00.000Z",
      disabled_at: overrides.disabled_at ?? null,
    };
  }

  function claimFenceMatches(source, owner, version, operationNow) {
    return (
      source.poll_claim_owner === owner &&
      String(source.poll_claim_version) === String(version) &&
      Date.parse(source.poll_claim_expires_at) > Date.parse(operationNow)
    );
  }

  async function query(sql, params = []) {
    state.calls.push({ sql, params });
    if (/^\s*BEGIN\s*$/i.test(sql) || /^\s*COMMIT\s*$/i.test(sql) || /^\s*ROLLBACK\s*$/i.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
      return { rows: [{ operation_now: params[0] || OPERATION_NOW }] };
    }
    if (/FROM campaigns/.test(sql)) {
      return { rows: state.events.filter((event) => event.event_code === params[0]) };
    }
    if (/FROM codeclip_provider_account_bindings/.test(sql)) {
      return {
        rows: state.bindings.filter(
          (binding) =>
            binding.vertical === params[0] &&
            binding.provider === params[1] &&
            binding.provider_account_id === params[2] &&
            (!/status = 'active'/.test(sql) || binding.status === "active")
        ),
      };
    }
    if (/FROM codeclip_provider_credentials/.test(sql) && /account_lookup_key = \$4/.test(sql)) {
      return {
        rows: state.credentials.filter(
          (credential) =>
            credential.vertical === params[0] &&
            credential.provider === params[1] &&
            credential.environment === params[2] &&
            credential.account_lookup_key === params[3]
        ),
      };
    }
    if (/FROM codeclip_provider_credentials/.test(sql) && /WHERE id = \$1/.test(sql)) {
      return {
        rows: state.credentials.filter(
          (credential) => String(credential.id) === String(params[0])
        ),
      };
    }
    if (/FROM codeclip_provider_poll_sources/.test(sql) && /FOR UPDATE/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      return { rows: source ? [{ ...source }] : [] };
    }
    if (/FROM codeclip_provider_poll_sources/.test(sql) && /WHERE id = \$1/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      return { rows: source ? [{ ...source }] : [] };
    }
    if (/FROM codeclip_provider_poll_sources/.test(sql) && /account_lookup_key = \$4/.test(sql)) {
      const source = state.sources.find(
        (item) =>
          item.vertical === params[0] &&
          item.provider === params[1] &&
          item.environment === params[2] &&
          item.account_lookup_key === params[3]
      );
      return { rows: source ? [{ ...source }] : [] };
    }
    if (/INSERT INTO codeclip_provider_poll_sources/.test(sql)) {
      const source = sourceRow({
        provider: params[1],
        environment: params[2],
        account_lookup_key: params[3],
        provider_account_id: params[4],
        poll_interval_ms: params[5],
        next_poll_at: params[6],
        checkpoint: JSON.parse(params[7]),
        created_at: params[8],
        updated_at: params[8],
      });
      state.sources.push(source);
      return { rows: [{ ...source }] };
    }
    if (/UPDATE codeclip_provider_poll_sources/.test(sql) && /poll_claim_version = poll_claim_version \+ 1/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      if (!source || source.status !== "active") return { rows: [] };
      const activeClaim =
        source.poll_claim_expires_at &&
        Date.parse(source.poll_claim_expires_at) > Date.parse(params[2]);
      if (activeClaim) return { rows: [] };
      source.poll_claim_owner = params[1];
      source.poll_claimed_at = params[2];
      source.poll_claim_expires_at = new Date(Date.parse(params[2]) + Number(params[3])).toISOString();
      source.poll_claim_version += 1;
      source.updated_at = params[2];
      return {
        rows: [{
          id: source.id,
          poll_claim_version: source.poll_claim_version,
          poll_claimed_at: source.poll_claimed_at,
          poll_claim_expires_at: source.poll_claim_expires_at,
        }],
      };
    }
    if (/UPDATE codeclip_provider_poll_sources/.test(sql) && /checkpoint = \$2::jsonb/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      if (!source || !claimFenceMatches(source, params[5], params[6], params[3])) {
        return { rows: [] };
      }
      source.checkpoint = JSON.parse(params[1]);
      source.next_poll_at = params[2];
      source.last_polled_at = params[3];
      source.poll_claim_owner = null;
      source.poll_claimed_at = null;
      source.poll_claim_expires_at = null;
      source.consecutive_failures = params[7];
      source.last_error_code = params[8];
      source.last_success_at = params[9];
      source.last_detection_at = params[10];
      source.last_attempt_duration_ms = params[11];
      source.last_detections_count = params[12];
      source.status = params[13];
      source.updated_at = params[3];
      return { rows: [{ ...source }] };
    }
    if (/UPDATE codeclip_provider_poll_sources/.test(sql) && /AND status = 'paused'/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      if (!source || source.status !== "paused") return { rows: [] };
      source.status = "active";
      source.next_poll_at = params[1];
      source.last_error_code = null;
      source.updated_at = params[2];
      return { rows: [{ ...source }] };
    }
    return { rows: [] };
  }

  async function createDelivery(delivery) {
    const existing = state.deliveries.find(
      (item) =>
        item.provider === delivery.provider &&
        item.event_code === delivery.eventCode &&
        item.external_message_id === delivery.externalMessageId
    );
    if (existing) return { status: "existing", row: { id: existing.id } };
    const created = {
      id: state.nextDeliveryId++,
      provider: delivery.provider,
      provider_account_id: delivery.providerAccountId,
      event_code: delivery.eventCode,
      external_message_id: delivery.externalMessageId,
      initial_delivery_source: delivery.initialDeliverySource,
      provider_detection_metadata: delivery.providerDetectionMetadata,
      processing_state: delivery.processingState,
      core_persistence_state: delivery.corePersistenceState,
    };
    state.deliveries.push(created);
    return { status: "created", row: { id: created.id } };
  }

  return {
    state,
    pool: {
      async connect() {
        return { query, release() {} };
      },
      query,
    },
    ingest(args, opts) {
      return ingestCodeClipProviderPollDetections(args, {
        ...opts,
        createDelivery,
      });
    },
  };
}

async function activate(store) {
  return activateCodeClipTikTokPolling(
    {
      eventCode: "CC-TIKTOK",
      environment: "sandbox",
      providerAccountId: ACCOUNT_ID,
      now: OPERATION_NOW,
    },
    {
      queryClient: store.pool,
      adapterRegistry: createCodeClipProductionPollAdapterRegistry({
        tiktok: { fetchImpl: async () => makeDisplayResponse({ videos: [] }) },
      }),
    }
  );
}

async function poll(store, pages, now = OPERATION_NOW) {
  const fetchQueue = makeFetchQueue(pages);
  const registry = createCodeClipProductionPollAdapterRegistry({
    tiktok: { fetchImpl: fetchQueue.fetch, timeoutMs: 10_000 },
  });
  const result = await pollCodeClipProviderSource(
    {
      sourceId: store.state.sources[0].id,
      owner: "worker.test",
      leaseMs: 60_000,
      now,
      queryClient: store.pool,
      adapterRegistry: registry,
      clock: () => Date.parse(now),
    },
    {
      secretRead: async () => ({ ok: true, accessToken: ACCESS_TOKEN }),
      ingest: store.ingest,
    }
  );
  return { result, fetchQueue };
}

test("activation plus generic service baseline initializes without historical deliveries", async () => {
  const store = makeRuntimeStore();
  const activated = await activate(store);
  assert.equal(activated.status, "activated");
  assert.deepEqual(store.state.sources[0].checkpoint, {});
  assert.equal(store.state.sources[0].next_poll_at, OPERATION_NOW);

  const { result, fetchQueue } = await poll(store, [
    {
      videos: [
        {
          id: "hist-2",
          create_time: 1785922200,
          share_url: "https://www.tiktok.com/@creator/video/hist-2",
        },
        {
          id: "hist-1",
          create_time: 1785920400,
          share_url: "https://www.tiktok.com/@creator/video/hist-1",
        },
      ],
      hasMore: true,
      cursor: 123456,
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.classification, "empty");
  assert.equal(result.detectionCount, 0);
  assert.equal(result.deliveryIds.length, 0);
  assert.equal(store.state.deliveries.length, 0);
  assert.equal(result.pageComplete, true);
  assert.deepEqual(store.state.sources[0].checkpoint, {
    initialized: true,
    highWaterPublishedAt: "2026-08-05T09:30:00.000Z",
    highWaterVideoId: "hist-2",
  });
  assert.equal(fetchQueue.calls.length, 1);
  assert.equal(JSON.parse(fetchQueue.calls[0].body).cursor, undefined);
});

test("generic service creates provider_polling delivery for new video and replay is existing", async () => {
  const store = makeRuntimeStore();
  await activate(store);
  await poll(store, [
    {
      videos: [{ id: "hist", create_time: 1785920400 }],
      hasMore: false,
    },
  ]);
  const baselineCheckpoint = { ...store.state.sources[0].checkpoint };

  const newer = { id: "new-1", create_time: 1785924000, share_url: "https://www.tiktok.com/@creator/video/new-1" };
  const first = await poll(store, [{ videos: [newer], hasMore: false }], "2026-08-05T10:01:00.000Z");
  assert.equal(first.result.ok, true);
  assert.equal(first.result.classification, "success");
  assert.equal(first.result.detectionCount, 1);
  assert.equal(first.result.createdCount, 1);
  assert.equal(first.result.existingCount, 0);
  assert.deepEqual(first.result.deliveryIds, ["500"]);
  assert.equal(store.state.deliveries.length, 1);
  assert.equal(store.state.deliveries[0].initial_delivery_source, "provider_polling");
  assert.equal(store.state.deliveries[0].external_message_id, "poll:tiktok:new-1");
  assert.deepEqual(store.state.deliveries[0].provider_detection_metadata, {
    provider: "tiktok",
    channel: "tiktok",
    providerContentId: "new-1",
    publishedAt: "2026-08-05T10:00:00.000Z",
    detectedAt: "2026-08-05T10:01:00.000Z",
    detectionSource: "display_api_polling",
    canonicalUrl: "https://www.tiktok.com/@creator/video/new-1",
  });
  assert.equal(store.state.deliveries[0].core_persistence_state, "not_started");
  assert.deepEqual(store.state.sources[0].checkpoint, {
    initialized: true,
    highWaterPublishedAt: "2026-08-05T10:00:00.000Z",
    highWaterVideoId: "new-1",
  });

  store.state.sources[0].checkpoint = baselineCheckpoint;
  const replay = await poll(store, [{ videos: [newer], hasMore: false }], "2026-08-05T10:02:00.000Z");
  assert.equal(replay.result.createdCount, 0);
  assert.equal(replay.result.existingCount, 1);
  assert.deepEqual(replay.result.deliveryIds, ["500"]);
  assert.equal(store.state.deliveries.length, 1);
});

test("pagination stores pending high-water, short schedules, then promotes on boundary", async () => {
  const store = makeRuntimeStore();
  await activate(store);
  await poll(store, [
    {
      videos: [{ id: "old-boundary", create_time: 1785920400 }],
      hasMore: false,
    },
  ]);

  const firstPage = await poll(store, [
    {
      videos: [
        { id: "new-3", create_time: 1785927600, share_url: "https://www.tiktok.com/@creator/video/new-3" },
        { id: "new-2", create_time: 1785924000, share_url: "https://www.tiktok.com/@creator/video/new-2" },
      ],
      hasMore: true,
      cursor: 777,
    },
  ], "2026-08-05T10:03:00.000Z");
  assert.equal(firstPage.result.pageComplete, false);
  assert.equal(firstPage.result.createdCount, 2);
  assert.equal(firstPage.result.nextPollAt, "2026-08-05T10:03:05.000Z");
  assert.deepEqual(store.state.sources[0].checkpoint, {
    initialized: true,
    highWaterPublishedAt: "2026-08-05T09:00:00.000Z",
    highWaterVideoId: "old-boundary",
    pendingHighWaterPublishedAt: "2026-08-05T11:00:00.000Z",
    pendingHighWaterVideoId: "new-3",
    cursor: 777,
  });

  const secondPage = await poll(store, [
    {
      videos: [{ id: "old-boundary", create_time: 1785920400 }],
      hasMore: false,
      cursor: 0,
    },
  ], "2026-08-05T10:04:00.000Z");
  assert.equal(JSON.parse(secondPage.fetchQueue.calls[0].body).cursor, 777);
  assert.equal(secondPage.result.pageComplete, true);
  assert.equal(secondPage.result.createdCount, 0);
  assert.deepEqual(store.state.sources[0].checkpoint, {
    initialized: true,
    highWaterPublishedAt: "2026-08-05T11:00:00.000Z",
    highWaterVideoId: "new-3",
  });
  assert.equal(store.state.deliveries.length, 2);
  assert.deepEqual(
    store.state.deliveries.map((delivery) => delivery.external_message_id).sort(),
    ["poll:tiktok:new-2", "poll:tiktok:new-3"]
  );
});
