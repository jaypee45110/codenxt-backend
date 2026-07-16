const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipProviderAccountBindingAuditTable } = require("./db");
const { toPublicCodeClipProviderBinding } = require("./verticals/codeclip/provider-account-bindings");
const {
  appendCodeClipProviderAccountBindingAuditEvent,
  listCodeClipProviderAccountBindingAuditEvents,
  normalizeCodeClipProviderBindingAuditLimit,
  sanitizeCodeClipProviderBindingAuditState,
  toAuditState,
  toPublicCodeClipProviderBindingAuditEvent,
} = require("./verticals/codeclip/provider-account-binding-audit");

function createBinding(overrides = {}) {
  return {
    id: overrides.id || "bind-1",
    vertical: overrides.vertical || "codeclip",
    eventCode: overrides.eventCode || "CC-AUDIT-1",
    provider: overrides.provider || "meta",
    channel: overrides.channel || "instagram",
    providerAccountId: overrides.providerAccountId || "ig-account-123456",
    status: overrides.status || "active",
    displayName: overrides.displayName ?? "Main Instagram",
    createdAt: overrides.createdAt || "2026-07-15T01:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-07-15T01:00:00.000Z",
    disabledAt: overrides.disabledAt || null,
  };
}

function createAuditClient() {
  const calls = [];
  const rows = [];
  let nextId = 1;

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/CREATE TABLE IF NOT EXISTS codeclip_provider_account_binding_audit/.test(sql)) {
        return { rows: [] };
      }
      if (/CREATE INDEX IF NOT EXISTS/.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO codeclip_provider_account_binding_audit/.test(sql)) {
        const row = {
          id: String(nextId++),
          vertical: params[0],
          binding_id: params[1],
          event_code: params[2],
          provider: params[3],
          channel: params[4],
          action: params[5],
          actor_type: params[6],
          actor_id: params[7],
          before_state: JSON.parse(params[8]),
          after_state: JSON.parse(params[9]),
          metadata: JSON.parse(params[10]),
          created_at: `2026-07-15T01:00:0${nextId}.000Z`,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/FROM codeclip_provider_account_binding_audit/.test(sql)) {
        let result = rows.filter((row) => row.vertical === "codeclip");
        if (/binding_id =/.test(sql)) {
          const bindingIdParam = params.find((value) => value === "bind-1" || value === "bind-2");
          result = result.filter((row) => row.binding_id === bindingIdParam);
        }
        if (/event_code =/.test(sql)) {
          const eventCodeParam = params.find((value) => /^CC-AUDIT-/.test(String(value)));
          result = result.filter((row) => row.event_code === eventCodeParam);
        }
        const limit = params[params.length - 1];
        return {
          rows: result
            .slice()
            .sort((left, right) => Number(right.id) - Number(left.id))
            .slice(0, limit),
        };
      }
      return { rows: [] };
    },
  };
}

function assertProviderAccountIdAbsent(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("providerAccountId"), false);
  assert.equal(serialized.includes("provider_account_id"), false);
  assert.equal(serialized.includes("ig-account-123456"), false);
}

test("codeClip provider binding audit schema defines append-only table and indexes", async () => {
  const client = createAuditClient();

  await ensureCodeClipProviderAccountBindingAuditTable(client);

  assert.equal(client.calls.length, 5);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_provider_account_binding_audit/);
  assert.match(client.calls[0].sql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(client.calls[0].sql, /CHECK \(action IN \('created', 'display_name_updated', 'disabled', 'reactivated'\)\)/);
  assert.match(client.calls[1].sql, /codeclip_provider_account_binding_audit_binding_id_idx/);
  assert.match(client.calls[2].sql, /codeclip_provider_account_binding_audit_event_code_idx/);
  assert.match(client.calls[3].sql, /codeclip_provider_account_binding_audit_created_at_idx/);
  assert.match(client.calls[4].sql, /codeclip_provider_account_binding_audit_vertical_event_created_idx/);
});

test("codeClip provider binding audit appends public-safe binding state", async () => {
  const client = createAuditClient();
  const binding = createBinding();
  const publicBinding = toPublicCodeClipProviderBinding(binding);

  const event = await appendCodeClipProviderAccountBindingAuditEvent(
    {
      binding,
      action: "created",
      beforeState: null,
      afterState: publicBinding,
      metadata: { source: "operator" },
    },
    { queryClient: client }
  );

  assert.equal(event.action, "created");
  assert.equal(event.actorType, "operator");
  assert.equal(event.actorId, "admin");
  assert.equal(event.afterState.maskedAccountId.endsWith("3456"), true);
  assertProviderAccountIdAbsent(client.rows[0].after_state);
  assertProviderAccountIdAbsent(event.afterState);
});

test("codeClip provider binding audit rejects unsupported action and actor values", async () => {
  const client = createAuditClient();
  const binding = createBinding();

  await assert.rejects(
    appendCodeClipProviderAccountBindingAuditEvent(
      { binding, action: "deleted", afterState: toAuditState(binding) },
      { queryClient: client }
    ),
    { code: "INVALID_PROVIDER_BINDING_AUDIT_ACTION" }
  );
  await assert.rejects(
    appendCodeClipProviderAccountBindingAuditEvent(
      {
        binding,
        action: "created",
        actorType: "organizer",
        actorId: "admin",
        afterState: toAuditState(binding),
      },
      { queryClient: client }
    ),
    { code: "INVALID_PROVIDER_BINDING_AUDIT_ACTOR" }
  );
  await assert.rejects(
    appendCodeClipProviderAccountBindingAuditEvent(
      {
        binding,
        action: "created",
        actorType: "operator",
        actorId: "CODECLIP_ADMIN_KEY=s3cr3t",
        afterState: toAuditState(binding),
      },
      { queryClient: client }
    ),
    { code: "INVALID_PROVIDER_BINDING_AUDIT_ACTOR" }
  );
});

test("codeClip provider binding audit limit validation is strict", () => {
  assert.equal(normalizeCodeClipProviderBindingAuditLimit(undefined), 50);
  assert.equal(normalizeCodeClipProviderBindingAuditLimit(null), 50);
  assert.equal(normalizeCodeClipProviderBindingAuditLimit(1), 1);
  assert.equal(normalizeCodeClipProviderBindingAuditLimit("25"), 25);
  assert.equal(normalizeCodeClipProviderBindingAuditLimit(150), 100);
  assert.equal(normalizeCodeClipProviderBindingAuditLimit("250"), 100);

  for (const value of ["10abc", "1.5", "5 ", "", "0", 0, -1, 1.5, {}, []]) {
    assert.throws(
      () => normalizeCodeClipProviderBindingAuditLimit(value),
      { code: "INVALID_PROVIDER_BINDING_AUDIT_LIMIT" },
      `expected invalid limit for ${JSON.stringify(value)}`
    );
  }
});

test("codeClip provider binding audit sanitizer removes account and secret keys recursively", () => {
  const sanitized = sanitizeCodeClipProviderBindingAuditState({
    keep: "value",
    providerAccountId: "raw-account",
    adminKey: "admin-secret",
    nested: {
      provider_account_id: "raw-account-2",
      secret: "secret",
      webhookSecret: "webhook",
      apiKey: "api",
      authorization: "Bearer token",
      password: "pw",
      token: "token",
      accessToken: "access",
      refresh_token: "refresh",
      keepNested: true,
    },
    list: [
      {
        providerAccountId: "raw-account-3",
        admin_key: "admin-secret-2",
        keepList: 1,
      },
    ],
  });

  assert.deepEqual(sanitized, {
    keep: "value",
    nested: {
      keepNested: true,
    },
    list: [
      {
        keepList: 1,
      },
    ],
  });
});

test("codeClip provider binding audit serializer requires explicit codeClip vertical", () => {
  assert.equal(
    toPublicCodeClipProviderBindingAuditEvent({
      id: "audit-1",
      bindingId: "bind-1",
      eventCode: "CC-AUDIT-1",
      provider: "meta",
      channel: "instagram",
      action: "created",
      actorType: "operator",
      actorId: "admin",
      beforeState: null,
      afterState: {},
      metadata: {},
      createdAt: "2026-07-15T01:00:00.000Z",
    }),
    null
  );
  assert.equal(
    toPublicCodeClipProviderBindingAuditEvent({
      vertical: "codepod",
      id: "audit-1",
      bindingId: "bind-1",
      eventCode: "CC-AUDIT-1",
      provider: "meta",
      channel: "instagram",
      action: "created",
      actorType: "operator",
      actorId: "admin",
      beforeState: null,
      afterState: {},
      metadata: {},
      createdAt: "2026-07-15T01:00:00.000Z",
    }),
    null
  );

  const publicEvent = toPublicCodeClipProviderBindingAuditEvent({
    vertical: "codeclip",
    id: "audit-1",
    bindingId: "bind-1",
    eventCode: "CC-AUDIT-1",
    provider: "meta",
    channel: "instagram",
    action: "created",
    actorType: "operator",
    actorId: "admin",
    beforeState: null,
    afterState: { adminKey: "secret", keep: true },
    metadata: { authorization: "Bearer secret", source: "operator" },
    createdAt: "2026-07-15T01:00:00.000Z",
  });

  assert.equal(publicEvent.afterState.adminKey, undefined);
  assert.equal(publicEvent.afterState.keep, true);
  assert.deepEqual(publicEvent.metadata, { source: "operator" });
});

test("codeClip provider binding audit toAuditState serializes actual binding state safely", () => {
  const auditState = toAuditState(createBinding());

  assert.equal(auditState.id, "bind-1");
  assert.equal(auditState.eventCode, "CC-AUDIT-1");
  assert.equal(auditState.maskedAccountId.endsWith("3456"), true);
  assert.equal(auditState.providerAccountId, undefined);
  assertProviderAccountIdAbsent(auditState);
});

test("codeClip provider binding audit lists per binding and per episode newest first", async () => {
  const client = createAuditClient();
  const firstBinding = createBinding({ id: "bind-1", eventCode: "CC-AUDIT-1" });
  const secondBinding = createBinding({ id: "bind-2", eventCode: "CC-AUDIT-1" });
  client.rows.push({
    id: "99",
    vertical: "codepod",
    binding_id: "bind-1",
    event_code: "CC-AUDIT-1",
    provider: "meta",
    channel: "instagram",
    action: "created",
    actor_type: "operator",
    actor_id: "admin",
    before_state: null,
    after_state: {},
    metadata: {},
    created_at: "2026-07-15T01:00:00.000Z",
  });

  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding: firstBinding, action: "created", afterState: toAuditState(firstBinding) },
    { queryClient: client }
  );
  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding: firstBinding, action: "disabled", beforeState: toAuditState(firstBinding) },
    { queryClient: client }
  );
  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding: secondBinding, action: "created", afterState: toAuditState(secondBinding) },
    { queryClient: client }
  );

  const perBinding = await listCodeClipProviderAccountBindingAuditEvents(
    { bindingId: "bind-1", limit: 10 },
    { queryClient: client }
  );
  assert.deepEqual(
    perBinding.map((event) => event.action),
    ["disabled", "created"]
  );

  const perEpisode = await listCodeClipProviderAccountBindingAuditEvents(
    { eventCode: "CC-AUDIT-1", limit: 2 },
    { queryClient: client }
  );
  assert.deepEqual(
    perEpisode.map((event) => event.bindingId),
    ["bind-2", "bind-1"]
  );
});
