const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipProviderAccountBindingsTable } = require("./db");
const {
  CodeClipProviderAccountBindingError,
  createCodeClipProviderAccountBinding,
  disableCodeClipProviderAccountBinding,
  findActiveCodeClipProviderAccountBinding,
  listCodeClipProviderAccountBindingsForEvent,
  maskCodeClipProviderAccountId,
  normalizeCodeClipProviderAccountBindingInput,
  toPublicCodeClipProviderBinding,
} = require("./verticals/codeclip/provider-account-bindings");

function createBindingRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    vertical: overrides.vertical || "codeclip",
    event_code: overrides.event_code || "CC-BIND-1",
    provider: overrides.provider || "meta",
    channel: overrides.channel || "instagram",
    provider_account_id: overrides.provider_account_id || "page-1",
    status: overrides.status || "active",
    display_name: overrides.display_name ?? null,
    created_by: overrides.created_by || "operator",
    metadata: overrides.metadata || {},
    created_at: overrides.created_at || "2026-07-14T00:00:00.000Z",
    updated_at: overrides.updated_at || "2026-07-14T00:00:00.000Z",
    disabled_at: overrides.disabled_at || null,
  };
}

function createBindingClient() {
  const calls = [];
  const rows = [];
  let nextId = 1;

  function findActive(provider, providerAccountId) {
    return rows.find(
      (row) =>
        row.vertical === "codeclip" &&
        row.provider === provider &&
        row.provider_account_id === providerAccountId &&
        row.status === "active"
    ) || null;
  }

  function findById(id) {
    return rows.find((row) => String(row.id) === String(id) && row.vertical === "codeclip") || null;
  }

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/INSERT INTO codeclip_provider_account_bindings/.test(sql)) {
        const existing = findActive(params[2], params[4]);
        if (existing) {
          const error = new Error("duplicate active binding");
          error.code = "23505";
          throw error;
        }
        const row = createBindingRow({
          id: nextId++,
          vertical: params[0],
          event_code: params[1],
          provider: params[2],
          channel: params[3],
          provider_account_id: params[4],
          display_name: params[5],
          created_by: params[6],
          metadata: JSON.parse(params[7]),
        });
        rows.push(row);
        return { rows: [row] };
      }

      if (
        /FROM codeclip_provider_account_bindings/.test(sql) &&
        /provider_account_id = \$3/.test(sql) &&
        /status = 'active'/.test(sql)
      ) {
        const row = findActive(params[1], params[2]);
        return { rows: row ? [row] : [] };
      }

      if (/WHERE id = \$1/.test(sql) && /FROM codeclip_provider_account_bindings/.test(sql)) {
        const row = findById(params[0]);
        return { rows: row ? [row] : [] };
      }

      if (/UPDATE codeclip_provider_account_bindings/.test(sql)) {
        const row = findById(params[0]);
        if (!row) return { rows: [] };
        row.status = "disabled";
        row.disabled_at = row.disabled_at || "2026-07-14T01:00:00.000Z";
        row.updated_at = "2026-07-14T01:00:00.000Z";
        return { rows: [row] };
      }

      if (
        /FROM codeclip_provider_account_bindings/.test(sql) &&
        /event_code = \$1/.test(sql)
      ) {
        let result = rows.filter((row) => row.vertical === "codeclip" && row.event_code === params[0]);
        if (/AND status = 'active'/.test(sql)) {
          result = result.filter((row) => row.status === "active");
        }
        return { rows: result };
      }

      return { rows: [] };
    },
  };
}

function codeClipEvent(eventCode) {
  return { event_code: eventCode, vertical: "codeclip" };
}

function getEventByCode(events = {}) {
  return async (eventCode) => events[eventCode] || null;
}

async function createBinding(client, overrides = {}, events = {}) {
  return createCodeClipProviderAccountBinding(
    {
      eventCode: "CC-BIND-1",
      provider: "meta",
      channel: "instagram",
      providerAccountId: "page-1",
      createdBy: "test",
      ...overrides,
    },
    {
      queryClient: client,
      getEventByCode: getEventByCode({
        "CC-BIND-1": codeClipEvent("CC-BIND-1"),
        "CC-BIND-2": codeClipEvent("CC-BIND-2"),
        ...events,
      }),
    }
  );
}

test("codeClip provider account binding schema defines identity constraints and indexes", async () => {
  const client = createBindingClient();

  await ensureCodeClipProviderAccountBindingsTable(client);

  assert.equal(client.calls.length, 4);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_provider_account_bindings/);
  assert.match(client.calls[0].sql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(client.calls[0].sql, /CHECK \(status IN \('active', 'disabled'\)\)/);
  assert.match(client.calls[0].sql, /provider = 'meta' AND channel IN \('instagram', 'messenger', 'whatsapp'\)/);
  assert.match(client.calls[0].sql, /provider = 'sms' AND channel = 'sms'/);
  assert.match(client.calls[1].sql, /codeclip_provider_account_bindings_active_identity_idx/);
  assert.match(client.calls[1].sql, /vertical, provider, provider_account_id/);
  assert.match(client.calls[1].sql, /WHERE status = 'active'/);
  assert.match(client.calls[2].sql, /codeclip_provider_account_bindings_event_code_idx/);
  assert.match(client.calls[3].sql, /codeclip_provider_account_bindings_status_idx/);
});

test("codeClip provider account binding validation accepts supported provider channel pairs", () => {
  assert.equal(
    normalizeCodeClipProviderAccountBindingInput({
      eventCode: " CC-1 ",
      provider: " Meta ",
      channel: " Instagram ",
      providerAccountId: " page-1 ",
    }).channel,
    "instagram"
  );
  assert.equal(
    normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-1",
    }).channel,
    "messenger"
  );
  assert.equal(
    normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "meta",
      channel: "whatsapp",
      providerAccountId: "page-1",
    }).channel,
    "whatsapp"
  );
  assert.equal(
    normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "sms",
      channel: "sms",
      providerAccountId: "+15551234567",
    }).provider,
    "sms"
  );
});

test("codeClip provider account binding validation rejects invalid input", () => {
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "test",
      channel: "sms",
      providerAccountId: "test",
    }),
    /provider is not supported/
  );
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "meta",
      channel: "email",
      providerAccountId: "page-1",
    }),
    /channel is not valid/
  );
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "sms",
      channel: "instagram",
      providerAccountId: "sms-1",
    }),
    /channel is not valid/
  );
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "sms",
      channel: "sms",
      providerAccountId: " ",
    }),
    /providerAccountId/
  );
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      vertical: "codepod",
      eventCode: "CC-1",
      provider: "sms",
      channel: "sms",
      providerAccountId: "sms-1",
    }),
    /vertical/
  );
  assert.throws(
    () => normalizeCodeClipProviderAccountBindingInput({
      eventCode: "CC-1",
      provider: "sms",
      channel: "sms",
      providerAccountId: "sms-1",
      metadata: [],
    }),
    /metadata/
  );
});

test("codeClip provider account binding create stores active row and safe serializer masks account id", async () => {
  const client = createBindingClient();

  const result = await createBinding(client, {
    displayName: " Optional account label ",
    metadata: { source: "test" },
  });
  const publicBinding = toPublicCodeClipProviderBinding(result.row);

  assert.equal(result.status, "created");
  assert.equal(result.created, true);
  assert.equal(result.row.eventCode, "CC-BIND-1");
  assert.equal(result.row.provider, "meta");
  assert.equal(result.row.channel, "instagram");
  assert.equal(result.row.providerAccountId, "page-1");
  assert.equal(result.row.status, "active");
  assert.equal(result.row.displayName, "Optional account label");
  assert.ok(result.row.createdAt);
  assert.ok(result.row.updatedAt);
  assert.equal(publicBinding.maskedAccountId, "••••ge-1");
  assert.equal(publicBinding.displayName, "Optional account label");
  assert.equal(publicBinding.providerAccountId, undefined);
  assert.equal(publicBinding.metadata, undefined);
});

test("codeClip provider account binding create is idempotent for same active episode identity", async () => {
  const client = createBindingClient();

  const created = await createBinding(client);
  const existing = await createBinding(client, { displayName: "New label does not affect identity" });

  assert.equal(created.status, "created");
  assert.equal(existing.status, "existing");
  assert.equal(existing.existing, true);
  assert.equal(existing.row.id, created.row.id);
  assert.equal(client.rows.length, 1);
});

test("codeClip provider account binding create throws conflict for another active episode", async () => {
  const client = createBindingClient();
  await createBinding(client);

  await assert.rejects(
    () => createBinding(client, { eventCode: "CC-BIND-2" }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderAccountBindingError);
      assert.equal(error.code, "PROVIDER_ACCOUNT_BINDING_CONFLICT");
      return true;
    }
  );
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].event_code, "CC-BIND-1");
  assert.equal(client.rows[0].status, "active");
});

test("codeClip provider account binding treats same account under different providers separately", async () => {
  const client = createBindingClient();

  const meta = await createBinding(client, {
    provider: "meta",
    channel: "instagram",
    providerAccountId: "shared-account",
  });
  const sms = await createBinding(client, {
    provider: "sms",
    channel: "sms",
    providerAccountId: "shared-account",
  });

  assert.equal(meta.status, "created");
  assert.equal(sms.status, "created");
  assert.equal(client.rows.length, 2);
});

test("codeClip provider account binding requires an existing codeClip event", async () => {
  const client = createBindingClient();

  await assert.rejects(
    () => createCodeClipProviderAccountBinding(
      {
        eventCode: "CC-MISSING",
        provider: "meta",
        channel: "instagram",
        providerAccountId: "page-1",
      },
      { queryClient: client, getEventByCode: getEventByCode({}) }
    ),
    (error) => {
      assert.equal(error.code, "CODECLIP_EVENT_NOT_FOUND");
      return true;
    }
  );
  await assert.rejects(
    () => createCodeClipProviderAccountBinding(
      {
        eventCode: "CP-OTHER",
        provider: "meta",
        channel: "instagram",
        providerAccountId: "page-1",
      },
      { queryClient: client, getEventByCode: getEventByCode({ "CP-OTHER": { vertical: "codepod" } }) }
    ),
    (error) => {
      assert.equal(error.code, "CODECLIP_EVENT_NOT_FOUND");
      return true;
    }
  );
});

test("codeClip provider account binding active lookup excludes disabled rows", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);

  const active = await findActiveCodeClipProviderAccountBinding(
    { provider: "meta", providerAccountId: "page-1" },
    { queryClient: client }
  );
  const disabled = await disableCodeClipProviderAccountBinding(created.row.id, { queryClient: client });
  const activeAfterDisable = await findActiveCodeClipProviderAccountBinding(
    { provider: "meta", providerAccountId: "page-1" },
    { queryClient: client }
  );
  const disabledAgain = await disableCodeClipProviderAccountBinding(created.row.id, { queryClient: client });

  assert.equal(active.id, created.row.id);
  assert.equal(disabled.status, "disabled");
  assert.ok(disabled.disabledAt);
  assert.equal(activeAfterDisable, null);
  assert.equal(disabledAgain.status, "disabled");
  assert.equal(disabledAgain.disabledAt, disabled.disabledAt);
});

test("codeClip provider account binding can rebind after deactivation", async () => {
  const client = createBindingClient();
  const first = await createBinding(client);
  await disableCodeClipProviderAccountBinding(first.row.id, { queryClient: client });

  const second = await createBinding(client, { eventCode: "CC-BIND-2" });
  const active = await findActiveCodeClipProviderAccountBinding(
    { provider: "meta", providerAccountId: "page-1" },
    { queryClient: client }
  );

  assert.equal(second.status, "created");
  assert.equal(second.row.eventCode, "CC-BIND-2");
  assert.equal(active.id, second.row.id);
  assert.equal(client.rows.filter((row) => row.status === "active").length, 1);
  assert.equal(client.rows.filter((row) => row.status === "disabled").length, 1);
});

test("codeClip provider account binding listing is event isolated", async () => {
  const client = createBindingClient();
  const first = await createBinding(client, {
    eventCode: "CC-BIND-1",
    providerAccountId: "page-a",
  });
  const second = await createBinding(client, {
    eventCode: "CC-BIND-2",
    providerAccountId: "page-b",
  });
  await disableCodeClipProviderAccountBinding(first.row.id, { queryClient: client });

  const activeForFirst = await listCodeClipProviderAccountBindingsForEvent(
    "CC-BIND-1",
    { queryClient: client }
  );
  const allForFirst = await listCodeClipProviderAccountBindingsForEvent(
    "CC-BIND-1",
    { includeDisabled: true, queryClient: client }
  );
  const activeForSecond = await listCodeClipProviderAccountBindingsForEvent(
    "CC-BIND-2",
    { queryClient: client }
  );

  assert.equal(activeForFirst.length, 0);
  assert.equal(allForFirst.length, 1);
  assert.equal(allForFirst[0].id, first.row.id);
  assert.equal(activeForSecond.length, 1);
  assert.equal(activeForSecond[0].id, second.row.id);
});

test("codeClip provider account binding repository requires explicit query client", async () => {
  await assert.rejects(
    () => findActiveCodeClipProviderAccountBinding({ provider: "meta", providerAccountId: "page-1" }),
    /explicit query client/
  );
});

test("codeClip provider account binding mask handles short and long account IDs", () => {
  assert.equal(maskCodeClipProviderAccountId(""), "");
  assert.equal(maskCodeClipProviderAccountId("1"), "••");
  assert.equal(maskCodeClipProviderAccountId("1234"), "•••4");
  assert.equal(maskCodeClipProviderAccountId("123456789"), "•••••6789");
});
