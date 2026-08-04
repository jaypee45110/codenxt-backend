const test = require("node:test");
const assert = require("node:assert/strict");

const database = require("./db");
const {
  CodeClipProviderCredentialRefreshError,
  claimCodeClipProviderCredentialRefresh,
} = require("./verticals/codeclip/provider-credential-refresh");

const OPERATION_NOW = "2026-08-04T12:00:00.000Z";
const LEASE_MS = 60_000;
const EXPECTED_EXPIRES = "2026-08-04T12:01:00.000Z";

function createRefreshStoreClient(options = {}) {
  const calls = [];
  const rows = [];
  const auditRows = [];
  let nextAuditId = 1;
  const failAudit = options.failAudit === true;
  let forceUpdateRace = options.forceUpdateRace === true;

  function seed(row) {
    rows.push({
      id: row.id,
      vertical: "codeclip",
      provider: row.provider || "meta",
      environment: row.environment || "sandbox",
      status: row.status || "active",
      provider_account_id: row.provider_account_id || "page-refresh-1",
      has_access_token: row.has_access_token !== false,
      has_refresh_token: row.has_refresh_token !== false,
      access_token_expires_at: row.access_token_expires_at || null,
      encryption_key_version: row.encryption_key_version || 1,
      token_type: row.token_type || "Bearer",
      scopes: row.scopes || ["pages_messaging"],
      reauthorization_reason: row.reauthorization_reason || null,
      disabled_at: row.disabled_at || null,
      revoked_at: row.revoked_at || null,
      last_refreshed_at: row.last_refreshed_at || null,
      updated_at: row.updated_at || "2026-08-04T10:00:00.000Z",
      refresh_claim_owner: row.refresh_claim_owner ?? null,
      refresh_claimed_at: row.refresh_claimed_at ?? null,
      refresh_claim_expires_at: row.refresh_claim_expires_at ?? null,
      access_token_envelope: row.access_token_envelope || "v1.1.should-not-leak",
      refresh_token_envelope: row.refresh_token_envelope || "v1.1.should-not-leak-refresh",
    });
  }

  return {
    calls,
    rows,
    auditRows,
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

      if (
        /FROM codeclip_provider_credentials/.test(sql) &&
        /FOR UPDATE/i.test(sql)
      ) {
        const id = String(params[0]);
        const row = rows.find((r) => String(r.id) === id);
        if (!row) return { rows: [] };
        // Never return envelopes on claim path projection
        return {
          rows: [
            {
              id: row.id,
              vertical: row.vertical,
              provider: row.provider,
              environment: row.environment,
              status: row.status,
              provider_account_id: row.provider_account_id,
              has_access_token: row.has_access_token,
              has_refresh_token: row.has_refresh_token,
              access_token_expires_at: row.access_token_expires_at,
              encryption_key_version: row.encryption_key_version,
              token_type: row.token_type,
              scopes: row.scopes,
              reauthorization_reason: row.reauthorization_reason,
              disabled_at: row.disabled_at,
              revoked_at: row.revoked_at,
              last_refreshed_at: row.last_refreshed_at,
              updated_at: row.updated_at,
              refresh_claim_owner: row.refresh_claim_owner,
              refresh_claimed_at: row.refresh_claimed_at,
              refresh_claim_expires_at: row.refresh_claim_expires_at,
            },
          ],
        };
      }

      if (
        /UPDATE codeclip_provider_credentials/.test(sql) &&
        /refresh_claim_owner\s*=/.test(sql)
      ) {
        if (forceUpdateRace) return { rows: [] };
        const id = String(params[0]);
        const owner = params[1];
        const operationNow = params[2];
        const leaseMs = Number(params[3]);
        const row = rows.find((r) => String(r.id) === id);
        if (!row) return { rows: [] };
        if (!["active", "reauthorization_required"].includes(row.status)) {
          return { rows: [] };
        }
        if (!row.has_refresh_token) return { rows: [] };
        const opMs = Date.parse(operationNow);
        if (
          row.refresh_claim_expires_at !== null &&
          row.refresh_claim_expires_at !== undefined
        ) {
          const expMs = Date.parse(row.refresh_claim_expires_at);
          if (Number.isFinite(expMs) && expMs > opMs) {
            return { rows: [] };
          }
        }
        const expiresAt = new Date(opMs + leaseMs).toISOString();
        row.refresh_claim_owner = owner;
        row.refresh_claimed_at = new Date(operationNow).toISOString();
        row.refresh_claim_expires_at = expiresAt;
        return {
          rows: [
            {
              id: row.id,
              refresh_claimed_at: row.refresh_claimed_at,
              refresh_claim_expires_at: row.refresh_claim_expires_at,
            },
          ],
        };
      }

      if (/INSERT INTO codeclip_provider_credential_audit/.test(sql)) {
        if (failAudit) {
          throw new Error("forced audit failure");
        }
        const audit = {
          id: nextAuditId++,
          credential_id: params[0],
          vertical: params[1],
          provider: params[2],
          environment: params[3],
          action: params[4],
          actor_type: params[5],
          actor_id: params[6],
          reason_code: params[7],
          before_state:
            params[8] === null || params[8] === undefined
              ? null
              : typeof params[8] === "string"
                ? JSON.parse(params[8])
                : params[8],
          after_state:
            params[9] === null || params[9] === undefined
              ? null
              : typeof params[9] === "string"
                ? JSON.parse(params[9])
                : params[9],
          metadata:
            typeof params[10] === "string"
              ? JSON.parse(params[10])
              : params[10] || {},
          created_at: OPERATION_NOW,
        };
        auditRows.push(audit);
        return {
          rows: [
            {
              id: audit.id,
              credential_id: audit.credential_id,
              vertical: audit.vertical,
              provider: audit.provider,
              environment: audit.environment,
              action: audit.action,
              actor_type: audit.actor_type,
              actor_id: audit.actor_id,
              reason_code: audit.reason_code,
              before_state: audit.before_state,
              after_state: audit.after_state,
              metadata: audit.metadata,
              created_at: audit.created_at,
            },
          ],
        };
      }

      return { rows: [] };
    },
  };
}

function createRefreshStorePool(options = {}) {
  const store = createRefreshStoreClient(options);
  let released = 0;
  return {
    store,
    get released() {
      return released;
    },
    get calls() {
      return store.calls;
    },
    get rows() {
      return store.rows;
    },
    get auditRows() {
      return store.auditRows;
    },
    seed: store.seed.bind(store),
    async connect() {
      return {
        query: store.query.bind(store),
        release() {
          released += 1;
        },
      };
    },
  };
}

function assertNoSecretsInValue(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("access_token_envelope"), false);
  assert.equal(json.includes("refresh_token_envelope"), false);
  assert.equal(json.includes("should-not-leak"), false);
  assert.equal(json.includes("page-refresh-secret"), false);
  assert.equal(/"provider_account_id"\s*:/.test(json), false);
  assert.equal(/"providerAccountId"\s*:/.test(json), false);
  assert.equal(/"access_token"\s*:/.test(json), false);
  assert.equal(/"refresh_token"\s*:/.test(json), false);
  assert.equal(/"accessToken"\s*:/.test(json), false);
  assert.equal(/"refreshToken"\s*:/.test(json), false);
  assert.equal(/"owner"\s*:/.test(json), false);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

test("codeClip credential refresh exports only public claim surface", () => {
  const mod = require("./verticals/codeclip/provider-credential-refresh");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipProviderCredentialRefreshError",
    "claimCodeClipProviderCredentialRefresh",
  ].sort());
});

// ---------------------------------------------------------------------------
// Owner / lease / now validation
// ---------------------------------------------------------------------------

test("codeClip credential refresh validates owner lease and now fail-closed", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 1 });

  const base = {
    credentialId: 1,
    owner: "worker.refresh.1",
    leaseMs: LEASE_MS,
    now: OPERATION_NOW,
  };

  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: undefined },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: "   " },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: "Bad Owner!" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: `a${"b".repeat(128)}` },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: "has space" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        { ...base, owner: "line\nbreak" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );

  // Max boundary owner (128)
  const maxOwner = `a${"b".repeat(127)}`;
  assert.equal(maxOwner.length, 128);
  const maxOk = await claimCodeClipProviderCredentialRefresh(
    { ...base, owner: maxOwner },
    { queryClient: client }
  );
  assert.equal(maxOk.ok, true);

  for (const leaseMs of [null, "60000", true, 1.5, NaN, Infinity, 0, 4999, 300001, -1]) {
    await assert.rejects(
      () =>
        claimCodeClipProviderCredentialRefresh(
          {
            credentialId: 1,
            owner: "worker.b",
            leaseMs,
            now: OPERATION_NOW,
          },
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_INPUT",
      `lease ${String(leaseMs)}`
    );
  }

  // min/max accepted
  client.rows[0].refresh_claim_owner = null;
  client.rows[0].refresh_claimed_at = null;
  client.rows[0].refresh_claim_expires_at = null;
  const minOk = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 1,
      owner: "worker.min",
      leaseMs: 5000,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(minOk.ok, true);

  client.rows[0].refresh_claim_owner = null;
  client.rows[0].refresh_claimed_at = null;
  client.rows[0].refresh_claim_expires_at = null;
  const maxLeaseOk = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 1,
      owner: "worker.max",
      leaseMs: 300000,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(maxLeaseOk.ok, true);

  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId: 1,
          owner: "worker.now",
          leaseMs: LEASE_MS,
          now: "not-a-date",
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId: 1,
          owner: "worker.now",
          leaseMs: LEASE_MS,
          now: null,
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
});

test("codeClip credential refresh owner is trimmed and lowercased", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 2 });
  const result = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 2,
      owner: "  Worker.Refresh-1  ",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(result.ok, true);
  assert.equal(client.rows[0].refresh_claim_owner, "worker.refresh-1");
  assert.equal(Object.hasOwn(result, "owner"), false);
});

// ---------------------------------------------------------------------------
// Claim semantics
// ---------------------------------------------------------------------------

test("codeClip credential refresh first claim succeeds with audit and no secrets", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 10, provider_account_id: "page-refresh-secret" });

  const result = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 10,
      owner: "worker.a",
      // default lease
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );

  assert.deepEqual(
    {
      ok: result.ok,
      claimed: result.claimed,
      credentialId: result.credentialId,
      claimedAt: result.claimedAt,
      expiresAt: result.expiresAt,
      reclaimed: result.reclaimed,
    },
    {
      ok: true,
      claimed: true,
      credentialId: "10",
      claimedAt: OPERATION_NOW,
      expiresAt: EXPECTED_EXPIRES,
      reclaimed: false,
    }
  );
  assert.equal(Object.hasOwn(result, "owner"), false);
  assertNoSecretsInValue(result);

  assert.equal(client.auditRows.length, 1);
  assert.equal(client.auditRows[0].action, "refresh_claimed");
  assert.equal(client.auditRows[0].reason_code, "refresh_lease_acquired");
  assert.equal(client.auditRows[0].actor_type, "system");
  assert.deepEqual(client.auditRows[0].metadata, {});
  assertNoSecretsInValue(client.auditRows[0]);
  assert.equal(JSON.stringify(client.auditRows[0]).includes("worker.a"), false);

  const auditInsert = client.calls.find((c) =>
    /INSERT INTO codeclip_provider_credential_audit/.test(c.sql)
  );
  assert.ok(auditInsert);
  assert.equal(auditInsert.params[10], "{}");
  assertNoSecretsInValue(auditInsert.params);
});

test("codeClip credential refresh contention and stale reclaim boundary", async () => {
  const client = createRefreshStoreClient();
  client.seed({
    id: 11,
    refresh_claim_owner: "worker.old",
    refresh_claimed_at: "2026-08-04T11:59:00.000Z",
    refresh_claim_expires_at: "2026-08-04T12:00:01.000Z", // still active at OPERATION_NOW
  });

  const contended = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 11,
      owner: "worker.new",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.deepEqual(contended, {
    ok: false,
    reason: "REFRESH_CLAIM_CONTENTION",
  });
  assert.equal(client.rows[0].refresh_claim_owner, "worker.old");
  assert.equal(client.auditRows.length, 0);

  // Exact boundary expires_at == operation_now → stale / reclaimable
  client.rows[0].refresh_claim_expires_at = OPERATION_NOW;
  const reclaimed = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 11,
      owner: "worker.new",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(client.rows[0].refresh_claim_owner, "worker.new");
  assert.equal(client.auditRows.at(-1).reason_code, "refresh_lease_reclaimed");
  assert.equal(client.auditRows.at(-1).action, "refresh_claimed");
});

test("codeClip credential refresh eligibility gates status and refresh token", async () => {
  const client = createRefreshStoreClient();

  client.seed({ id: 20, status: "disabled", has_refresh_token: true });
  assert.deepEqual(
    await claimCodeClipProviderCredentialRefresh(
      {
        credentialId: 20,
        owner: "worker.a",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      },
      { queryClient: client }
    ),
    { ok: false, reason: "REFRESH_NOT_CLAIMABLE" }
  );

  client.seed({ id: 21, status: "revoked", has_refresh_token: true });
  assert.deepEqual(
    await claimCodeClipProviderCredentialRefresh(
      {
        credentialId: 21,
        owner: "worker.a",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      },
      { queryClient: client }
    ),
    { ok: false, reason: "REFRESH_NOT_CLAIMABLE" }
  );

  client.seed({ id: 22, status: "active", has_refresh_token: false });
  assert.deepEqual(
    await claimCodeClipProviderCredentialRefresh(
      {
        credentialId: 22,
        owner: "worker.a",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      },
      { queryClient: client }
    ),
    { ok: false, reason: "REFRESH_NOT_CLAIMABLE" }
  );

  // active + refresh token allowed
  client.seed({ id: 23, status: "active", has_refresh_token: true });
  const active = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 23,
      owner: "worker.a",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(active.ok, true);

  // reauthorization_required + refresh token allowed
  client.seed({
    id: 24,
    status: "reauthorization_required",
    has_refresh_token: true,
    reauthorization_reason: "token_invalid",
  });
  const reauth = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 24,
      owner: "worker.b",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.equal(reauth.ok, true);
});

test("codeClip credential refresh not found and guarded update race", async () => {
  const client = createRefreshStoreClient();
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId: 99999,
          owner: "worker.a",
          leaseMs: LEASE_MS,
          now: OPERATION_NOW,
        },
        { queryClient: client }
      ),
    (e) =>
      e instanceof CodeClipProviderCredentialRefreshError &&
      e.code === "CREDENTIAL_NOT_FOUND"
  );

  client.seed({ id: 30 });
  client.setForceUpdateRace(true);
  const raced = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 30,
      owner: "worker.a",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  assert.deepEqual(raced, { ok: false, reason: "REFRESH_CLAIM_CONTENTION" });
  assert.equal(client.auditRows.length, 0);
});

test("codeClip credential refresh concurrent claims yield single winner", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 40 });

  let lockHeld = false;
  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    if (/FOR UPDATE/i.test(sql)) {
      // Serialize claimers: second waiter sees claim already set after first completes
      while (lockHeld) {
        await new Promise((r) => setImmediate(r));
      }
      lockHeld = true;
      try {
        return await originalQuery(sql, params);
      } finally {
        // release after a tick so concurrent waiter re-reads
        setImmediate(() => {
          lockHeld = false;
        });
      }
    }
    return originalQuery(sql, params);
  };

  const [a, b] = await Promise.all([
    claimCodeClipProviderCredentialRefresh(
      {
        credentialId: 40,
        owner: "worker.a",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      },
      { queryClient: client }
    ),
    claimCodeClipProviderCredentialRefresh(
      {
        credentialId: 40,
        owner: "worker.b",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      },
      { queryClient: client }
    ),
  ]);

  const winners = [a, b].filter((r) => r.ok === true);
  const losers = [a, b].filter((r) => r.ok === false);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, "REFRESH_CLAIM_CONTENTION");
  assert.equal(client.auditRows.length, 1);
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

test("codeClip credential refresh uses SQL NOW when now is omitted", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 50 });

  const result = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 50,
      owner: "worker.clock",
      leaseMs: LEASE_MS,
      // now omitted
    },
    { queryClient: client }
  );
  assert.equal(result.ok, true);

  const clockCall = client.calls.find((c) =>
    /COALESCE\(\$1::timestamptz, NOW\(\)\)/i.test(c.sql)
  );
  assert.ok(clockCall);
  assert.equal(clockCall.params[0], null);

  const updateCall = client.calls.find(
    (c) =>
      /UPDATE codeclip_provider_credentials/.test(c.sql) &&
      /refresh_claim_owner/.test(c.sql)
  );
  assert.ok(updateCall);
  // claimed_at and lease math share the same operation timestamp param
  assert.equal(updateCall.params[2], result.claimedAt);
  assert.equal(updateCall.params[3], LEASE_MS);
});

test("codeClip credential refresh injected now is shared for claim times", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 51 });
  const injected = "2026-08-04T15:00:00.000Z";
  const result = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 51,
      owner: "worker.clock2",
      leaseMs: 120_000,
      now: injected,
    },
    { queryClient: client }
  );
  assert.equal(result.claimedAt, injected);
  assert.equal(result.expiresAt, "2026-08-04T15:02:00.000Z");

  const clockCall = client.calls.find((c) =>
    /COALESCE\(\$1::timestamptz, NOW\(\)\)/i.test(c.sql)
  );
  assert.equal(clockCall.params[0], injected);

  const updateCall = client.calls.find(
    (c) =>
      /UPDATE codeclip_provider_credentials/.test(c.sql) &&
      /refresh_claim_owner/.test(c.sql)
  );
  assert.equal(updateCall.params[2], injected);
  assert.equal(updateCall.params[3], 120_000);
});

// ---------------------------------------------------------------------------
// Transactions + audit failure
// ---------------------------------------------------------------------------

test("codeClip credential refresh pool owns BEGIN COMMIT and releases", async () => {
  const pool = createRefreshStorePool();
  pool.seed({ id: 60 });
  const before = pool.calls.length;
  const result = await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 60,
      owner: "worker.pool",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: pool }
  );
  assert.equal(result.ok, true);
  const tx = pool.calls.slice(before);
  assert.equal(tx.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), true);
  assert.equal(tx.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), true);
  assert.equal(tx.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
  assert.equal(
    tx.some((c) => /INSERT INTO codeclip_provider_credential_audit/i.test(c.sql)),
    true
  );
  assert.equal(pool.released, 1);
});

test("codeClip credential refresh audit failure is refresh typed error and rolls back", async () => {
  const pool = createRefreshStorePool({ failAudit: true });
  pool.seed({ id: 61 });
  let caught = null;
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId: 61,
          owner: "worker.fail",
          leaseMs: LEASE_MS,
          now: OPERATION_NOW,
        },
        { queryClient: pool }
      ),
    (e) => {
      caught = e;
      return true;
    }
  );

  assert.ok(caught instanceof CodeClipProviderCredentialRefreshError);
  assert.equal(caught.name, "CodeClipProviderCredentialRefreshError");
  assert.equal(caught.code, "CREDENTIAL_AUDIT_FAILED");
  // Must not bubble audit-module or credentials-module error classes
  assert.equal(caught.name.includes("Audit"), false);
  assert.equal(Object.getPrototypeOf(caught).constructor.name, "CodeClipProviderCredentialRefreshError");

  const serialized = JSON.stringify({
    name: caught.name,
    code: caught.code,
    message: caught.message,
    details: caught.details,
  });
  assert.equal(serialized.includes("forced audit failure"), false);
  assert.equal(serialized.includes("INSERT"), false);
  assert.equal(serialized.includes("worker.fail"), false);
  assert.equal(serialized.includes("access_token"), false);
  assert.equal(serialized.includes("envelope"), false);
  assert.equal(serialized.includes("page-refresh"), false);
  for (const key of Object.keys(caught.details || {})) {
    assert.ok(
      ["auditCode", "fieldName", "reason"].includes(key),
      `unexpected error detail field: ${key}`
    );
  }

  assert.equal(
    pool.calls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())),
    true
  );
  assert.equal(
    pool.calls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())),
    false
  );
  assert.equal(pool.released, 1);
  // No audit row committed through mock store
  assert.equal(pool.auditRows.length, 0);
});

test("codeClip credential refresh caller-client has no nested transaction", async () => {
  const client = createRefreshStoreClient();
  client.seed({ id: 62 });
  const before = client.calls.length;
  await claimCodeClipProviderCredentialRefresh(
    {
      credentialId: 62,
      owner: "worker.caller",
      leaseMs: LEASE_MS,
      now: OPERATION_NOW,
    },
    { queryClient: client }
  );
  const calls = client.calls.slice(before);
  assert.equal(calls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), false);
  assert.equal(calls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), false);
  assert.equal(calls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
  assert.equal(
    calls.some((c) => /INSERT INTO codeclip_provider_credential_audit/i.test(c.sql)),
    true
  );
});

test("codeClip credential refresh requires query client", async () => {
  await assert.rejects(
    () =>
      claimCodeClipProviderCredentialRefresh({
        credentialId: 1,
        owner: "worker.a",
        leaseMs: LEASE_MS,
        now: OPERATION_NOW,
      }),
    (e) => e.code === "DATABASE_UNAVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// Schema ensure regression hooks (refresh claim present; no encryption)
// ---------------------------------------------------------------------------

test("codeClip credential refresh schema ensure does not require encryption env", async () => {
  const previousKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const previousActive =
    process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  try {
    const client = {
      calls: [],
      async query(sql) {
        this.calls.push(sql);
        return { rows: [] };
      },
    };
    await database.ensureCodeClipProviderCredentialsTable(client);
    await database.ensureCodeClipProviderCredentialAuditTable(client);
    const joined = client.calls.join("\n");
    assert.match(joined, /refresh_claim_owner/);
    assert.match(joined, /refresh_claimed/);
    assert.equal(/refresh_succeeded/.test(joined), false);
  } finally {
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
});

// ---------------------------------------------------------------------------
// Real PostgreSQL concurrency (env-gated; never production)
// ---------------------------------------------------------------------------

test("codeClip credential refresh claim is single-winner in PostgreSQL", async (t) => {
  const connectionString =
    process.env.CODECLIP_PROVIDER_CREDENTIAL_REFRESH_CONCURRENCY_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip(
      "CODECLIP_PROVIDER_CREDENTIAL_REFRESH_CONCURRENCY_TEST_DATABASE_URL is not configured"
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
  const schema = `codeclip_refresh_claim_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.codeclip_provider_credentials (
        id BIGSERIAL PRIMARY KEY,
        vertical TEXT NOT NULL,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        account_lookup_key TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        access_token_envelope TEXT,
        refresh_token_envelope TEXT,
        access_token_expires_at TIMESTAMPTZ,
        token_type TEXT,
        scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
        encryption_key_version INTEGER NOT NULL,
        has_access_token BOOLEAN NOT NULL DEFAULT FALSE,
        has_refresh_token BOOLEAN NOT NULL DEFAULT FALSE,
        reauthorization_reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disabled_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_refreshed_at TIMESTAMPTZ,
        refresh_claim_owner TEXT,
        refresh_claimed_at TIMESTAMPTZ,
        refresh_claim_expires_at TIMESTAMPTZ,
        CHECK (vertical = 'codeclip'),
        CHECK (environment IN ('sandbox', 'production')),
        CHECK (status IN ('active', 'reauthorization_required', 'revoked', 'disabled')),
        CHECK (
          (
            refresh_claim_owner IS NULL
            AND refresh_claimed_at IS NULL
            AND refresh_claim_expires_at IS NULL
          )
          OR
          (
            refresh_claim_owner IS NOT NULL
            AND refresh_claimed_at IS NOT NULL
            AND refresh_claim_expires_at IS NOT NULL
          )
        ),
        CHECK (
          refresh_claim_expires_at IS NULL
          OR refresh_claim_expires_at > refresh_claimed_at
        ),
        CHECK (
          refresh_claim_owner IS NULL
          OR char_length(refresh_claim_owner) BETWEEN 1 AND 128
        )
      )
    `);
    await pool.query(`
      CREATE TABLE ${schema}.codeclip_provider_credential_audit (
        id BIGSERIAL PRIMARY KEY,
        credential_id BIGINT NOT NULL
          REFERENCES ${schema}.codeclip_provider_credentials (id)
          ON DELETE RESTRICT,
        vertical TEXT NOT NULL,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        reason_code TEXT,
        before_state JSONB,
        after_state JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (action IN (
          'created',
          'token_updated',
          'reauthorization_required',
          'revoked',
          'disabled',
          'reactivated',
          'refresh_claimed'
        )),
        CHECK (actor_type IN ('operator', 'operator_key', 'system'))
      )
    `);

    const inserted = await pool.query(
      `
        INSERT INTO ${schema}.codeclip_provider_credentials (
          vertical,
          provider,
          environment,
          account_lookup_key,
          provider_account_id,
          status,
          encryption_key_version,
          has_access_token,
          has_refresh_token,
          access_token_envelope,
          refresh_token_envelope
        )
        VALUES (
          'codeclip',
          'meta',
          'sandbox',
          'page-concurrency-1',
          'page-concurrency-1',
          'active',
          1,
          TRUE,
          TRUE,
          'v1.1.envelope-access',
          'v1.1.envelope-refresh'
        )
        RETURNING id
      `
    );
    const credentialId = inserted.rows[0].id;

    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

    // Present each exclusive connection as a pool so Alternativ B owns
    // BEGIN/COMMIT and FOR UPDATE holds across claim+audit statements.
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
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId,
          owner: "worker.pg.a",
          leaseMs: LEASE_MS,
          now: injectedNow,
        },
        { queryClient: poolA }
      ),
      claimCodeClipProviderCredentialRefresh(
        {
          credentialId,
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
    assert.equal(losers[0].reason, "REFRESH_CLAIM_CONTENTION");
    assert.equal(Object.hasOwn(winners[0], "owner"), false);

    const row = await pool.query(
      `
        SELECT refresh_claim_owner, refresh_claimed_at, refresh_claim_expires_at
        FROM ${schema}.codeclip_provider_credentials
        WHERE id = $1
      `,
      [credentialId]
    );
    assert.equal(row.rows.length, 1);
    const owner = row.rows[0].refresh_claim_owner;
    assert.ok(owner === "worker.pg.a" || owner === "worker.pg.b");
    assert.ok(row.rows[0].refresh_claimed_at);
    assert.ok(row.rows[0].refresh_claim_expires_at);

    const audits = await pool.query(
      `
        SELECT action, reason_code, actor_type, metadata
        FROM ${schema}.codeclip_provider_credential_audit
        WHERE credential_id = $1
        ORDER BY id ASC
      `,
      [credentialId]
    );
    assert.equal(audits.rows.length, 1, "exactly one committed refresh_claimed audit");
    assert.equal(audits.rows[0].action, "refresh_claimed");
    assert.equal(audits.rows[0].reason_code, "refresh_lease_acquired");
    assert.equal(audits.rows[0].actor_type, "system");
    assert.deepEqual(audits.rows[0].metadata, {});

    // No hanging transactions: connections can run a simple query
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
