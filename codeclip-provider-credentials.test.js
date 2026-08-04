const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CodeClipProviderCredentialError,
  createCodeClipProviderCredential,
  getCodeClipProviderCredentialById,
  findCodeClipProviderCredential,
  listCodeClipProviderCredentials,
  serializeCodeClipProviderCredentialForOperator,
} = require("./verticals/codeclip/provider-credentials");
const {
  decryptCodeClipProviderCredentialSecret,
} = require("./verticals/codeclip/provider-credential-crypto");

const ENV_KEYS = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS";
const ENV_ACTIVE = "CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION";

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

function createCredentialStoreClient() {
  const calls = [];
  const rows = [];
  let nextId = 1;

  function identityKey(row) {
    return [row.vertical, row.provider, row.environment, row.account_lookup_key].join("|");
  }

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });

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
          created_at: "2026-08-04T10:00:00.000Z",
          updated_at: "2026-08-04T10:00:00.000Z",
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
        return {
          rows: [
            {
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
            },
          ],
        };
      }

      if (/FROM codeclip_provider_credentials/.test(sql) && /WHERE id = \$1/.test(sql)) {
        const id = String(params[0]);
        const row = rows.find((item) => String(item.id) === id);
        if (!row) return { rows: [] };
        return {
          rows: [
            {
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
            },
          ],
        };
      }

      if (
        /FROM codeclip_provider_credentials/.test(sql) &&
        /account_lookup_key = \$4/.test(sql)
      ) {
        const key = [params[0], params[1], params[2], params[3]].join("|");
        const row = rows.find((item) => identityKey(item) === key);
        if (!row) return { rows: [] };
        return {
          rows: [
            {
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
            },
          ],
        };
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
        const page = filtered.slice(0, limit).map((row) => ({
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
        }));
        return { rows: page };
      }

      return { rows: [] };
    },
  };
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
    { queryClient: client, env }
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
    (call) => /SELECT/i.test(call.sql) || /RETURNING/i.test(call.sql)
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
    { queryClient: client, env }
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
    { queryClient: client, env }
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
        { queryClient: client, env }
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
        { queryClient: client, env }
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
        { queryClient: client, env }
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
        { queryClient: client, env }
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
        { queryClient: client, env }
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
        { queryClient: client, env: {} }
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
  await createCodeClipProviderCredential(input, { queryClient: client, env });
  await assert.rejects(
    () => createCodeClipProviderCredential(input, { queryClient: client, env }),
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
    { queryClient: client, env }
  );
  const b = await createCodeClipProviderCredential(
    { ...base, environment: "production" },
    { queryClient: client, env }
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
    { queryClient: client, env }
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
      { queryClient: client, env }
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
    { queryClient: client, env }
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
    { queryClient: client, env }
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
