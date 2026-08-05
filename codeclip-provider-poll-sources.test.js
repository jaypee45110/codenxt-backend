const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderPollSourceError,
  createCodeClipProviderPollSource,
  getCodeClipProviderPollSourceById,
  findCodeClipProviderPollSource,
  listDueCodeClipProviderPollSources,
  claimCodeClipProviderPollSource,
  completeCodeClipProviderPollSourceClaim,
  reactivateCodeClipProviderPollSource,
  releaseCodeClipProviderPollSourceClaim,
} = require("./verticals/codeclip/provider-poll-sources");

const OPERATION_NOW = "2026-08-04T12:00:00.000Z";
const LEASE_MS = 60_000;
const EXPECTED_EXPIRES = "2026-08-04T12:01:00.000Z";
/** Contract bounds (not imported; private repository constants). */
const POLL_INTERVAL_MS_MIN = 30_000;
const POLL_INTERVAL_MS_MAX = 86_400_000;
const POLL_INTERVAL_MS = POLL_INTERVAL_MS_MIN;
const LIST_LIMIT_MAX = 100;
const CHECKPOINT_MAX_BYTES = 4096;

const PUBLIC_EXPORTS = Object.freeze([
  "CodeClipProviderPollSourceError",
  "createCodeClipProviderPollSource",
  "getCodeClipProviderPollSourceById",
  "findCodeClipProviderPollSource",
  "listDueCodeClipProviderPollSources",
  "claimCodeClipProviderPollSource",
  "completeCodeClipProviderPollSourceClaim",
  "reactivateCodeClipProviderPollSource",
  "releaseCodeClipProviderPollSourceClaim",
]);

function assertPollError(error, code) {
  assert.ok(error instanceof CodeClipProviderPollSourceError);
  assert.equal(error.code, code);
}

function createPollStoreClient(options = {}) {
  const calls = [];
  const rows = [];
  let nextId = 1;
  let forceUpdateRace = options.forceUpdateRace === true;
  let uniqueOnInsert = options.uniqueOnInsert === true;

  function seed(row) {
    const id = row.id != null ? row.id : nextId++;
    if (typeof id === "number" && id >= nextId) nextId = id + 1;
    rows.push({
      id,
      vertical: "codeclip",
      provider: row.provider || "youtube",
      environment: row.environment || "sandbox",
      account_lookup_key: row.account_lookup_key || row.provider_account_id || "UC_poll_source_test_channel_01",
      provider_account_id:
        row.provider_account_id || row.account_lookup_key || "UC_poll_source_test_channel_01",
      status: row.status || "active",
      poll_interval_ms: row.poll_interval_ms ?? POLL_INTERVAL_MS,
      next_poll_at: row.next_poll_at || OPERATION_NOW,
      last_polled_at: row.last_polled_at ?? null,
      checkpoint: row.checkpoint || {},
      poll_claim_owner: row.poll_claim_owner ?? null,
      poll_claimed_at: row.poll_claimed_at ?? null,
      poll_claim_expires_at: row.poll_claim_expires_at ?? null,
      poll_claim_version: row.poll_claim_version ?? 0,
      consecutive_failures: row.consecutive_failures ?? 0,
      last_error_code: row.last_error_code ?? null,
      last_success_at: row.last_success_at ?? null,
      last_detection_at: row.last_detection_at ?? null,
      last_attempt_duration_ms: row.last_attempt_duration_ms ?? null,
      last_detections_count: row.last_detections_count ?? null,
      created_at: row.created_at || "2026-08-04T09:00:00.000Z",
      updated_at: row.updated_at || "2026-08-04T10:00:00.000Z",
      disabled_at: row.disabled_at ?? null,
    });
    return rows[rows.length - 1];
  }

  function claimFenceMatches(row, owner, version, operationNow) {
    if (!row.poll_claim_owner) return false;
    if (String(row.poll_claim_owner).toLowerCase() !== String(owner).toLowerCase()) {
      return false;
    }
    if (String(row.poll_claim_version) !== String(version)) return false;
    const opMs = Date.parse(operationNow);
    const expMs = Date.parse(row.poll_claim_expires_at);
    return Number.isFinite(expMs) && expMs > opMs;
  }

  return {
    calls,
    rows,
    seed,
    setForceUpdateRace(value) {
      forceUpdateRace = Boolean(value);
    },
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (
        /^\s*BEGIN\s*$/i.test(sql.trim()) ||
        /^\s*COMMIT\s*$/i.test(sql.trim()) ||
        /^\s*ROLLBACK\s*$/i.test(sql.trim())
      ) {
        return { rows: [] };
      }

      if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
        const injected = params[0];
        if (injected === null || injected === undefined) {
          return { rows: [{ operation_now: new Date(OPERATION_NOW) }] };
        }
        return { rows: [{ operation_now: new Date(injected) }] };
      }

      if (/INSERT INTO codeclip_provider_poll_sources/.test(sql)) {
        if (uniqueOnInsert) {
          const err = new Error("duplicate key");
          err.code = "23505";
          throw err;
        }
        const row = {
          id: nextId++,
          vertical: params[0],
          provider: params[1],
          environment: params[2],
          account_lookup_key: params[3],
          provider_account_id: params[4],
          status: "active",
          poll_interval_ms: params[5],
          next_poll_at: params[6],
          last_polled_at: null,
          checkpoint:
            typeof params[7] === "string" ? JSON.parse(params[7]) : params[7] || {},
          poll_claim_owner: null,
          poll_claimed_at: null,
          poll_claim_expires_at: null,
          poll_claim_version: 0,
          consecutive_failures: 0,
          last_error_code: null,
          last_success_at: null,
          last_detection_at: null,
          last_attempt_duration_ms: null,
          last_detections_count: null,
          created_at: params[8],
          updated_at: params[8],
          disabled_at: null,
        };
        rows.push(row);
        return { rows: [{ ...row }] };
      }

      if (
        /FROM codeclip_provider_poll_sources/.test(sql) &&
        /FOR UPDATE/i.test(sql)
      ) {
        const id = String(params[0]);
        const row = rows.find((r) => String(r.id) === id);
        if (!row) return { rows: [] };
        return { rows: [{ ...row }] };
      }

      if (
        /^\s*SELECT\b/i.test(sql) &&
        /FROM codeclip_provider_poll_sources/.test(sql) &&
        /WHERE id = \$1/.test(sql) &&
        !/FOR UPDATE/i.test(sql)
      ) {
        const id = String(params[0]);
        const row = rows.find((r) => String(r.id) === id);
        if (!row) return { rows: [] };
        return { rows: [{ ...row }] };
      }

      if (
        /^\s*SELECT\b/i.test(sql) &&
        /FROM codeclip_provider_poll_sources/.test(sql) &&
        /account_lookup_key = \$4/.test(sql)
      ) {
        const row = rows.find(
          (r) =>
            r.vertical === params[0] &&
            r.provider === params[1] &&
            r.environment === params[2] &&
            r.account_lookup_key === params[3]
        );
        return { rows: row ? [{ ...row }] : [] };
      }

      if (
        /^\s*SELECT\b/i.test(sql) &&
        /FROM codeclip_provider_poll_sources/.test(sql) &&
        /next_poll_at <=/.test(sql)
      ) {
        const operationNow = params[1];
        const limit = Number(params[2]);
        const opMs = Date.parse(operationNow);
        let providerFilter = null;
        let environmentFilter = null;
        if (params.length >= 4) {
          // order: provider then environment if both present
          if (/\bprovider =/.test(sql)) {
            providerFilter = params[3];
            if (/\benvironment =/.test(sql) && params.length >= 5) {
              environmentFilter = params[4];
            }
          } else if (/\benvironment =/.test(sql)) {
            environmentFilter = params[3];
          }
        }

        const due = rows
          .filter((r) => r.vertical === "codeclip")
          .filter((r) => r.status === "active")
          .filter((r) => Date.parse(r.next_poll_at) <= opMs)
          .filter((r) => {
            if (r.poll_claim_expires_at == null) return true;
            return Date.parse(r.poll_claim_expires_at) <= opMs;
          })
          .filter((r) => !providerFilter || r.provider === providerFilter)
          .filter((r) => !environmentFilter || r.environment === environmentFilter)
          .sort((a, b) => {
            const d = Date.parse(a.next_poll_at) - Date.parse(b.next_poll_at);
            if (d !== 0) return d;
            return Number(a.id) - Number(b.id);
          })
          .slice(0, limit)
          .map((r) => ({ ...r }));
        return { rows: due };
      }

      if (/UPDATE codeclip_provider_poll_sources/.test(sql)) {
        if (forceUpdateRace) return { rows: [] };
        const id = String(params[0]);
        const row = rows.find((r) => String(r.id) === id);
        if (!row) return { rows: [] };

        // Claim path: sets owner + increments version in SQL
        if (/poll_claim_version = poll_claim_version \+ 1/.test(sql)) {
          const owner = params[1];
          const operationNow = params[2];
          const leaseMs = Number(params[3]);
          const opMs = Date.parse(operationNow);
          const active =
            row.poll_claim_expires_at != null &&
            Date.parse(row.poll_claim_expires_at) > opMs;
          if (row.status !== "active") return { rows: [] };
          if (active) return { rows: [] };

          row.poll_claim_owner = owner;
          row.poll_claimed_at = operationNow;
          row.poll_claim_expires_at = new Date(opMs + leaseMs).toISOString();
          row.poll_claim_version = Number(row.poll_claim_version || 0) + 1;
          row.updated_at = operationNow;
          return {
            rows: [
              {
                id: row.id,
                poll_claim_version: row.poll_claim_version,
                poll_claimed_at: row.poll_claimed_at,
                poll_claim_expires_at: row.poll_claim_expires_at,
              },
            ],
          };
        }

        // Reactivation path: paused -> active, explicit next_poll_at, clear error/claim.
        if (/status = 'active'/.test(sql) && /AND status = 'paused'/.test(sql)) {
          if (row.status !== "paused") return { rows: [] };
          if (
            row.poll_claim_owner &&
            row.poll_claim_expires_at &&
            Date.parse(row.poll_claim_expires_at) > Date.parse(params[2])
          ) {
            return { rows: [] };
          }
          row.status = "active";
          row.next_poll_at = params[1];
          row.last_error_code = null;
          row.poll_claim_owner = null;
          row.poll_claimed_at = null;
          row.poll_claim_expires_at = null;
          row.updated_at = params[2];
          return { rows: [{ ...row }] };
        }

        // Complete path: checkpoint + next_poll + claim clear (+ observability)
        if (/checkpoint = \$2::jsonb/.test(sql)) {
          const checkpoint =
            typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
          const nextPollAt = params[2];
          const operationNow = params[3];
          const owner = params[5];
          const version = params[6];
          if (!claimFenceMatches(row, owner, version, operationNow)) {
            return { rows: [] };
          }
          row.checkpoint = checkpoint;
          row.next_poll_at = nextPollAt;
          row.last_polled_at = operationNow;
          row.poll_claim_owner = null;
          row.poll_claimed_at = null;
          row.poll_claim_expires_at = null;
          if (params.length >= 14) {
            row.consecutive_failures = params[7];
            row.last_error_code = params[8];
            row.last_success_at = params[9];
            row.last_detection_at = params[10];
            row.last_attempt_duration_ms = params[11];
            row.last_detections_count = params[12];
            row.status = params[13];
          }
          row.updated_at = operationNow;
          return { rows: [{ ...row }] };
        }

        // Release path with scheduling (F1D2B)
        if (
          /poll_claim_owner = NULL/.test(sql) &&
          /next_poll_at = \$6::timestamptz/.test(sql)
        ) {
          const operationNow = params[1];
          const owner = params[3];
          const version = params[4];
          if (!claimFenceMatches(row, owner, version, operationNow)) {
            return { rows: [] };
          }
          row.poll_claim_owner = null;
          row.poll_claimed_at = null;
          row.poll_claim_expires_at = null;
          row.next_poll_at = params[5];
          row.last_polled_at = operationNow;
          row.consecutive_failures = params[6];
          row.last_error_code = params[7];
          row.last_attempt_duration_ms = params[8];
          row.last_detections_count = params[9];
          row.status = params[10];
          row.updated_at = operationNow;
          return { rows: [{ ...row }] };
        }

        // Release path: claim clear only
        if (
          /poll_claim_owner = NULL/.test(sql) &&
          /poll_claim_version = \$5::bigint/.test(sql)
        ) {
          const operationNow = params[1];
          const owner = params[3];
          const version = params[4];
          if (!claimFenceMatches(row, owner, version, operationNow)) {
            return { rows: [] };
          }
          row.poll_claim_owner = null;
          row.poll_claimed_at = null;
          row.poll_claim_expires_at = null;
          row.updated_at = operationNow;
          return { rows: [{ ...row }] };
        }

        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

test("provider poll sources exports only the public repository API", () => {
  const exported = require("./verticals/codeclip/provider-poll-sources");
  assert.deepEqual(Object.keys(exported).sort(), [...PUBLIC_EXPORTS].sort());
  for (const key of [
    "normalizeCodeClipProviderPollCheckpoint",
    "MIN_POLL_INTERVAL_MS",
    "MAX_POLL_INTERVAL_MS",
    "DEFAULT_LEASE_MS",
    "CHECKPOINT_MAX_BYTES",
    "POLL_SOURCE_STATUSES",
    "DEFAULT_LIST_LIMIT",
    "MAX_LIST_LIMIT",
  ]) {
    assert.equal(Object.hasOwn(exported, key), false, `must not export ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Checkpoint via public create/complete (private normalizer not exported)
// ---------------------------------------------------------------------------

test("create accepts empty/default and bounded nested checkpoint", async () => {
  const client = createPollStoreClient();
  const empty = await createCodeClipProviderPollSource(
    {
      provider: "youtube",
      environment: "sandbox",
      providerAccountId: "UC_checkpoint_empty",
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    { queryClient: client, now: OPERATION_NOW }
  );
  assert.deepEqual(empty.pollSource.checkpoint, {});

  const nested = await createCodeClipProviderPollSource(
    {
      provider: "youtube",
      environment: "production",
      providerAccountId: "UC_checkpoint_nested",
      pollIntervalMs: POLL_INTERVAL_MS,
      checkpoint: { pageToken: "abc", nested: { n: 1 } },
    },
    { queryClient: client, now: OPERATION_NOW }
  );
  assert.deepEqual(nested.pollSource.checkpoint, {
    pageToken: "abc",
    nested: { n: 1 },
  });
  // Defensive copy: mutating returned object does not affect a fresh get
  nested.pollSource.checkpoint.pageToken = "mutated";
  const again = await getCodeClipProviderPollSourceById(nested.pollSource.id, {
    queryClient: client,
  });
  assert.equal(again.checkpoint.pageToken, "abc");
});

test("create rejects non-object and oversized checkpoint fail-closed without SQL write", async () => {
  const client = createPollStoreClient();

  for (const bad of [
    [],
    "x",
    1,
    { n: NaN },
    { n: Infinity },
    { f: () => 1 },
    { blob: "x".repeat(CHECKPOINT_MAX_BYTES + 1) },
  ]) {
    const callsBefore = client.calls.length;
    await assert.rejects(
      () =>
        createCodeClipProviderPollSource(
          {
            provider: "youtube",
            environment: "sandbox",
            providerAccountId: "UC_bad_checkpoint_shape",
            pollIntervalMs: POLL_INTERVAL_MS,
            checkpoint: bad,
          },
          { queryClient: client, now: OPERATION_NOW }
        ),
      (error) => {
        assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
        assert.equal(error.details.fieldName, "checkpoint");
        return true;
      }
    );
    const insertAfter = client.calls
      .slice(callsBefore)
      .some((c) => /INSERT INTO codeclip_provider_poll_sources/.test(c.sql));
    assert.equal(insertAfter, false, "malformed checkpoint must never reach SQL");
  }
});

// ---------------------------------------------------------------------------
// Create / get
// ---------------------------------------------------------------------------

test("create poll source succeeds for polling-capable provider", async () => {
  const client = createPollStoreClient();
  const result = await createCodeClipProviderPollSource(
    {
      provider: "youtube",
      environment: "sandbox",
      providerAccountId: "UC_poll_source_test_channel_01",
      pollIntervalMs: POLL_INTERVAL_MS,
      checkpoint: { cursor: "0" },
    },
    { queryClient: client, now: OPERATION_NOW }
  );

  assert.equal(result.status, "created");
  assert.equal(result.pollSource.provider, "youtube");
  assert.equal(result.pollSource.environment, "sandbox");
  assert.equal(result.pollSource.providerAccountId, "UC_poll_source_test_channel_01");
  assert.equal(result.pollSource.pollIntervalMs, POLL_INTERVAL_MS);
  assert.deepEqual(result.pollSource.checkpoint, { cursor: "0" });
  assert.equal(result.pollSource.pollClaimVersion, 0);
  assert.equal(result.pollSource.pollClaimOwner, null);
  assert.equal(result.pollSource.status, "active");

  const insert = client.calls.find((c) => /INSERT INTO codeclip_provider_poll_sources/.test(c.sql));
  assert.ok(insert);
  assert.equal(insert.params[5], POLL_INTERVAL_MS);
});

test("find poll source by provider identity returns safe row or null", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 31,
    provider: "tiktok",
    environment: "sandbox",
    account_lookup_key: "tiktok-account-31",
    provider_account_id: "tiktok-account-31",
    checkpoint: { initialized: true },
  });

  const found = await findCodeClipProviderPollSource(
    {
      provider: "tiktok",
      environment: "sandbox",
      providerAccountId: "tiktok-account-31",
    },
    { queryClient: client }
  );
  assert.equal(found.id, "31");
  assert.equal(found.provider, "tiktok");
  assert.deepEqual(found.checkpoint, { initialized: true });

  const missing = await findCodeClipProviderPollSource(
    {
      provider: "tiktok",
      environment: "production",
      providerAccountId: "tiktok-account-31",
    },
    { queryClient: client }
  );
  assert.equal(missing, null);
});

test("reactivate paused poll source preserves checkpoint and clears error/claim", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 32,
    provider: "tiktok",
    environment: "sandbox",
    account_lookup_key: "tiktok-account-32",
    provider_account_id: "tiktok-account-32",
    status: "paused",
    next_poll_at: null,
    checkpoint: {
      initialized: true,
      highWaterPublishedAt: "2026-08-04T11:00:00.000Z",
      highWaterVideoId: "vid-old",
    },
    poll_claim_owner: "old.worker",
    poll_claimed_at: "2026-08-04T11:00:00.000Z",
    poll_claim_expires_at: "2026-08-04T11:01:00.000Z",
    last_error_code: "reauthorization_required",
    consecutive_failures: 4,
  });

  const result = await reactivateCodeClipProviderPollSource(
    {
      pollSourceId: 32,
      nextPollAt: OPERATION_NOW,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );

  assert.equal(result.status, "reactivated");
  assert.equal(result.pollSource.status, "active");
  assert.equal(result.pollSource.nextPollAt, OPERATION_NOW);
  assert.equal(result.pollSource.lastErrorCode, null);
  assert.equal(result.pollSource.pollClaimOwner, null);
  assert.equal(result.pollSource.consecutiveFailures, 4);
  assert.deepEqual(result.pollSource.checkpoint, {
    initialized: true,
    highWaterPublishedAt: "2026-08-04T11:00:00.000Z",
    highWaterVideoId: "vid-old",
  });
});

test("reactivate rejects non-paused sources and races fail closed", async () => {
  const client = createPollStoreClient();
  client.seed({ id: 33, status: "active" });
  await assert.rejects(
    () =>
      reactivateCodeClipProviderPollSource(
        { pollSourceId: 33, nextPollAt: OPERATION_NOW, now: OPERATION_NOW },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_SOURCE_NOT_REACTIVATABLE");
      assert.equal(error.details.status, "active");
      return true;
    }
  );

  const raced = createPollStoreClient({ forceUpdateRace: true });
  raced.seed({ id: 34, status: "paused" });
  await assert.rejects(
    () =>
      reactivateCodeClipProviderPollSource(
        { pollSourceId: 34, nextPollAt: OPERATION_NOW, now: OPERATION_NOW },
        { queryClient: raced }
      ),
    (error) => {
      assertPollError(error, "POLL_SOURCE_RACE");
      return true;
    }
  );

  const claimed = createPollStoreClient();
  claimed.seed({
    id: 35,
    status: "paused",
    poll_claim_owner: "worker.active",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
  });

  await assert.rejects(
    () =>
      reactivateCodeClipProviderPollSource(
        { pollSourceId: 35, nextPollAt: OPERATION_NOW, now: OPERATION_NOW },
        { queryClient: claimed }
      ),
    (error) => {
      assertPollError(error, "POLL_SOURCE_NOT_REACTIVATABLE");
      assert.equal(error.details.status, "paused");
      return true;
    }
  );
});

test("create poll source rejects push-only providers via registry gate", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "meta",
          environment: "sandbox",
          providerAccountId: "page-1",
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { queryClient: client, now: OPERATION_NOW }
      ),
    (error) => {
      assertPollError(error, "POLLING_NOT_SUPPORTED");
      return true;
    }
  );

  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "sms",
          environment: "sandbox",
          providerAccountId: "sms-1",
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { queryClient: client, now: OPERATION_NOW }
      ),
    (error) => {
      assertPollError(error, "POLLING_NOT_SUPPORTED");
      return true;
    }
  );

  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "test",
          environment: "sandbox",
          providerAccountId: "t-1",
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { queryClient: client, now: OPERATION_NOW }
      ),
    (error) => {
      assertPollError(error, "POLLING_NOT_SUPPORTED");
      return true;
    }
  );
});

test("create poll source rejects unknown provider fail-closed", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "not-a-provider",
          environment: "sandbox",
          providerAccountId: "x",
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      return true;
    }
  );
});

test("create poll source rejects invalid poll intervals without clamping", async () => {
  const client = createPollStoreClient();

  for (const bad of [
    POLL_INTERVAL_MS_MIN - 1,
    5_000,
    29_999,
    POLL_INTERVAL_MS_MAX + 1,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "30000",
    "abc",
    null,
    undefined,
    true,
    false,
    30000n,
  ]) {
    await assert.rejects(
      () =>
        createCodeClipProviderPollSource(
          {
            provider: "youtube",
            environment: "sandbox",
            providerAccountId: "UC_poll_interval_test",
            pollIntervalMs: bad,
          },
          { queryClient: client, now: OPERATION_NOW }
        ),
      (error) => {
        assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
        return true;
      }
    );
  }

  // Boundary values accepted (no clamp needed)
  const low = await createCodeClipProviderPollSource(
    {
      provider: "youtube",
      environment: "sandbox",
      providerAccountId: "UC_poll_interval_min",
      pollIntervalMs: POLL_INTERVAL_MS_MIN,
    },
    { queryClient: client, now: OPERATION_NOW }
  );
  assert.equal(low.pollSource.pollIntervalMs, 30_000);

  const high = await createCodeClipProviderPollSource(
    {
      provider: "youtube",
      environment: "production",
      providerAccountId: "UC_poll_interval_max",
      pollIntervalMs: POLL_INTERVAL_MS_MAX,
    },
    { queryClient: client, now: OPERATION_NOW }
  );
  assert.equal(high.pollSource.pollIntervalMs, 86_400_000);
});

test("repository does not lazy-ensure schema on ordinary operations", async () => {
  const mod = require("fs").readFileSync(
    require("path").join(__dirname, "verticals/codeclip/provider-poll-sources.js"),
    "utf8"
  );
  assert.equal(/ensureCodeClipProviderPollSourcesTable/.test(mod), false);
  assert.equal(/ensurePollSourcesSchema/.test(mod), false);
  assert.equal(/require\(["']\.\.\/\.\.\/db["']\)/.test(mod), false);
});

test("create poll source rejects invalid checkpoint", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "youtube",
          environment: "sandbox",
          providerAccountId: "UC_bad_checkpoint",
          pollIntervalMs: POLL_INTERVAL_MS,
          checkpoint: ["not", "object"],
        },
        { queryClient: client, now: OPERATION_NOW }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      assert.equal(error.details.fieldName, "checkpoint");
      return true;
    }
  );
});

test("create poll source maps unique violation to already exists", async () => {
  const client = createPollStoreClient({ uniqueOnInsert: true });
  await assert.rejects(
    () =>
      createCodeClipProviderPollSource(
        {
          provider: "youtube",
          environment: "sandbox",
          providerAccountId: "UC_dup",
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        { queryClient: client, now: OPERATION_NOW }
      ),
    (error) => {
      assertPollError(error, "POLL_SOURCE_ALREADY_EXISTS");
      return true;
    }
  );
});

test("get poll source by id returns public shape or null", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 42,
    provider: "youtube",
    provider_account_id: "UC_get_me",
    account_lookup_key: "UC_get_me",
  });

  const found = await getCodeClipProviderPollSourceById(42, {
    queryClient: client,
  });
  assert.equal(found.id, "42");
  assert.equal(found.provider, "youtube");
  assert.equal(found.providerAccountId, "UC_get_me");

  const missing = await getCodeClipProviderPollSourceById(999, {
    queryClient: client,
  });
  assert.equal(missing, null);
});

// ---------------------------------------------------------------------------
// listDue
// ---------------------------------------------------------------------------

test("listDue returns only active due unclaimed sources ordered by next_poll_at", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 1,
    next_poll_at: "2026-08-04T11:00:00.000Z",
    provider_account_id: "UC_a",
    account_lookup_key: "UC_a",
  });
  client.seed({
    id: 2,
    next_poll_at: "2026-08-04T11:30:00.000Z",
    provider_account_id: "UC_b",
    account_lookup_key: "UC_b",
  });
  client.seed({
    id: 3,
    next_poll_at: "2026-08-04T13:00:00.000Z", // future — not due
    provider_account_id: "UC_c",
    account_lookup_key: "UC_c",
  });
  client.seed({
    id: 4,
    next_poll_at: "2026-08-04T10:00:00.000Z",
    status: "disabled",
    provider_account_id: "UC_d",
    account_lookup_key: "UC_d",
  });
  client.seed({
    id: 5,
    next_poll_at: "2026-08-04T10:00:00.000Z",
    poll_claim_owner: "worker-a",
    poll_claimed_at: "2026-08-04T11:50:00.000Z",
    poll_claim_expires_at: "2026-08-04T12:30:00.000Z", // active claim
    poll_claim_version: 1,
    provider_account_id: "UC_e",
    account_lookup_key: "UC_e",
  });
  client.seed({
    id: 6,
    next_poll_at: "2026-08-04T10:30:00.000Z",
    poll_claim_owner: "worker-old",
    poll_claimed_at: "2026-08-04T11:00:00.000Z",
    poll_claim_expires_at: "2026-08-04T11:01:00.000Z", // stale claim — due
    poll_claim_version: 2,
    provider_account_id: "UC_f",
    account_lookup_key: "UC_f",
  });

  const listed = await listDueCodeClipProviderPollSources(
    { now: OPERATION_NOW, limit: 10 },
    { queryClient: client }
  );

  // Order by next_poll_at ASC: 6 (10:30), 1 (11:00), 2 (11:30)
  assert.deepEqual(
    listed.items.map((i) => i.id),
    ["6", "1", "2"]
  );
  assert.equal(listed.asOf, OPERATION_NOW);
});

test("listDue rejects limit above max fail-closed (no clamp)", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      listDueCodeClipProviderPollSources(
        { limit: LIST_LIMIT_MAX + 1, now: OPERATION_NOW },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      return true;
    }
  );
});

test("listDue rejects non-polling provider filter", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      listDueCodeClipProviderPollSources(
        { provider: "meta", now: OPERATION_NOW },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

test("claim increments poll_claim_version in SQL and returns fence fields", async () => {
  const client = createPollStoreClient();
  client.seed({ id: 10, poll_claim_version: 0 });

  const claimed = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 10,
      owner: "worker-1",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );

  assert.equal(claimed.ok, true);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.pollSourceId, "10");
  assert.equal(claimed.claimVersion, 1);
  assert.equal(claimed.claimedAt, OPERATION_NOW);
  assert.equal(claimed.expiresAt, EXPECTED_EXPIRES);
  assert.equal(claimed.reclaimed, false);

  const update = client.calls.find((c) =>
    /poll_claim_version = poll_claim_version \+ 1/.test(c.sql)
  );
  assert.ok(update, "version must be incremented in SQL");
  // No JS-computed version in params
  assert.equal(
    update.params.some((p) => p === 1 && update.params.indexOf(p) === update.params.length - 1),
    false
  );
  assert.match(update.sql, /poll_claim_version = poll_claim_version \+ 1/);
  assert.equal(/poll_claim_version = \$/.test(update.sql), false);

  assert.equal(client.rows[0].poll_claim_owner, "worker-1");
  assert.equal(client.rows[0].poll_claim_version, 1);
});

test("claim rejects active contention and allows stale reclaim with version bump", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 11,
    poll_claim_owner: "worker-a",
    poll_claimed_at: "2026-08-04T11:50:00.000Z",
    poll_claim_expires_at: "2026-08-04T12:30:00.000Z",
    poll_claim_version: 3,
  });

  const contended = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 11,
      owner: "worker-b",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.deepEqual(contended, { ok: false, reason: "POLL_CLAIM_CONTENTION" });
  assert.equal(client.rows[0].poll_claim_version, 3);

  // Stale reclaim
  client.rows[0].poll_claim_expires_at = "2026-08-04T11:59:00.000Z";
  const reclaimed = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 11,
      owner: "worker-b",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.claimVersion, 4);
  assert.equal(client.rows[0].poll_claim_owner, "worker-b");
});

test("claim rejects disabled poll source", async () => {
  const client = createPollStoreClient();
  client.seed({ id: 12, status: "disabled" });
  const result = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 12,
      owner: "worker-1",
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.deepEqual(result, { ok: false, reason: "POLL_SOURCE_NOT_CLAIMABLE" });
});

test("claim uses FOR UPDATE under transaction", async () => {
  // Explicit query client is caller-owned (Alternativ B): no nested BEGIN/COMMIT.
  // FOR UPDATE still runs so the caller can hold the lock inside their TX.
  const client = createPollStoreClient();
  client.seed({ id: 13 });
  await claimCodeClipProviderPollSource(
    { pollSourceId: 13, owner: "worker-1", now: OPERATION_NOW },
    { queryClient: client }
  );
  assert.equal(client.calls.some((c) => /^\s*BEGIN\s*$/i.test(c.sql.trim())), false);
  assert.equal(client.calls.some((c) => /FOR UPDATE/i.test(c.sql)), true);
  assert.equal(client.calls.some((c) => /^\s*COMMIT\s*$/i.test(c.sql.trim())), false);

  // Pool path: repository owns BEGIN/COMMIT around FOR UPDATE + claim UPDATE.
  const poolCalls = [];
  const poolRows = [
    {
      id: 14,
      vertical: "codeclip",
      provider: "youtube",
      environment: "sandbox",
      account_lookup_key: "UC_pool",
      provider_account_id: "UC_pool",
      status: "active",
      poll_interval_ms: POLL_INTERVAL_MS,
      next_poll_at: OPERATION_NOW,
      last_polled_at: null,
      checkpoint: {},
      poll_claim_owner: null,
      poll_claimed_at: null,
      poll_claim_expires_at: null,
      poll_claim_version: 0,
      created_at: OPERATION_NOW,
      updated_at: OPERATION_NOW,
      disabled_at: null,
    },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          poolCalls.push({ sql, params });
          if (/^\s*BEGIN\s*$/i.test(sql.trim()) || /^\s*COMMIT\s*$/i.test(sql.trim()) || /^\s*ROLLBACK\s*$/i.test(sql.trim())) {
            return { rows: [] };
          }
          if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
            return { rows: [{ operation_now: new Date(OPERATION_NOW) }] };
          }
          if (/FOR UPDATE/i.test(sql)) {
            return { rows: [{ ...poolRows[0] }] };
          }
          if (/poll_claim_version = poll_claim_version \+ 1/.test(sql)) {
            poolRows[0].poll_claim_owner = params[1];
            poolRows[0].poll_claimed_at = params[2];
            poolRows[0].poll_claim_expires_at = EXPECTED_EXPIRES;
            poolRows[0].poll_claim_version = 1;
            return {
              rows: [
                {
                  id: 14,
                  poll_claim_version: 1,
                  poll_claimed_at: OPERATION_NOW,
                  poll_claim_expires_at: EXPECTED_EXPIRES,
                },
              ],
            };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const claimed = await claimCodeClipProviderPollSource(
    { pollSourceId: 14, owner: "worker-pool", now: OPERATION_NOW },
    { queryClient: pool }
  );
  assert.equal(claimed.ok, true);
  assert.equal(poolCalls.some((c) => /^\s*BEGIN\s*$/i.test(c.sql.trim())), true);
  assert.equal(poolCalls.some((c) => /FOR UPDATE/i.test(c.sql)), true);
  assert.equal(poolCalls.some((c) => /^\s*COMMIT\s*$/i.test(c.sql.trim())), true);
});

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

test("completeClaim atomically updates checkpoint, next_poll_at, and clears claim", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 20,
    poll_interval_ms: POLL_INTERVAL_MS,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 1,
    checkpoint: { old: true },
  });

  const completed = await completeCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 20,
      owner: "worker-1",
      expectedVersion: 1,
      checkpoint: { pageToken: "next-page" },
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );

  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.pollSource.checkpoint, { pageToken: "next-page" });
  assert.equal(completed.pollSource.pollClaimOwner, null);
  assert.equal(completed.pollSource.pollClaimedAt, null);
  assert.equal(completed.pollSource.pollClaimExpiresAt, null);
  assert.equal(completed.pollSource.lastPolledAt, OPERATION_NOW);
  assert.equal(
    completed.pollSource.nextPollAt,
    new Date(Date.parse(OPERATION_NOW) + POLL_INTERVAL_MS).toISOString()
  );
  // Version retained after complete (fencing token history)
  assert.equal(completed.pollSource.pollClaimVersion, 1);

  const update = client.calls.find((c) => /checkpoint = \$2::jsonb/.test(c.sql));
  assert.ok(update);
  assert.match(update.sql, /poll_claim_owner = NULL/);
  assert.match(update.sql, /next_poll_at = \$3::timestamptz/);
  assert.match(update.sql, /last_polled_at = \$4::timestamptz/);
  assert.match(update.sql, /poll_claim_owner = \$6/);
  assert.match(update.sql, /poll_claim_version = \$7::bigint/);
  assert.match(update.sql, /poll_claim_expires_at > \$4::timestamptz/);

  // Single UPDATE — not two separate claim-clear + schedule statements
  const updateCount = client.calls.filter((c) =>
    /UPDATE codeclip_provider_poll_sources/.test(c.sql)
  ).length;
  assert.equal(updateCount, 1);
});

test("completeClaim accepts explicit nextPollAt", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 21,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 2,
  });

  const next = "2026-08-04T15:00:00.000Z";
  const completed = await completeCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 21,
      owner: "worker-1",
      expectedVersion: 2,
      checkpoint: {},
      nextPollAt: next,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(completed.pollSource.nextPollAt, next);
});

test("completeClaim fails closed on wrong owner, version, or stale claim", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 22,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 5,
  });

  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 22,
          owner: "worker-other",
          expectedVersion: 5,
          checkpoint: {},
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );

  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 22,
          owner: "worker-1",
          expectedVersion: 4,
          checkpoint: {},
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );

  // Stale: expires_at <= now
  client.rows[0].poll_claim_expires_at = "2026-08-04T11:59:00.000Z";
  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 22,
          owner: "worker-1",
          expectedVersion: 5,
          checkpoint: {},
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );
});

test("completeClaim requires expectedVersion", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 1,
          owner: "worker-1",
          checkpoint: {},
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      assert.equal(error.details.fieldName, "expectedVersion");
      return true;
    }
  );
});

test("completeClaim beforeComplete receives frozen context and ignores return value", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 50,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 1,
    checkpoint: { seed: true },
  });

  let seen = null;
  const completed = await completeCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 50,
      owner: "worker-1",
      expectedVersion: 1,
      checkpoint: { after: true },
      now: OPERATION_NOW,
    },
    {
      queryClient: client,
      beforeComplete: async (ctx) => {
        seen = ctx;
        assert.equal(Object.isFrozen(ctx), true);
        assert.equal(Object.isFrozen(ctx.pollSource), true);
        assert.equal(Object.isFrozen(ctx.pollSource.checkpoint), true);
        assert.deepEqual(ctx.pollSource.checkpoint, { seed: true });
        // Mutating snapshot must not rewrite repository intent.
        try {
          ctx.pollSource.checkpoint.seed = false;
        } catch {
          // freeze may throw in strict mode
        }
        assert.equal(ctx.pollSource.checkpoint.seed, true);
        return { shouldBeIgnored: true };
      },
    }
  );

  assert.ok(seen);
  assert.equal(seen.operationNow, OPERATION_NOW);
  assert.equal(typeof seen.queryClient.query, "function");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.pollSource.checkpoint, { after: true });
});

test("completeClaim beforeComplete failure prevents complete and is safe", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 51,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 2,
    checkpoint: { keep: true },
  });

  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 51,
          owner: "worker-1",
          expectedVersion: 2,
          checkpoint: { leaked: true },
          now: OPERATION_NOW,
        },
        {
          queryClient: client,
          beforeComplete: async () => {
            throw new Error("raw SQL SELECT * FROM secrets token=abc");
          },
        }
      ),
    (error) => {
      assertPollError(error, "FENCED_PERSISTENCE_FAILED");
      assert.equal(error.message.includes("secrets"), false);
      assert.equal(error.message.includes("token=abc"), false);
      return true;
    }
  );

  // Claim still held; checkpoint not advanced (complete UPDATE not applied).
  assert.equal(client.rows[0].poll_claim_owner, "worker-1");
  assert.deepEqual(client.rows[0].checkpoint, { keep: true });
});

test("completeClaim rejects non-function beforeComplete", async () => {
  const client = createPollStoreClient();
  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 1,
          owner: "worker-1",
          expectedVersion: 1,
          checkpoint: {},
          now: OPERATION_NOW,
        },
        { queryClient: client, beforeComplete: "nope" }
      ),
    (error) => {
      assertPollError(error, "INVALID_POLL_SOURCE_INPUT");
      assert.equal(error.details.fieldName, "beforeComplete");
      return true;
    }
  );
});

test("releaseClaim paused status clears next_poll_at", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 52,
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 1,
    next_poll_at: OPERATION_NOW,
  });

  const released = await releaseCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 52,
      owner: "worker-1",
      expectedVersion: 1,
      now: OPERATION_NOW,
      status: "paused",
      consecutiveFailures: 2,
      lastErrorCode: "credential_unusable",
      nextPollAt: null,
    },
    { queryClient: client }
  );

  assert.equal(released.status, "released");
  assert.equal(released.pollSource.status, "paused");
  assert.equal(released.pollSource.nextPollAt, null);
  assert.equal(released.pollSource.consecutiveFailures, 2);
  assert.equal(released.pollSource.lastErrorCode, "credential_unusable");
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

test("releaseClaim clears claim when fence matches", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 30,
    next_poll_at: "2026-08-04T11:00:00.000Z",
    checkpoint: { keep: true },
    poll_claim_owner: "worker-1",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 7,
  });

  const released = await releaseCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 30,
      owner: "worker-1",
      expectedVersion: 7,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );

  assert.equal(released.status, "released");
  assert.equal(released.pollSource.pollClaimOwner, null);
  assert.deepEqual(released.pollSource.checkpoint, { keep: true });
  assert.equal(released.pollSource.nextPollAt, "2026-08-04T11:00:00.000Z");
  assert.equal(released.pollSource.pollClaimVersion, 7);
});

test("releaseClaim rejects stale or superseded fence so old worker cannot clear new claim", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 31,
    poll_claim_owner: "worker-new",
    poll_claimed_at: OPERATION_NOW,
    poll_claim_expires_at: EXPECTED_EXPIRES,
    poll_claim_version: 9,
  });

  // Old worker with older version
  await assert.rejects(
    () =>
      releaseCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 31,
          owner: "worker-old",
          expectedVersion: 8,
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );
  assert.equal(client.rows[0].poll_claim_owner, "worker-new");
  assert.equal(client.rows[0].poll_claim_version, 9);

  // Same owner wrong version
  await assert.rejects(
    () =>
      releaseCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 31,
          owner: "worker-new",
          expectedVersion: 8,
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );
});

test("releaseClaim rejects stale lease strictly", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 32,
    poll_claim_owner: "worker-1",
    poll_claimed_at: "2026-08-04T11:00:00.000Z",
    poll_claim_expires_at: "2026-08-04T11:30:00.000Z",
    poll_claim_version: 1,
  });

  await assert.rejects(
    () =>
      releaseCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 32,
          owner: "worker-1",
          expectedVersion: 1,
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Race / fencing integration
// ---------------------------------------------------------------------------

test("complete after newer claim fence fails; new owner can complete", async () => {
  const client = createPollStoreClient();
  client.seed({
    id: 40,
    poll_claim_version: 0,
  });

  const first = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 40,
      owner: "worker-old",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(first.claimVersion, 1);

  // Force stale then reclaim as new worker
  client.rows[0].poll_claim_expires_at = "2026-08-04T11:00:00.000Z";
  const second = await claimCodeClipProviderPollSource(
    {
      pollSourceId: 40,
      owner: "worker-new",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(second.claimVersion, 2);

  await assert.rejects(
    () =>
      completeCodeClipProviderPollSourceClaim(
        {
          pollSourceId: 40,
          owner: "worker-old",
          expectedVersion: 1,
          checkpoint: { from: "old" },
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (error) => {
      assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );

  const completed = await completeCodeClipProviderPollSourceClaim(
    {
      pollSourceId: 40,
      owner: "worker-new",
      expectedVersion: 2,
      checkpoint: { from: "new" },
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.pollSource.checkpoint, { from: "new" });
});

test("repository requires explicit query client", async () => {
  await assert.rejects(
    () =>
      createCodeClipProviderPollSource({
        provider: "youtube",
        environment: "sandbox",
        providerAccountId: "UC_x",
        pollIntervalMs: POLL_INTERVAL_MS,
      }),
    (error) => {
      assertPollError(error, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
});

test("F1D1 surface has no ledger or adapter imports", () => {
  const mod = require("fs").readFileSync(
    require("path").join(__dirname, "verticals/codeclip/provider-poll-sources.js"),
    "utf8"
  );
  assert.equal(/provider-adapters/.test(mod), false);
  assert.equal(/createCodeClipProviderDelivery/.test(mod), false);
  assert.equal(/youtube-websub/.test(mod), false);
  assert.equal(/youtube-reconciliation/.test(mod), false);
  assert.equal(/fetch\s*\(/.test(mod), false);
  assert.equal(/http\.request/.test(mod), false);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL concurrency (env-gated; never production)
// ---------------------------------------------------------------------------

test("codeClip poll source claim is single-winner in PostgreSQL", async (t) => {
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
    t.skip(
      "concurrency test requires an explicitly isolated local PostgreSQL database"
    );
    return;
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const schema = `codeclip_poll_claim_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.codeclip_provider_poll_sources (
        id BIGSERIAL PRIMARY KEY,
        vertical TEXT NOT NULL,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        account_lookup_key TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        poll_interval_ms BIGINT NOT NULL,
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_polled_at TIMESTAMPTZ,
        checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
        poll_claim_owner TEXT,
        poll_claimed_at TIMESTAMPTZ,
        poll_claim_expires_at TIMESTAMPTZ,
        poll_claim_version BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disabled_at TIMESTAMPTZ,
        CHECK (vertical = 'codeclip'),
        CHECK (environment IN ('sandbox', 'production')),
        CHECK (status IN ('active', 'disabled')),
        CHECK (poll_interval_ms >= 30000 AND poll_interval_ms <= 86400000),
        CHECK (jsonb_typeof(checkpoint) = 'object'),
        CHECK (poll_claim_version >= 0),
        CHECK (
          (
            poll_claim_owner IS NULL
            AND poll_claimed_at IS NULL
            AND poll_claim_expires_at IS NULL
          )
          OR
          (
            poll_claim_owner IS NOT NULL
            AND poll_claimed_at IS NOT NULL
            AND poll_claim_expires_at IS NOT NULL
          )
        ),
        CHECK (
          poll_claim_expires_at IS NULL
          OR poll_claim_expires_at > poll_claimed_at
        ),
        UNIQUE (vertical, provider, environment, account_lookup_key)
      )
    `);

    const inserted = await pool.query(
      `
        INSERT INTO ${schema}.codeclip_provider_poll_sources (
          vertical,
          provider,
          environment,
          account_lookup_key,
          provider_account_id,
          status,
          poll_interval_ms,
          next_poll_at,
          checkpoint,
          poll_claim_version
        )
        VALUES (
          'codeclip',
          'youtube',
          'sandbox',
          'UC_poll_concurrency_1',
          'UC_poll_concurrency_1',
          'active',
          30000,
          '2026-08-04T12:00:00.000Z',
          '{}'::jsonb,
          0
        )
        RETURNING id
      `
    );
    const pollSourceId = inserted.rows[0].id;

    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

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
    const poolA = asOwnedPool(clientA);
    const poolB = asOwnedPool(clientB);

    const injectedNow = "2026-08-04T16:00:00.000Z";
    const [first, second] = await Promise.all([
      claimCodeClipProviderPollSource(
        {
          pollSourceId,
          owner: "worker.pg.a",
          leaseMs: LEASE_MS,
          now: injectedNow,
        },
        { queryClient: poolA }
      ),
      claimCodeClipProviderPollSource(
        {
          pollSourceId,
          owner: "worker.pg.b",
          leaseMs: LEASE_MS,
          now: injectedNow,
        },
        { queryClient: poolB }
      ),
    ]);

    const winners = [first, second].filter((r) => r && r.ok === true);
    const losers = [first, second].filter((r) => r && r.ok === false);
    assert.equal(winners.length, 1, "exactly one claim winner");
    assert.equal(losers.length, 1, "exactly one contention loser");
    assert.equal(winners[0].claimed, true);
    assert.equal(losers[0].reason, "POLL_CLAIM_CONTENTION");
    assert.equal(winners[0].claimVersion, 1);
    assert.ok(winners[0].claimedAt);
    assert.ok(winners[0].expiresAt);

    const row = await pool.query(
      `
        SELECT poll_claim_owner, poll_claim_version, poll_claimed_at, poll_claim_expires_at
        FROM ${schema}.codeclip_provider_poll_sources
        WHERE id = $1
      `,
      [pollSourceId]
    );
    assert.equal(row.rows.length, 1);
    const owner = row.rows[0].poll_claim_owner;
    assert.ok(owner === "worker.pg.a" || owner === "worker.pg.b");
    assert.equal(Number(row.rows[0].poll_claim_version), 1);

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

test("codeClip poll source complete/release fence after reclaim in PostgreSQL", async (t) => {
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
    t.skip(
      "concurrency test requires an explicitly isolated local PostgreSQL database"
    );
    return;
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const schema = `codeclip_poll_fence_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.codeclip_provider_poll_sources (
        id BIGSERIAL PRIMARY KEY,
        vertical TEXT NOT NULL,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        account_lookup_key TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        poll_interval_ms BIGINT NOT NULL,
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_polled_at TIMESTAMPTZ,
        checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
        poll_claim_owner TEXT,
        poll_claimed_at TIMESTAMPTZ,
        poll_claim_expires_at TIMESTAMPTZ,
        poll_claim_version BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disabled_at TIMESTAMPTZ,
        CHECK (vertical = 'codeclip'),
        CHECK (poll_interval_ms >= 30000 AND poll_interval_ms <= 86400000),
        CHECK (jsonb_typeof(checkpoint) = 'object'),
        CHECK (poll_claim_version >= 0),
        CHECK (
          (
            poll_claim_owner IS NULL
            AND poll_claimed_at IS NULL
            AND poll_claim_expires_at IS NULL
          )
          OR
          (
            poll_claim_owner IS NOT NULL
            AND poll_claimed_at IS NOT NULL
            AND poll_claim_expires_at IS NOT NULL
          )
        ),
        CHECK (
          poll_claim_expires_at IS NULL
          OR poll_claim_expires_at > poll_claimed_at
        )
      )
    `);

    const inserted = await pool.query(
      `
        INSERT INTO ${schema}.codeclip_provider_poll_sources (
          vertical, provider, environment, account_lookup_key, provider_account_id,
          status, poll_interval_ms, next_poll_at, checkpoint, poll_claim_version
        )
        VALUES (
          'codeclip', 'youtube', 'sandbox', 'UC_poll_fence_1', 'UC_poll_fence_1',
          'active', 30000, '2026-08-04T12:00:00.000Z', '{"seed":true}'::jsonb, 0
        )
        RETURNING id
      `
    );
    const pollSourceId = inserted.rows[0].id;

    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

    function asOwnedPool(client) {
      return {
        async connect() {
          return {
            query: client.query.bind(client),
            release() {},
          };
        },
      };
    }
    const poolA = asOwnedPool(clientA);
    const poolB = asOwnedPool(clientB);

    const claimNow = "2026-08-04T16:00:00.000Z";
    const firstClaim = await claimCodeClipProviderPollSource(
      {
        pollSourceId,
        owner: "worker.old",
        leaseMs: LEASE_MS,
        now: claimNow,
      },
      { queryClient: poolA }
    );
    assert.equal(firstClaim.ok, true);
    assert.equal(firstClaim.claimVersion, 1);

    // Expire lease so worker.b can reclaim with a higher version.
    await pool.query(
      `
        UPDATE ${schema}.codeclip_provider_poll_sources
        SET poll_claim_expires_at = '2026-08-04T15:59:00.000Z'
        WHERE id = $1
      `,
      [pollSourceId]
    );

    const reclaim = await claimCodeClipProviderPollSource(
      {
        pollSourceId,
        owner: "worker.new",
        leaseMs: LEASE_MS,
        now: claimNow,
      },
      { queryClient: poolB }
    );
    assert.equal(reclaim.ok, true);
    assert.equal(reclaim.claimVersion, 2);
    assert.equal(reclaim.reclaimed, true);
    assert.ok(reclaim.claimVersion > firstClaim.claimVersion);

    await assert.rejects(
      () =>
        completeCodeClipProviderPollSourceClaim(
          {
            pollSourceId,
            owner: "worker.old",
            expectedVersion: firstClaim.claimVersion,
            checkpoint: { from: "old-worker" },
            now: claimNow,
          },
          { queryClient: poolA }
        ),
      (error) => {
        assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
        return true;
      }
    );

    await assert.rejects(
      () =>
        releaseCodeClipProviderPollSourceClaim(
          {
            pollSourceId,
            owner: "worker.old",
            expectedVersion: firstClaim.claimVersion,
            now: claimNow,
          },
          { queryClient: poolA }
        ),
      (error) => {
        assertPollError(error, "POLL_CLAIM_FENCE_MISMATCH");
        return true;
      }
    );

    const completed = await completeCodeClipProviderPollSourceClaim(
      {
        pollSourceId,
        owner: "worker.new",
        expectedVersion: reclaim.claimVersion,
        checkpoint: { from: "new-worker" },
        now: claimNow,
      },
      { queryClient: poolB }
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.pollSource.checkpoint, { from: "new-worker" });
    assert.equal(completed.pollSource.pollClaimOwner, null);

    const row = await pool.query(
      `
        SELECT checkpoint, poll_claim_owner, poll_claim_version
        FROM ${schema}.codeclip_provider_poll_sources
        WHERE id = $1
      `,
      [pollSourceId]
    );
    assert.deepEqual(row.rows[0].checkpoint, { from: "new-worker" });
    assert.equal(row.rows[0].poll_claim_owner, null);
    assert.equal(Number(row.rows[0].poll_claim_version), 2);
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
