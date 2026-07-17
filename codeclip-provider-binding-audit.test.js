const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipProviderAccountBindingAuditTable } = require("./db");
const { toPublicCodeClipProviderBinding } = require("./verticals/codeclip/provider-account-bindings");
const {
  appendCodeClipProviderAccountBindingAuditEvent,
  listCodeClipProviderAccountBindingAuditEvents,
  listCodeClipProviderAccountBindingAuditEventsPage,
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
          const bindingIdParam = params[1];
          result = result.filter((row) => row.binding_id === String(bindingIdParam));
        }
        if (/event_code =/.test(sql)) {
          const eventCodeParam = params.find((value) => /^CC-AUDIT-/.test(String(value)));
          result = result.filter((row) => row.event_code === eventCodeParam);
        }
        if (/created_at </.test(sql)) {
          const createdAtParamIndex = params.findIndex((value) =>
            /^\d{4}-\d{2}-\d{2}T/.test(String(value))
          );
          const cursorCreatedAt = params[createdAtParamIndex];
          const cursorId = params[createdAtParamIndex + 1];
          result = result.filter(
            (row) =>
              row.created_at < cursorCreatedAt ||
              (row.created_at === cursorCreatedAt && BigInt(row.id) < BigInt(cursorId))
          );
        }
        const limit = params[params.length - 1];
        return {
          rows: result
            .slice()
            .sort((left, right) => {
              if (left.created_at === right.created_at) {
                const leftId = BigInt(left.id);
                const rightId = BigInt(right.id);

                if (rightId > leftId) return 1;
                if (rightId < leftId) return -1;
                return 0;
              }

              return right.created_at.localeCompare(left.created_at);
            })
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

  assert.equal(client.calls.length, 6);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_provider_account_binding_audit/);
  assert.match(client.calls[0].sql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(client.calls[0].sql, /CHECK \(action IN \('created', 'display_name_updated', 'disabled', 'reactivated'\)\)/);
  assert.match(client.calls[1].sql, /ALTER COLUMN actor_id DROP NOT NULL/);
  assert.match(client.calls[2].sql, /codeclip_provider_account_binding_audit_binding_id_idx/);
  assert.match(client.calls[3].sql, /codeclip_provider_account_binding_audit_event_code_idx/);
  assert.match(client.calls[4].sql, /codeclip_provider_account_binding_audit_created_at_idx/);
  assert.match(client.calls[5].sql, /codeclip_provider_account_binding_audit_vertical_event_created_idx/);
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

test("codeClip provider binding audit paginates and validates bindingId and cursor", async () => {
  const client = createAuditClient();
  const binding = createBinding({ id: "1", eventCode: "CC-AUDIT-PAGE" });

  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding, action: "created", afterState: toAuditState(binding) },
    { queryClient: client }
  );
  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding, action: "disabled", beforeState: toAuditState(binding) },
    { queryClient: client }
  );

  const firstPage = await listCodeClipProviderAccountBindingAuditEventsPage(
    { bindingId: "1", limit: 1 },
    { queryClient: client }
  );
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.page.limit, 1);
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);

  const secondPage = await listCodeClipProviderAccountBindingAuditEventsPage(
    { bindingId: "1", limit: 1, cursor: firstPage.page.nextCursor },
    { queryClient: client }
  );
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);
  assert.equal(secondPage.page.hasMore, false);
  assert.equal(secondPage.page.nextCursor, null);

  for (const bindingId of ["", "0", "-1", "1.5", "abc", "9223372036854775808"]) {
    await assert.rejects(
      () =>
        listCodeClipProviderAccountBindingAuditEventsPage(
          { bindingId },
          { queryClient: client }
        ),
      (error) => error.code === "INVALID_PROVIDER_BINDING_AUDIT_INPUT"
    );
  }

  const invalidCursor = Buffer.from(
    JSON.stringify({ v: 1, createdAt: "not-a-date", id: "1" })
  ).toString("base64url");
  await assert.rejects(
    () =>
      listCodeClipProviderAccountBindingAuditEventsPage(
        { bindingId: "1", cursor: invalidCursor },
        { queryClient: client }
      ),
    (error) => error.code === "INVALID_PROVIDER_BINDING_AUDIT_CURSOR"
  );
});

test("codeClip provider binding audit pagination sorts large bigint IDs deterministically", async () => {
  const client = createAuditClient();
  const binding = createBinding({ id: "1", eventCode: "CC-AUDIT-BIGINT" });

  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding, action: "created", afterState: toAuditState(binding) },
    { queryClient: client }
  );
  await appendCodeClipProviderAccountBindingAuditEvent(
    { binding, action: "disabled", beforeState: toAuditState(binding) },
    { queryClient: client }
  );

  const matchingRows = client.rows.filter((row) => row.binding_id === "1");
  matchingRows[0].id = "9007199254740992";
  matchingRows[1].id = "9007199254740993";
  matchingRows[0].created_at = "2026-07-15T02:00:00.000Z";
  matchingRows[1].created_at = "2026-07-15T02:00:00.000Z";

  const firstPage = await listCodeClipProviderAccountBindingAuditEventsPage(
    { bindingId: "1", limit: 1 },
    { queryClient: client }
  );
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].id, "9007199254740993");
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);

  const secondPage = await listCodeClipProviderAccountBindingAuditEventsPage(
    { bindingId: "1", limit: 1, cursor: firstPage.page.nextCursor },
    { queryClient: client }
  );
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0].id, "9007199254740992");
  assert.equal(secondPage.page.hasMore, false);
  assert.equal(secondPage.page.nextCursor, null);
});
