const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CodeClipProviderCredentialError,
  createCodeClipProviderCredential,
  getCodeClipProviderCredentialById,
  findCodeClipProviderCredential,
  listCodeClipProviderCredentials,
  updateCodeClipProviderCredentialTokens,
  setCodeClipProviderCredentialStatus,
  getCodeClipProviderCredentialSecretsForUse,
  inspectCodeClipProviderCredentialUsability,
  serializeCodeClipProviderCredentialForOperator,
} = require("./verticals/codeclip/provider-credentials");
const {
  decryptCodeClipProviderCredentialSecret,
} = require("./verticals/codeclip/provider-credential-crypto");

const ENV_KEYS = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS";
const ENV_ACTIVE = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION";

/** Default mutation actor for C2 tests (audit requires actor). */
const SYSTEM_ACTOR = Object.freeze({ type: "system" });
const OPERATOR_ACTOR = Object.freeze({ type: "operator", id: "admin.user-1" });

function mutationOpts(extra = {}) {
  return { actor: SYSTEM_ACTOR, ...extra };
}

function keyB64(bytes = crypto.randomBytes(32)) {
  return bytes.toString("base64");
}

function makeCryptoEnv({ activeVersion = 1, versions = [1] } = {}) {
  const keys = Object.fromEntries(versions.map((v) => [v, keyB64()]));
  return {
    [ENV_KEYS]: Object.entries(keys)
      .map(([v, k]) => `${v}:${k}`)
      .join(";"),
    [ENV_ACTIVE]: String(activeVersion),
    keys,
  };
}

function assertSafeCredential(credential) {
  assert.ok(credential);
  assert.equal(Object.hasOwn(credential, "providerAccountId"), false);
  assert.equal(Object.hasOwn(credential, "accountLookupKey"), false);
  assert.equal(Object.hasOwn(credential, "accessTokenEnvelope"), false);
  assert.equal(Object.hasOwn(credential, "refreshTokenEnvelope"), false);
  assert.equal(Object.hasOwn(credential, "access_token_envelope"), false);
  assert.equal(Object.hasOwn(credential, "refresh_token_envelope"), false);
  assert.equal(Object.hasOwn(credential, "provider_account_id"), false);
  assert.equal(Object.hasOwn(credential, "account_lookup_key"), false);
  assert.equal(typeof credential.maskedAccountId, "string");
  assert.ok(credential.maskedAccountId.includes("•") || credential.maskedAccountId.length > 0);
  assert.equal(Array.isArray(credential.scopes), true);
  assert.equal(typeof credential.metadata, "object");
  assert.equal(Array.isArray(credential.metadata), false);
}

function createCredentialStoreClient(options = {}) {
  const calls = [];
  const rows = [];
  const auditRows = [];
  let nextId = 1;
  let nextAuditId = 1;
  const failAudit = options.failAudit === true;
  /** When set, force status UPDATE to see a different locked status (race). */
  let forceStatusRace = options.forceStatusRace === true;

  function identityKey(row) {
    return [row.vertical, row.provider, row.environment, row.account_lookup_key].join("|");
  }

  function toSafeRow(row) {
    return {
      id: row.id,
      vertical: row.vertical,
      provider: row.provider,
      environment: row.environment,
      provider_account_id: row.provider_account_id,
      status: row.status,
      token_type: row.token_type,
      scopes: row.scopes,
      has_access_token: row.has_access_token,
      has_refresh_token: row.has_refresh_token,
      access_token_expires_at: row.access_token_expires_at,
      encryption_key_version: row.encryption_key_version,
      reauthorization_reason: row.reauthorization_reason,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      disabled_at: row.disabled_at,
      revoked_at: row.revoked_at,
      last_refreshed_at: row.last_refreshed_at,
    };
  }

  function toLockedRow(row) {
    return {
      ...toSafeRow(row),
      access_token_envelope: row.access_token_envelope,
      refresh_token_envelope: row.refresh_token_envelope,
    };
  }

  return {
    calls,
    rows,
    auditRows,
    setForceStatusRace(value) {
      forceStatusRace = Boolean(value);
    },
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/^\s*BEGIN\s*$/i.test(sql.trim()) || /^\s*COMMIT\s*$/i.test(sql.trim()) || /^\s*ROLLBACK\s*$/i.test(sql.trim())) {
        return { rows: [] };
      }

      if (/INSERT INTO codeclip_provider_credential_audit/.test(sql)) {
        if (failAudit) {
          throw new Error("audit insert failed for test");
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
            typeof params[10] === "string" ? JSON.parse(params[10]) : params[10] || {},
          created_at: "2026-08-04T10:00:00.000Z",
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

      if (/INSERT INTO codeclip_provider_credentials/.test(sql)) {
        const row = {
          id: nextId++,
          vertical: params[0],
          provider: params[1],
          environment: params[2],
          account_lookup_key: params[3],
          provider_account_id: params[4],
          status: "active",
          access_token_envelope: params[5],
          refresh_token_envelope: params[6],
          access_token_expires_at: params[7],
          token_type: params[8],
          scopes: params[9] || [],
          encryption_key_version: params[10],
          has_access_token: params[11],
          has_refresh_token: params[12],
          reauthorization_reason: null,
          metadata:
            typeof params[13] === "string" ? JSON.parse(params[13]) : params[13] || {},
          created_at: params[14] || "2026-08-04T10:00:00.000Z",
          updated_at: params[14] || "2026-08-04T10:00:00.000Z",
          disabled_at: null,
          revoked_at: null,
          last_refreshed_at: null,
        };
        if (rows.some((existing) => identityKey(existing) === identityKey(row))) {
          const error = new Error("duplicate key value violates unique constraint");
          error.code = "23505";
          throw error;
        }
        rows.push(row);
        // RETURNING only safe columns (no envelopes / lookup key)
        return { rows: [toSafeRow(row)] };
      }

      if (/UPDATE codeclip_provider_credentials/.test(sql)) {
        const id = String(params[0]);
        const row = rows.find((item) => String(item.id) === id);
        if (!row) return { rows: [] };

        // Status setter path: no token envelopes in SET clause.
        if (!/access_token_envelope\s*=/.test(sql)) {
          // Expected: status=$3, updated_at=$4, optional disabled/revoked/reauth, WHERE status=$last
          const expectedFromStatus = params[params.length - 1];
          if (forceStatusRace || row.status !== expectedFromStatus) {
            return { rows: [] };
          }
          row.status = params[2];
          row.updated_at = params[3];
          // Apply optional fields by scanning SET clause order used by repository.
          if (/disabled_at\s*=/.test(sql)) {
            // Find param index for disabled_at: after status and updated_at at least
            const setMatch = sql.match(
              /SET\s+([\s\S]*?)\s+WHERE/i
            );
            if (setMatch) {
              const setSql = setMatch[1];
              const assignments = setSql.split(",").map((s) => s.trim());
              for (const assignment of assignments) {
                const m = assignment.match(/^(\w+)\s*=\s*\$(\d+)/i);
                if (!m) continue;
                const col = m[1].toLowerCase();
                const idx = Number(m[2]) - 1;
                if (col === "status") row.status = params[idx];
                else if (col === "updated_at") row.updated_at = params[idx];
                else if (col === "disabled_at") row.disabled_at = params[idx];
                else if (col === "revoked_at") row.revoked_at = params[idx];
                else if (col === "reauthorization_reason") {
                  row.reauthorization_reason = params[idx];
                }
              }
            }
          } else {
            // Still parse set clauses without disabled_at (e.g. reauth only)
            const setMatch = sql.match(/SET\s+([\s\S]*?)\s+WHERE/i);
            if (setMatch) {
              const assignments = setMatch[1].split(",").map((s) => s.trim());
              for (const assignment of assignments) {
                const m = assignment.match(/^(\w+)\s*=\s*\$(\d+)/i);
                if (!m) continue;
                const col = m[1].toLowerCase();
                const idx = Number(m[2]) - 1;
                if (col === "status") row.status = params[idx];
                else if (col === "updated_at") row.updated_at = params[idx];
                else if (col === "disabled_at") row.disabled_at = params[idx];
                else if (col === "revoked_at") row.revoked_at = params[idx];
                else if (col === "reauthorization_reason") {
                  row.reauthorization_reason = params[idx];
                }
              }
            }
          }
          return { rows: [toSafeRow(row)] };
        }

        if (!["active", "reauthorization_required"].includes(row.status)) {
          return { rows: [] };
        }
        // Params match updateCodeClipProviderCredentialTokens UPDATE binding.
        row.access_token_envelope = params[1];
        row.refresh_token_envelope = params[2];
        row.has_access_token = params[3];
        row.has_refresh_token = params[4];
        row.encryption_key_version = params[5];
        row.access_token_expires_at = params[6];
        row.token_type = params[7];
        row.scopes = params[8] || [];
        row.metadata =
          typeof params[9] === "string" ? JSON.parse(params[9]) : params[9] || {};
        row.status = params[10];
        row.reauthorization_reason = params[11];
        row.last_refreshed_at = params[12];
        row.updated_at = params[12];
        return { rows: [toSafeRow(row)] };
      }

      if (/FROM codeclip_provider_credentials/.test(sql) && /WHERE id = \$1/.test(sql)) {
        const id = String(params[0]);
        const row = rows.find((item) => String(item.id) === id);
        if (!row) return { rows: [] };
        if (/FOR UPDATE/i.test(sql)) {
          return { rows: [toLockedRow(row)] };
        }
        // Purpose-specific projections for secret-read / inspect
        if (/access_token_envelope/.test(sql) && !/refresh_token_envelope/.test(sql)) {
          return {
            rows: [
              {
                id: row.id,
                provider: row.provider,
                environment: row.environment,
                status: row.status,
                token_type: row.token_type,
                access_token_expires_at: row.access_token_expires_at,
                has_access_token: row.has_access_token,
                access_token_envelope: row.access_token_envelope,
              },
            ],
          };
        }
        if (/refresh_token_envelope/.test(sql) && !/access_token_envelope/.test(sql)) {
          return {
            rows: [
              {
                id: row.id,
                provider: row.provider,
                environment: row.environment,
                status: row.status,
                has_access_token: row.has_access_token,
                access_token_expires_at: row.access_token_expires_at,
                has_refresh_token: row.has_refresh_token,
                refresh_token_envelope: row.refresh_token_envelope,
              },
            ],
          };
        }
        if (
          /has_access_token/.test(sql) &&
          /has_refresh_token/.test(sql) &&
          !/provider_account_id/.test(sql) &&
          !/access_token_envelope/.test(sql) &&
          !/metadata/.test(sql)
        ) {
          return {
            rows: [
              {
                id: row.id,
                provider: row.provider,
                environment: row.environment,
                status: row.status,
                has_access_token: row.has_access_token,
                has_refresh_token: row.has_refresh_token,
                access_token_expires_at: row.access_token_expires_at,
              },
            ],
          };
        }
        return { rows: [toSafeRow(row)] };
      }

      if (
        /FROM codeclip_provider_credentials/.test(sql) &&
        /account_lookup_key = \$4/.test(sql)
      ) {
        const key = [params[0], params[1], params[2], params[3]].join("|");
        const row = rows.find((item) => identityKey(item) === key);
        if (!row) return { rows: [] };
        return { rows: [toSafeRow(row)] };
      }

      if (/ORDER BY updated_at DESC, id DESC/.test(sql)) {
        let filtered = [...rows];
        // params: vertical, optional provider, environment, status, cursor..., limit+1
        // simplistic filter: match by presence of provider/env/status in params after vertical
        // For tests we rely on sequential optional filters.
        // Re-parse by inspecting SQL predicates.
        if (/provider = \$/.test(sql)) {
          const provider = params.find((p, i) => i > 0 && typeof p === "string" && ["meta", "youtube", "sms", "test"].includes(p));
          // better: walk predicates order
        }
        // Apply filters from SQL param order matching repository build:
        // $1 vertical, then optional provider, environment, status, cursor pair, limit
        let idx = 1;
        if (/provider = \$/.test(sql)) {
          filtered = filtered.filter((r) => r.provider === params[idx]);
          idx += 1;
        }
        if (/environment = \$/.test(sql)) {
          filtered = filtered.filter((r) => r.environment === params[idx]);
          idx += 1;
        }
        if (/status = \$/.test(sql)) {
          filtered = filtered.filter((r) => r.status === params[idx]);
          idx += 1;
        }
        if (/updated_at </.test(sql)) {
          const cursorUpdatedAt = params[idx];
          const cursorId = params[idx + 1];
          idx += 2;
          filtered = filtered.filter((r) => {
            const t = Date.parse(r.updated_at);
            const c = Date.parse(cursorUpdatedAt);
            return t < c || (t === c && Number(r.id) < Number(cursorId));
          });
        }
        const limit = params[params.length - 1];
        filtered.sort((a, b) => {
          const ta = Date.parse(a.updated_at);
          const tb = Date.parse(b.updated_at);
          if (tb !== ta) return tb - ta;
          return Number(b.id) - Number(a.id);
        });
        const page = filtered.slice(0, limit).map((row) => toSafeRow(row));
        return { rows: page };
      }

      return { rows: [] };
    },
  };
}

/**
 * Mock pool: repository-owned transaction path (connect + BEGIN/COMMIT/ROLLBACK + release).
 * Returned client is the same store client used for queries.
 */
function createCredentialStorePool(options = {}) {
  const store = createCredentialStoreClient(options);
  let released = 0;
  const pool = {
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
    async connect() {
      return {
        query: store.query.bind(store),
        release() {
          released += 1;
        },
      };
    },
  };
  return pool;
}

function extractSafeProjectionClause(sql) {
  // Only inspect the returned column list (SELECT … FROM or RETURNING …),
  // never INSERT column lists where envelopes must appear for writes.
  if (/RETURNING/i.test(sql)) {
    return sql.split(/RETURNING/i)[1];
  }
  if (/SELECT/i.test(sql) && /FROM/i.test(sql)) {
    return sql.split(/FROM/i)[0];
  }
  return null;
}

function assertSafeSqlProjection(sql) {
  assert.equal(/SELECT\s+\*/i.test(sql), false);
  const projection = extractSafeProjectionClause(sql);
  assert.ok(projection, "expected SELECT or RETURNING projection");
  assert.equal(/access_token_envelope/.test(projection), false);
  assert.equal(/refresh_token_envelope/.test(projection), false);
  assert.equal(/account_lookup_key/.test(projection), false);
  // provider_account_id is allowed only for internal masking in the projection
  assert.match(projection, /provider_account_id/);
}

function assertNoSecretsInAuditParams(params) {
  const serialized = JSON.stringify(params);
  assert.equal(serialized.includes("access_token_envelope"), false);
  assert.equal(serialized.includes("refresh_token_envelope"), false);
  assert.equal(serialized.includes("access-secret"), false);
  assert.equal(serialized.includes("plaintext"), false);
  assert.equal(/"provider_account_id"\s*:/.test(serialized), false);
  // raw account ids used in tests
  assert.equal(serialized.includes("page-1234567890"), false);
}

function auditInserts(client) {
  return client.calls.filter((c) =>
    /INSERT INTO codeclip_provider_credential_audit/.test(c.sql)
  );
}

test("codeClip credentials safe SQL projection excludes envelopes and lookup key", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-projection-1",
      environment: "sandbox",
      accessToken: "proj-token",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  await getCodeClipProviderCredentialById(created.credential.id, {
    queryClient: client,
  });
  await findCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-projection-1",
      environment: "sandbox",
    },
    { queryClient: client }
  );
  await listCodeClipProviderCredentials(
    { environment: "sandbox", limit: 10 },
    { queryClient: client }
  );

  const selectOrReturning = client.calls.filter(
    (call) =>
      /codeclip_provider_credentials/i.test(call.sql) &&
      (/SELECT/i.test(call.sql) || /RETURNING/i.test(call.sql))
  );
  assert.ok(selectOrReturning.length >= 4);
  for (const call of selectOrReturning) {
    assertSafeSqlProjection(call.sql);
  }
  assertSafeCredential(created.credential);
});

test("codeClip credentials create access-only and returns safe row", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const result = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-1234567890",
      environment: "sandbox",
      accessToken: "access-secret-token",
      tokenType: "Bearer",
      scopes: ["pages_messaging"],
      metadata: { source: "test" },
      accessTokenExpiresAt: "2026-09-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  assert.equal(result.status, "created");
  assert.equal(result.created, true);
  assertSafeCredential(result.credential);
  assert.equal(result.credential.provider, "meta");
  assert.equal(result.credential.environment, "sandbox");
  assert.equal(result.credential.hasAccessToken, true);
  assert.equal(result.credential.hasRefreshToken, false);
  assert.equal(result.credential.encryptionKeyVersion, 1);
  assert.equal(result.credential.status, "active");
  assert.deepEqual(result.credential.scopes, ["pages_messaging"]);
  assert.equal(result.credential.maskedAccountId.includes("7890"), true);
  assert.equal(result.credential.maskedAccountId.includes("page-1234567890"), false);

  // INSERT SQL must not be SELECT *
  const insert = client.calls.find((c) => /INSERT INTO codeclip_provider_credentials/.test(c.sql));
  assert.ok(insert);
  assert.equal(/SELECT \*/.test(insert.sql), false);
  assert.match(insert.sql, /RETURNING/);
  assert.equal(/access_token_envelope/.test(insert.sql.split("RETURNING")[1]), false);

  // Stored envelope decrypts with crypto env (internal store only)
  const stored = client.rows[0];
  const decrypted = decryptCodeClipProviderCredentialSecret({
    envelope: stored.access_token_envelope,
    env,
  });
  assert.equal(decrypted.ok, true);
  assert.equal(decrypted.plaintext, "access-secret-token");
  assert.equal(JSON.stringify(result).includes("access-secret-token"), false);
});

test("codeClip credentials create both tokens with same key version", async () => {
  const env = makeCryptoEnv({ versions: [1, 2], activeVersion: 2 });
  const client = createCredentialStoreClient();
  const result = await createCodeClipProviderCredential(
    {
      provider: "youtube",
      providerAccountId: "UCabcdefghijklmnopqrstuv",
      environment: "production",
      accessToken: "access-a",
      refreshToken: "refresh-b",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  assert.equal(result.credential.hasAccessToken, true);
  assert.equal(result.credential.hasRefreshToken, true);
  assert.equal(result.credential.encryptionKeyVersion, 2);
  assert.equal(client.rows[0].encryption_key_version, 2);
  assert.match(client.rows[0].access_token_envelope, /^v1\.2\./);
  assert.match(client.rows[0].refresh_token_envelope, /^v1\.2\./);
});

test("codeClip credentials create rejects providers without credentials capability", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "sms",
          providerAccountId: "sender-1",
          environment: "sandbox",
          accessToken: "x",
        },
        { queryClient: client, env, actor: SYSTEM_ACTOR }
      ),
    (error) =>
      error instanceof CodeClipProviderCredentialError &&
      error.code === "UNSUPPORTED_CREDENTIAL_PROVIDER"
  );
  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "test",
          providerAccountId: "t-1",
          environment: "sandbox",
          accessToken: "x",
        },
        { queryClient: client, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "UNSUPPORTED_CREDENTIAL_PROVIDER"
  );
});

test("codeClip credentials create rejects invalid inputs and missing tokens", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();

  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-1",
          environment: "sandbox",
        },
        { queryClient: client, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );

  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-1",
          environment: "staging",
          accessToken: "x",
        },
        { queryClient: client, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );

  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-1",
          environment: "sandbox",
          accessToken: "x",
          metadata: { access_token: "nope" },
        },
        { queryClient: client, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );
});

test("codeClip credentials create fails closed without encryption keys", async () => {
  const client = createCredentialStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-1",
          environment: "sandbox",
          accessToken: "x",
        },
        { queryClient: client, env: {}, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "CREDENTIAL_ENCRYPTION_FAILED"
  );
});

test("codeClip credentials create conflict is explicit", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const input = {
    provider: "meta",
    providerAccountId: "page-dup",
    environment: "sandbox",
    accessToken: "a",
  };
  await createCodeClipProviderCredential(input, { queryClient: client, env, actor: SYSTEM_ACTOR });
  await assert.rejects(
    () => createCodeClipProviderCredential(input, { queryClient: client, env, actor: SYSTEM_ACTOR }),
    (error) => error.code === "CREDENTIAL_CONFLICT"
  );
});

test("codeClip credentials sandbox and production are separate uniqueness keys", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const base = {
    provider: "meta",
    providerAccountId: "page-shared",
    accessToken: "a",
  };
  const a = await createCodeClipProviderCredential(
    { ...base, environment: "sandbox" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const b = await createCodeClipProviderCredential(
    { ...base, environment: "production" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  assert.notEqual(a.credential.id, b.credential.id);
  assert.equal(client.rows.length, 2);
});

test("codeClip credentials get and find return safe rows or null", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-lookup-1",
      environment: "sandbox",
      accessToken: "secret",
      accessTokenExpiresAt: "2026-08-04T09:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const byId = await getCodeClipProviderCredentialById(created.credential.id, {
    queryClient: client,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  assertSafeCredential(byId);
  assert.equal(byId.expired, true);

  const found = await findCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-lookup-1",
      environment: "sandbox",
    },
    { queryClient: client, now: new Date("2026-08-04T08:00:00.000Z") }
  );
  assertSafeCredential(found);
  assert.equal(found.expired, false);

  assert.equal(
    await getCodeClipProviderCredentialById(99999, { queryClient: client }),
    null
  );
  assert.equal(
    await findCodeClipProviderCredential(
      {
        provider: "meta",
        providerAccountId: "missing",
        environment: "sandbox",
      },
      { queryClient: client }
    ),
    null
  );

  // Safe SQL never selects *
  for (const call of client.calls.filter((c) => /SELECT/.test(c.sql))) {
    assert.equal(/SELECT\s+\*/.test(call.sql), false);
    assert.equal(/access_token_envelope/.test(call.sql), false);
  }
});

test("codeClip credentials list filters cursor and limit without decrypt", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  for (let i = 0; i < 3; i += 1) {
    const created = await createCodeClipProviderCredential(
      {
        provider: "meta",
        providerAccountId: `page-list-${i}`,
        environment: "sandbox",
        accessToken: `tok-${i}`,
      },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    );
    // stagger updated_at for deterministic ordering in mock
    client.rows[i].updated_at = `2026-08-04T10:0${i}:00.000Z`;
    // keep created credential id mapping
    void created;
  }
  // also production row should be filterable out
  await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-list-prod",
      environment: "production",
      accessToken: "prod",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const page1 = await listCodeClipProviderCredentials(
    { environment: "sandbox", limit: 2 },
    { queryClient: client }
  );
  assert.equal(page1.items.length, 2);
  assert.equal(page1.page.hasMore, true);
  assert.ok(page1.page.nextCursor);
  page1.items.forEach(assertSafeCredential);

  const page2 = await listCodeClipProviderCredentials(
    { environment: "sandbox", limit: 2, cursor: page1.page.nextCursor },
    { queryClient: client }
  );
  assert.equal(page2.items.length, 1);
  assert.equal(page2.page.hasMore, false);

  const filtered = await listCodeClipProviderCredentials(
    { environment: "production", provider: "meta" },
    { queryClient: client }
  );
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].environment, "production");
});

test("codeClip credentials operator serializer defensive copies and strips raw fields", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-serialize",
      environment: "sandbox",
      accessToken: "s",
      scopes: ["a"],
      metadata: { k: 1 },
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const serialized = serializeCodeClipProviderCredentialForOperator(created.credential);
  assertSafeCredential(serialized);
  serialized.scopes.push("b");
  serialized.metadata.k = 9;
  assert.deepEqual(created.credential.scopes, ["a"]);
  assert.equal(created.credential.metadata.k, 1);

  // raw DB-like row projection
  const fromRaw = serializeCodeClipProviderCredentialForOperator({
    id: 1,
    vertical: "codeclip",
    provider: "meta",
    environment: "sandbox",
    provider_account_id: "page-raw",
    status: "active",
    token_type: null,
    scopes: [],
    has_access_token: true,
    has_refresh_token: false,
    access_token_expires_at: null,
    encryption_key_version: 1,
    reauthorization_reason: null,
    metadata: {},
    created_at: "2026-08-04T10:00:00.000Z",
    updated_at: "2026-08-04T10:00:00.000Z",
    disabled_at: null,
    revoked_at: null,
    last_refreshed_at: null,
  });
  assertSafeCredential(fromRaw);
  assert.equal(Object.hasOwn(fromRaw, "provider_account_id"), false);

  assert.equal(serializeCodeClipProviderCredentialForOperator(null), null);
});

test("codeClip credentials require query client", async () => {
  await assert.rejects(
    () =>
      createCodeClipProviderCredential({
        provider: "meta",
        providerAccountId: "x",
        environment: "sandbox",
        accessToken: "a",
      }),
    (error) => error.code === "DATABASE_UNAVAILABLE"
  );
});

// ---------------------------------------------------------------------------
// F1C2B2A: token update + transaction contract
// ---------------------------------------------------------------------------

test("codeClip credentials token update pool path owns BEGIN COMMIT and releases client", async () => {
  const env = makeCryptoEnv({ versions: [1], activeVersion: 1 });
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-update-1",
      environment: "sandbox",
      accessToken: "access-old",
      refreshToken: "refresh-keep",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  const beforeTxCalls = pool.calls.length;
  const updated = await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    {
      accessToken: "access-new",
      accessTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      scopes: ["pages_messaging", "public_profile"],
    },
    { queryClient: pool, env, now: new Date("2026-08-04T12:00:00.000Z"), actor: SYSTEM_ACTOR }
  );

  assert.equal(updated.status, "updated");
  assertSafeCredential(updated.credential);
  assert.equal(updated.credential.hasAccessToken, true);
  assert.equal(updated.credential.hasRefreshToken, true);
  assert.deepEqual(updated.credential.scopes, ["pages_messaging", "public_profile"]);
  assert.equal(JSON.stringify(updated).includes("access-new"), false);
  assert.equal(JSON.stringify(updated).includes("refresh-keep"), false);

  const stored = pool.rows[0];
  const access = decryptCodeClipProviderCredentialSecret({
    envelope: stored.access_token_envelope,
    env,
  });
  const refresh = decryptCodeClipProviderCredentialSecret({
    envelope: stored.refresh_token_envelope,
    env,
  });
  assert.equal(access.plaintext, "access-new");
  assert.equal(refresh.plaintext, "refresh-keep");

  const txCalls = pool.calls.slice(beforeTxCalls);
  assert.equal(txCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), true);
  assert.equal(txCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), true);
  assert.equal(txCalls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
  assert.equal(txCalls.some((c) => /FOR UPDATE/i.test(c.sql)), true);
  assert.equal(txCalls.some((c) => /UPDATE codeclip_provider_credentials/i.test(c.sql)), true);
  assert.equal(pool.released, 1);
  assert.equal(
    txCalls.some((c) => /INSERT INTO codeclip_provider_credential_audit/i.test(c.sql)),
    true
  );
  const audit = auditInserts(pool).at(-1);
  assert.equal(audit.params[4], "token_updated");
  assertNoSecretsInAuditParams(audit.params);
});

test("codeClip credentials token update pool path rolls back on decrypt failure and releases", async () => {
  const key1 = keyB64();
  const key2 = keyB64();
  const envCreate = {
    [ENV_KEYS]: `1:${key1}`,
    [ENV_ACTIVE]: "1",
  };
  const envUpdate = {
    [ENV_KEYS]: `2:${key2}`,
    [ENV_ACTIVE]: "2",
  };
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-missing-old-key",
      environment: "sandbox",
      accessToken: "a1",
      refreshToken: "r1",
    },
    { queryClient: pool.store, env: envCreate, actor: SYSTEM_ACTOR }
  );

  const beforeTxCalls = pool.calls.length;
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "a2" },
        { queryClient: pool, env: envUpdate, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "CREDENTIAL_DECRYPTION_FAILED"
  );

  const txCalls = pool.calls.slice(beforeTxCalls);
  assert.equal(txCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), true);
  assert.equal(txCalls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), true);
  assert.equal(txCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), false);
  assert.equal(pool.released, 1);
  assert.equal(pool.rows[0].encryption_key_version, 1);
  assert.equal(
    decryptCodeClipProviderCredentialSecret({
      envelope: pool.rows[0].access_token_envelope,
      env: envCreate,
    }).plaintext,
    "a1"
  );
});

test("codeClip credentials token update caller-owned client does not BEGIN COMMIT or ROLLBACK", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-caller-owned",
      environment: "sandbox",
      accessToken: "old",
      refreshToken: "keep",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const before = client.calls.length;
  const updated = await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "new" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  assert.equal(updated.status, "updated");
  const updateCalls = client.calls.slice(before);
  assert.equal(updateCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), false);
  assert.equal(updateCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), false);
  assert.equal(updateCalls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
  assert.equal(updateCalls.some((c) => /FOR UPDATE/i.test(c.sql)), true);
  assert.equal(updateCalls.some((c) => /UPDATE codeclip_provider_credentials/i.test(c.sql)), true);
  // Same mock client instance used for lock + update (caller-owned path)
  assert.equal(
    decryptCodeClipProviderCredentialSecret({
      envelope: client.rows[0].access_token_envelope,
      env,
    }).plaintext,
    "new"
  );
  assert.equal(
    decryptCodeClipProviderCredentialSecret({
      envelope: client.rows[0].refresh_token_envelope,
      env,
    }).plaintext,
    "keep"
  );
});

test("codeClip credentials token update re-encrypts full set to active key version", async () => {
  const key1 = keyB64();
  const key2 = keyB64();
  const envV1 = {
    [ENV_KEYS]: `1:${key1};2:${key2}`,
    [ENV_ACTIVE]: "1",
  };
  const envV2 = {
    [ENV_KEYS]: `1:${key1};2:${key2}`,
    [ENV_ACTIVE]: "2",
  };
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "youtube",
      providerAccountId: "UCabcdefghijklmnopqrstuv",
      environment: "production",
      accessToken: "access-v1",
      refreshToken: "refresh-v1",
    },
    { queryClient: pool.store, env: envV1, actor: SYSTEM_ACTOR }
  );
  assert.equal(created.credential.encryptionKeyVersion, 1);
  assert.match(pool.rows[0].access_token_envelope, /^v1\.1\./);

  const updated = await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "access-v2" },
    { queryClient: pool, env: envV2, actor: SYSTEM_ACTOR }
  );
  assert.equal(updated.credential.encryptionKeyVersion, 2);
  assert.match(pool.rows[0].access_token_envelope, /^v1\.2\./);
  assert.match(pool.rows[0].refresh_token_envelope, /^v1\.2\./);

  const access = decryptCodeClipProviderCredentialSecret({
    envelope: pool.rows[0].access_token_envelope,
    env: envV2,
  });
  const refresh = decryptCodeClipProviderCredentialSecret({
    envelope: pool.rows[0].refresh_token_envelope,
    env: envV2,
  });
  assert.equal(access.plaintext, "access-v2");
  assert.equal(refresh.plaintext, "refresh-v1");
});

test("codeClip credentials token update rejects empty patch and null token clearing", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-reject-patch",
      environment: "sandbox",
      accessToken: "a",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { metadata: { x: 1 } },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { scopes: ["a"] },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: null },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_CREDENTIAL_INPUT"
  );
});

test("codeClip credentials token update rejects disabled and revoked", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-status-gate",
      environment: "sandbox",
      accessToken: "a",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  pool.rows[0].status = "disabled";
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "b" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_STATUS_FOR_TOKEN_UPDATE"
  );

  pool.rows[0].status = "revoked";
  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "b" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_STATUS_FOR_TOKEN_UPDATE"
  );
});

test("codeClip credentials token update recovers reauthorization_required to active", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-reauth",
      environment: "sandbox",
      accessToken: "old",
      refreshToken: "r",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );
  pool.rows[0].status = "reauthorization_required";
  pool.rows[0].reauthorization_reason = "provider_revoked";

  const updated = await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "fresh", refreshToken: "r2" },
    { queryClient: pool, env, actor: SYSTEM_ACTOR }
  );
  assert.equal(updated.credential.status, "active");
  assert.equal(updated.credential.reauthorizationRequired, false);
  assert.equal(updated.credential.reauthorizationReason, null);
  assert.equal(pool.rows[0].status, "active");
  assert.equal(pool.rows[0].reauthorization_reason, null);
});

test("codeClip credentials token update not found and race status guard", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();

  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        999,
        { accessToken: "x" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "CREDENTIAL_NOT_FOUND"
  );

  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-race",
      environment: "sandbox",
      accessToken: "a",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  const originalQuery = pool.store.query.bind(pool.store);
  let locked = false;
  pool.store.query = async (sql, params) => {
    const result = await originalQuery(sql, params);
    if (/FOR UPDATE/i.test(sql)) {
      locked = true;
      pool.rows[0].status = "disabled";
    }
    return result;
  };

  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "b" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (error) => error.code === "INVALID_STATUS_FOR_TOKEN_UPDATE"
  );
  assert.equal(locked, true);
  pool.store.query = originalQuery;
});

// ---------------------------------------------------------------------------
// F1C2B2B: secret-read + inspect
// ---------------------------------------------------------------------------

function assertNoSecretsInObject(value, forbiddenStrings = []) {
  const json = JSON.stringify(value);
  assert.equal(Object.hasOwn(value || {}, "access_token_envelope"), false);
  assert.equal(Object.hasOwn(value || {}, "refresh_token_envelope"), false);
  assert.equal(Object.hasOwn(value || {}, "provider_account_id"), false);
  assert.equal(Object.hasOwn(value || {}, "providerAccountId"), false);
  for (const s of forbiddenStrings) {
    assert.equal(json.includes(s), false, `must not contain ${s}`);
  }
}

test("codeClip credentials secret-read provider_api returns access only", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-secret-api",
      environment: "sandbox",
      accessToken: "access-secret-value",
      refreshToken: "refresh-secret-value",
      tokenType: "Bearer",
      accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const result = await getCodeClipProviderCredentialSecretsForUse(
    {
      id: created.credential.id,
      purpose: "provider_api",
      now: new Date("2026-08-04T12:00:00.000Z"),
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  assert.equal(result.ok, true);
  assert.equal(result.purpose, "provider_api");
  assert.equal(result.accessToken, "access-secret-value");
  assert.equal(Object.hasOwn(result, "refreshToken"), false);
  assert.deepEqual(result.credential, {
    id: created.credential.id,
    provider: "meta",
    environment: "sandbox",
    tokenType: "Bearer",
    accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    expired: false,
  });
  assert.equal(JSON.stringify(result).includes("refresh-secret-value"), false);

  const secretSql = client.calls.filter(
    (c) => /access_token_envelope/.test(c.sql) && /SELECT/i.test(c.sql)
  );
  assert.ok(secretSql.length >= 1);
  for (const call of secretSql) {
    assert.equal(/SELECT\s+\*/i.test(call.sql), false);
    assert.equal(/refresh_token_envelope/.test(call.sql), false);
    assert.equal(/provider_account_id/.test(call.sql), false);
  }
});

test("codeClip credentials secret-read provider_api status and expiry gates", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-api-gates",
      environment: "sandbox",
      accessToken: "a",
      refreshToken: "r",
      accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      {
        id: created.credential.id,
        purpose: "provider_api",
        now: new Date("2026-08-04T12:00:00.000Z"),
      },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "TOKEN_EXPIRED" }
  );

  client.rows[0].status = "reauthorization_required";
  client.rows[0].access_token_expires_at = "2026-12-01T00:00:00.000Z";
  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose: "provider_api" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "REAUTHORIZATION_REQUIRED" }
  );

  client.rows[0].status = "disabled";
  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose: "provider_api" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "CREDENTIAL_NOT_USABLE" }
  );

  client.rows[0].status = "revoked";
  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose: "provider_api" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "CREDENTIAL_NOT_USABLE" }
  );

  client.rows[0].status = "active";
  client.rows[0].has_access_token = false;
  client.rows[0].access_token_envelope = null;
  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose: "provider_api" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "TOKEN_NOT_PRESENT" }
  );
});

test("codeClip credentials secret-read refresh returns refresh only", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-secret-refresh",
      environment: "sandbox",
      accessToken: "access-hidden",
      refreshToken: "refresh-visible",
      accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const active = await getCodeClipProviderCredentialSecretsForUse(
    {
      id: created.credential.id,
      purpose: "refresh",
      now: new Date("2026-08-04T12:00:00.000Z"),
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  assert.equal(active.ok, true);
  assert.equal(active.purpose, "refresh");
  assert.equal(active.refreshToken, "refresh-visible");
  assert.equal(Object.hasOwn(active, "accessToken"), false);
  assert.equal(JSON.stringify(active).includes("access-hidden"), false);
  assert.equal(active.credential.status, "active");
  assert.equal(active.credential.hasAccessToken, true);
  assert.equal(active.credential.expired, true);

  client.rows[0].status = "reauthorization_required";
  const reauth = await getCodeClipProviderCredentialSecretsForUse(
    { id: created.credential.id, purpose: "refresh" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  assert.equal(reauth.ok, true);
  assert.equal(reauth.refreshToken, "refresh-visible");
  assert.equal(reauth.credential.status, "reauthorization_required");

  client.rows[0].status = "disabled";
  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose: "refresh" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "CREDENTIAL_NOT_USABLE" }
  );

  const refreshSql = client.calls.filter(
    (c) => /refresh_token_envelope/.test(c.sql) && /SELECT/i.test(c.sql)
  );
  assert.ok(refreshSql.length >= 1);
  for (const call of refreshSql) {
    assert.equal(/access_token_envelope/.test(call.sql), false);
    assert.equal(/SELECT\s+\*/i.test(call.sql), false);
  }
});

test("codeClip credentials secret-read rejects invalid purposes and not found", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-purpose",
      environment: "sandbox",
      accessToken: "a",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  for (const purpose of [undefined, "", "validation", "debug", "VALIDATION"]) {
    const result = await getCodeClipProviderCredentialSecretsForUse(
      { id: created.credential.id, purpose },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    );
    assert.deepEqual(result, { ok: false, reason: "INVALID_SECRET_PURPOSE" });
  }

  assert.deepEqual(
    await getCodeClipProviderCredentialSecretsForUse(
      { id: 99999, purpose: "provider_api" },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    ),
    { ok: false, reason: "CREDENTIAL_NOT_FOUND" }
  );
});

test("codeClip credentials secret-read decrypt failure is fail-closed", async () => {
  const envCreate = makeCryptoEnv({ versions: [1], activeVersion: 1 });
  const envWrong = makeCryptoEnv({ versions: [2], activeVersion: 2 });
  const client = createCredentialStoreClient();
  const accessPlain = "access-plain-unique-xyz";
  const refreshPlain = "refresh-plain-unique-xyz";
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-decrypt-fail",
      environment: "sandbox",
      accessToken: accessPlain,
      refreshToken: refreshPlain,
      accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    },
    { queryClient: client, env: envCreate, actor: SYSTEM_ACTOR }
  );

  const api = await getCodeClipProviderCredentialSecretsForUse(
    { id: created.credential.id, purpose: "provider_api" },
    { queryClient: client, env: envWrong }
  );
  assert.deepEqual(api, { ok: false, reason: "CREDENTIAL_DECRYPTION_FAILED" });
  assertNoSecretsInObject(api, [accessPlain, refreshPlain]);

  const refresh = await getCodeClipProviderCredentialSecretsForUse(
    { id: created.credential.id, purpose: "refresh" },
    { queryClient: client, env: envWrong }
  );
  assert.deepEqual(refresh, { ok: false, reason: "CREDENTIAL_DECRYPTION_FAILED" });
  assertNoSecretsInObject(refresh, [accessPlain, refreshPlain]);
});

test("codeClip credentials inspect usability without decrypt or encryption env", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-inspect",
      environment: "sandbox",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const beforeCalls = client.calls.length;
  const inspection = await inspectCodeClipProviderCredentialUsability(
    {
      id: created.credential.id,
      now: new Date("2026-08-04T12:00:00.000Z"),
    },
    { queryClient: client }
  );

  assert.deepEqual(inspection, {
    id: created.credential.id,
    provider: "meta",
    environment: "sandbox",
    status: "active",
    hasAccessToken: true,
    hasRefreshToken: true,
    accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    expired: false,
    reauthorizationRequired: false,
    usableForProviderApi: true,
    usableForRefresh: true,
  });
  assert.equal(Object.hasOwn(inspection, "maskedAccountId"), false);
  assert.equal(Object.hasOwn(inspection, "metadata"), false);
  assert.equal(Object.hasOwn(inspection, "scopes"), false);
  assert.equal(JSON.stringify(inspection).includes("secret-access"), false);

  const inspectCalls = client.calls.slice(beforeCalls);
  assert.ok(inspectCalls.length >= 1);
  for (const call of inspectCalls) {
    assert.equal(/access_token_envelope/.test(call.sql), false);
    assert.equal(/refresh_token_envelope/.test(call.sql), false);
    assert.equal(/provider_account_id/.test(call.sql), false);
    assert.equal(/SELECT\s+\*/i.test(call.sql), false);
    assert.equal(/metadata/.test(call.sql), false);
  }

  // expired
  client.rows[0].access_token_expires_at = "2026-08-01T00:00:00.000Z";
  const expired = await inspectCodeClipProviderCredentialUsability(
    {
      id: created.credential.id,
      now: new Date("2026-08-04T12:00:00.000Z"),
    },
    { queryClient: client }
  );
  assert.equal(expired.expired, true);
  assert.equal(expired.usableForProviderApi, false);
  assert.equal(expired.usableForRefresh, true);

  client.rows[0].status = "reauthorization_required";
  client.rows[0].access_token_expires_at = "2026-12-01T00:00:00.000Z";
  const reauth = await inspectCodeClipProviderCredentialUsability(
    { id: created.credential.id },
    { queryClient: client }
  );
  assert.equal(reauth.reauthorizationRequired, true);
  assert.equal(reauth.usableForProviderApi, false);
  assert.equal(reauth.usableForRefresh, true);

  client.rows[0].status = "disabled";
  const disabled = await inspectCodeClipProviderCredentialUsability(
    { id: created.credential.id },
    { queryClient: client }
  );
  assert.equal(disabled.usableForProviderApi, false);
  assert.equal(disabled.usableForRefresh, false);

  assert.equal(
    await inspectCodeClipProviderCredentialUsability(
      { id: 99999 },
      { queryClient: client }
    ),
    null
  );
});

// ---------------------------------------------------------------------------
// F1C2C2: atomic mutation audit + status lifecycle
// ---------------------------------------------------------------------------

test("codeClip credentials public exports include status setter and no audit re-exports", () => {
  const mod = require("./verticals/codeclip/provider-credentials");
  assert.deepEqual(
    Object.keys(mod).sort(),
    [
      "CodeClipProviderCredentialError",
      "createCodeClipProviderCredential",
      "findCodeClipProviderCredential",
      "getCodeClipProviderCredentialById",
      "getCodeClipProviderCredentialSecretsForUse",
      "inspectCodeClipProviderCredentialUsability",
      "listCodeClipProviderCredentials",
      "serializeCodeClipProviderCredentialForOperator",
      "setCodeClipProviderCredentialStatus",
      "updateCodeClipProviderCredentialTokens",
    ].sort()
  );
  assert.equal(Object.hasOwn(mod, "appendCodeClipProviderCredentialAudit"), false);
  assert.equal(Object.hasOwn(mod, "listCodeClipProviderCredentialAudit"), false);
});

test("codeClip credentials create requires actor and writes created audit", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const operationNow = "2026-08-04T15:30:00.000Z";

  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-no-actor",
          environment: "sandbox",
          accessToken: "tok",
        },
        { queryClient: client, env }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );

  const result = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-create-audit",
      environment: "sandbox",
      accessToken: "access-secret-token",
      scopes: ["pages_messaging"],
    },
    {
      queryClient: client,
      env,
      actor: OPERATOR_ACTOR,
      now: operationNow,
    }
  );

  assert.equal(result.status, "created");
  assert.equal(result.created, true);
  assertSafeCredential(result.credential);
  assert.equal(result.credential.updatedAt, operationNow);

  const inserts = auditInserts(client);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[4], "created");
  assert.equal(inserts[0].params[5], "operator");
  assert.equal(inserts[0].params[6], "admin.user-1");
  assert.equal(inserts[0].params[7], "credential_created");
  assert.equal(inserts[0].params[8], null);
  assert.ok(inserts[0].params[9]);
  const after = JSON.parse(inserts[0].params[9]);
  assert.equal(after.status, "active");
  assert.equal(Object.hasOwn(after, "provider_account_id"), false);
  assert.equal(JSON.stringify(after).includes("page-create-audit"), false);
  assert.equal(JSON.stringify(after).includes("access-secret-token"), false);
  assertNoSecretsInAuditParams(inserts[0].params);
});

test("codeClip credentials create custom reason and conflict writes no audit", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const input = {
    provider: "meta",
    providerAccountId: "page-create-conflict",
    environment: "sandbox",
    accessToken: "a",
  };

  await createCodeClipProviderCredential(input, {
    queryClient: client,
    env,
    actor: SYSTEM_ACTOR,
    reason: "operator_onboarded",
  });
  assert.equal(client.auditRows[0].reason_code, "operator_onboarded");
  assert.equal(client.auditRows[0].action, "created");
  const auditCount = client.auditRows.length;

  await assert.rejects(
    () =>
      createCodeClipProviderCredential(input, {
        queryClient: client,
        env,
        actor: SYSTEM_ACTOR,
      }),
    (e) => e.code === "CREDENTIAL_CONFLICT"
  );
  assert.equal(client.auditRows.length, auditCount);
});

test("codeClip credentials create encryption failure starts no TX or audit", async () => {
  const client = createCredentialStoreClient();
  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-enc-fail",
          environment: "sandbox",
          accessToken: "x",
        },
        { queryClient: client, env: {}, actor: SYSTEM_ACTOR }
      ),
    (e) => e.code === "CREDENTIAL_ENCRYPTION_FAILED"
  );
  assert.equal(client.rows.length, 0);
  assert.equal(client.auditRows.length, 0);
  assert.equal(
    client.calls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())),
    false
  );
});

test("codeClip credentials create audit failure rolls back insert on pool path", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool({ failAudit: true });
  await assert.rejects(
    () =>
      createCodeClipProviderCredential(
        {
          provider: "meta",
          providerAccountId: "page-audit-fail-create",
          environment: "sandbox",
          accessToken: "tok",
        },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (e) =>
      e instanceof CodeClipProviderCredentialError &&
      e.code === "CREDENTIAL_AUDIT_FAILED"
  );
  assert.equal(pool.released, 1);
  assert.equal(
    pool.calls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())),
    true
  );
  assert.equal(JSON.stringify(pool.calls.at(-1) || {}).includes("access-secret"), false);
});

test("codeClip credentials create pool ownership includes audit before commit", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-create-pool",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: pool, env, actor: SYSTEM_ACTOR }
  );
  const sqls = pool.calls.map((c) => String(c.sql).trim());
  const beginIdx = sqls.findIndex((s) => /^\s*BEGIN/i.test(s));
  const insertIdx = sqls.findIndex((s) =>
    /INSERT INTO codeclip_provider_credentials/i.test(s)
  );
  const auditIdx = sqls.findIndex((s) =>
    /INSERT INTO codeclip_provider_credential_audit/i.test(s)
  );
  const commitIdx = sqls.findIndex((s) => /^\s*COMMIT/i.test(s));
  assert.ok(beginIdx >= 0 && insertIdx > beginIdx);
  assert.ok(auditIdx > insertIdx);
  assert.ok(commitIdx > auditIdx);
  assert.equal(pool.released, 1);
});

test("codeClip credentials token update requires actor and writes token_updated audit", async () => {
  const env = makeCryptoEnv({ versions: [1, 2], activeVersion: 1 });
  const client = createCredentialStoreClient();
  const operationNow = "2026-08-04T16:00:00.000Z";
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-token-audit",
      environment: "sandbox",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: "2026-09-01T00:00:00.000Z",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "new-access" },
        { queryClient: client, env }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );

  const envV2 = {
    [ENV_KEYS]: env[ENV_KEYS],
    [ENV_ACTIVE]: "2",
  };
  // Recreate key material for v2 - use same makeCryptoEnv pattern
  const key1 = keyB64();
  const key2 = keyB64();
  const envCreate = {
    [ENV_KEYS]: `1:${key1};2:${key2}`,
    [ENV_ACTIVE]: "1",
  };
  const envUpdate = {
    [ENV_KEYS]: `1:${key1};2:${key2}`,
    [ENV_ACTIVE]: "2",
  };
  const client2 = createCredentialStoreClient();
  const created2 = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-token-audit-2",
      environment: "sandbox",
      accessToken: "old-access",
      refreshToken: "old-refresh",
    },
    { queryClient: client2, env: envCreate, actor: SYSTEM_ACTOR }
  );

  const updated = await updateCodeClipProviderCredentialTokens(
    created2.credential.id,
    {
      accessToken: "new-access-token-value",
      accessTokenExpiresAt: "2026-11-01T00:00:00.000Z",
    },
    {
      queryClient: client2,
      env: envUpdate,
      actor: OPERATOR_ACTOR,
      reason: "operator_rotated_tokens",
      now: operationNow,
    }
  );

  assert.equal(updated.status, "updated");
  assert.equal(updated.credential.encryptionKeyVersion, 2);
  assert.equal(updated.credential.accessTokenExpiresAt, "2026-11-01T00:00:00.000Z");
  assert.equal(updated.credential.updatedAt, operationNow);
  assert.equal(updated.credential.lastRefreshedAt, operationNow);

  const tokenAudits = client2.auditRows.filter((a) => a.action === "token_updated");
  assert.equal(tokenAudits.length, 1);
  assert.equal(tokenAudits[0].reason_code, "operator_rotated_tokens");
  assert.equal(tokenAudits[0].actor_type, "operator");
  assert.ok(tokenAudits[0].before_state);
  assert.ok(tokenAudits[0].after_state);
  assert.equal(tokenAudits[0].before_state.encryptionKeyVersion, 1);
  assert.equal(tokenAudits[0].after_state.encryptionKeyVersion, 2);
  assert.equal(
    JSON.stringify(tokenAudits[0]).includes("new-access-token-value"),
    false
  );
  assert.equal(
    JSON.stringify(tokenAudits[0]).includes("old-access"),
    false
  );
  const auditCall = auditInserts(client2).at(-1);
  assertNoSecretsInAuditParams(auditCall.params);
});

test("codeClip credentials token update reauth recovery appears in audit before/after", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-reauth-audit",
      environment: "sandbox",
      accessToken: "a",
      refreshToken: "r",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  client.rows[0].status = "reauthorization_required";
  client.rows[0].reauthorization_reason = "provider_revoked";

  await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "fresh" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const audit = client.auditRows.find((a) => a.action === "token_updated");
  assert.equal(audit.before_state.status, "reauthorization_required");
  assert.equal(audit.before_state.reauthorizationReason, "provider_revoked");
  assert.equal(audit.after_state.status, "active");
  assert.equal(audit.after_state.reauthorizationReason, null);
});

test("codeClip credentials token update audit failure rolls back on pool path", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-token-audit-fail",
      environment: "sandbox",
      accessToken: "a1",
      refreshToken: "r1",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );
  const envelopeBefore = pool.rows[0].access_token_envelope;

  // Fail only subsequent audit inserts (after create already audited)
  const originalQuery = pool.store.query.bind(pool.store);
  pool.store.query = async (sql, params) => {
    if (/INSERT INTO codeclip_provider_credential_audit/.test(sql)) {
      // allow create audit already done; fail token update audit
      if (pool.store.auditRows.length >= 1) {
        throw new Error("forced audit failure");
      }
    }
    return originalQuery(sql, params);
  };

  await assert.rejects(
    () =>
      updateCodeClipProviderCredentialTokens(
        created.credential.id,
        { accessToken: "a2" },
        { queryClient: pool, env, actor: SYSTEM_ACTOR }
      ),
    (e) => e.code === "CREDENTIAL_AUDIT_FAILED"
  );
  assert.equal(
    pool.calls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())),
    true
  );
  assert.equal(pool.released >= 1, true);
});

test("codeClip credentials token update caller-client has no nested TX and writes audit", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-token-caller",
      environment: "sandbox",
      accessToken: "a",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const before = client.calls.length;
  await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "b" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const txCalls = client.calls.slice(before);
  assert.equal(txCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), false);
  assert.equal(txCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), false);
  assert.equal(txCalls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
  assert.equal(
    txCalls.some((c) => /INSERT INTO codeclip_provider_credential_audit/i.test(c.sql)),
    true
  );
});

test("codeClip credentials status setter allows all permitted transitions with timestamps", async () => {
  const env = makeCryptoEnv();
  const operationNow = "2026-08-04T18:00:00.000Z";

  async function seed(accountId) {
    const client = createCredentialStoreClient();
    const created = await createCodeClipProviderCredential(
      {
        provider: "meta",
        providerAccountId: accountId,
        environment: "sandbox",
        accessToken: "tok",
      },
      { queryClient: client, env, actor: SYSTEM_ACTOR }
    );
    return { client, id: created.credential.id };
  }

  // active -> disabled
  {
    const { client, id } = await seed("page-st-disabled");
    const result = await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "disabled",
        reason: "operator_disabled",
        actor: OPERATOR_ACTOR,
        now: operationNow,
      },
      { queryClient: client }
    );
    assert.equal(result.status, "updated");
    assert.equal(result.credential.status, "disabled");
    assert.equal(result.credential.disabledAt, operationNow);
    assert.equal(result.credential.updatedAt, operationNow);
    const audit = client.auditRows.at(-1);
    assert.equal(audit.action, "disabled");
    assert.equal(audit.before_state.status, "active");
    assert.equal(audit.after_state.status, "disabled");
  }

  // disabled -> active (reactivated)
  {
    const { client, id } = await seed("page-st-reactivate");
    await setCodeClipProviderCredentialStatus(
      id,
      { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR, now: operationNow },
      { queryClient: client }
    );
    const result = await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "active",
        reason: "operator_reactivated",
        actor: SYSTEM_ACTOR,
        now: "2026-08-04T19:00:00.000Z",
      },
      { queryClient: client }
    );
    assert.equal(result.credential.status, "active");
    assert.equal(result.credential.disabledAt, null);
    assert.equal(result.credential.updatedAt, "2026-08-04T19:00:00.000Z");
    assert.equal(client.auditRows.at(-1).action, "reactivated");
  }

  // active -> reauthorization_required
  {
    const { client, id } = await seed("page-st-reauth");
    const result = await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "reauthorization_required",
        reason: "token_invalid_detected",
        actor: SYSTEM_ACTOR,
        now: operationNow,
      },
      { queryClient: client }
    );
    assert.equal(result.credential.status, "reauthorization_required");
    assert.equal(result.credential.reauthorizationReason, "token_invalid_detected");
    assert.equal(client.auditRows.at(-1).action, "reauthorization_required");
  }

  // reauthorization_required -> disabled
  {
    const { client, id } = await seed("page-st-reauth-dis");
    await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "reauthorization_required",
        reason: "token_invalid_detected",
        actor: SYSTEM_ACTOR,
        now: operationNow,
      },
      { queryClient: client }
    );
    const result = await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "disabled",
        reason: "operator_disabled",
        actor: SYSTEM_ACTOR,
        now: "2026-08-04T20:00:00.000Z",
      },
      { queryClient: client }
    );
    assert.equal(result.credential.status, "disabled");
    assert.equal(result.credential.reauthorizationReason, null);
    assert.equal(result.credential.disabledAt, "2026-08-04T20:00:00.000Z");
    assert.equal(client.auditRows.at(-1).action, "disabled");
  }

  // * -> revoked from active, reauth, disabled
  for (const [label, setup] of [
    ["from-active", async (client, id) => {}],
    [
      "from-reauth",
      async (client, id) => {
        await setCodeClipProviderCredentialStatus(
          id,
          {
            status: "reauthorization_required",
            reason: "token_invalid_detected",
            actor: SYSTEM_ACTOR,
            now: operationNow,
          },
          { queryClient: client }
        );
      },
    ],
    [
      "from-disabled",
      async (client, id) => {
        await setCodeClipProviderCredentialStatus(
          id,
          {
            status: "disabled",
            reason: "operator_disabled",
            actor: SYSTEM_ACTOR,
            now: operationNow,
          },
          { queryClient: client }
        );
      },
    ],
  ]) {
    const { client, id } = await seed(`page-st-revoked-${label}`);
    await setup(client, id);
    const result = await setCodeClipProviderCredentialStatus(
      id,
      {
        status: "revoked",
        reason: "operator_revoked",
        actor: OPERATOR_ACTOR,
        now: "2026-08-04T21:00:00.000Z",
      },
      { queryClient: client }
    );
    assert.equal(result.credential.status, "revoked", label);
    assert.equal(result.credential.revokedAt, "2026-08-04T21:00:00.000Z", label);
    assert.equal(result.credential.disabledAt, null, label);
    assert.equal(result.credential.reauthorizationReason, null, label);
    assert.equal(client.auditRows.at(-1).action, "revoked", label);
  }
});

test("codeClip credentials status setter rejects forbidden transitions", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-forbidden",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const id = created.credential.id;

  // same-state
  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        id,
        { status: "active", reason: "noop", actor: SYSTEM_ACTOR },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_STATUS_TRANSITION"
  );

  // reauth -> active via status setter
  await setCodeClipProviderCredentialStatus(
    id,
    {
      status: "reauthorization_required",
      reason: "token_invalid_detected",
      actor: SYSTEM_ACTOR,
    },
    { queryClient: client }
  );
  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        id,
        { status: "active", reason: "should_fail", actor: SYSTEM_ACTOR },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_STATUS_TRANSITION"
  );

  // disabled -> reauthorization_required
  await setCodeClipProviderCredentialStatus(
    id,
    { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
    { queryClient: client }
  );
  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        id,
        {
          status: "reauthorization_required",
          reason: "should_fail",
          actor: SYSTEM_ACTOR,
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_STATUS_TRANSITION"
  );

  // revoked is terminal
  await setCodeClipProviderCredentialStatus(
    id,
    { status: "revoked", reason: "operator_revoked", actor: SYSTEM_ACTOR },
    { queryClient: client }
  );
  for (const status of ["active", "disabled", "reauthorization_required"]) {
    await assert.rejects(
      () =>
        setCodeClipProviderCredentialStatus(
          id,
          { status, reason: "should_fail", actor: SYSTEM_ACTOR },
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_STATUS_TRANSITION",
      status
    );
  }
});

test("codeClip credentials status setter requires actor and reason", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-required",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        created.credential.id,
        { status: "disabled", reason: "operator_disabled" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        created.credential.id,
        { status: "disabled", actor: SYSTEM_ACTOR },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_INPUT"
  );
});

test("codeClip credentials status setter not found and status race", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();

  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        99999,
        { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
        { queryClient: client }
      ),
    (e) => e.code === "CREDENTIAL_NOT_FOUND"
  );

  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-race",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );

  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    const result = await originalQuery(sql, params);
    if (/FOR UPDATE/i.test(sql) && /codeclip_provider_credentials/i.test(sql)) {
      client.rows[0].status = "revoked";
    }
    return result;
  };

  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        created.credential.id,
        { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
        { queryClient: client }
      ),
    (e) =>
      e.code === "INVALID_STATUS_TRANSITION" || e.code === "CREDENTIAL_STATUS_RACE"
  );
  client.query = originalQuery;
});

test("codeClip credentials status setter audit failure rolls back on pool path", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-audit-fail",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  const originalQuery = pool.store.query.bind(pool.store);
  pool.store.query = async (sql, params) => {
    if (
      /INSERT INTO codeclip_provider_credential_audit/.test(sql) &&
      pool.store.auditRows.length >= 1
    ) {
      throw new Error("forced status audit failure");
    }
    return originalQuery(sql, params);
  };

  await assert.rejects(
    () =>
      setCodeClipProviderCredentialStatus(
        created.credential.id,
        { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
        { queryClient: pool }
      ),
    (e) => e.code === "CREDENTIAL_AUDIT_FAILED"
  );
  assert.equal(
    pool.calls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())),
    true
  );
  assert.equal(pool.released >= 1, true);
});

test("codeClip credentials status setter pool and caller transaction ownership", async () => {
  const env = makeCryptoEnv();
  const pool = createCredentialStorePool();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-tx",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: pool.store, env, actor: SYSTEM_ACTOR }
  );

  const before = pool.calls.length;
  await setCodeClipProviderCredentialStatus(
    created.credential.id,
    { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
    { queryClient: pool }
  );
  const txCalls = pool.calls.slice(before);
  assert.equal(txCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), true);
  assert.equal(txCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), true);
  assert.equal(
    txCalls.some((c) => /INSERT INTO codeclip_provider_credential_audit/i.test(c.sql)),
    true
  );
  assert.equal(pool.released >= 1, true);

  // caller-owned client: no nested TX
  const client = createCredentialStoreClient();
  const created2 = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-st-caller",
      environment: "sandbox",
      accessToken: "tok",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  const before2 = client.calls.length;
  await setCodeClipProviderCredentialStatus(
    created2.credential.id,
    { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
    { queryClient: client }
  );
  const callerCalls = client.calls.slice(before2);
  assert.equal(callerCalls.some((c) => /^\s*BEGIN/i.test(String(c.sql).trim())), false);
  assert.equal(callerCalls.some((c) => /^\s*COMMIT/i.test(String(c.sql).trim())), false);
  assert.equal(callerCalls.some((c) => /^\s*ROLLBACK/i.test(String(c.sql).trim())), false);
});

test("codeClip credentials status and mutation audits never SELECT star or leak secrets", async () => {
  const env = makeCryptoEnv();
  const client = createCredentialStoreClient();
  const created = await createCodeClipProviderCredential(
    {
      provider: "meta",
      providerAccountId: "page-no-star",
      environment: "sandbox",
      accessToken: "super-secret-access",
      refreshToken: "super-secret-refresh",
    },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  await updateCodeClipProviderCredentialTokens(
    created.credential.id,
    { accessToken: "super-secret-access-2" },
    { queryClient: client, env, actor: SYSTEM_ACTOR }
  );
  await setCodeClipProviderCredentialStatus(
    created.credential.id,
    { status: "disabled", reason: "operator_disabled", actor: SYSTEM_ACTOR },
    { queryClient: client }
  );

  for (const call of client.calls) {
    assert.equal(/SELECT\s+\*/i.test(call.sql), false);
  }
  for (const call of auditInserts(client)) {
    assertNoSecretsInAuditParams(call.params);
    assert.equal(JSON.stringify(call.params).includes("super-secret"), false);
  }
  // secret-read does not write audit
  const auditCount = client.auditRows.length;
  await getCodeClipProviderCredentialSecretsForUse(
    { id: created.credential.id, purpose: "provider_api" },
    { queryClient: client, env }
  );
  assert.equal(client.auditRows.length, auditCount);
});
