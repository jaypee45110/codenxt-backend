const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CodeClipTikTokOAuthError,
  createCodeClipTikTokOAuthState,
  claimCodeClipTikTokOAuthState,
  completeCodeClipTikTokOAuthState,
} = require("./verticals/codeclip/tiktok/oauth-state");

const NOW = "2026-08-05T12:00:00.000Z";
const ACTOR = Object.freeze({ type: "operator", id: "admin.1" });

function hashState(raw) {
  return crypto.createHash("sha256").update(String(raw), "utf8").digest("hex");
}

function createStateStore() {
  const calls = [];
  const rows = [];
  let nextId = 1;

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*BEGIN|COMMIT|ROLLBACK\s*$/i.test(sql.trim())) return { rows: [] };
      if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
        const injected = params[0];
        return {
          rows: [
            {
              operation_now: injected
                ? new Date(injected)
                : new Date(NOW),
            },
          ],
        };
      }
      if (/INSERT INTO codeclip_tiktok_oauth_states/.test(sql)) {
        const row = {
          id: nextId++,
          state_hash: params[0],
          event_code: params[1],
          environment: params[2],
          redirect_uri: params[3],
          requested_scopes: params[4],
          return_url: params[5],
          created_by: params[6],
          status: "pending",
          claim_owner: null,
          claimed_at: null,
          claim_expires_at: null,
          claim_version: 0,
          created_at: params[7],
          expires_at: params[8],
          completed_at: null,
          consumed_at: null,
        };
        rows.push(row);
        return { rows: [{ ...row }] };
      }
      if (/FROM codeclip_tiktok_oauth_states/.test(sql) && /FOR UPDATE/i.test(sql)) {
        if (/state_hash = \$1/.test(sql)) {
          const row = rows.find((r) => r.state_hash === params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (/id = \$1/.test(sql)) {
          const row = rows.find((r) => String(r.id) === String(params[0]));
          return { rows: row ? [{ ...row }] : [] };
        }
      }
      if (/UPDATE codeclip_tiktok_oauth_states/.test(sql)) {
        if (/claim_version = claim_version \+ 1/.test(sql)) {
          const row = rows.find((r) => String(r.id) === String(params[0]));
          if (!row) return { rows: [] };
          const op = params[2];
          const lease = Number(params[3]);
          const opMs = Date.parse(op);
          const active =
            row.status === "claimed" &&
            row.claim_expires_at &&
            Date.parse(row.claim_expires_at) > opMs;
          if (active) return { rows: [] };
          if (row.status === "completed") return { rows: [] };
          if (Date.parse(row.expires_at) <= opMs) return { rows: [] };
          row.status = "claimed";
          row.claim_owner = params[1];
          row.claimed_at = op;
          row.claim_expires_at = new Date(opMs + lease).toISOString();
          row.claim_version = Number(row.claim_version || 0) + 1;
          return { rows: [{ ...row }] };
        }
        if (/status = 'completed'/.test(sql)) {
          const row = rows.find((r) => String(r.id) === String(params[0]));
          if (!row) return { rows: [] };
          const op = params[1];
          const owner = params[2];
          const version = String(params[3]);
          if (row.status !== "claimed") return { rows: [] };
          if (String(row.claim_owner).toLowerCase() !== String(owner).toLowerCase()) {
            return { rows: [] };
          }
          if (String(row.claim_version) !== version) return { rows: [] };
          if (Date.parse(row.claim_expires_at) <= Date.parse(op)) return { rows: [] };
          row.status = "completed";
          row.completed_at = op;
          row.consumed_at = op;
          row.claim_owner = null;
          row.claimed_at = null;
          row.claim_expires_at = null;
          return { rows: [{ ...row }] };
        }
      }
      return { rows: [] };
    },
  };
}

function createPoolClientLikeStateStoreClient() {
  const store = createStateStore();
  let connectCalls = 0;
  let releaseCalls = 0;
  return {
    ...store,
    get connectCalls() {
      return connectCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    async connect() {
      connectCalls += 1;
      throw new Error("PoolClient connect must not be called");
    },
    release() {
      releaseCalls += 1;
    },
  };
}

function countTransactionCalls(client, statement) {
  const pattern = new RegExp(`^\\s*${statement}\\s*$`, "i");
  return client.calls.filter((call) => pattern.test(String(call.sql || "").trim()))
    .length;
}

const baseCreate = {
  eventCode: "CC-TIKTOK-1",
  environment: "sandbox",
  redirectUri: "https://api.example.test/api/codeclip/providers/tiktok/oauth/callback",
  returnUrl: "https://app.example.test/checkout/tiktok",
  actor: ACTOR,
  now: NOW,
};

test("create TikTok OAuth state stores only hash and returns raw state for URL", async () => {
  const client = createStateStore();
  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: client,
  });

  assert.equal(typeof created.rawState, "string");
  assert.ok(created.rawState.length >= 43); // 32 bytes base64url
  assert.equal(created.oauthState.status, "pending");
  assert.equal(created.oauthState.eventCode, "CC-TIKTOK-1");
  assert.deepEqual(created.oauthState.requestedScopes, ["user.info.basic"]);
  assert.equal(Object.hasOwn(created.oauthState, "rawState"), false);
  assert.equal(Object.hasOwn(created.oauthState, "stateHash"), false);

  const insert = client.calls.find((c) =>
    /INSERT INTO codeclip_tiktok_oauth_states/.test(c.sql)
  );
  assert.ok(insert);
  assert.equal(insert.params[0], hashState(created.rawState));
  assert.equal(
    insert.params.some((p) => p === created.rawState),
    false
  );
  assert.equal(created.expiresAt, "2026-08-05T12:10:00.000Z");
});

test("create TikTok OAuth state accepts user.info.basic with video.list", async () => {
  const client = createStateStore();
  const created = await createCodeClipTikTokOAuthState(
    { ...baseCreate, requestedScopes: ["video.list", "user.info.basic"] },
    { queryClient: client }
  );

  assert.deepEqual(created.oauthState.requestedScopes, [
    "user.info.basic",
    "video.list",
  ]);
});

test("claim pending state increments version; contention and stale reclaim", async () => {
  const client = createStateStore();
  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: client,
  });

  const claimed = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-a",
      leaseMs: 60_000,
      now: NOW,
    },
    { queryClient: client }
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.claimVersion, 1);
  assert.equal(claimed.oauthState.status, "claimed");

  const contended = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-b",
      leaseMs: 60_000,
      now: NOW,
    },
    { queryClient: client }
  );
  assert.equal(contended.ok, false);
  assert.equal(contended.reason, "OAUTH_STATE_CONTENTION");

  client.rows[0].claim_expires_at = "2026-08-05T11:59:00.000Z";
  const reclaimed = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-b",
      leaseMs: 60_000,
      now: NOW,
    },
    { queryClient: client }
  );
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.claimVersion, 2);
});

test("complete is fenced; wrong version fails; correct completes", async () => {
  const client = createStateStore();
  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: client,
  });
  const claimed = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-a",
      leaseMs: 60_000,
      now: NOW,
    },
    { queryClient: client }
  );

  await assert.rejects(
    () =>
      completeCodeClipTikTokOAuthState(
        {
          stateId: created.oauthState.id,
          owner: "worker-a",
          expectedClaimVersion: 99,
          now: NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokOAuthError);
      assert.equal(error.code, "OAUTH_STATE_STALE");
      return true;
    }
  );

  const completed = await completeCodeClipTikTokOAuthState(
    {
      stateId: created.oauthState.id,
      owner: "worker-a",
      expectedClaimVersion: claimed.claimVersion,
      now: NOW,
    },
    { queryClient: client }
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.oauthState.status, "completed");
  assert.equal(completed.oauthState.claimOwner, null);

  const again = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-c",
      now: NOW,
    },
    { queryClient: client }
  );
  assert.equal(again.ok, true);
  assert.equal(again.alreadyCompleted, true);
  assert.equal(again.status, "completed");
});

test("complete accepts caller-owned PoolClient-like client without nested connect or release", async () => {
  const client = createPoolClientLikeStateStoreClient();
  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: client,
  });
  const claimed = await claimCodeClipTikTokOAuthState(
    {
      state: created.rawState,
      owner: "worker-a",
      leaseMs: 60_000,
      now: NOW,
    },
    { queryClient: client }
  );

  const completed = await completeCodeClipTikTokOAuthState(
    {
      stateId: created.oauthState.id,
      owner: "worker-a",
      expectedClaimVersion: claimed.claimVersion,
      now: NOW,
    },
    { queryClient: client }
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.oauthState.status, "completed");
  assert.equal(client.connectCalls, 0);
  assert.equal(client.releaseCalls, 0);
  assert.equal(countTransactionCalls(client, "BEGIN"), 0);
  assert.equal(countTransactionCalls(client, "COMMIT"), 0);
  assert.equal(countTransactionCalls(client, "ROLLBACK"), 0);
});

test("state mutations use pool-owned transaction for pool-like query clients", async () => {
  const store = createStateStore();
  const events = [];
  const acquiredClient = {
    async query(sql, params = []) {
      const normalized = String(sql).trim().toUpperCase();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        events.push(normalized);
        return { rows: [] };
      }
      events.push("QUERY");
      return store.query(sql, params);
    },
    release() {
      events.push("RELEASE");
    },
  };
  const pool = {
    async query(sql, params = []) {
      return store.query(sql, params);
    },
    async connect() {
      events.push("CONNECT");
      return acquiredClient;
    },
  };

  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: pool,
  });

  assert.equal(created.oauthState.status, "pending");
  assert.deepEqual(events, ["CONNECT", "BEGIN", "QUERY", "QUERY", "COMMIT", "RELEASE"]);
});

test("state mutations fail closed for unknown database client shape", async () => {
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthState(baseCreate, {
        queryClient: { connect: async () => ({ release() {} }) },
      }),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokOAuthError);
      assert.equal(error.code, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
});

test("expired and missing state fail closed", async () => {
  const client = createStateStore();
  const created = await createCodeClipTikTokOAuthState(baseCreate, {
    queryClient: client,
  });
  client.rows[0].expires_at = "2026-08-05T11:00:00.000Z";

  await assert.rejects(
    () =>
      claimCodeClipTikTokOAuthState(
        { state: created.rawState, owner: "worker-a", now: NOW },
        { queryClient: client }
      ),
    (error) => error.code === "OAUTH_STATE_EXPIRED"
  );

  await assert.rejects(
    () =>
      claimCodeClipTikTokOAuthState(
        { state: "not-a-real-state-value-xxxxxx", owner: "worker-a", now: NOW },
        { queryClient: client }
      ),
    (error) => error.code === "OAUTH_STATE_NOT_FOUND"
  );
});

test("invalid scopes and environments rejected", async () => {
  const client = createStateStore();
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthState(
        { ...baseCreate, requestedScopes: ["video.list"] },
        { queryClient: client }
      ),
    (error) => error.code === "INVALID_SCOPES"
  );
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthState(
        { ...baseCreate, requestedScopes: ["user.info.basic", "comment.list"] },
        { queryClient: client }
      ),
    (error) => error.code === "INVALID_SCOPES"
  );
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthState(
        { ...baseCreate, environment: "staging" },
        { queryClient: client }
      ),
    (error) => error.code === "INVALID_ENVIRONMENT"
  );
});

test("TikTok OAuth state schema ensure is present and secret-free", async () => {
  const database = require("./db");
  assert.equal(typeof database.ensureCodeClipTikTokOAuthStatesTable, "function");
  const calls = [];
  await database.ensureCodeClipTikTokOAuthStatesTable({
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
  });
  const joined = calls.join("\n");
  assert.match(joined, /CREATE TABLE IF NOT EXISTS codeclip_tiktok_oauth_states/);
  assert.match(joined, /state_hash TEXT NOT NULL/);
  assert.match(joined, /claim_version BIGINT NOT NULL DEFAULT 0/);
  assert.match(joined, /status IN \('pending', 'claimed', 'completed'\)/);
  assert.equal(/client_secret|access_token|refresh_token|code_verifier/.test(joined), false);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL concurrency (env-gated; never production)
// ---------------------------------------------------------------------------

const CODECLIP_TIKTOK_OAUTH_STATE_CONCURRENCY_ENV =
  "CODECLIP_TIKTOK_OAUTH_STATE_CONCURRENCY_TEST_DATABASE_URL";

function resolveLocalConcurrencyDatabaseUrl(t) {
  const connectionString = process.env[CODECLIP_TIKTOK_OAUTH_STATE_CONCURRENCY_ENV];
  if (!connectionString) {
    t.skip(`${CODECLIP_TIKTOK_OAUTH_STATE_CONCURRENCY_ENV} is not configured`);
    return null;
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    t.skip("concurrency test database URL is invalid");
    return null;
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    t.skip(
      "concurrency test requires an explicitly isolated local PostgreSQL database"
    );
    return null;
  }
  return connectionString;
}

function asOwnedPool(client) {
  return {
    async connect() {
      return {
        query: client.query.bind(client),
        release() {
          // session retained for assertions / cleanup
        },
      };
    },
  };
}

function buildTikTokOAuthStateDdl(schema) {
  return `
    CREATE TABLE ${schema}.codeclip_tiktok_oauth_states (
      id BIGSERIAL PRIMARY KEY,
      state_hash TEXT NOT NULL,
      event_code TEXT NOT NULL,
      environment TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      requested_scopes TEXT[] NOT NULL,
      return_url TEXT NOT NULL,
      created_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_owner TEXT,
      claimed_at TIMESTAMPTZ,
      claim_expires_at TIMESTAMPTZ,
      claim_version BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      UNIQUE (state_hash),
      CHECK (environment IN ('sandbox', 'production')),
      CHECK (status IN ('pending', 'claimed', 'completed')),
      CHECK (char_length(state_hash) BETWEEN 32 AND 128),
      CHECK (char_length(event_code) BETWEEN 1 AND 120),
      CHECK (char_length(redirect_uri) BETWEEN 1 AND 512),
      CHECK (char_length(return_url) BETWEEN 1 AND 2048),
      CHECK (cardinality(requested_scopes) >= 1),
      CHECK (expires_at > created_at),
      CHECK (claim_version >= 0),
      CHECK (
        (
          claim_owner IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
        )
        OR
        (
          claim_owner IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL
        )
      ),
      CHECK (
        claim_expires_at IS NULL
        OR claim_expires_at > claimed_at
      ),
      CHECK (
        claim_owner IS NULL
        OR char_length(claim_owner) BETWEEN 1 AND 128
      ),
      CHECK (
        (
          status = 'completed'
          AND completed_at IS NOT NULL
          AND consumed_at IS NOT NULL
        )
        OR
        (
          status IN ('pending', 'claimed')
          AND completed_at IS NULL
          AND consumed_at IS NULL
        )
      )
    )
  `;
}

function createSchemaScopedPool(pool, schema) {
  return {
    async connect() {
      const client = await pool.connect();
      await client.query(`SET search_path TO ${schema}`);
      return client;
    },
  };
}

test("TikTok OAuth state claim is single-winner in PostgreSQL", async (t) => {
  const connectionString = resolveLocalConcurrencyDatabaseUrl(t);
  if (!connectionString) return;

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const schema = `codeclip_tiktok_oauth_claim_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(buildTikTokOAuthStateDdl(schema));
    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

    const setupPool = createSchemaScopedPool(pool, schema);
    const created = await createCodeClipTikTokOAuthState(
      {
        ...baseCreate,
        eventCode: `CC-TIKTOK-PG-CLAIM-${process.pid}`,
        now: "2026-08-05T12:00:00.000Z",
        ttlSeconds: 600,
      },
      { queryClient: setupPool }
    );

    const poolA = asOwnedPool(clientA);
    const poolB = asOwnedPool(clientB);
    const injectedNow = "2026-08-05T12:00:00.000Z";

    const [first, second] = await Promise.all([
      claimCodeClipTikTokOAuthState(
        {
          state: created.rawState,
          owner: "worker.pg.a",
          leaseMs: 60_000,
          now: injectedNow,
        },
        { queryClient: poolA }
      ),
      claimCodeClipTikTokOAuthState(
        {
          state: created.rawState,
          owner: "worker.pg.b",
          leaseMs: 60_000,
          now: injectedNow,
        },
        { queryClient: poolB }
      ),
    ]);

    const winners = [first, second].filter((r) => r && r.ok === true);
    const losers = [first, second].filter((r) => r && r.ok === false);
    assert.equal(winners.length, 1, "exactly one claim winner");
    assert.equal(losers.length, 1, "exactly one contention loser");
    assert.equal(winners[0].claimVersion, 1);
    assert.equal(losers[0].reason, "OAUTH_STATE_CONTENTION");
    assert.equal(Object.hasOwn(winners[0].oauthState || {}, "rawState"), false);
    assert.equal(Object.hasOwn(winners[0].oauthState || {}, "stateHash"), false);

    const row = await pool.query(
      `
        SELECT claim_owner, claim_version, status, state_hash,
               claimed_at, claim_expires_at
        FROM ${schema}.codeclip_tiktok_oauth_states
        WHERE id = $1
      `,
      [created.oauthState.id]
    );
    assert.equal(row.rows.length, 1);
    const owner = row.rows[0].claim_owner;
    assert.ok(owner === "worker.pg.a" || owner === "worker.pg.b");
    assert.equal(Number(row.rows[0].claim_version), 1);
    assert.equal(row.rows[0].status, "claimed");
    assert.equal(row.rows[0].state_hash, hashState(created.rawState));
    assert.notEqual(row.rows[0].state_hash, created.rawState);
    assert.ok(row.rows[0].claimed_at);
    assert.ok(row.rows[0].claim_expires_at);

    await clientA.query("SELECT 1");
    await clientB.query("SELECT 1");
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
      // ignore cleanup failure
    }
    await pool.end();
  }
});

test("TikTok OAuth state stale reclaim, fence, and complete in PostgreSQL", async (t) => {
  const connectionString = resolveLocalConcurrencyDatabaseUrl(t);
  if (!connectionString) return;

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const schema = `codeclip_tiktok_oauth_fence_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(buildTikTokOAuthStateDdl(schema));
    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

    const setupPool = createSchemaScopedPool(pool, schema);
    const t0 = "2026-08-05T12:00:00.000Z";
    const created = await createCodeClipTikTokOAuthState(
      {
        ...baseCreate,
        eventCode: `CC-TIKTOK-PG-FENCE-${process.pid}`,
        now: t0,
        ttlSeconds: 600,
      },
      { queryClient: setupPool }
    );

    const poolA = asOwnedPool(clientA);
    const poolB = asOwnedPool(clientB);

    // Owner A claims with short lease (10s min).
    const claimedA = await claimCodeClipTikTokOAuthState(
      {
        state: created.rawState,
        owner: "worker.pg.a",
        leaseMs: 10_000,
        now: t0,
      },
      { queryClient: poolA }
    );
    assert.equal(claimedA.ok, true);
    assert.equal(claimedA.claimVersion, 1);
    const versionA = claimedA.claimVersion;

    // After lease expiry, owner B reclaims.
    // claim_expires_at = t0 + 10s; reclaim at t0 + 10s is stale (expires_at <= now).
    const tReclaim = "2026-08-05T12:00:10.000Z";
    const claimedB = await claimCodeClipTikTokOAuthState(
      {
        state: created.rawState,
        owner: "worker.pg.b",
        leaseMs: 60_000,
        now: tReclaim,
      },
      { queryClient: poolB }
    );
    assert.equal(claimedB.ok, true);
    assert.equal(claimedB.claimVersion, 2);
    assert.ok(claimedB.claimVersion > versionA);
    assert.equal(claimedB.oauthState.claimOwner, "worker.pg.b");

    const afterReclaim = await pool.query(
      `
        SELECT claim_owner, claim_version, status, completed_at, consumed_at
        FROM ${schema}.codeclip_tiktok_oauth_states
        WHERE id = $1
      `,
      [created.oauthState.id]
    );
    assert.equal(afterReclaim.rows[0].claim_owner, "worker.pg.b");
    assert.equal(Number(afterReclaim.rows[0].claim_version), 2);
    assert.equal(afterReclaim.rows[0].status, "claimed");
    assert.equal(afterReclaim.rows[0].completed_at, null);
    assert.equal(afterReclaim.rows[0].consumed_at, null);

    // Old fence (A + version 1) cannot complete.
    await assert.rejects(
      () =>
        completeCodeClipTikTokOAuthState(
          {
            stateId: created.oauthState.id,
            owner: "worker.pg.a",
            expectedClaimVersion: versionA,
            now: tReclaim,
          },
          { queryClient: poolA }
        ),
      (error) => {
        assert.ok(error instanceof CodeClipTikTokOAuthError);
        assert.ok(
          error.code === "OAUTH_STATE_OWNER_MISMATCH" ||
            error.code === "OAUTH_STATE_STALE" ||
            error.code === "OAUTH_STATE_RACE"
        );
        return true;
      }
    );

    const afterOldFence = await pool.query(
      `
        SELECT claim_owner, claim_version, status, completed_at, consumed_at
        FROM ${schema}.codeclip_tiktok_oauth_states
        WHERE id = $1
      `,
      [created.oauthState.id]
    );
    assert.equal(afterOldFence.rows[0].claim_owner, "worker.pg.b");
    assert.equal(Number(afterOldFence.rows[0].claim_version), 2);
    assert.equal(afterOldFence.rows[0].status, "claimed");
    assert.equal(afterOldFence.rows[0].completed_at, null);
    assert.equal(afterOldFence.rows[0].consumed_at, null);

    // Current fence (B + version 2) completes.
    const completed = await completeCodeClipTikTokOAuthState(
      {
        stateId: created.oauthState.id,
        owner: "worker.pg.b",
        expectedClaimVersion: claimedB.claimVersion,
        now: tReclaim,
      },
      { queryClient: poolB }
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.alreadyCompleted, false);
    assert.equal(completed.oauthState.status, "completed");
    assert.equal(completed.oauthState.claimOwner, null);
    assert.ok(completed.oauthState.completedAt);
    assert.ok(completed.oauthState.consumedAt);

    const afterComplete = await pool.query(
      `
        SELECT claim_owner, claimed_at, claim_expires_at, claim_version,
               status, completed_at, consumed_at, state_hash
        FROM ${schema}.codeclip_tiktok_oauth_states
        WHERE id = $1
      `,
      [created.oauthState.id]
    );
    assert.equal(afterComplete.rows[0].status, "completed");
    assert.equal(afterComplete.rows[0].claim_owner, null);
    assert.equal(afterComplete.rows[0].claimed_at, null);
    assert.equal(afterComplete.rows[0].claim_expires_at, null);
    assert.equal(Number(afterComplete.rows[0].claim_version), 2);
    assert.ok(afterComplete.rows[0].completed_at);
    assert.ok(afterComplete.rows[0].consumed_at);
    assert.equal(afterComplete.rows[0].state_hash, hashState(created.rawState));

    // Idempotent completed: claim returns alreadyCompleted; complete is safe.
    const reclaimCompleted = await claimCodeClipTikTokOAuthState(
      {
        state: created.rawState,
        owner: "worker.pg.c",
        now: tReclaim,
      },
      { queryClient: poolA }
    );
    assert.equal(reclaimCompleted.ok, true);
    assert.equal(reclaimCompleted.alreadyCompleted, true);
    assert.equal(reclaimCompleted.status, "completed");

    const completeAgain = await completeCodeClipTikTokOAuthState(
      {
        stateId: created.oauthState.id,
        owner: "worker.pg.b",
        expectedClaimVersion: claimedB.claimVersion,
        now: tReclaim,
      },
      { queryClient: poolB }
    );
    assert.equal(completeAgain.status, "completed");
    assert.equal(completeAgain.alreadyCompleted, true);
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
      // ignore cleanup failure
    }
    await pool.end();
  }
});
