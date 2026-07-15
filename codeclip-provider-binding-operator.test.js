const test = require("node:test");
const assert = require("node:assert/strict");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);

const ADMIN_KEY = "codeclip-binding-admin-key";

const state = {
  campaigns: new Map(),
  bindings: [],
  nextBindingId: 1,
  fail: false,
};

function resetState() {
  state.campaigns.clear();
  state.bindings.length = 0;
  state.nextBindingId = 1;
  state.fail = false;
}

function addEvent(eventCode, vertical = "codeclip") {
  const row = {
    id: `event-${eventCode}`,
    event_code: eventCode,
    vertical,
    raw_event: {
      id: `event-${eventCode}`,
      code: eventCode,
      vertical,
    },
  };
  state.campaigns.set(eventCode, row);
  return row;
}

function addBinding({
  eventCode = "CC-BIND-OP",
  provider = "meta",
  channel = "instagram",
  providerAccountId = "account-secret-123456",
  status = "active",
  vertical = "codeclip",
  displayName = null,
} = {}) {
  const row = {
    id: String(state.nextBindingId++),
    vertical,
    event_code: eventCode,
    provider,
    channel,
    provider_account_id: providerAccountId,
    status,
    display_name: displayName,
    created_by: "operator",
    metadata: {},
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    disabled_at: status === "disabled" ? "2026-07-15T00:05:00.000Z" : null,
  };
  state.bindings.push(row);
  return row;
}

function activeRows(provider, providerAccountId) {
  return state.bindings.filter(
    (row) =>
      row.vertical === "codeclip" &&
      row.provider === provider &&
      row.provider_account_id === providerAccountId &&
      row.status === "active"
  );
}

const pool = {
  async query(sql, params = []) {
    if (state.fail) {
      throw new Error("forced provider binding database failure SELECT * FROM secrets");
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /provider_account_id = \$3/.test(sql) &&
      /status = 'active'/.test(sql)
    ) {
      return { rows: activeRows(params[1], params[2]).slice(0, 2) };
    }

    if (/INSERT INTO codeclip_provider_account_bindings/.test(sql)) {
      const existing = activeRows(params[2], params[4])[0];
      if (existing) {
        const error = new Error("duplicate active binding");
        error.code = "23505";
        throw error;
      }
      const row = addBinding({
        eventCode: params[1],
        provider: params[2],
        channel: params[3],
        providerAccountId: params[4],
        displayName: params[5],
      });
      row.created_by = params[6];
      row.metadata = JSON.parse(params[7]);
      return { rows: [row] };
    }

    if (/WHERE id = \$1/.test(sql) && /FROM codeclip_provider_account_bindings/.test(sql)) {
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      return { rows: row ? [row] : [] };
    }

    if (/UPDATE codeclip_provider_account_bindings/.test(sql)) {
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      if (!row) return { rows: [] };
      row.status = "disabled";
      row.disabled_at = row.disabled_at || "2026-07-15T00:05:00.000Z";
      row.updated_at = "2026-07-15T00:05:00.000Z";
      return { rows: [row] };
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /event_code = \$1/.test(sql)
    ) {
      let rows = state.bindings.filter(
        (row) => row.vertical === "codeclip" && row.event_code === params[0]
      );
      if (/AND status = 'active'/.test(sql)) {
        rows = rows.filter((row) => row.status === "active");
      }
      return { rows };
    }

    return { rows: [] };
  },
};

async function getCampaignByCode(eventCode) {
  if (state.fail) {
    throw new Error("forced campaign database failure SELECT * FROM campaigns");
  }
  return state.campaigns.get(eventCode) || null;
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool,
    getCampaignByCode,
    testDbConnection: async () => null,
    ensureCodePodGoldXtraRedemptionsTable: async () => null,
    ensureCodePodKeywordInteractionsTable: async () => null,
    ensureCodeClipProviderAccountBindingsTable: async () => null,
  },
};

const { app } = require("./server");

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withEnv(env, run) {
  const originals = {};
  for (const name of Object.keys(env)) {
    originals[name] = process.env[name];
    const value = env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      restoreEnv(name, value);
    }
  }
}

async function withServer(run) {
  resetState();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
    listeningServer.on("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withAuthorizedServer(run) {
  await withEnv({ CODECLIP_ADMIN_KEY: ADMIN_KEY }, async () => {
    await withServer(run);
  });
}

function adminHeaders(extra = {}) {
  return {
    "x-admin-key": ADMIN_KEY,
    ...extra,
  };
}

async function readJson(response) {
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function createBindingRequest(baseUrl, eventCode, body, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/events/${eventCode}/provider-bindings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function listBindingsRequest(baseUrl, eventCode, query = "", headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/events/${eventCode}/provider-bindings${query}`, {
      headers,
    })
  );
}

async function disableBindingRequest(baseUrl, bindingId, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}/disable`, {
      method: "POST",
      headers,
    })
  );
}

function validBody(overrides = {}) {
  return {
    provider: "meta",
    channel: "instagram",
    providerAccountId: "account-secret-123456",
    displayName: "Main Instagram",
    ...overrides,
  };
}

function assertNoLeaks(payload, rawAccountId = "account-secret-123456") {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(rawAccountId));
  assert.doesNotMatch(serialized, /SELECT|stack|forced provider binding database failure|x-admin-key|codeclip-binding-admin-key/i);
  assert.doesNotMatch(serialized, /codePod|codeTone|codeperks|screen video|PrintPoster/i);
}

test("codeClip provider binding operator authorization is fail-closed and accepts the configured admin key", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: undefined }, async () => {
    await withServer(async (baseUrl) => {
      addEvent("CC-AUTH");
      const missingConfig = await createBindingRequest(baseUrl, "CC-AUTH", validBody(), {});
      assert.equal(missingConfig.status, 503);
      assert.deepEqual(missingConfig.body, {
        ok: false,
        error: "Operator inspection unavailable",
      });
    });
  });

  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-AUTH");
    const route = `${baseUrl}/internal/codeclip/events/CC-AUTH/provider-bindings`;
    const missing = await readJson(await fetch(route));
    const wrong = await readJson(await fetch(route, { headers: { "x-admin-key": "wrong-key" } }));
    const allowed = await listBindingsRequest(baseUrl, "CC-AUTH");

    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { ok: false, error: "Unauthorized" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { ok: false, error: "Unauthorized" });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, { ok: true, eventCode: "CC-AUTH", bindings: [] });
  });
});

test("codeClip provider binding operator creates a safe Meta Instagram binding", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-CREATE");

    const response = await createBindingRequest(baseUrl, "CC-CREATE", validBody());

    assert.equal(response.status, 201);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.created, true);
    assert.equal(response.body.binding.eventCode, "CC-CREATE");
    assert.equal(response.body.binding.provider, "meta");
    assert.equal(response.body.binding.channel, "instagram");
    assert.equal(response.body.binding.status, "active");
    assert.equal(response.body.binding.displayName, "Main Instagram");
    assert.equal(response.body.binding.maskedAccountId.endsWith("3456"), true);
    assert.equal(response.body.binding.providerAccountId, undefined);
    assert.equal(state.bindings.length, 1);
    assertNoLeaks(response.body);
  });
});

test("codeClip provider binding operator rejects invalid create input safely", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-INVALID");

    const missingAccount = await createBindingRequest(baseUrl, "CC-INVALID", validBody({ providerAccountId: "" }));
    const invalidProvider = await createBindingRequest(baseUrl, "CC-INVALID", validBody({ provider: "test" }));
    const invalidChannel = await createBindingRequest(baseUrl, "CC-INVALID", validBody({ channel: "email" }));
    const invalidPair = await createBindingRequest(baseUrl, "CC-INVALID", {
      provider: "sms",
      channel: "instagram",
      providerAccountId: "+15551234567",
    });

    for (const response of [missingAccount, invalidProvider, invalidChannel, invalidPair]) {
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        ok: false,
        error: "Invalid provider binding request",
      });
      assertNoLeaks(response.body);
    }
    assert.equal(state.bindings.length, 0);
  });
});

test("codeClip provider binding operator uses URL eventCode and hides inaccessible events", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-URL");
    addEvent("CC-BODY");
    addEvent("CP-OTHER", "codepod");

    const response = await createBindingRequest(baseUrl, "CC-URL", validBody({ eventCode: "CC-BODY" }));
    const missing = await createBindingRequest(baseUrl, "CC-MISSING", validBody());
    const foreign = await createBindingRequest(baseUrl, "CP-OTHER", validBody());

    assert.equal(response.status, 201);
    assert.equal(response.body.binding.eventCode, "CC-URL");
    assert.equal(state.bindings[0].event_code, "CC-URL");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { ok: false, error: "Event not found" });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { ok: false, error: "Event not found" });
    assertNoLeaks(missing.body);
    assertNoLeaks(foreign.body);
  });
});

test("codeClip provider binding operator create is idempotent only for exact active binding", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-IDEM");

    const created = await createBindingRequest(baseUrl, "CC-IDEM", validBody());
    const repeated = await createBindingRequest(baseUrl, "CC-IDEM", validBody({ displayName: "Ignored" }));
    const incompatible = await createBindingRequest(baseUrl, "CC-IDEM", validBody({ channel: "messenger" }));

    assert.equal(created.status, 201);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.created, false);
    assert.equal(repeated.body.binding.id, created.body.binding.id);
    assert.equal(state.bindings.length, 1);
    assert.equal(incompatible.status, 409);
    assert.deepEqual(incompatible.body, {
      ok: false,
      error: "Provider account binding conflict",
    });
  });
});

test("codeClip provider binding operator returns conflict for provider account bound to another Episode", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-A");
    addEvent("CC-B");
    await createBindingRequest(baseUrl, "CC-A", validBody());

    const conflict = await createBindingRequest(baseUrl, "CC-B", validBody());

    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, {
      ok: false,
      error: "Provider account binding conflict",
    });
    assert.equal(state.bindings.length, 1);
    assertNoLeaks(conflict.body);
  });
});

test("codeClip provider binding operator list is event isolated and masks account ids", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-LIST");
    addEvent("CC-EMPTY");
    addEvent("CP-LIST", "codepod");
    const active = addBinding({ eventCode: "CC-LIST", providerAccountId: "list-secret-123456" });
    addBinding({ eventCode: "CC-LIST", providerAccountId: "list-disabled-123456", status: "disabled" });
    addBinding({ eventCode: "CC-OTHER", providerAccountId: "other-secret-123456" });

    const listed = await listBindingsRequest(baseUrl, "CC-LIST");
    const withDisabled = await listBindingsRequest(baseUrl, "CC-LIST", "?includeDisabled=true");
    const falseQuery = await listBindingsRequest(baseUrl, "CC-LIST", "?includeDisabled=1");
    const empty = await listBindingsRequest(baseUrl, "CC-EMPTY");
    const missing = await listBindingsRequest(baseUrl, "CC-MISSING");
    const foreign = await listBindingsRequest(baseUrl, "CP-LIST");

    assert.equal(listed.status, 200);
    assert.equal(listed.body.bindings.length, 1);
    assert.equal(listed.body.bindings[0].id, active.id);
    assert.equal(listed.body.bindings[0].providerAccountId, undefined);
    assert.equal(withDisabled.body.bindings.length, 2);
    assert.equal(falseQuery.body.bindings.length, 1);
    assert.deepEqual(empty.body, { ok: true, eventCode: "CC-EMPTY", bindings: [] });
    assert.equal(missing.status, 404);
    assert.equal(foreign.status, 404);
    assertNoLeaks(listed.body, "list-secret-123456");
    assertNoLeaks(withDisabled.body, "list-disabled-123456");
  });
});

test("codeClip provider binding operator disables bindings idempotently", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-DISABLE");
    const binding = addBinding({ eventCode: "CC-DISABLE", providerAccountId: "disable-secret-123456" });
    const foreign = addBinding({
      eventCode: "CP-DISABLE",
      providerAccountId: "foreign-secret-123456",
      vertical: "codepod",
    });

    const disabled = await disableBindingRequest(baseUrl, binding.id);
    const repeated = await disableBindingRequest(baseUrl, binding.id);
    const missing = await disableBindingRequest(baseUrl, "missing-binding");
    const foreignResponse = await disableBindingRequest(baseUrl, foreign.id);

    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.binding.status, "disabled");
    assert.ok(disabled.body.binding.disabledAt);
    assert.equal(activeRows("meta", "disable-secret-123456").length, 0);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.binding.status, "disabled");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { ok: false, error: "Provider binding not found" });
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(foreignResponse.body, { ok: false, error: "Provider binding not found" });
    assertNoLeaks(disabled.body, "disable-secret-123456");
  });
});

test("codeClip provider binding operator database failures are public-safe", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-FAIL");
    const binding = addBinding({ eventCode: "CC-FAIL", providerAccountId: "fail-secret-123456" });
    state.fail = true;

    const create = await createBindingRequest(baseUrl, "CC-FAIL", validBody({ providerAccountId: "fail-create-123456" }));
    const list = await listBindingsRequest(baseUrl, "CC-FAIL");
    const disable = await disableBindingRequest(baseUrl, binding.id);

    for (const response of [create, list, disable]) {
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        ok: false,
        error: "Provider binding operation unavailable",
      });
      assertNoLeaks(response.body, "fail-secret-123456");
    }
  });
});
