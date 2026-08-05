const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const CONNECTION_ENV =
  "CODECLIP_PROVIDER_POLL_SOURCES_CONCURRENCY_TEST_DATABASE_URL";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const EVENT_CODE = "CC-POLL-PG-E2E";
const ACCOUNT_ID = "tiktok-pg-e2e-account";
const ACCESS_TOKEN = "pg-e2e-access-token";
const REFRESH_TOKEN = "pg-e2e-refresh-token";
const ENVIRONMENT = "sandbox";
const START = "2026-08-05T10:00:00.000Z";
const SECOND = "2026-08-05T10:10:00.000Z";
const THIRD = "2026-08-05T10:20:00.000Z";
const FOURTH = "2026-08-05T10:30:00.000Z";
const FIFTH = "2026-08-05T10:40:00.000Z";

function localConnectionString(t) {
  const connectionString = process.env[CONNECTION_ENV];
  if (!connectionString) {
    t.skip(`${CONNECTION_ENV} is not configured`);
    return null;
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    t.skip(`${CONNECTION_ENV} is invalid`);
    return null;
  }
  if (!LOCAL_HOSTS.has(parsed.hostname) && parsed.hostname !== "[::1]") {
    t.skip(`${CONNECTION_ENV} must point to localhost PostgreSQL`);
    return null;
  }
  return connectionString;
}

function schemaName() {
  return `codeclip_poll_worker_e2e_${process.pid}_${Date.now()}_${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

function quoteIdent(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("invalid schema identifier");
  }
  return `"${value}"`;
}

function makeCryptoEnv() {
  return {
    CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: `1:${crypto
      .randomBytes(32)
      .toString("base64")}`,
    CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION: "1",
  };
}

function makeScopedPool(basePool, schema) {
  async function prepare(client) {
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    return client;
  }
  return {
    async connect() {
      const client = await basePool.connect();
      try {
        await prepare(client);
      } catch (error) {
        client.release();
        throw error;
      }
      return client;
    },
    async query(sql, params = []) {
      const client = await this.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  };
}

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
        if (normalized === "content-type") return "application/json";
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
      const parsed = new URL(String(url));
      assert.equal(parsed.origin + parsed.pathname, "https://open.tiktokapis.com/v2/video/list/");
      assert.equal(parsed.searchParams.get("fields"), "id,create_time,share_url,title,duration");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(String(options.headers.Authorization || "").startsWith("Bearer "), true);
      assert.doesNotMatch(String(url), /access-token|pg-e2e-access-token/i);
      const body = JSON.parse(options.body);
      assert.ok(body.max_count <= 20);
      calls.push({ cursor: body.cursor ?? null, maxCount: body.max_count });
      const page = pages[Math.min(index, pages.length - 1)] || { videos: [] };
      index += 1;
      return makeDisplayResponse(page);
    },
  };
}

function video(id, createTimeSec, extra = {}) {
  return {
    id,
    create_time: createTimeSec,
    share_url: `https://www.tiktok.com/@codeclip/video/${encodeURIComponent(id)}`,
    title: id,
    duration: 10,
    ...extra,
  };
}

async function setupSchema({ pool, scopedPool, database, schema }) {
  await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  await scopedPool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      vertical TEXT NOT NULL,
      event_code TEXT UNIQUE NOT NULL,
      name TEXT,
      venue TEXT,
      city TEXT,
      start_at TIMESTAMPTZ,
      unlock_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      status TEXT,
      dashboard_access_key TEXT,
      benefit_inventory JSONB,
      raw_event JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await database.ensureCodeClipProviderCredentialsTable(scopedPool);
  await database.ensureCodeClipProviderCredentialAuditTable(scopedPool);
  await database.ensureCodeClipProviderAccountBindingsTable(scopedPool);
  await database.ensureCodeClipProviderPollSourcesTable(scopedPool);
  await database.ensureCodeClipProviderDeliveriesTable(scopedPool);
}

async function setupFixtures({ scopedPool, cryptoEnv, now }) {
  const {
    createCodeClipProviderCredential,
  } = require("./verticals/codeclip/provider-credentials");
  const {
    createCodeClipProviderAccountBinding,
  } = require("./verticals/codeclip/provider-account-bindings");

  await scopedPool.query(
    `
      INSERT INTO campaigns (
        id, vertical, event_code, name, status, raw_event
      )
      VALUES ($1, 'codeclip', $2, 'PG E2E Episode', 'active', $3::jsonb)
    `,
    ["pg-e2e-event", EVENT_CODE, JSON.stringify({ vertical: "codeclip" })]
  );

  const credential = await createCodeClipProviderCredential(
    {
      provider: "tiktok",
      environment: ENVIRONMENT,
      providerAccountId: ACCOUNT_ID,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
      tokenType: "bearer",
      scopes: ["user.info.basic", "video.list"],
    },
    {
      queryClient: scopedPool,
      env: cryptoEnv,
      now,
      actor: { type: "system" },
    }
  );
  assert.equal(credential.status, "created");

  const binding = await createCodeClipProviderAccountBinding(
    {
      eventCode: EVENT_CODE,
      provider: "tiktok",
      channel: "tiktok",
      providerAccountId: ACCOUNT_ID,
      createdBy: "pg-e2e",
    },
    {
      queryClient: scopedPool,
      getEventByCode: async () => ({ event_code: EVENT_CODE, vertical: "codeclip" }),
    }
  );
  assert.ok(binding.created || binding.existing);
}

async function sourceById(pool, id) {
  const result = await pool.query(
    `SELECT * FROM codeclip_provider_poll_sources WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function dueSourceIds(pool, now) {
  const result = await pool.query(
    `
      SELECT id
      FROM codeclip_provider_poll_sources
      WHERE status = 'active'
        AND next_poll_at <= $1::timestamptz
        AND (
          poll_claim_expires_at IS NULL
          OR poll_claim_expires_at <= $1::timestamptz
        )
      ORDER BY next_poll_at ASC, id ASC
    `,
    [now]
  );
  return result.rows.map((row) => String(row.id));
}

async function deliveries(pool) {
  const result = await pool.query(
    `
      SELECT provider, provider_account_id, event_code, external_message_id,
             initial_delivery_source, processing_state, core_persistence_state,
             completion_state
      FROM codeclip_provider_deliveries
      ORDER BY id ASC
    `
  );
  return result.rows;
}

async function makeSourceDue(pool, id, now) {
  await pool.query(
    `
      UPDATE codeclip_provider_poll_sources
      SET next_poll_at = $2::timestamptz
      WHERE id = $1
    `,
    [id, now]
  );
}

async function runRuntimeOnce({ scopedPool, registry, now, cryptoEnv }) {
  const {
    createCodeClipProviderPollingWorkerRuntime,
  } = require("./verticals/codeclip/provider-polling/worker-runtime");
  const previousKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const previousActive =
    process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    {
      enabled: true,
      provider: "tiktok",
      environment: ENVIRONMENT,
      intervalMs: 30_000,
      limit: 25,
      concurrency: 4,
      leaseMs: 60_000,
      ownerPrefix: "codeclip.provider.poll.pg",
      failureBackoffMs: 30_000,
      shutdownTimeoutMs: 5_000,
      runOnStart: false,
      oneShot: false,
    },
    {
      queryClient: scopedPool,
      adapterRegistry: registry,
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => now },
    }
  );
  try {
    process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS =
      cryptoEnv.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION =
      cryptoEnv.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    await runtime.start();
    const summary = await runtime.runOnce();
    await runtime.stop();
    assert.equal(runtime.getStatus().state, "stopped");
    return summary;
  } finally {
    try {
      await runtime.stop();
    } catch {
      // preserve test failure
    }
    if (previousKeys === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = previousKeys;
    }
    if (previousActive === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION =
        previousActive;
    }
  }
}

test("local PostgreSQL provider polling worker E2E is isolated and replay-safe", async (t) => {
  const connectionString = localConnectionString(t);
  if (!connectionString) return;

  const { Pool } = require("pg");
  const database = require("./db");
  const {
    activateCodeClipTikTokPolling,
  } = require("./verticals/codeclip/tiktok/polling-activation");
  const {
    createCodeClipProductionPollAdapterRegistry,
  } = require("./verticals/codeclip/provider-polling/production-adapter-registry");
  const {
    claimCodeClipProviderPollSource,
    completeCodeClipProviderPollSourceClaim,
    releaseCodeClipProviderPollSourceClaim,
  } = require("./verticals/codeclip/provider-poll-sources");

  const pool = new Pool({ connectionString });
  const schema = schemaName();
  const scopedPool = makeScopedPool(pool, schema);
  const cryptoEnv = makeCryptoEnv();

  try {
    await setupSchema({ pool, scopedPool, database, schema });
    await setupFixtures({ scopedPool, cryptoEnv, now: START });

    const fetchA = makeFetchQueue([
      { videos: [video("old-video-1", 100), video("old-video-2", 90)] },
      { videos: [video("new-video-1", 110), video("old-video-1", 100)] },
      { videos: [video("new-video-1", 110), video("old-video-1", 100)] },
      {
        videos: [video("new-video-3", 130), video("new-video-2", 120)],
        hasMore: true,
        cursor: 1234567890,
      },
      { videos: [video("new-video-1", 110), video("old-video-1", 100)] },
    ]);
    const registry = createCodeClipProductionPollAdapterRegistry({
      tiktok: { fetchImpl: fetchA.fetch },
    });

    const activation = await activateCodeClipTikTokPolling(
      {
        eventCode: EVENT_CODE,
        environment: ENVIRONMENT,
        providerAccountId: ACCOUNT_ID,
        now: START,
      },
      { queryClient: scopedPool, adapterRegistry: registry }
    );
    assert.equal(activation.status, "activated");
    const secondActivation = await activateCodeClipTikTokPolling(
      {
        eventCode: EVENT_CODE,
        environment: ENVIRONMENT,
        providerAccountId: ACCOUNT_ID,
        now: START,
      },
      { queryClient: scopedPool, adapterRegistry: registry }
    );
    assert.equal(secondActivation.status, "already_active");
    const sourceId = activation.sourceId;
    let source = await sourceById(scopedPool, sourceId);
    assert.equal(source.provider, "tiktok");
    assert.equal(source.environment, ENVIRONMENT);
    assert.equal(source.status, "active");
    assert.deepEqual(source.checkpoint, {});

    const baseline = await runRuntimeOnce({ scopedPool, registry, now: START, cryptoEnv });
    assert.equal(baseline.scanned, 1);
    assert.equal(baseline.attempted, 1);
    assert.equal(baseline.succeeded, 1);
    assert.equal(baseline.failed, 0);
    assert.equal(baseline.items[0].detectionsCount, 0);
    assert.equal((await deliveries(scopedPool)).length, 0);
    source = await sourceById(scopedPool, sourceId);
    assert.equal(source.checkpoint.initialized, true);
    assert.equal(source.checkpoint.highWaterVideoId, "old-video-1");

    await makeSourceDue(scopedPool, sourceId, SECOND);
    const newVideo = await runRuntimeOnce({ scopedPool, registry, now: SECOND, cryptoEnv });
    assert.equal(newVideo.items[0].detectionsCount, 1);
    let rows = await deliveries(scopedPool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_message_id, "poll:tiktok:new-video-1");
    assert.equal(rows[0].initial_delivery_source, "provider_polling");
    assert.equal(rows[0].event_code, EVENT_CODE);
    assert.equal(rows[0].processing_state, "processing");
    source = await sourceById(scopedPool, sourceId);
    assert.equal(source.checkpoint.highWaterVideoId, "new-video-1");
    assert.equal(Number(source.last_detections_count), 1);
    assert.equal(Number(source.consecutive_failures), 0);
    assert.ok(source.last_success_at);
    assert.ok(source.last_detection_at);

    await makeSourceDue(scopedPool, sourceId, THIRD);
    const replay = await runRuntimeOnce({ scopedPool, registry, now: THIRD, cryptoEnv });
    assert.equal(replay.items[0].deliveriesCount, 0);
    rows = await deliveries(scopedPool);
    assert.equal(rows.length, 1);

    await makeSourceDue(scopedPool, sourceId, FOURTH);
    const pageOne = await runRuntimeOnce({ scopedPool, registry, now: FOURTH, cryptoEnv });
    assert.equal(pageOne.items[0].pageComplete, false);
    rows = await deliveries(scopedPool);
    assert.equal(rows.length, 3);
    source = await sourceById(scopedPool, sourceId);
    assert.equal(source.checkpoint.highWaterVideoId, "new-video-1");
    assert.equal(source.checkpoint.pendingHighWaterVideoId, "new-video-3");
    assert.equal(source.checkpoint.cursor, 1234567890);

    const pageTwo = await runRuntimeOnce({ scopedPool, registry, now: FIFTH, cryptoEnv });
    assert.equal(pageTwo.items[0].pageComplete, true);
    rows = await deliveries(scopedPool);
    assert.equal(rows.length, 3);
    source = await sourceById(scopedPool, sourceId);
    assert.equal(source.checkpoint.highWaterVideoId, "new-video-3");
    assert.equal(Object.hasOwn(source.checkpoint, "cursor"), false);
    assert.equal(Object.hasOwn(source.checkpoint, "pendingHighWaterVideoId"), false);
    assert.equal(fetchA.calls[4].cursor, 1234567890);

    await makeSourceDue(scopedPool, sourceId, "2026-08-05T11:00:00.000Z");
    const [claimA, claimB] = await Promise.all([
      claimCodeClipProviderPollSource(
        {
          pollSourceId: sourceId,
          owner: "codeclip.pg.a",
          leaseMs: 60_000,
          now: "2026-08-05T11:00:00.000Z",
        },
        { queryClient: scopedPool }
      ),
      claimCodeClipProviderPollSource(
        {
          pollSourceId: sourceId,
          owner: "codeclip.pg.b",
          leaseMs: 60_000,
          now: "2026-08-05T11:00:00.000Z",
        },
        { queryClient: scopedPool }
      ),
    ]);
    assert.equal([claimA, claimB].filter((claim) => claim.ok === true).length, 1);
    assert.equal([claimA, claimB].filter((claim) => claim.ok === false).length, 1);

    const winner = claimA.ok ? { claim: claimA, owner: "codeclip.pg.a" } : { claim: claimB, owner: "codeclip.pg.b" };
    const loser = claimA.ok ? claimB : claimA;
    assert.equal(loser.reason, "POLL_CLAIM_CONTENTION");
    await scopedPool.query(
	      `UPDATE codeclip_provider_poll_sources
	       SET poll_claim_expires_at = $2::timestamptz
	       WHERE id = $1`,
	      [sourceId, "2026-08-05T11:01:00.000Z"]
	    );
    const reclaim = await claimCodeClipProviderPollSource(
      {
        pollSourceId: sourceId,
        owner: "codeclip.pg.reclaim",
        leaseMs: 60_000,
        now: "2026-08-05T11:02:00.000Z",
      },
      { queryClient: scopedPool }
    );
    assert.equal(reclaim.ok, true);
    assert.equal(Number(reclaim.claimVersion), Number(winner.claim.claimVersion) + 1);
    await assert.rejects(
      () =>
        completeCodeClipProviderPollSourceClaim(
          {
            pollSourceId: sourceId,
            owner: winner.owner,
            expectedVersion: winner.claim.claimVersion,
            checkpoint: { stale: true },
            now: "2026-08-05T11:02:00.000Z",
          },
          { queryClient: scopedPool }
        ),
      (error) => error.code === "POLL_CLAIM_FENCE_MISMATCH"
    );
    await assert.rejects(
      () =>
        releaseCodeClipProviderPollSourceClaim(
          {
            pollSourceId: sourceId,
            owner: winner.owner,
            expectedVersion: winner.claim.claimVersion,
            now: "2026-08-05T11:02:00.000Z",
            status: "active",
            nextPollAt: "2026-08-05T11:30:00.000Z",
          },
          { queryClient: scopedPool }
        ),
      (error) => error.code === "POLL_CLAIM_FENCE_MISMATCH"
    );
    await completeCodeClipProviderPollSourceClaim(
      {
        pollSourceId: sourceId,
        owner: "codeclip.pg.reclaim",
        expectedVersion: reclaim.claimVersion,
        checkpoint: source.checkpoint,
        nextPollAt: "2026-08-05T11:30:00.000Z",
        now: "2026-08-05T11:02:00.000Z",
      },
      { queryClient: scopedPool }
    );

    await scopedPool.query(
      `UPDATE codeclip_provider_poll_sources
       SET status = 'paused', next_poll_at = NULL, last_error_code = 'reauthorization_required'
       WHERE id = $1`,
      [sourceId]
    );
    assert.deepEqual(await dueSourceIds(scopedPool, "2026-08-05T12:00:00.000Z"), []);
    const fetchBeforePaused = fetchA.calls.length;
    const paused = await runRuntimeOnce({
      scopedPool,
      registry,
      now: "2026-08-05T12:00:00.000Z",
      cryptoEnv,
    });
    assert.equal(paused.scanned, 0);
    assert.equal(fetchA.calls.length, fetchBeforePaused);

    const reactivated = await activateCodeClipTikTokPolling(
      {
        eventCode: EVENT_CODE,
        environment: ENVIRONMENT,
        providerAccountId: ACCOUNT_ID,
        now: "2026-08-05T12:10:00.000Z",
      },
      { queryClient: scopedPool, adapterRegistry: registry }
    );
    assert.equal(reactivated.status, "reactivated");
    source = await sourceById(scopedPool, sourceId);
    assert.equal(source.status, "active");
    assert.equal(source.last_error_code, null);
    assert.equal(source.checkpoint.highWaterVideoId, "new-video-3");

    await scopedPool.query(
      `UPDATE codeclip_provider_poll_sources
       SET status = 'disabled', disabled_at = $2::timestamptz
       WHERE id = $1`,
      [sourceId, "2026-08-05T12:20:00.000Z"]
    );
    await assert.rejects(
      () =>
        activateCodeClipTikTokPolling(
          {
            eventCode: EVENT_CODE,
            environment: ENVIRONMENT,
            providerAccountId: ACCOUNT_ID,
            now: "2026-08-05T12:20:00.000Z",
          },
          { queryClient: scopedPool, adapterRegistry: registry }
        ),
      (error) => error.code === "TIKTOK_POLL_SOURCE_DISABLED"
    );
    assert.deepEqual(await dueSourceIds(scopedPool, "2026-08-05T12:30:00.000Z"), []);

    const serialized = JSON.stringify({ baseline, newVideo, replay, pageOne, pageTwo });
    assert.doesNotMatch(serialized, /pg-e2e-access-token|pg-e2e-refresh-token|Authorization|Bearer/i);
    assert.doesNotMatch(serialized, /tiktok-pg-e2e-account/);
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    } finally {
      await pool.end();
    }
  }
});
