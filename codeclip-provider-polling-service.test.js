const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderPollingServiceError,
  pollCodeClipProviderSource,
} = require("./verticals/codeclip/provider-polling/service");
const {
  createCodeClipProviderPollAdapterRegistry,
} = require("./verticals/codeclip/provider-polling/adapter-registry");

const OPERATION_NOW = "2026-08-04T12:00:00.000Z";
const TOKEN = "secret-access-token-value-do-not-leak";

function makeRegistry(pollImpl) {
  const registry = createCodeClipProviderPollAdapterRegistry();
  registry.register({
    provider: "youtube",
    poll: pollImpl,
  });
  return registry;
}

/** Pool-like client: full service requires connect(). */
function makePoolClient() {
  return {
    async connect() {
      return {
        async query() {
          return { rows: [] };
        },
        release() {},
      };
    },
    async query() {
      return { rows: [] };
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    claim: async () => ({
      ok: true,
      claimed: true,
      claimVersion: 3,
      claimedAt: OPERATION_NOW,
      expiresAt: "2026-08-04T12:01:00.000Z",
      pollSourceId: "42",
    }),
    getById: async () => ({
      id: "42",
      provider: "youtube",
      environment: "sandbox",
      providerAccountId: "UC_channel_service",
      pollIntervalMs: 30_000,
      checkpoint: { cursor: "0" },
      consecutiveFailures: 0,
      status: "active",
    }),
    findCredential: async () => ({
      id: "9",
      provider: "youtube",
      environment: "sandbox",
    }),
    inspectUsability: async () => ({
      id: "9",
      usableForProviderApi: true,
      reauthorizationRequired: false,
    }),
    secretRead: async () => ({
      ok: true,
      accessToken: TOKEN,
    }),
    listBindings: async () => [{ eventCode: "CC-EP-1", id: "b1" }],
    ingest: async (args) => ({
      status: "ingested",
      createdCount: args.detections.length,
      existingCount: 0,
      deliveryIds: args.detections.map((_, i) => String(i + 1)),
      bindingCount: args.bindings.length,
      pollSource: { id: "42", nextPollAt: args.nextPollAt },
    }),
    releaseClaim: async (args) => ({
      status: "released",
      pollSource: {
        id: "42",
        nextPollAt: args.nextPollAt,
        status: args.status,
        lastErrorCode: args.lastErrorCode,
      },
    }),
    ...overrides,
  };
}

test("service success path claims, polls adapter, ingests, returns safe summary", async () => {
  let seenToken = null;
  const registry = makeRegistry(async (input) => {
    seenToken = input.accessToken;
    return {
      ok: true,
      detections: [
        {
          providerObjectId: "vid-1",
          publishedAt: "2026-08-01T00:00:00.000Z",
          detectedAt: OPERATION_NOW,
          source: "data_api",
        },
      ],
      nextCheckpoint: { cursor: "1" },
      page: { complete: true },
    };
  });

  const ingestArgs = [];
  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      leaseMs: 60_000,
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      ingest: async (args) => {
        ingestArgs.push(args);
        return {
          status: "ingested",
          createdCount: 1,
          existingCount: 0,
          deliveryIds: ["77"],
          bindingCount: 1,
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(seenToken, TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.sourceId, "42");
  assert.equal(result.classification, "success");
  assert.equal(result.claimVersion, 3);
  assert.equal(result.pageComplete, true);
  assert.equal(result.detectionCount, 1);
  assert.equal(result.bindingCount, 1);
  assert.deepEqual(result.deliveryIds, ["77"]);
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(Object.hasOwn(result, "checkpoint"), false);
  assert.equal(Object.hasOwn(result, "providerAccountId"), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);

  assert.equal(ingestArgs.length, 1);
  assert.equal(ingestArgs[0].expectedVersion, 3);
  assert.deepEqual(ingestArgs[0].checkpoint, { cursor: "1" });
  assert.equal(ingestArgs[0].detections[0].deliverySource, "data_api_polling");
});

test("service incomplete page uses short page delay not poll_interval", async () => {
  const registry = makeRegistry(async () => ({
    ok: true,
    detections: [],
    nextCheckpoint: { page: 2 },
    page: { complete: false },
  }));

  let nextPollAt = null;
  await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      listBindings: async () => [],
      ingest: async (args) => {
        nextPollAt = args.nextPollAt;
        return {
          status: "ingested",
          createdCount: 0,
          existingCount: 0,
          deliveryIds: [],
          bindingCount: 0,
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  // default page delay 5000ms
  assert.equal(nextPollAt, "2026-08-04T12:00:05.000Z");
});

test("service zero bindings still completes with empty delivery set", async () => {
  const registry = makeRegistry(async () => ({
    ok: true,
    detections: [
      {
        providerObjectId: "vid-1",
        publishedAt: "2026-08-01T00:00:00.000Z",
        detectedAt: OPERATION_NOW,
        source: "data_api",
      },
    ],
    nextCheckpoint: {},
    page: { complete: true },
  }));

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      listBindings: async () => [],
      ingest: async (args) => {
        assert.equal(args.bindings.length, 0);
        return {
          status: "ingested",
          createdCount: 0,
          existingCount: 0,
          deliveryIds: [],
          bindingCount: 0,
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.bindingCount, 0);
  assert.equal(result.deliveryIds.length, 0);
});

test("service credential_unusable pauses without calling adapter", async () => {
  let polled = false;
  const registry = makeRegistry(async () => {
    polled = true;
    return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
  });

  const releases = [];
  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      findCredential: async () => null,
      releaseClaim: async (args) => {
        releases.push(args);
        return {
          status: "released",
          pollSource: { id: "42", nextPollAt: args.nextPollAt, status: args.status },
        };
      },
    })
  );

  assert.equal(polled, false);
  assert.equal(result.ok, false);
  assert.equal(result.classification, "credential_unusable");
  assert.equal(releases[0].status, "paused");
  assert.equal(releases[0].nextPollAt, null);
  assert.equal(releases[0].lastErrorCode, "credential_unusable");
  assert.equal(result.nextPollAt, null);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("service maps adapter failure classification to fenced release", async () => {
  const registry = makeRegistry(async () => ({
    ok: false,
    classification: "rate_limited",
    retryAfterMs: 60_000,
  }));

  const releases = [];
  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      releaseClaim: async (args) => {
        releases.push(args);
        return {
          status: "released",
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.classification, "rate_limited");
  assert.equal(releases[0].lastErrorCode, "rate_limited");
  assert.equal(releases[0].status, "active");
  assert.equal(releases[0].nextPollAt, "2026-08-04T12:01:00.000Z");
});

test("service refreshes expired provider token once before polling", async () => {
  const refreshedToken = "secret-refreshed-access-token-value-do-not-leak";
  const queryClient = makePoolClient();
  const env = { SAFE_ENV: "1" };
  let secretReads = 0;
  let refreshCalls = 0;
  let seenToken = null;

  const registry = makeRegistry(async (input) => {
    seenToken = input.accessToken;
    return {
      ok: true,
      detections: [],
      nextCheckpoint: { cursor: "1" },
      page: { complete: true },
    };
  });

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient,
      credentialEnv: env,
      adapterRegistry: registry,
      credentialRefreshRegistry: {
        get(provider) {
          assert.equal(provider, "youtube");
          return async (input, options) => {
            refreshCalls += 1;
            assert.equal(input.credentialId, "9");
            assert.equal(input.owner, "worker-a:refresh");
            assert.equal(options.queryClient, queryClient);
            assert.equal(options.env, env);
            return { ok: true, status: "refreshed", credentialId: "9" };
          };
        },
      },
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      secretRead: async () => {
        secretReads += 1;
        if (secretReads === 1) {
          return { ok: false, reason: "TOKEN_EXPIRED" };
        }
        return {
          ok: true,
          accessToken: refreshedToken,
          credential: { scopes: ["video.list"] },
        };
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.classification, "empty");
  assert.equal(secretReads, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(seenToken, refreshedToken);
  assert.equal(JSON.stringify(result).includes(refreshedToken), false);
});

test("service maps failed expired-token refresh to retryable release", async () => {
  let polled = false;
  const releases = [];
  const registry = makeRegistry(async () => {
    polled = true;
    return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
  });

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      credentialRefreshRegistry: {
        get() {
          return async () => ({
            ok: false,
            status: "retryable",
            classification: "REFRESH_CLAIM_CONTENTION",
          });
        },
      },
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      secretRead: async () => ({ ok: false, reason: "TOKEN_EXPIRED" }),
      releaseClaim: async (args) => {
        releases.push(args);
        return {
          status: "released",
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(polled, false);
  assert.equal(result.ok, false);
  assert.equal(result.classification, "retryable");
  assert.equal(releases[0].status, "active");
  assert.equal(releases[0].lastErrorCode, "retryable");
});

test("service requires video.list on TikTok credential before polling", async () => {
  let polled = false;
  let secretReads = 0;
  const releases = [];
  const registry = createCodeClipProviderPollAdapterRegistry();
  registry.register({
    provider: "tiktok",
    poll: async () => {
      polled = true;
      return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
    },
  });

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      getById: async () => ({
        id: "42",
        provider: "tiktok",
        environment: "sandbox",
        providerAccountId: "tiktok-account",
        pollIntervalMs: 30_000,
        checkpoint: {},
        consecutiveFailures: 0,
        status: "active",
      }),
      findCredential: async () => ({
        id: "9",
        provider: "tiktok",
        environment: "sandbox",
        scopes: ["user.info.basic"],
      }),
      secretRead: async () => {
        secretReads += 1;
        return { ok: true, accessToken: TOKEN };
      },
      releaseClaim: async (args) => {
        releases.push(args);
        return {
          status: "released",
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(polled, false);
  assert.equal(secretReads, 0);
  assert.equal(result.ok, false);
  assert.equal(result.classification, "reauthorization_required");
  assert.equal(releases[0].status, "paused");
  assert.equal(releases[0].lastErrorCode, "reauthorization_required");
});

test("service fails closed when TikTok refresh does not preserve video.list", async () => {
  let polled = false;
  let findCalls = 0;
  let secretReads = 0;
  const releases = [];
  const registry = createCodeClipProviderPollAdapterRegistry();
  registry.register({
    provider: "tiktok",
    poll: async () => {
      polled = true;
      return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
    },
  });

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      credentialRefreshRegistry: {
        get() {
          return async () => ({ ok: true, status: "refreshed", credentialId: "9" });
        },
      },
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      getById: async () => ({
        id: "42",
        provider: "tiktok",
        environment: "sandbox",
        providerAccountId: "tiktok-account",
        pollIntervalMs: 30_000,
        checkpoint: {},
        consecutiveFailures: 0,
        status: "active",
      }),
      findCredential: async () => {
        findCalls += 1;
        return {
          id: "9",
          provider: "tiktok",
          environment: "sandbox",
          scopes:
            findCalls === 1
              ? ["user.info.basic", "video.list"]
              : ["user.info.basic"],
        };
      },
      secretRead: async () => {
        secretReads += 1;
        return { ok: false, reason: "TOKEN_EXPIRED" };
      },
      releaseClaim: async (args) => {
        releases.push(args);
        return {
          status: "released",
          pollSource: { id: "42", nextPollAt: args.nextPollAt },
        };
      },
    })
  );

  assert.equal(polled, false);
  assert.equal(findCalls, 2);
  assert.equal(secretReads, 1);
  assert.equal(result.ok, false);
  assert.equal(result.classification, "reauthorization_required");
  assert.equal(releases[0].status, "paused");
  assert.equal(releases[0].lastErrorCode, "reauthorization_required");
});

test("service maps adapter throw to provider_malformed_response", async () => {
  const registry = makeRegistry(async () => {
    throw new Error(`boom ${TOKEN}`);
  });

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps()
  );

  assert.equal(result.ok, false);
  assert.equal(result.classification, "provider_malformed_response");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("service requires adapterRegistry and pool with connect()", async () => {
  await assert.rejects(
    () =>
      pollCodeClipProviderSource({
        sourceId: "1",
        owner: "w",
        queryClient: makePoolClient(),
      }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingServiceError);
      assert.equal(error.code, "INVALID_SERVICE_INPUT");
      return true;
    }
  );
  await assert.rejects(
    () =>
      pollCodeClipProviderSource({
        sourceId: "1",
        owner: "w",
        adapterRegistry: makeRegistry(async () => ({})),
      }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingServiceError);
      assert.equal(error.code, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
  // Query-only client (caller-owned TX style) is rejected for full HTTP service flow.
  await assert.rejects(
    () =>
      pollCodeClipProviderSource({
        sourceId: "1",
        owner: "w",
        queryClient: { query: async () => ({ rows: [] }) },
        adapterRegistry: makeRegistry(async () => ({})),
      }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingServiceError);
      assert.equal(error.code, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
});

test("service fence mismatch during ingest returns retryable without leaking internals", async () => {
  const {
    CodeClipProviderPollingIngestError,
  } = require("./verticals/codeclip/provider-polling/delivery-ingest");
  const registry = makeRegistry(async () => ({
    ok: true,
    detections: [],
    nextCheckpoint: {},
    page: { complete: true },
  }));

  const result = await pollCodeClipProviderSource(
    {
      sourceId: "42",
      owner: "worker-a",
      now: OPERATION_NOW,
      queryClient: makePoolClient(),
      adapterRegistry: registry,
      clock: () => Date.parse(OPERATION_NOW),
    },
    baseDeps({
      ingest: async () => {
        throw new CodeClipProviderPollingIngestError(
          "POLL_CLAIM_FENCE_MISMATCH",
          "poll claim fence did not match"
        );
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.classification, "retryable");
});

// ---------------------------------------------------------------------------
// Env-gated PostgreSQL concurrency (skip without local URL)
// ---------------------------------------------------------------------------

test("poll service fenced ingest single-winner in PostgreSQL", async (t) => {
  const connectionString =
    process.env.CODECLIP_PROVIDER_POLL_SOURCES_CONCURRENCY_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "CODECLIP_PROVIDER_POLL_SOURCES_CONCURRENCY_TEST_DATABASE_URL is not configured"
    );
    return;
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    t.skip("concurrency test database URL is invalid");
    return;
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    t.skip("concurrency test requires local PostgreSQL");
    return;
  }

  const { Pool } = require("pg");
  const database = require("./db");
  const {
    createCodeClipProviderPollSource,
    claimCodeClipProviderPollSource,
    completeCodeClipProviderPollSourceClaim,
  } = require("./verticals/codeclip/provider-poll-sources");
  const {
    ingestCodeClipProviderPollDetections,
  } = require("./verticals/codeclip/provider-polling/delivery-ingest");
  const {
    getCodeClipProviderPollingCompletionInput,
  } = require("./verticals/codeclip/provider-polling/detection-metadata");

  const pool = new Pool({ connectionString });
  const schema = `codeclip_poll_svc_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);

    await database.ensureCodeClipProviderPollSourcesTable(pool);
    await database.ensureCodeClipProviderDeliveriesTable(pool);

    const created = await createCodeClipProviderPollSource(
      {
        provider: "tiktok",
        environment: "sandbox",
        providerAccountId: "UC_svc_fence_channel_01",
        pollIntervalMs: 30_000,
      },
      { queryClient: pool, now: OPERATION_NOW }
    );
    const sourceId = created.pollSource.id;

    const claimA = await claimCodeClipProviderPollSource(
      {
        pollSourceId: sourceId,
        owner: "worker.a",
        leaseMs: 60_000,
        now: OPERATION_NOW,
      },
      { queryClient: pool }
    );
    assert.equal(claimA.ok, true);

    // Expire and reclaim as B
    await pool.query(
      `UPDATE codeclip_provider_poll_sources
       SET poll_claimed_at = '2026-08-04T10:00:00.000Z',
           poll_claim_expires_at = '2026-08-04T11:00:00.000Z'
       WHERE id = $1`,
      [sourceId]
    );
    const claimB = await claimCodeClipProviderPollSource(
      {
        pollSourceId: sourceId,
        owner: "worker.b",
        leaseMs: 60_000,
        now: OPERATION_NOW,
      },
      { queryClient: pool }
    );
    assert.equal(claimB.ok, true);
    assert.equal(claimB.claimVersion, 2);

    await assert.rejects(
      () =>
        ingestCodeClipProviderPollDetections(
          {
            pollSourceId: sourceId,
            owner: "worker.a",
            expectedVersion: 1,
            checkpoint: { from: "a" },
            provider: "tiktok",
            providerAccountId: "tiktok_sandbox_account_01",
            detections: [
              {
                providerObjectId: "vid-a",
                publishedAt: "2026-08-04T11:30:00.000Z",
                detectedAt: OPERATION_NOW,
                source: "display_api_polling",
                deliverySource: "provider_polling",
              },
            ],
            bindings: [{ eventCode: "CC-FENCE" }],
            now: OPERATION_NOW,
          },
          { queryClient: pool }
        ),
      (error) => error.code === "POLL_CLAIM_FENCE_MISMATCH"
    );

    const deliveriesAfterA = await pool.query(
      `SELECT COUNT(*)::int AS c FROM codeclip_provider_deliveries`
    );
    assert.equal(deliveriesAfterA.rows[0].c, 0);

    const ingested = await ingestCodeClipProviderPollDetections(
      {
        pollSourceId: sourceId,
        owner: "worker.b",
        expectedVersion: 2,
        checkpoint: { from: "b" },
        nextPollAt: "2026-08-04T12:30:00.000Z",
        provider: "tiktok",
        providerAccountId: "tiktok_sandbox_account_01",
        detections: [
          {
            providerObjectId: "vid-b",
            publishedAt: "2026-08-04T11:45:00.000Z",
            source: "display_api_polling",
            deliverySource: "provider_polling",
            detectedAt: OPERATION_NOW,
            canonicalUrl: "https://www.tiktok.com/@creator/video/vid-b",
          },
        ],
        bindings: [{ eventCode: "CC-FENCE" }],
        now: OPERATION_NOW,
        observability: {
          lastSuccessAt: OPERATION_NOW,
          lastDetectionAt: OPERATION_NOW,
          lastDetectionsCount: 1,
        },
      },
      { queryClient: pool }
    );
    assert.equal(ingested.createdCount, 1);

    const row = await pool.query(
      `SELECT checkpoint, poll_claim_owner, poll_claim_version
       FROM codeclip_provider_poll_sources WHERE id = $1`,
      [sourceId]
    );
    assert.deepEqual(row.rows[0].checkpoint, { from: "b" });
    assert.equal(row.rows[0].poll_claim_owner, null);
    assert.equal(Number(row.rows[0].poll_claim_version), 2);

    const deliveryRow = await pool.query(
      `SELECT provider, initial_delivery_source, provider_detection_metadata
       FROM codeclip_provider_deliveries
       WHERE provider = 'tiktok'
         AND event_code = 'CC-FENCE'
         AND external_message_id = 'poll:tiktok:vid-b'`
    );
    assert.equal(deliveryRow.rows.length, 1);
    assert.deepEqual(deliveryRow.rows[0].provider_detection_metadata, {
      provider: "tiktok",
      channel: "tiktok",
      providerContentId: "vid-b",
      publishedAt: "2026-08-04T11:45:00.000Z",
      detectedAt: OPERATION_NOW,
      detectionSource: "display_api_polling",
      canonicalUrl: "https://www.tiktok.com/@creator/video/vid-b",
    });
    const completionInput = getCodeClipProviderPollingCompletionInput(
      deliveryRow.rows[0]
    );
    assert.equal(completionInput.ok, true);
    assert.deepEqual(
      completionInput.completionInput,
      deliveryRow.rows[0].provider_detection_metadata
    );

    // Replay is existing
    await completeCodeClipProviderPollSourceClaim(
      {
        pollSourceId: sourceId,
        owner: "worker.b",
        expectedVersion: 2,
        checkpoint: { from: "b" },
        now: OPERATION_NOW,
      },
      { queryClient: pool }
    ).catch(() => {
      // claim already cleared; reclaim for replay test
    });

    const claimReplay = await claimCodeClipProviderPollSource(
      {
        pollSourceId: sourceId,
        owner: "worker.b",
        leaseMs: 60_000,
        now: OPERATION_NOW,
      },
      { queryClient: pool }
    );
    const replay = await ingestCodeClipProviderPollDetections(
      {
        pollSourceId: sourceId,
        owner: "worker.b",
        expectedVersion: claimReplay.claimVersion,
        checkpoint: { from: "b2" },
        provider: "tiktok",
        providerAccountId: "tiktok_sandbox_account_01",
        detections: [
          {
            providerObjectId: "vid-b",
            publishedAt: "2026-08-04T11:45:00.000Z",
            source: "display_api_polling",
            deliverySource: "provider_polling",
            detectedAt: OPERATION_NOW,
            canonicalUrl: "https://www.tiktok.com/@creator/video/changed",
          },
        ],
        bindings: [{ eventCode: "CC-FENCE" }],
        now: OPERATION_NOW,
      },
      { queryClient: pool }
    );
    assert.equal(replay.existingCount, 1);
    assert.equal(replay.createdCount, 0);
  } finally {
    try {
      clientA.release();
    } catch {
      // ignore
    }
    try {
      clientB.release();
    } catch {
      // ignore
    }
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch {
      // ignore
    }
    await pool.end();
  }
});
