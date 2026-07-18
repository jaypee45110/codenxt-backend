const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipProviderAccountBindingsTable } = require("./db");
const {
  CodeClipProviderAccountBindingError,
  createCodeClipProviderAccountBinding,
  disableCodeClipProviderAccountBinding,
  findActiveCodeClipProviderAccountBinding,
  listCodeClipProviderAccountBindings,
  listCodeClipProviderAccountBindingsForEvent,
  maskCodeClipProviderAccountId,
  normalizeCodeClipProviderAccountBindingInput,
  reactivateCodeClipProviderAccountBinding,
  toPublicCodeClipProviderBinding,
  updateCodeClipProviderAccountBinding,
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

  function findActiveRows(provider, providerAccountId) {
    return rows.filter(
      (row) =>
        row.vertical === "codeclip" &&
        row.provider === provider &&
        row.provider_account_id === providerAccountId &&
        row.status === "active"
    );
  }

  function findActive(provider, providerAccountId) {
    return findActiveRows(provider, providerAccountId)[0] || null;
  }

  function findById(id) {
    return rows.find((row) => String(row.id) === String(id) && row.vertical === "codeclip") || null;
  }

  function sortByUpdatedAndIdDesc(left, right) {
    if (left.updated_at === right.updated_at) {
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);

      if (rightId > leftId) return 1;
      if (rightId < leftId) return -1;
      return 0;
    }

    return String(right.updated_at).localeCompare(String(left.updated_at));
  }

  function unescapeLikeLiteral(value) {
    return String(value || "")
      .replace(/^%|%$/g, "")
      .replace(/\\([\\%_])/g, "$1");
  }

  return {
    calls,
    rows,
    failReactivateUniqueViolation: false,
    reactivateReturnsNoRows: false,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT/.test(sql)) {
        return { rows: [] };
      }

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
        /AND status = 'active'/.test(sql)
      ) {
        return { rows: findActiveRows(params[1], params[2]).slice(0, 2) };
      }

      if (
        /FROM codeclip_provider_account_bindings/.test(sql) &&
        /provider_account_id = \$3/.test(sql) &&
        /ORDER BY status = 'active' DESC/.test(sql)
      ) {
        const result = rows
          .filter(
            (row) =>
              row.vertical === params[0] &&
              row.provider === params[1] &&
              row.provider_account_id === params[2]
          )
          .slice()
          .sort((left, right) => {
            if (left.status !== right.status) {
              return left.status === "active" ? -1 : 1;
            }
            return sortByUpdatedAndIdDesc(left, right);
          });
        return { rows: result.slice(0, 3) };
      }

      if (/WHERE id = \$1/.test(sql) && /FROM codeclip_provider_account_bindings/.test(sql)) {
        const row = findById(params[0]);
        return { rows: row ? [row] : [] };
      }

      if (/UPDATE codeclip_provider_account_bindings/.test(sql) && /display_name = \$2/.test(sql)) {
        const row = findById(params[0]);
        if (!row) return { rows: [] };
        row.display_name = params[1];
        row.updated_at = "2026-07-14T02:00:00.000Z";
        return { rows: [row] };
      }

      if (/UPDATE codeclip_provider_account_bindings/.test(sql) && /status = 'active'/.test(sql)) {
        if (this.reactivateReturnsNoRows) return { rows: [] };
        const row = findById(params[0]);
        if (!row) return { rows: [] };
        if (this.failReactivateUniqueViolation) {
          rows.push(
            createBindingRow({
              id: nextId++,
              event_code: "CC-BIND-WINNER",
              provider: row.provider,
              channel: row.channel,
              provider_account_id: row.provider_account_id,
              status: "active",
            })
          );
          const error = new Error("duplicate active binding");
          error.code = "23505";
          throw error;
        }
        row.status = "active";
        row.disabled_at = null;
        row.updated_at = "2026-07-14T02:00:00.000Z";
        return { rows: [row] };
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
        /ORDER BY updated_at DESC, id DESC/.test(sql)
      ) {
        let paramIndex = 0;
        const verticalParam = params[paramIndex++];
        let result = rows.filter((row) => row.vertical === verticalParam);
        if (/event_code =/.test(sql)) {
          const eventCodeParam = params[paramIndex++];
          result = result.filter((row) => row.event_code === eventCodeParam);
        }
        if (/provider =/.test(sql)) {
          const providerParam = params[paramIndex++];
          result = result.filter((row) => row.provider === providerParam);
        }
        if (/channel =/.test(sql)) {
          const channelParam = params[paramIndex++];
          result = result.filter((row) => row.channel === channelParam);
        }
        if (/status =/.test(sql)) {
          const statusParam = params[paramIndex++];
          result = result.filter((row) => row.status === statusParam);
        }
        if (/LOWER\(event_code\) LIKE/.test(sql)) {
          const search = unescapeLikeLiteral(params[paramIndex++]);
          result = result.filter((row) =>
            [row.event_code, row.provider, row.channel, row.display_name || ""]
              .map((value) => String(value).toLowerCase())
              .some((value) => value.includes(search))
          );
        }
        if (/updated_at </.test(sql)) {
          const cursorUpdatedAt = params[paramIndex++];
          const cursorId = params[paramIndex++];
          result = result.filter(
            (row) =>
              row.updated_at < cursorUpdatedAt ||
              (row.updated_at === cursorUpdatedAt && BigInt(row.id) < BigInt(cursorId))
          );
        }
        const limit = params[params.length - 1];
        return { rows: result.slice().sort(sortByUpdatedAndIdDesc).slice(0, limit) };
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

  assert.equal(client.calls.length, 9);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_provider_account_bindings/);
  assert.match(client.calls[0].sql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(client.calls[0].sql, /CHECK \(status IN \('active', 'disabled'\)\)/);
  assert.match(client.calls[0].sql, /provider = 'meta' AND channel IN \('instagram', 'messenger', 'whatsapp'\)/);
  assert.match(client.calls[0].sql, /provider = 'sms' AND channel = 'sms'/);
  assert.match(client.calls[1].sql, /DROP CONSTRAINT IF EXISTS codeclip_provider_account_bindings_provider_check/);
  assert.match(client.calls[2].sql, /DROP CONSTRAINT IF EXISTS codeclip_provider_account_bindings_check/);
  assert.match(client.calls[3].sql, /DROP CONSTRAINT IF EXISTS codeclip_provider_account_bindings_provider_channel_check/);
  assert.match(client.calls[4].sql, /ADD CONSTRAINT codeclip_provider_account_bindings_provider_check/);
  assert.match(client.calls[4].sql, /provider IN \('meta', 'sms', 'youtube'\)/);
  assert.match(client.calls[5].sql, /ADD CONSTRAINT codeclip_provider_account_bindings_provider_channel_check/);
  assert.match(client.calls[5].sql, /provider = 'youtube' AND channel = 'youtube'/);
  assert.match(client.calls[6].sql, /codeclip_provider_account_bindings_active_identity_idx/);
  assert.match(client.calls[6].sql, /vertical, provider, provider_account_id/);
  assert.match(client.calls[6].sql, /WHERE status = 'active'/);
  assert.match(client.calls[7].sql, /codeclip_provider_account_bindings_event_code_idx/);
  assert.match(client.calls[8].sql, /codeclip_provider_account_bindings_status_idx/);
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
      assert.equal(error.details.eventCode, "CC-BIND-1");
      assert.equal(error.details.channel, "instagram");
      assert.equal(error.details.status, "active");
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

test("codeClip provider account binding active lookup detects ambiguous active rows", async () => {
  const client = createBindingClient();
  client.rows.push(
    createBindingRow({ id: 1, event_code: "CC-BIND-1" }),
    createBindingRow({ id: 2, event_code: "CC-BIND-2" })
  );

  await assert.rejects(
    () =>
      findActiveCodeClipProviderAccountBinding(
        { provider: "meta", providerAccountId: "page-1" },
        { queryClient: client }
      ),
    (error) => {
      assert.equal(error.code, "PROVIDER_ACCOUNT_BINDING_AMBIGUOUS");
      return true;
    }
  );
});

test("codeClip provider account binding requires reactivation for disabled identity", async () => {
  const client = createBindingClient();
  const first = await createBinding(client);
  await disableCodeClipProviderAccountBinding(first.row.id, { queryClient: client });

  await assert.rejects(
    () => createBinding(client, { eventCode: "CC-BIND-2" }),
    (error) => {
      assert.equal(error.code, "PROVIDER_ACCOUNT_BINDING_CONFLICT");
      assert.equal(error.details.reactivationRequired, true);
      assert.equal(error.details.bindingId, first.row.id);
      return true;
    }
  );
  const active = await findActiveCodeClipProviderAccountBinding(
    { provider: "meta", providerAccountId: "page-1" },
    { queryClient: client }
  );

  assert.equal(active, null);
  assert.equal(client.rows.filter((row) => row.status === "active").length, 0);
  assert.equal(client.rows.filter((row) => row.status === "disabled").length, 1);
});

test("codeClip provider account binding global list filters searches and paginates safely", async () => {
  const client = createBindingClient();
  client.rows.push(
    createBindingRow({
      id: "9007199254740992",
      event_code: "CC-LIST-A",
      provider_account_id: "raw-account-a",
      display_name: "Literal 100% match",
      updated_at: "2026-07-16T00:00:00.000Z",
    }),
    createBindingRow({
      id: "9007199254740993",
      event_code: "CC-LIST-B",
      provider: "legacy_provider",
      channel: "legacy_channel",
      provider_account_id: "raw-account-b",
      display_name: "Historical value",
      updated_at: "2026-07-16T00:00:00.000Z",
    }),
    createBindingRow({
      id: "9007199254740994",
      event_code: "CC-LIST-A",
      provider: "sms",
      channel: "sms",
      provider_account_id: "raw-account-c",
      status: "disabled",
      display_name: "Disabled SMS",
      updated_at: "2026-07-15T00:00:00.000Z",
    })
  );

  const firstPage = await listCodeClipProviderAccountBindings(
    { limit: 1 },
    { queryClient: client }
  );
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].id, "9007199254740993");
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);

  const secondPage = await listCodeClipProviderAccountBindings(
    { limit: 1, cursor: firstPage.page.nextCursor },
    { queryClient: client }
  );
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0].id, "9007199254740992");
  assert.equal(secondPage.page.hasMore, true);
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);

  const providerFilter = await listCodeClipProviderAccountBindings(
    { provider: "legacy_provider" },
    { queryClient: client }
  );
  assert.equal(providerFilter.items.length, 1);
  assert.equal(providerFilter.items[0].provider, "legacy_provider");
  assert.equal(providerFilter.items[0].channel, "legacy_channel");

  const eventStatusFilter = await listCodeClipProviderAccountBindings(
    { eventCode: "CC-LIST-A", status: "disabled" },
    { queryClient: client }
  );
  assert.equal(eventStatusFilter.items.length, 1);
  assert.equal(eventStatusFilter.items[0].status, "disabled");

  const literalSearch = await listCodeClipProviderAccountBindings(
    { search: "100%" },
    { queryClient: client }
  );
  assert.equal(literalSearch.items.length, 1);
  assert.equal(literalSearch.items[0].displayName, "Literal 100% match");

  const publicBinding = toPublicCodeClipProviderBinding(firstPage.items[0]);
  assert.equal(publicBinding.providerAccountId, undefined);
  assert.equal(publicBinding.vertical, "codeclip");
  assert.equal(JSON.stringify(publicBinding).includes("raw-account-b"), false);
});

test("codeClip provider account binding update only changes display name", async () => {
  const client = createBindingClient();
  const created = await createBinding(client, {
    displayName: "Old label",
  });
  const before = { ...client.rows[0] };

  const updated = await updateCodeClipProviderAccountBinding(
    created.row.id,
    { displayName: " New label " },
    { queryClient: client }
  );

  assert.equal(updated.id, created.row.id);
  assert.equal(updated.displayName, "New label");
  assert.equal(updated.updatedAt, "2026-07-14T02:00:00.000Z");
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].event_code, before.event_code);
  assert.equal(client.rows[0].provider, before.provider);
  assert.equal(client.rows[0].channel, before.channel);
  assert.equal(client.rows[0].provider_account_id, before.provider_account_id);
  assert.equal(client.rows[0].status, before.status);
});

test("codeClip provider account binding update clears display name with empty string or null", async () => {
  const client = createBindingClient();
  const created = await createBinding(client, {
    displayName: "Old label",
  });

  const empty = await updateCodeClipProviderAccountBinding(
    created.row.id,
    { displayName: "" },
    { queryClient: client }
  );
  const nullValue = await updateCodeClipProviderAccountBinding(
    created.row.id,
    { displayName: null },
    { queryClient: client }
  );

  assert.equal(empty.displayName, null);
  assert.equal(nullValue.displayName, null);
  assert.equal(client.rows[0].display_name, null);
});

test("codeClip provider account binding update rejects missing or undefined displayName", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);

  for (const input of [{}, { displayName: undefined }, null]) {
    await assert.rejects(
      () => updateCodeClipProviderAccountBinding(created.row.id, input, { queryClient: client }),
      (error) => {
        assert.ok(error instanceof CodeClipProviderAccountBindingError);
        assert.equal(error.code, "INVALID_PROVIDER_BINDING");
        return true;
      }
    );
  }
});

test("codeClip provider account binding reactivates disabled row in place", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);
  const disabled = await disableCodeClipProviderAccountBinding(created.row.id, { queryClient: client });

  const result = await reactivateCodeClipProviderAccountBinding(created.row.id, { queryClient: client });

  assert.equal(result.reactivated, true);
  assert.equal(result.row.id, created.row.id);
  assert.equal(result.row.status, "active");
  assert.equal(result.row.disabledAt, null);
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].id, created.row.id);
  assert.equal(client.rows[0].disabled_at, null);
  assert.notEqual(disabled.disabledAt, null);
});

test("codeClip provider account binding reactivation is idempotent for active row", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);

  const result = await reactivateCodeClipProviderAccountBinding(created.row.id, { queryClient: client });

  assert.equal(result.reactivated, false);
  assert.equal(result.row.id, created.row.id);
  assert.equal(result.row.status, "active");
  assert.equal(
    client.calls.some((call) => /UPDATE codeclip_provider_account_bindings/.test(call.sql)),
    false
  );
});

test("codeClip provider account binding reactivation conflict leaves disabled row unchanged", async () => {
  const client = createBindingClient();
  const first = await createBinding(client);
  const disabled = await disableCodeClipProviderAccountBinding(first.row.id, { queryClient: client });
  client.rows.push(
    createBindingRow({
      id: 2,
      event_code: "CC-BIND-2",
      provider: "meta",
      channel: "instagram",
      provider_account_id: "page-1",
      status: "active",
    })
  );

  await assert.rejects(
    () => reactivateCodeClipProviderAccountBinding(first.row.id, { queryClient: client }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderAccountBindingError);
      assert.equal(error.code, "PROVIDER_ACCOUNT_BINDING_CONFLICT");
      assert.equal(error.details.eventCode, "CC-BIND-2");
      assert.equal(error.details.channel, "instagram");
      assert.equal(error.details.status, "active");
      return true;
    }
  );

  assert.equal(client.rows[0].id, first.row.id);
  assert.equal(client.rows[0].status, "disabled");
  assert.equal(client.rows[0].disabled_at, disabled.disabledAt);
  assert.equal(client.rows[0].event_code, "CC-BIND-1");
  assert.equal(client.rows[0].provider, "meta");
  assert.equal(client.rows[0].channel, "instagram");
  assert.equal(client.rows[0].provider_account_id, "page-1");
});

test("codeClip provider account binding reactivation maps unique violation to conflict", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);
  const disabled = await disableCodeClipProviderAccountBinding(created.row.id, { queryClient: client });
  client.failReactivateUniqueViolation = true;

  await assert.rejects(
    () => reactivateCodeClipProviderAccountBinding(created.row.id, { queryClient: client }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderAccountBindingError);
      assert.equal(error.code, "PROVIDER_ACCOUNT_BINDING_CONFLICT");
      assert.equal(error.details.eventCode, "CC-BIND-WINNER");
      assert.equal(error.details.channel, "instagram");
      assert.equal(error.details.status, "active");
      return true;
    }
  );

  assert.equal(client.rows[0].status, "disabled");
  assert.equal(client.rows[0].disabled_at, disabled.disabledAt);
  assert.equal(client.rows[0].event_code, "CC-BIND-1");
  assert.equal(client.rows[0].provider, "meta");
  assert.equal(client.rows[0].channel, "instagram");
  assert.equal(client.rows[0].provider_account_id, "page-1");
});

test("codeClip provider account binding reactivation does not report success without row", async () => {
  const client = createBindingClient();
  const created = await createBinding(client);
  await disableCodeClipProviderAccountBinding(created.row.id, { queryClient: client });
  client.reactivateReturnsNoRows = true;

  const result = await reactivateCodeClipProviderAccountBinding(created.row.id, { queryClient: client });

  assert.deepEqual(result, { reactivated: false, row: null });
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

test("codeClip provider account binding repository operations do not initialize schema", async () => {
  const client = createBindingClient();

  await createBinding(client);
  await findActiveCodeClipProviderAccountBinding(
    { provider: "meta", providerAccountId: "page-1" },
    { queryClient: client }
  );
  await listCodeClipProviderAccountBindingsForEvent("CC-BIND-1", { queryClient: client });
  await disableCodeClipProviderAccountBinding(1, { queryClient: client });

  assert.equal(
    client.calls.some((call) => /CREATE TABLE|CREATE INDEX/.test(call.sql)),
    false
  );
});

test("codeClip provider account binding mask handles short and long account IDs", () => {
  assert.equal(maskCodeClipProviderAccountId(""), "");
  assert.equal(maskCodeClipProviderAccountId("1"), "••");
  assert.equal(maskCodeClipProviderAccountId("1234"), "•••4");
  assert.equal(maskCodeClipProviderAccountId("123456789"), "•••••6789");
});
