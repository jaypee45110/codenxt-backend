const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderCredentialAuditError,
  appendCodeClipProviderCredentialAudit,
  listCodeClipProviderCredentialAudit,
} = require("./verticals/codeclip/provider-credential-audit");

function baseSnapshot(overrides = {}) {
  return {
    id: 1,
    provider: "meta",
    environment: "sandbox",
    status: "active",
    maskedAccountId: "••••••7890",
    hasAccessToken: true,
    hasRefreshToken: false,
    accessTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    encryptionKeyVersion: 1,
    tokenType: "Bearer",
    scopes: ["pages_messaging"],
    reauthorizationReason: null,
    disabledAt: null,
    revokedAt: null,
    lastRefreshedAt: null,
    updatedAt: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

function createdInput(overrides = {}) {
  return {
    credentialId: 1,
    provider: "meta",
    environment: "sandbox",
    action: "created",
    actor: { type: "system" },
    reason: "credential_created",
    beforeState: null,
    afterState: baseSnapshot(),
    ...overrides,
  };
}

function createAuditStoreClient(options = {}) {
  const calls = [];
  const rows = [];
  let nextId = 1;
  const failOn = options.failOn || null;

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (failOn === "insert" && /INSERT INTO codeclip_provider_credential_audit/.test(sql)) {
        const err = new Error("relation does not exist");
        err.code = "42P01";
        throw err;
      }
      if (failOn === "select" && /FROM codeclip_provider_credential_audit/.test(sql)) {
        const err = new Error("connection terminated unexpectedly");
        throw err;
      }

      if (/INSERT INTO codeclip_provider_credential_audit/.test(sql)) {
        const row = {
          id: nextId++,
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
          created_at: `2026-08-04T10:00:${String(nextId).padStart(2, "0")}.000Z`,
        };
        rows.push(row);
        return {
          rows: [
            {
              id: row.id,
              credential_id: row.credential_id,
              vertical: row.vertical,
              provider: row.provider,
              environment: row.environment,
              action: row.action,
              actor_type: row.actor_type,
              actor_id: row.actor_id,
              reason_code: row.reason_code,
              before_state: row.before_state,
              after_state: row.after_state,
              metadata: row.metadata,
              created_at: row.created_at,
            },
          ],
        };
      }

      if (/FROM codeclip_provider_credential_audit/.test(sql)) {
        assert.equal(/SELECT\s+\*/i.test(sql), false);
        let filtered = [...rows];
        let idx = 2;
        filtered = filtered.filter(
          (r) =>
            String(r.vertical) === String(params[0]) &&
            String(r.credential_id) === String(params[1])
        );
        if (/action = \$/.test(sql)) {
          filtered = filtered.filter((r) => r.action === params[idx]);
          idx += 1;
        }
        if (/created_at </.test(sql)) {
          const cursorCreatedAt = params[idx];
          const cursorId = params[idx + 1];
          idx += 2;
          filtered = filtered.filter((r) => {
            const t = Date.parse(r.created_at);
            const c = Date.parse(cursorCreatedAt);
            return t < c || (t === c && Number(r.id) < Number(cursorId));
          });
        }
        const limit = params[params.length - 1];
        filtered.sort((a, b) => {
          const ta = Date.parse(a.created_at);
          const tb = Date.parse(b.created_at);
          if (tb !== ta) return tb - ta;
          return Number(b.id) - Number(a.id);
        });
        return {
          rows: filtered.slice(0, limit).map((row) => ({
            id: row.id,
            credential_id: row.credential_id,
            vertical: row.vertical,
            provider: row.provider,
            environment: row.environment,
            action: row.action,
            actor_type: row.actor_type,
            actor_id: row.actor_id,
            reason_code: row.reason_code,
            before_state: row.before_state,
            after_state: row.after_state,
            metadata: row.metadata,
            created_at: row.created_at,
          })),
        };
      }

      return { rows: [] };
    },
  };
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

test("codeClip credential audit exports only public surface", () => {
  const mod = require("./verticals/codeclip/provider-credential-audit");
  assert.deepEqual(
    Object.keys(mod).sort(),
    [
      "CodeClipProviderCredentialAuditError",
      "appendCodeClipProviderCredentialAudit",
      "listCodeClipProviderCredentialAudit",
    ].sort()
  );
});

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

test("codeClip credential audit actor contract", async () => {
  const client = createAuditStoreClient();
  const after = baseSnapshot();

  const cases = [
    {
      name: "operator without id",
      actor: { type: "operator" },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "operator invalid id",
      actor: { type: "operator", id: "Bad Actor!" },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "operator empty id",
      actor: { type: "operator", id: "   " },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "operator_key with id",
      actor: { type: "operator_key", id: "key-1" },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "system invalid id",
      actor: { type: "system", id: "Bad System!" },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "unknown actor type",
      actor: { type: "robot" },
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
    {
      name: "missing actor",
      actor: null,
      code: "INVALID_CREDENTIAL_AUDIT_ACTOR",
    },
  ];

  for (const tc of cases) {
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          createdInput({ actor: tc.actor, afterState: after }),
          { queryClient: client }
        ),
      (e) => e.code === tc.code,
      tc.name
    );
  }

  const okOperator = await appendCodeClipProviderCredentialAudit(
    createdInput({
      actor: { type: "operator", id: "Admin.User-1" },
      reason: "credential_created",
      afterState: after,
    }),
    { queryClient: client }
  );
  assert.equal(okOperator.actorType, "operator");
  assert.equal(okOperator.actorId, "admin.user-1");

  const okKey = await appendCodeClipProviderCredentialAudit(
    createdInput({ actor: { type: "operator_key" }, afterState: after }),
    { queryClient: client }
  );
  assert.equal(okKey.actorType, "operator_key");
  assert.equal(okKey.actorId, null);

  const okSystemNoId = await appendCodeClipProviderCredentialAudit(
    createdInput({ actor: { type: "system" }, afterState: after }),
    { queryClient: client }
  );
  assert.equal(okSystemNoId.actorType, "system");
  assert.equal(okSystemNoId.actorId, null);

  const okSystemWithId = await appendCodeClipProviderCredentialAudit(
    createdInput({
      actor: { type: "system", id: "OAuth_Callback" },
      afterState: after,
    }),
    { queryClient: client }
  );
  assert.equal(okSystemWithId.actorType, "system");
  assert.equal(okSystemWithId.actorId, "oauth_callback");
});

// ---------------------------------------------------------------------------
// Reason
// ---------------------------------------------------------------------------

test("codeClip credential audit reason contract", async () => {
  const client = createAuditStoreClient();
  const after = baseSnapshot();

  const rejectCases = [
    { name: "missing reason", reason: undefined, code: "INVALID_CREDENTIAL_AUDIT_REASON" },
    { name: "null reason", reason: null, code: "INVALID_CREDENTIAL_AUDIT_REASON" },
    {
      name: "spaces / free text",
      reason: "Bad Reason With Spaces",
      code: "INVALID_CREDENTIAL_AUDIT_REASON",
    },
    {
      name: "invalid start char",
      reason: "1starts_with_digit",
      code: "INVALID_CREDENTIAL_AUDIT_REASON",
    },
    {
      name: "too long",
      reason: `a${"b".repeat(64)}`,
      code: "INVALID_CREDENTIAL_AUDIT_REASON",
    },
    {
      name: "hyphen not allowed",
      reason: "credential-created",
      code: "INVALID_CREDENTIAL_AUDIT_REASON",
    },
  ];

  for (const tc of rejectCases) {
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          createdInput({ reason: tc.reason, afterState: after }),
          { queryClient: client }
        ),
      (e) => e.code === tc.code,
      tc.name
    );
  }

  const ok = await appendCodeClipProviderCredentialAudit(
    createdInput({ reason: "  Credential_Created  ", afterState: after }),
    { queryClient: client }
  );
  assert.equal(ok.reasonCode, "credential_created");
});

// ---------------------------------------------------------------------------
// Actions and before/after invariants
// ---------------------------------------------------------------------------

test("codeClip credential audit actions and state invariants", async () => {
  const client = createAuditStoreClient();
  const before = baseSnapshot({ status: "active" });
  const after = baseSnapshot({ status: "active", id: 7 });

  const allActions = [
    "created",
    "token_updated",
    "reauthorization_required",
    "revoked",
    "disabled",
    "reactivated",
    "refresh_claimed",
    "refresh_succeeded",
    "refresh_failed",
    "refresh_released",
  ];

  for (const action of allActions) {
    const row = await appendCodeClipProviderCredentialAudit(
      {
        credentialId: 7,
        provider: "youtube",
        environment: "sandbox",
        action,
        actor: { type: "system" },
        reason: `reason_${action}`,
        beforeState: action === "created" ? null : before,
        afterState: after,
      },
      { queryClient: client }
    );
    assert.equal(row.action, action);
  }

  await assert.rejects(
    () =>
      appendCodeClipProviderCredentialAudit(
        {
          credentialId: 7,
          provider: "youtube",
          environment: "sandbox",
          action: "secret_accessed",
          actor: { type: "system" },
          reason: "probe",
          beforeState: before,
          afterState: after,
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_ACTION"
  );

  await assert.rejects(
    () =>
      appendCodeClipProviderCredentialAudit(
        {
          credentialId: 7,
          provider: "youtube",
          environment: "sandbox",
          action: "created",
          actor: { type: "system" },
          reason: "credential_created",
          beforeState: before,
          afterState: after,
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT"
  );

  await assert.rejects(
    () =>
      appendCodeClipProviderCredentialAudit(
        {
          credentialId: 7,
          provider: "youtube",
          environment: "sandbox",
          action: "created",
          actor: { type: "system" },
          reason: "credential_created",
          beforeState: null,
          afterState: null,
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT"
  );

  for (const action of [
    "token_updated",
    "disabled",
    "reactivated",
    "reauthorization_required",
    "revoked",
  ]) {
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          {
            credentialId: 7,
            provider: "youtube",
            environment: "sandbox",
            action,
            actor: { type: "system" },
            reason: "missing_before",
            beforeState: null,
            afterState: after,
          },
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT",
      `${action} requires before`
    );
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          {
            credentialId: 7,
            provider: "youtube",
            environment: "sandbox",
            action,
            actor: { type: "system" },
            reason: "missing_after",
            beforeState: before,
            afterState: null,
          },
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT",
      `${action} requires after`
    );
  }
});

// ---------------------------------------------------------------------------
// Snapshot allowlist, masking, nested forbidden
// ---------------------------------------------------------------------------

test("codeClip credential audit snapshot allowlist and top-level forbidden fields", async () => {
  const client = createAuditStoreClient();

  const forbiddenTopLevel = [
    { access_token_envelope: "v1.1.x.y.z" },
    { refresh_token_envelope: "v1.1.x.y.z" },
    { metadata: { x: 1 } },
    { access_token: "secret" },
    { refresh_token: "secret" },
    { token: "secret" },
    { plaintext: "secret" },
    { account_lookup_key: "lookup" },
  ];

  for (const extra of forbiddenTopLevel) {
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          createdInput({
            afterState: { ...baseSnapshot(), ...extra },
          }),
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      `forbidden ${Object.keys(extra)[0]}`
    );
  }
});

test("codeClip credential audit rejects nested forbidden fields and nested containers", async () => {
  const client = createAuditStoreClient();

  const nestedCases = [
    {
      name: "nested token under allowlisted field",
      afterState: baseSnapshot({ status: { token: "x" } }),
    },
    {
      name: "nested access_token under allowlisted field",
      afterState: baseSnapshot({
        reauthorizationReason: { access_token: "x" },
      }),
    },
    {
      name: "nested refresh_token under allowlisted field",
      afterState: baseSnapshot({
        tokenType: { refresh_token: "x" },
      }),
    },
    {
      name: "nested envelope under allowlisted field",
      afterState: baseSnapshot({
        status: { envelope: "v1" },
      }),
    },
    {
      name: "nested provider_account_id under allowlisted field",
      afterState: baseSnapshot({
        status: { provider_account_id: "raw-id" },
      }),
    },
    {
      name: "nested metadata under allowlisted field",
      afterState: baseSnapshot({
        status: { metadata: { secret: 1 } },
      }),
    },
    {
      name: "nested object in scopes",
      afterState: baseSnapshot({
        scopes: [{ token: "hidden" }],
      }),
    },
    {
      name: "nested array in scopes",
      afterState: baseSnapshot({
        scopes: [["nested"]],
      }),
    },
    {
      name: "nested object under non-scopes field without forbidden key",
      afterState: baseSnapshot({
        status: { nested: "value" },
      }),
    },
    {
      name: "array under non-scopes field",
      afterState: baseSnapshot({
        tokenType: ["a", "b"],
      }),
    },
  ];

  for (const tc of nestedCases) {
    await assert.rejects(
      () =>
        appendCodeClipProviderCredentialAudit(
          createdInput({ afterState: tc.afterState }),
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_AUDIT_SNAPSHOT",
      tc.name
    );
  }
});

test("codeClip credential audit masks raw account ids and omits them from snapshots", async () => {
  const client = createAuditStoreClient();

  const longId = "page-1234567890";
  // Distinct ids chosen so they cannot collide with allowlisted field names in JSON.
  const shortIds = [
    { id: "z9", expectMask: "••" }, // length <= 2 → full mask
    { id: "wxyz", expectMask: "•••z" }, // length <= 4 → keep last char
    { id: "q", expectMask: "••" },
  ];

  const longRow = await appendCodeClipProviderCredentialAudit(
    createdInput({
      credentialId: 42,
      provider: "meta",
      environment: "production",
      afterState: {
        id: 42,
        provider: "meta",
        environment: "production",
        status: "active",
        provider_account_id: longId,
        has_access_token: true,
        has_refresh_token: false,
        access_token_expires_at: "2026-12-01T00:00:00.000Z",
        encryption_key_version: 2,
        token_type: "Bearer",
        scopes: ["a", "b"],
        reauthorization_reason: null,
        disabled_at: null,
        revoked_at: null,
        last_refreshed_at: null,
        updated_at: "2026-08-04T11:00:00.000Z",
      },
    }),
    { queryClient: client }
  );

  assert.equal(longRow.afterState.maskedAccountId.includes("7890"), true);
  assert.equal(longRow.afterState.maskedAccountId.includes(longId), false);
  assert.equal(Object.hasOwn(longRow.afterState, "provider_account_id"), false);
  assert.equal(Object.hasOwn(longRow.afterState, "providerAccountId"), false);
  assert.equal(Object.hasOwn(longRow.afterState, "metadata"), false);
  assert.equal(JSON.stringify(longRow.afterState).includes(longId), false);
  assert.equal(JSON.stringify(client.rows[0].after_state).includes(longId), false);

  // camelCase raw id is mask source only, never retained
  const camelRaw = "camel-account-9999";
  const camelRow = await appendCodeClipProviderCredentialAudit(
    createdInput({
      credentialId: 43,
      afterState: {
        id: 43,
        provider: "meta",
        environment: "sandbox",
        status: "active",
        providerAccountId: camelRaw,
        hasAccessToken: true,
        hasRefreshToken: false,
        accessTokenExpiresAt: null,
        encryptionKeyVersion: 1,
        tokenType: null,
        scopes: [],
        reauthorizationReason: null,
        disabledAt: null,
        revokedAt: null,
        lastRefreshedAt: null,
        updatedAt: "2026-08-04T11:00:00.000Z",
      },
    }),
    { queryClient: client }
  );
  assert.equal(JSON.stringify(camelRow.afterState).includes(camelRaw), false);
  assert.equal(Object.hasOwn(camelRow.afterState, "providerAccountId"), false);
  assert.equal(camelRow.afterState.maskedAccountId.includes("9999"), true);

  for (const { id: shortId, expectMask } of shortIds) {
    const row = await appendCodeClipProviderCredentialAudit(
      createdInput({
        credentialId: 50 + shortId.length,
        afterState: {
          id: 50 + shortId.length,
          provider: "meta",
          environment: "sandbox",
          status: "active",
          provider_account_id: shortId,
          has_access_token: false,
          has_refresh_token: false,
          encryption_key_version: 1,
          scopes: [],
          updated_at: "2026-08-04T11:00:00.000Z",
        },
      }),
      { queryClient: client }
    );
    assert.equal(row.afterState.maskedAccountId, expectMask, `mask for ${shortId}`);
    assert.notEqual(row.afterState.maskedAccountId, shortId);
    assert.equal(Object.hasOwn(row.afterState, "provider_account_id"), false);
    assert.equal(
      JSON.stringify(row.afterState).includes(shortId),
      false,
      `short id ${shortId} must not appear in snapshot JSON`
    );
  }

  // scopes defensive copy on returned row / stored row
  assert.deepEqual(longRow.afterState.scopes, ["a", "b"]);
  longRow.afterState.scopes.push("c");
  assert.deepEqual(client.rows[0].after_state.scopes, ["a", "b"]);
});

test("codeClip credential audit returned snapshots are defensive against caller mutation of input", async () => {
  const client = createAuditStoreClient();
  const after = baseSnapshot({ scopes: ["pages_messaging"] });

  const row = await appendCodeClipProviderCredentialAudit(
    createdInput({ afterState: after }),
    { queryClient: client }
  );

  after.scopes.push("mutated-by-caller");
  after.status = "revoked";
  after.maskedAccountId = "leaked";

  assert.deepEqual(row.afterState.scopes, ["pages_messaging"]);
  assert.equal(row.afterState.status, "active");
  assert.equal(row.afterState.maskedAccountId, "••••••7890");
  assert.deepEqual(client.rows[0].after_state.scopes, ["pages_messaging"]);
  assert.equal(client.rows[0].after_state.status, "active");

  row.afterState.scopes.push("mutated-return");
  assert.deepEqual(client.rows[0].after_state.scopes, ["pages_messaging"]);
});

// ---------------------------------------------------------------------------
// Append SQL hygiene and errors
// ---------------------------------------------------------------------------

test("codeClip credential audit append SQL hygiene and safe errors", async () => {
  const client = createAuditStoreClient();
  const after = baseSnapshot({ id: 7, provider: "youtube" });

  const created = await appendCodeClipProviderCredentialAudit(
    {
      credentialId: 7,
      provider: "youtube",
      environment: "sandbox",
      action: "created",
      actor: { type: "operator", id: "admin" },
      reason: "credential_created",
      beforeState: null,
      afterState: after,
    },
    { queryClient: client }
  );

  assert.equal(created.action, "created");
  assert.equal(created.beforeState, null);
  assert.ok(created.afterState);
  assert.equal(created.credentialId, "7");
  assert.equal(created.vertical, "codeclip");
  assert.equal(created.provider, "youtube");
  assert.equal(created.environment, "sandbox");
  assert.equal(created.actorType, "operator");
  assert.equal(created.actorId, "admin");
  assert.equal(created.reasonCode, "credential_created");
  assert.deepEqual(created.metadata, {});

  const insert = client.calls.find((c) =>
    /INSERT INTO codeclip_provider_credential_audit/.test(c.sql)
  );
  assert.ok(insert);
  assert.match(
    insert.sql,
    /INSERT INTO codeclip_provider_credential_audit\s*\(\s*credential_id,\s*vertical,\s*provider,\s*environment,\s*action,\s*actor_type,\s*actor_id,\s*reason_code,\s*before_state,\s*after_state,\s*metadata\s*\)/s
  );
  assert.equal(/SELECT\s+\*/i.test(insert.sql), false);
  assert.match(insert.sql, /RETURNING/);
  assert.equal(/BEGIN/i.test(insert.sql), false);
  assert.equal(/COMMIT/i.test(insert.sql), false);
  assert.equal(/ROLLBACK/i.test(insert.sql), false);

  // params mapping
  assert.equal(insert.params[0], "7");
  assert.equal(insert.params[1], "codeclip");
  assert.equal(insert.params[2], "youtube");
  assert.equal(insert.params[3], "sandbox");
  assert.equal(insert.params[4], "created");
  assert.equal(insert.params[5], "operator");
  assert.equal(insert.params[6], "admin");
  assert.equal(insert.params[7], "credential_created");
  assert.equal(insert.params[8], null);
  assert.equal(typeof insert.params[9], "string");
  assert.equal(insert.params[10], "{}");

  const serializedParams = JSON.stringify(insert.params);
  assert.equal(serializedParams.includes("access_token"), false);
  assert.equal(serializedParams.includes("envelope"), false);
  assert.equal(serializedParams.includes("BEGIN"), false);

  // no TX statements in any call
  for (const call of client.calls) {
    assert.equal(/\bBEGIN\b/i.test(call.sql), false);
    assert.equal(/\bCOMMIT\b/i.test(call.sql), false);
    assert.equal(/\bROLLBACK\b/i.test(call.sql), false);
  }

  const failing = createAuditStoreClient({ failOn: "insert" });
  await assert.rejects(
    () =>
      appendCodeClipProviderCredentialAudit(createdInput({ afterState: after }), {
        queryClient: failing,
      }),
    (e) => {
      assert.equal(e instanceof CodeClipProviderCredentialAuditError, true);
      assert.equal(e.code, "DATABASE_ERROR");
      assert.equal(e.message.includes("relation"), false);
      assert.equal(JSON.stringify(e.details).includes("42P01"), false);
      assert.equal(JSON.stringify(e).includes("access_token"), false);
      assert.equal(JSON.stringify(e).includes("INSERT"), false);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

test("codeClip credential audit list contract", async () => {
  const client = createAuditStoreClient();
  const after = baseSnapshot({ id: 9 });

  for (let i = 0; i < 3; i += 1) {
    await appendCodeClipProviderCredentialAudit(
      {
        credentialId: 9,
        provider: "meta",
        environment: "sandbox",
        action: i === 1 ? "disabled" : "created",
        actor: { type: "system" },
        reason: "credential_created",
        beforeState: i === 1 ? baseSnapshot({ id: 9 }) : null,
        afterState: i === 1 ? baseSnapshot({ id: 9, status: "disabled" }) : after,
      },
      { queryClient: client }
    );
  }
  await appendCodeClipProviderCredentialAudit(
    createdInput({
      credentialId: 99,
      afterState: baseSnapshot({ id: 99 }),
    }),
    { queryClient: client }
  );

  await assert.rejects(
    () => listCodeClipProviderCredentialAudit({}, { queryClient: client }),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: "not-a-number" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: 0 },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: 9, action: "secret_accessed" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_ACTION"
  );

  for (const limit of [
    0,
    -1,
    1.5,
    101,
    500,
    "abc",
    "50",
    "100",
    null,
    true,
    false,
    NaN,
    Infinity,
    -Infinity,
  ]) {
    await assert.rejects(
      () =>
        listCodeClipProviderCredentialAudit(
          { credentialId: 9, limit },
          { queryClient: client }
        ),
      (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT",
      `limit ${String(limit)}`
    );
  }

  const page1 = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 2 },
    { queryClient: client }
  );
  assert.equal(page1.items.length, 2);
  assert.equal(page1.page.hasMore, true);
  assert.ok(page1.page.nextCursor);
  assert.equal(page1.page.limit, 2);
  assert.equal(
    page1.items.every((item) => String(item.credentialId) === "9"),
    true
  );

  // limit+1 fetch visible in SQL params
  const listCalls = client.calls.filter((c) =>
    /FROM codeclip_provider_credential_audit/.test(c.sql)
  );
  const lastList = listCalls[listCalls.length - 1];
  assert.equal(lastList.params[lastList.params.length - 1], 3); // limit 2 + 1

  const page2 = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 2, cursor: page1.page.nextCursor },
    { queryClient: client }
  );
  assert.equal(page2.items.length, 1);
  assert.equal(page2.page.hasMore, false);
  assert.equal(page2.page.nextCursor, null);

  const filtered = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, action: "disabled" },
    { queryClient: client }
  );
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].action, "disabled");

  const limit1 = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 1 },
    { queryClient: client }
  );
  assert.equal(limit1.items.length, 1);
  assert.equal(limit1.page.limit, 1);
  assert.equal(limit1.page.hasMore, true);

  // default limit when omitted
  const defaultPage = await listCodeClipProviderCredentialAudit(
    { credentialId: 9 },
    { queryClient: client }
  );
  assert.equal(defaultPage.page.limit, 50);

  // max limit 100 accepted; SQL fetches limit + 1
  const maxPage = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 100 },
    { queryClient: client }
  );
  assert.equal(maxPage.page.limit, 100);
  const maxListCall = client.calls
    .filter((c) => /FROM codeclip_provider_credential_audit/.test(c.sql))
    .at(-1);
  assert.equal(maxListCall.params[maxListCall.params.length - 1], 101);

  const empty = await listCodeClipProviderCredentialAudit(
    { credentialId: 12345 },
    { queryClient: client }
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.page.hasMore, false);
  assert.equal(empty.page.nextCursor, null);

  // sorting contract
  for (const call of client.calls.filter((c) =>
    /FROM codeclip_provider_credential_audit/.test(c.sql)
  )) {
    assert.equal(/SELECT\s+\*/i.test(call.sql), false);
    assert.match(call.sql, /ORDER BY created_at DESC, id DESC/);
    assert.match(
      call.sql,
      /id,\s*credential_id,\s*vertical,\s*provider,\s*environment,\s*action,\s*actor_type,\s*actor_id,\s*reason_code,\s*before_state,\s*after_state,\s*metadata,\s*created_at/
    );
  }

  // defensive copies of before/after in list output
  if (page1.items[0].afterState?.scopes) {
    page1.items[0].afterState.scopes.push("mutated");
    const again = await listCodeClipProviderCredentialAudit(
      { credentialId: 9, limit: 10 },
      { queryClient: client }
    );
    assert.equal(
      again.items.some((i) => i.afterState?.scopes?.includes("mutated")),
      false
    );
  }
});

test("codeClip credential audit list cursor validation", async () => {
  const client = createAuditStoreClient();
  await appendCodeClipProviderCredentialAudit(
    createdInput({ credentialId: 9, afterState: baseSnapshot({ id: 9 }) }),
    { queryClient: client }
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: 9, cursor: "not-valid" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: 9, cursor: "!!!not-base64!!!" },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        {
          credentialId: 9,
          cursor: encodeCursor({
            v: 99,
            createdAt: "2026-08-04T10:00:00.000Z",
            id: "1",
          }),
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        {
          credentialId: 9,
          cursor: encodeCursor({
            v: 1,
            createdAt: "not-a-date",
            id: "1",
          }),
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        {
          credentialId: 9,
          cursor: encodeCursor({
            v: 1,
            createdAt: "2026-08-04T10:00:00.000Z",
            id: "0",
          }),
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT" || e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        {
          credentialId: 9,
          cursor: encodeCursor({
            v: 1,
            createdAt: "2026-08-04T10:00:00.000Z",
            id: "abc",
          }),
        },
        { queryClient: client }
      ),
    (e) => e.code === "INVALID_CREDENTIAL_AUDIT_INPUT" || e.code === "INVALID_CREDENTIAL_AUDIT_CURSOR"
  );

  // valid cursor from page works
  const first = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 1 },
    { queryClient: client }
  );
  const second = await listCodeClipProviderCredentialAudit(
    { credentialId: 9, limit: 1, cursor: first.page.nextCursor },
    { queryClient: client }
  );
  assert.ok(Array.isArray(second.items));
});

test("codeClip credential audit list DB errors are sanitized", async () => {
  const failing = createAuditStoreClient({ failOn: "select" });
  await assert.rejects(
    () =>
      listCodeClipProviderCredentialAudit(
        { credentialId: 1 },
        { queryClient: failing }
      ),
    (e) => {
      assert.equal(e instanceof CodeClipProviderCredentialAuditError, true);
      assert.equal(e.code, "DATABASE_ERROR");
      assert.equal(String(e.message).includes("connection terminated"), false);
      assert.equal(JSON.stringify(e.details).includes("connection"), false);
      return true;
    }
  );
});

test("codeClip credential audit requires query client", async () => {
  await assert.rejects(
    () =>
      appendCodeClipProviderCredentialAudit({
        credentialId: 1,
        provider: "meta",
        environment: "sandbox",
        action: "created",
        actor: { type: "system" },
        reason: "credential_created",
        beforeState: null,
        afterState: baseSnapshot(),
      }),
    (e) =>
      e instanceof CodeClipProviderCredentialAuditError &&
      e.code === "DATABASE_UNAVAILABLE"
  );

  await assert.rejects(
    () => listCodeClipProviderCredentialAudit({ credentialId: 1 }),
    (e) =>
      e instanceof CodeClipProviderCredentialAuditError &&
      e.code === "DATABASE_UNAVAILABLE"
  );
});
