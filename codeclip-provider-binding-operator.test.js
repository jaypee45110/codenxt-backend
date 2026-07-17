const test = require("node:test");
const assert = require("node:assert/strict");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);

const ADMIN_KEY = "codeclip-binding-admin-key";

const state = {
  campaigns: new Map(),
  bindings: [],
  auditRows: [],
  nextBindingId: 1,
  nextAuditId: 1,
  fail: false,
  failAudit: false,
  failReactivateUniqueViolation: false,
  reactivateReturnsNoRows: false,
  transactionLog: [],
  auditInsertUsedTransaction: false,
  bindingMutationUsedTransaction: false,
  nextTransactionId: 1,
  createRaceProviderAccountId: null,
  createRaceInserted: false,
  createRaceWaiters: [],
  reactivateRaceProviderAccountId: null,
  reactivateRaceWaiters: [],
};

function resetState() {
  state.campaigns.clear();
  state.bindings.length = 0;
  state.auditRows.length = 0;
  state.nextBindingId = 1;
  state.nextAuditId = 1;
  state.fail = false;
  state.failAudit = false;
  state.failReactivateUniqueViolation = false;
  state.reactivateReturnsNoRows = false;
  state.transactionLog.length = 0;
  state.auditInsertUsedTransaction = false;
  state.bindingMutationUsedTransaction = false;
  state.nextTransactionId = 1;
  state.createRaceProviderAccountId = null;
  state.createRaceInserted = false;
  state.createRaceWaiters.length = 0;
  state.reactivateRaceProviderAccountId = null;
  state.reactivateRaceWaiters.length = 0;
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

function cloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}

function recordInsertedBinding(queryClient, row) {
  if (!queryClient.transactionJournal) return;
  queryClient.transactionJournal.insertedBindingIds.push(String(row.id));
}

function recordInsertedAudit(queryClient, row) {
  if (!queryClient.transactionJournal) return;
  queryClient.transactionJournal.insertedAuditIds.push(String(row.id));
}

function recordBindingBeforeUpdate(queryClient, row) {
  const journal = queryClient.transactionJournal;
  if (!journal) return;
  const rowId = String(row.id);
  if (journal.insertedBindingIds.includes(rowId)) return;
  if (!journal.updatedBindings.has(rowId)) {
    journal.updatedBindings.set(rowId, {
      before: cloneRow(row),
      after: null,
    });
  }
}

function recordBindingAfterUpdate(queryClient, row) {
  const journal = queryClient.transactionJournal;
  if (!journal) return;
  const rowId = String(row.id);
  const entry = journal.updatedBindings.get(rowId);
  if (!entry) return;
  row.__lastMutationTxId = queryClient.transactionId;
  entry.after = cloneRow(row);
}

function waitForRace(waiters, expectedCount = 2) {
  return new Promise((resolve, reject) => {
    const entry = { resolve: null, reject };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("race barrier timed out"));
    }, 1000);

    entry.resolve = () => {
      clearTimeout(timer);
      resolve();
    };

    waiters.push(entry);
    if (waiters.length >= expectedCount) {
      const entries = waiters.splice(0, waiters.length);
      for (const waiter of entries) waiter.resolve();
    }
  });
}

const pool = {
  isTransactionClient: false,
  async query(sql, params = []) {
    if (/SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT/.test(sql)) {
      state.transactionLog.push(sql.trim());
      return { rows: [] };
    }

    if (state.fail) {
      throw new Error("forced provider binding database failure SELECT * FROM secrets");
    }

    if (/INSERT INTO codeclip_provider_account_binding_audit/.test(sql)) {
      if (state.failAudit) {
        throw new Error("forced provider binding audit failure INSERT secret token");
      }
      state.auditInsertUsedTransaction = Boolean(this.isTransactionClient);
      const row = {
        id: String(state.nextAuditId++),
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
        created_at: `2026-07-15T00:20:0${state.nextAuditId}.000Z`,
      };
      state.auditRows.push(row);
      recordInsertedAudit(this, row);
      return { rows: [row] };
    }

    if (/FROM codeclip_provider_account_binding_audit/.test(sql)) {
      let rows = state.auditRows.filter((row) => row.vertical === "codeclip");
      if (/binding_id =/.test(sql)) {
        rows = rows.filter((row) => row.binding_id === String(params[1]));
      }
      if (/event_code =/.test(sql)) {
        rows = rows.filter((row) => row.event_code === String(params[1]));
      }
      return {
        rows: rows
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
          .slice(0, Number(params[params.length - 1])),
      };
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /provider_account_id = \$3/.test(sql) &&
      /AND status = 'active'/.test(sql)
    ) {
      return { rows: activeRows(params[1], params[2]).slice(0, 2) };
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /provider_account_id = \$3/.test(sql) &&
      /ORDER BY status = 'active' DESC/.test(sql)
    ) {
      const rows = state.bindings
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
      return { rows: rows.slice(0, 3) };
    }

    if (/INSERT INTO codeclip_provider_account_bindings/.test(sql)) {
      state.bindingMutationUsedTransaction = Boolean(this.isTransactionClient);
      const existing = activeRows(params[2], params[4])[0];
      if (existing) {
        const error = new Error("duplicate active binding");
        error.code = "23505";
        throw error;
      }
      if (state.createRaceProviderAccountId === params[4]) {
        await waitForRace(state.createRaceWaiters);
        if (state.createRaceInserted || activeRows(params[2], params[4]).length > 0) {
          const error = new Error("duplicate active binding");
          error.code = "23505";
          throw error;
        }
        state.createRaceInserted = true;
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
      recordInsertedBinding(this, row);
      return { rows: [row] };
    }

    if (/WHERE id = \$1/.test(sql) && /FROM codeclip_provider_account_bindings/.test(sql)) {
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      return { rows: row ? [row] : [] };
    }

    if (/UPDATE codeclip_provider_account_bindings/.test(sql) && /display_name = \$2/.test(sql)) {
      state.bindingMutationUsedTransaction = Boolean(this.isTransactionClient);
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      if (!row) return { rows: [] };
      recordBindingBeforeUpdate(this, row);
      row.display_name = params[1];
      row.updated_at = "2026-07-15T00:10:00.000Z";
      recordBindingAfterUpdate(this, row);
      return { rows: [row] };
    }

    if (/UPDATE codeclip_provider_account_bindings/.test(sql) && /status = 'active'/.test(sql)) {
      state.bindingMutationUsedTransaction = Boolean(this.isTransactionClient);
      if (state.reactivateReturnsNoRows) return { rows: [] };
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      if (!row) return { rows: [] };
      if (state.failReactivateUniqueViolation) {
        addBinding({
          eventCode: "CC-REACTIVATE-23505-WINNER",
          provider: row.provider,
          channel: row.channel,
          providerAccountId: row.provider_account_id,
        });
        const error = new Error("duplicate active binding");
        error.code = "23505";
        throw error;
      }
      if (state.reactivateRaceProviderAccountId === row.provider_account_id) {
        await waitForRace(state.reactivateRaceWaiters);
        if (
          activeRows(row.provider, row.provider_account_id).some(
            (item) => String(item.id) !== String(row.id)
          )
        ) {
          const error = new Error("duplicate active binding");
          error.code = "23505";
          throw error;
        }
      }
      recordBindingBeforeUpdate(this, row);
      row.status = "active";
      row.disabled_at = null;
      row.updated_at = "2026-07-15T00:10:00.000Z";
      recordBindingAfterUpdate(this, row);
      return { rows: [row] };
    }

    if (/UPDATE codeclip_provider_account_bindings/.test(sql)) {
      state.bindingMutationUsedTransaction = Boolean(this.isTransactionClient);
      const row =
        state.bindings.find(
          (item) => String(item.id) === String(params[0]) && item.vertical === "codeclip"
        ) || null;
      if (!row) return { rows: [] };
      recordBindingBeforeUpdate(this, row);
      row.status = "disabled";
      row.disabled_at = row.disabled_at || "2026-07-15T00:05:00.000Z";
      row.updated_at = "2026-07-15T00:05:00.000Z";
      recordBindingAfterUpdate(this, row);
      return { rows: [row] };
    }

    if (
      /FROM codeclip_provider_account_bindings/.test(sql) &&
      /ORDER BY updated_at DESC, id DESC/.test(sql)
    ) {
      let paramIndex = 0;
      const verticalParam = params[paramIndex++];
      let rows = state.bindings.filter((row) => row.vertical === verticalParam);
      if (/event_code =/.test(sql)) {
        const eventCodeParam = params[paramIndex++];
        rows = rows.filter((row) => row.event_code === eventCodeParam);
      }
      if (/provider =/.test(sql)) {
        const providerParam = params[paramIndex++];
        rows = rows.filter((row) => row.provider === providerParam);
      }
      if (/channel =/.test(sql)) {
        const channelParam = params[paramIndex++];
        rows = rows.filter((row) => row.channel === channelParam);
      }
      if (/status =/.test(sql)) {
        const statusParam = params[paramIndex++];
        rows = rows.filter((row) => row.status === statusParam);
      }
      if (/LOWER\(event_code\) LIKE/.test(sql)) {
        const search = unescapeLikeLiteral(params[paramIndex++]);
        rows = rows.filter((row) =>
          [row.event_code, row.provider, row.channel, row.display_name || ""]
            .map((value) => String(value).toLowerCase())
            .some((value) => value.includes(search))
        );
      }
      if (/updated_at </.test(sql)) {
        const cursorUpdatedAt = params[paramIndex++];
        const cursorId = params[paramIndex++];
        rows = rows.filter(
          (row) =>
            row.updated_at < cursorUpdatedAt ||
            (row.updated_at === cursorUpdatedAt && BigInt(row.id) < BigInt(cursorId))
        );
      }
      const limit = params[params.length - 1];
      return { rows: rows.slice().sort(sortByUpdatedAndIdDesc).slice(0, limit) };
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

async function withCodeClipCorePersistenceTransaction(work) {
  const transactionJournal = {
    insertedBindingIds: [],
    insertedAuditIds: [],
    updatedBindings: new Map(),
  };
  const queryClient = Object.create(pool);
  queryClient.isTransactionClient = true;
  queryClient.transactionId = state.nextTransactionId++;
  queryClient.transactionJournal = transactionJournal;
  try {
    state.transactionLog.push("BEGIN");
    const result = await work({ queryClient });
    state.transactionLog.push("COMMIT");
    for (const [rowId] of transactionJournal.updatedBindings) {
      const current = state.bindings.find((row) => String(row.id) === rowId);
      if (current && current.__lastMutationTxId === queryClient.transactionId) {
        delete current.__lastMutationTxId;
      }
    }
    return result;
  } catch (error) {
    state.transactionLog.push("ROLLBACK");
    state.bindings = state.bindings.filter(
      (row) => !transactionJournal.insertedBindingIds.includes(String(row.id))
    );
    state.auditRows = state.auditRows.filter(
      (row) => !transactionJournal.insertedAuditIds.includes(String(row.id))
    );
    for (const [rowId, entry] of transactionJournal.updatedBindings) {
      const current = state.bindings.find((row) => String(row.id) === rowId);
      if (current && current.__lastMutationTxId === queryClient.transactionId) {
        Object.assign(current, cloneRow(entry.before));
        delete current.__lastMutationTxId;
      }
    }
    throw error;
  }
}

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
    ensureCodeClipProviderAccountBindingAuditTable: async () => null,
    withCodeClipCorePersistenceTransaction,
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

async function globalCreateBindingRequest(baseUrl, body, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function globalListBindingsRequest(baseUrl, query = "", headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings${query}`, {
      headers,
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

async function getBindingRequest(baseUrl, bindingId, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}`, {
      headers,
    })
  );
}

async function updateBindingRequest(baseUrl, bindingId, body, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function updateBindingRawRequest(baseUrl, bindingId, rawBody, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: rawBody,
    })
  );
}

async function reactivateBindingRequest(baseUrl, bindingId, headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}/reactivate`, {
      method: "POST",
      headers,
    })
  );
}

async function bindingAuditRequest(baseUrl, bindingId, query = "", headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/provider-bindings/${bindingId}/audit${query}`, {
      headers,
    })
  );
}

async function eventAuditRequest(baseUrl, eventCode, query = "", headers = adminHeaders()) {
  return readJson(
    await fetch(`${baseUrl}/internal/codeclip/events/${eventCode}/provider-binding-audit${query}`, {
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

function assertStructuredValidationError(response) {
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Invalid provider binding request.",
      details: {},
    },
  });
}

function assertProviderBindingNotFound(response) {
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { ok: false, error: "Provider binding not found" });
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

test("test transaction rollback restores its own update and preserves sequence gaps", async () => {
  resetState();
  const binding = addBinding({
    eventCode: "CC-TX-ROLLBACK",
    providerAccountId: "tx-rollback-secret-123456",
    displayName: "Before",
  });
  const nextBeforeTransaction = state.nextBindingId;

  await assert.rejects(
    () =>
      withCodeClipCorePersistenceTransaction(async ({ queryClient }) => {
        await queryClient.query(
          "UPDATE codeclip_provider_account_bindings SET display_name = $2 WHERE id = $1 RETURNING *",
          [binding.id, "Temporary"]
        );
        await queryClient.query(
          "INSERT INTO codeclip_provider_account_bindings VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            "codeclip",
            "CC-TX-ROLLBACK",
            "meta",
            "messenger",
            "tx-rollback-insert-123456",
            null,
            "operator_key",
            "{}",
          ]
        );
        await queryClient.query(
          "INSERT INTO codeclip_provider_account_binding_audit VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            "codeclip",
            binding.id,
            "CC-TX-ROLLBACK",
            "meta",
            "instagram",
            "display_name_updated",
            "operator_key",
            null,
            JSON.stringify({ displayName: "Before" }),
            JSON.stringify({ displayName: "Temporary" }),
            "{}",
          ]
        );
        throw new Error("rollback transaction");
      }),
    /rollback transaction/
  );

  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].id, binding.id);
  assert.equal(state.bindings[0].display_name, "Before");
  assert.equal(state.bindings[0].__lastMutationTxId, undefined);
  assert.equal(state.auditRows.length, 0);
  assert.equal(state.nextBindingId, nextBeforeTransaction + 1);
});

test("test transaction rollback does not overwrite later committed updates", async () => {
  resetState();
  const binding = addBinding({
    eventCode: "CC-TX-ISOLATED",
    providerAccountId: "tx-isolated-secret-123456",
    displayName: "Before",
  });
  let releaseTransactionA;
  let transactionAReady;
  const transactionAReadyPromise = new Promise((resolve) => {
    transactionAReady = resolve;
  });
  const releaseTransactionAPromise = new Promise((resolve) => {
    releaseTransactionA = resolve;
  });

  const transactionA = withCodeClipCorePersistenceTransaction(async ({ queryClient }) => {
    await queryClient.query(
      "UPDATE codeclip_provider_account_bindings SET display_name = $2 WHERE id = $1 RETURNING *",
      [binding.id, "Transaction A"]
    );
    await queryClient.query(
      "INSERT INTO codeclip_provider_account_bindings VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        "codeclip",
        "CC-TX-ISOLATED",
        "meta",
        "messenger",
        "tx-isolated-a-insert-123456",
        null,
        "operator_key",
        "{}",
      ]
    );
    await queryClient.query(
      "INSERT INTO codeclip_provider_account_binding_audit VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        "codeclip",
        binding.id,
        "CC-TX-ISOLATED",
        "meta",
        "instagram",
        "display_name_updated",
        "operator_key",
        null,
        JSON.stringify({ displayName: "Before" }),
        JSON.stringify({ displayName: "Transaction A" }),
        "{}",
      ]
    );
    transactionAReady();
    await releaseTransactionAPromise;
    throw new Error("rollback transaction A");
  }).catch((error) => error);

  await transactionAReadyPromise;
  const transactionAInsertedId = state.bindings.find(
    (row) => row.provider_account_id === "tx-isolated-a-insert-123456"
  )?.id;

  const transactionBResult = await withCodeClipCorePersistenceTransaction(async ({ queryClient }) => {
    await queryClient.query(
      "UPDATE codeclip_provider_account_bindings SET display_name = $2 WHERE id = $1 RETURNING *",
      [binding.id, "Transaction B"]
    );
    return queryClient.query(
      "INSERT INTO codeclip_provider_account_bindings VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        "codeclip",
        "CC-TX-ISOLATED",
        "sms",
        "sms",
        "tx-isolated-b-insert-123456",
        null,
        "operator_key",
        "{}",
      ]
    );
  });

  releaseTransactionA();
  const transactionAError = await transactionA;

  assert.match(transactionAError.message, /rollback transaction A/);
  assert.equal(state.bindings.find((row) => row.id === binding.id).display_name, "Transaction B");
  assert.ok(state.bindings.some((row) => row.provider_account_id === "tx-isolated-b-insert-123456"));
  assert.equal(
    state.bindings.some((row) => row.provider_account_id === "tx-isolated-a-insert-123456"),
    false
  );
  assert.equal(state.auditRows.length, 0);
  assert.equal(transactionBResult.rows[0].id, String(Number(transactionAInsertedId) + 1));
  assert.equal(state.nextBindingId, Number(transactionBResult.rows[0].id) + 1);
  assert.equal(state.bindings.find((row) => row.id === binding.id).__lastMutationTxId, undefined);
});

test("codeClip provider binding global list filters searches and paginates safely", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addBinding({
      id: "ignored",
      eventCode: "CC-GLOBAL-A",
      providerAccountId: "global-raw-a-123456",
      displayName: "Literal 100% match",
    });
    state.bindings[0].id = "9007199254740992";
    state.bindings[0].updated_at = "2026-07-16T00:00:00.000Z";
    addBinding({
      eventCode: "CC-GLOBAL-B",
      provider: "legacy_provider",
      channel: "legacy_channel",
      providerAccountId: "global-raw-b-123456",
      displayName: "Historical binding",
    });
    state.bindings[1].id = "9007199254740993";
    state.bindings[1].updated_at = "2026-07-16T00:00:00.000Z";
    addBinding({
      eventCode: "CC-GLOBAL-A",
      provider: "sms",
      channel: "sms",
      providerAccountId: "global-raw-c-123456",
      status: "disabled",
      displayName: "Disabled SMS",
    });
    state.bindings[2].id = "9007199254740994";
    state.bindings[2].updated_at = "2026-07-15T00:00:00.000Z";

    const firstPage = await globalListBindingsRequest(baseUrl, "?limit=1");
    const cursor = encodeURIComponent(firstPage.body.page.nextCursor);
    const secondPage = await globalListBindingsRequest(baseUrl, `?limit=1&cursor=${cursor}`);
    const providerFilter = await globalListBindingsRequest(baseUrl, "?provider=legacy_provider");
    const statusFilter = await globalListBindingsRequest(baseUrl, "?eventCode=CC-GLOBAL-A&status=disabled");
    const literalSearch = await globalListBindingsRequest(baseUrl, "?search=100%25");
    const invalidCursor = await globalListBindingsRequest(baseUrl, "?cursor=eyJ2IjoxLCJ1cGRhdGVkQXQiOiJub3QtYS1kYXRlIiwiaWQiOiIxIn0");

    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.items.length, 1);
    assert.equal(firstPage.body.items[0].id, "9007199254740993");
    assert.equal(firstPage.body.items[0].provider, "legacy_provider");
    assert.equal(firstPage.body.items[0].providerAccountId, undefined);
    assert.equal(firstPage.body.items[0].vertical, "codeclip");
    assert.equal(firstPage.body.page.hasMore, true);
    assert.ok(firstPage.body.page.nextCursor);
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.items[0].id, "9007199254740992");
    assert.notEqual(secondPage.body.items[0].id, firstPage.body.items[0].id);
    assert.equal(providerFilter.body.items.length, 1);
    assert.equal(providerFilter.body.items[0].channel, "legacy_channel");
    assert.equal(statusFilter.body.items.length, 1);
    assert.equal(statusFilter.body.items[0].status, "disabled");
    assert.equal(literalSearch.body.items.length, 1);
    assert.equal(literalSearch.body.items[0].displayName, "Literal 100% match");
    assert.equal(invalidCursor.status, 400);
    assert.equal(invalidCursor.body.error.code, "INVALID_CURSOR");
    assertNoLeaks(firstPage.body, "global-raw-b-123456");
    assertNoLeaks(statusFilter.body, "global-raw-c-123456");
  });
});

test("codeClip provider binding global create validates episodes and returns deterministic conflicts", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-GLOBAL-CREATE");
    addEvent("CC-GLOBAL-OTHER");

    const missingEventCode = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "" })
    );
    const invalidEventCode = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "bad\u0000code" })
    );
    const unknownEpisode = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "CC-GLOBAL-MISSING" })
    );
    const created = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "CC-GLOBAL-CREATE" })
    );
    const repeatedActive = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "CC-GLOBAL-CREATE" })
    );
    const otherEpisode = await globalCreateBindingRequest(
      baseUrl,
      validBody({ eventCode: "CC-GLOBAL-OTHER" })
    );
    const disabled = addBinding({
      eventCode: "CC-GLOBAL-OTHER",
      providerAccountId: "disabled-global-123456",
      status: "disabled",
    });
    const disabledConflict = await globalCreateBindingRequest(
      baseUrl,
      validBody({
        eventCode: "CC-GLOBAL-OTHER",
        providerAccountId: "disabled-global-123456",
      })
    );

    assert.equal(missingEventCode.status, 400);
    assert.equal(missingEventCode.body.error.code, "VALIDATION_ERROR");
    assert.equal(invalidEventCode.status, 400);
    assert.equal(invalidEventCode.body.error.code, "VALIDATION_ERROR");
    assert.equal(unknownEpisode.status, 404);
    assert.equal(unknownEpisode.body.error.code, "EPISODE_NOT_FOUND");
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.binding.eventCode, "CC-GLOBAL-CREATE");
    assert.equal(created.body.binding.providerAccountId, undefined);
    assert.equal(repeatedActive.status, 409);
    assert.equal(repeatedActive.body.error.code, "PROVIDER_ACCOUNT_ALREADY_BOUND");
    assert.equal(repeatedActive.body.error.details.bindingId, created.body.binding.id);
    assert.equal(otherEpisode.status, 409);
    assert.equal(otherEpisode.body.error.code, "PROVIDER_ACCOUNT_ALREADY_BOUND");
    assert.equal(disabledConflict.status, 409);
    assert.equal(disabledConflict.body.error.code, "REACTIVATION_REQUIRED");
    assert.equal(disabledConflict.body.error.details.bindingId, disabled.id);
    assert.equal(state.auditRows.filter((row) => row.action === "created").length, 1);
    assert.equal(state.auditRows[0].actor_type, "operator_key");
    assert.equal(state.auditRows[0].actor_id, null);
    assert.equal(state.bindings.filter((row) => row.provider_account_id === "account-secret-123456").length, 1);
    assertNoLeaks(repeatedActive.body);
    assertNoLeaks(disabledConflict.body, "disabled-global-123456");
  });
});

test("codeClip provider binding global create race commits one binding and one audit", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-GLOBAL-RACE");
    const providerAccountId = "create-race-secret-123456";
    state.createRaceProviderAccountId = providerAccountId;

    const results = await Promise.all([
      globalCreateBindingRequest(
        baseUrl,
        validBody({ eventCode: "CC-GLOBAL-RACE", providerAccountId })
      ),
      globalCreateBindingRequest(
        baseUrl,
        validBody({ eventCode: "CC-GLOBAL-RACE", providerAccountId })
      ),
    ]);

    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 1);

    const created = results.find((result) => result.status === 201);
    const conflict = results.find((result) => result.status === 409);
    const active = activeRows("meta", providerAccountId);
    const createdAudits = state.auditRows.filter((row) => row.action === "created");

    assert.equal(conflict.body.error.code, "PROVIDER_ACCOUNT_ALREADY_BOUND");
    assert.equal(conflict.body.error.details.bindingId, created.body.binding.id);
    assert.equal(conflict.body.error.details.eventCode, "CC-GLOBAL-RACE");
    assert.equal(conflict.body.error.details.provider, "meta");
    assert.equal(conflict.body.error.details.channel, "instagram");
    assert.equal(conflict.body.error.details.status, "active");
    assert.equal(active.length, 1);
    assert.equal(active[0].id, created.body.binding.id);
    assert.equal(createdAudits.length, 1);
    assert.equal(createdAudits[0].binding_id, created.body.binding.id);
    assert.equal(
      state.bindings.filter((row) => row.provider_account_id === providerAccountId).length,
      1
    );
    assertNoLeaks(conflict.body, providerAccountId);
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
    assert.equal(state.auditRows.length, 1);
    assert.equal(state.auditRows[0].action, "created");
    assert.equal(state.auditRows[0].before_state, null);
    assert.equal(state.auditRows[0].after_state.eventCode, "CC-CREATE");
    assert.equal(state.auditRows[0].after_state.providerAccountId, undefined);
    assert.equal(state.bindingMutationUsedTransaction, true);
    assert.equal(state.auditInsertUsedTransaction, true);
    assert.deepEqual(state.transactionLog, ["BEGIN", "COMMIT"]);
    assertNoLeaks(response.body);
    assertNoLeaks(state.auditRows);
  });
});

test("codeClip provider binding operator rolls back create when audit insert fails", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-CREATE-AUDIT-FAIL");
    state.failAudit = true;

    const response = await createBindingRequest(
      baseUrl,
      "CC-CREATE-AUDIT-FAIL",
      validBody({ providerAccountId: "audit-create-fail-123456" })
    );

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      ok: false,
      error: "Provider binding operation unavailable",
    });
    assert.deepEqual(state.transactionLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(state.bindings.length, 0);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "audit-create-fail-123456");
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
    assert.equal(state.auditRows.length, 1);
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
    const missing = await disableBindingRequest(baseUrl, "999999");
    const foreignResponse = await disableBindingRequest(baseUrl, foreign.id);

    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.binding.status, "disabled");
    assert.ok(disabled.body.binding.disabledAt);
    assert.equal(activeRows("meta", "disable-secret-123456").length, 0);
    assert.equal(state.auditRows.length, 1);
    assert.equal(state.auditRows[0].action, "disabled");
    assert.equal(state.auditRows[0].before_state.status, "active");
    assert.equal(state.auditRows[0].after_state.status, "disabled");
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.binding.status, "disabled");
    assert.equal(state.auditRows.length, 1);
    assertProviderBindingNotFound(missing);
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(foreignResponse.body, { ok: false, error: "Provider binding not found" });
    assertNoLeaks(disabled.body, "disable-secret-123456");
  });
});

test("codeClip provider binding operator rolls back disable when audit insert fails", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-DISABLE-AUDIT-FAIL",
      providerAccountId: "disable-audit-fail-123456",
    });
    const before = { ...binding };
    state.failAudit = true;

    const response = await disableBindingRequest(baseUrl, binding.id);

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      ok: false,
      error: "Provider binding operation unavailable",
    });
    assert.deepEqual(state.transactionLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(state.bindings[0].status, before.status);
    assert.equal(state.bindings[0].disabled_at, before.disabled_at);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "disable-audit-fail-123456");
  });
});

test("codeClip provider binding operator reads active and disabled bindings safely", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const active = addBinding({ eventCode: "CC-GET", providerAccountId: "get-active-secret-123456" });
    const disabled = addBinding({
      eventCode: "CC-GET",
      providerAccountId: "get-disabled-secret-123456",
      status: "disabled",
    });
    const foreign = addBinding({
      eventCode: "CP-GET",
      providerAccountId: "get-foreign-secret-123456",
      vertical: "codepod",
    });

    const activeResponse = await getBindingRequest(baseUrl, active.id);
    const disabledResponse = await getBindingRequest(baseUrl, disabled.id);
    const missing = await getBindingRequest(baseUrl, "999999");
    const foreignResponse = await getBindingRequest(baseUrl, foreign.id);

    assert.equal(activeResponse.status, 200);
    assert.equal(activeResponse.body.binding.status, "active");
    assert.equal(activeResponse.body.binding.maskedAccountId.endsWith("3456"), true);
    assert.equal(activeResponse.body.binding.providerAccountId, undefined);
    assert.equal(disabledResponse.status, 200);
    assert.equal(disabledResponse.body.binding.status, "disabled");
    assertProviderBindingNotFound(missing);
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(foreignResponse.body, { ok: false, error: "Provider binding not found" });
    assertNoLeaks(activeResponse.body, "get-active-secret-123456");
    assertNoLeaks(disabledResponse.body, "get-disabled-secret-123456");
  });
});

test("codeClip provider binding operator update changes only displayName", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const active = addBinding({
      eventCode: "CC-UPDATE",
      providerAccountId: "update-active-secret-123456",
      displayName: "Old active",
    });
    const disabled = addBinding({
      eventCode: "CC-UPDATE",
      providerAccountId: "update-disabled-secret-123456",
      status: "disabled",
      displayName: "Old disabled",
    });
    const before = { ...state.bindings[0] };

    const updated = await updateBindingRequest(baseUrl, active.id, { displayName: " Main Instagram " });
    const auditAfterUpdate = state.auditRows.length;
    const updatedAtAfterUpdate = state.bindings[0].updated_at;
    const repeated = await updateBindingRequest(baseUrl, active.id, { displayName: "Main Instagram" });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.binding.displayName, "Main Instagram");
    assert.equal(updated.body.binding.updatedAt, "2026-07-15T00:10:00.000Z");
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.binding.displayName, "Main Instagram");
    assert.equal(state.auditRows.length, auditAfterUpdate);
    assert.equal(state.bindings[0].updated_at, updatedAtAfterUpdate);

    const clearedEmpty = await updateBindingRequest(baseUrl, active.id, { displayName: "" });
    const clearedNull = await updateBindingRequest(baseUrl, disabled.id, { displayName: null });

    assert.equal(clearedEmpty.status, 200);
    assert.equal(clearedEmpty.body.binding.displayName, null);
    assert.equal(clearedNull.status, 200);
    assert.equal(clearedNull.body.binding.displayName, null);
    assert.equal(state.auditRows.length, 3);
    assert.deepEqual(
      state.auditRows.map((row) => row.action),
      ["display_name_updated", "display_name_updated", "display_name_updated"]
    );
    assert.equal(state.auditRows[0].before_state.displayName, "Old active");
    assert.equal(state.auditRows[0].after_state.displayName, "Main Instagram");
    assert.equal(state.auditRows[0].after_state.providerAccountId, undefined);
    assert.equal(state.bindings[0].event_code, before.event_code);
    assert.equal(state.bindings[0].provider, before.provider);
    assert.equal(state.bindings[0].channel, before.channel);
    assert.equal(state.bindings[0].provider_account_id, before.provider_account_id);
    assert.equal(state.bindings[0].status, before.status);
    assertNoLeaks(updated.body, "update-active-secret-123456");
  });
});

test("codeClip provider binding operator rolls back update when audit insert fails", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-UPDATE-AUDIT-FAIL",
      providerAccountId: "update-audit-fail-123456",
      displayName: "Before",
    });
    const before = { ...binding };
    state.failAudit = true;

    const response = await updateBindingRequest(baseUrl, binding.id, { displayName: "After" });

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      ok: false,
      error: "Provider binding operation unavailable",
    });
    assert.deepEqual(state.transactionLog, ["BEGIN", "ROLLBACK"]);
    assert.equal(state.bindings[0].display_name, before.display_name);
    assert.equal(state.bindings[0].updated_at, before.updated_at);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "update-audit-fail-123456");
  });
});

test("codeClip provider binding operator update rejects missing or forbidden fields", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-UPDATE-INVALID",
      providerAccountId: "update-invalid-secret-123456",
      displayName: "Before",
    });
    const forbiddenBodies = [
      {},
      { eventCode: "CC-OTHER" },
      { event_code: "CC-OTHER" },
      { provider: "sms" },
      { channel: "messenger" },
      { providerAccountId: "other-account" },
      { provider_account_id: "other-account" },
      { status: "disabled" },
      { vertical: "codepod" },
      { id: "other-id" },
      { createdBy: "someone" },
      { created_by: "someone" },
      { displayName: "Allowed", eventCode: "CC-OTHER" },
      { displayName: "Allowed", provider: "meta" },
    ];

    for (const body of forbiddenBodies) {
      const response = await updateBindingRequest(baseUrl, binding.id, body);
      assertStructuredValidationError(response);
      assertNoLeaks(response.body, "update-invalid-secret-123456");
      assert.doesNotMatch(JSON.stringify(response.body), /eventCode|provider_account_id|other-account|foo/);
    }

    assert.equal(state.bindings[0].display_name, "Before");
    assert.equal(state.bindings[0].event_code, "CC-UPDATE-INVALID");
    assert.equal(state.bindings[0].provider_account_id, "update-invalid-secret-123456");
    assert.equal(state.auditRows.length, 0);
  });
});

test("codeClip provider binding operator PATCH body allowlist is strict", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-PATCH-ALLOWLIST",
      providerAccountId: "patch-allowlist-secret-123456",
      displayName: "Before",
    });

    const allowed = await updateBindingRequest(baseUrl, binding.id, { displayName: "New name" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.binding.displayName, "New name");
    assert.equal(state.bindings[0].display_name, "New name");
    assert.equal(state.auditRows.length, 1);

    const rejectedBodies = [
      {
        body: { foo: "unique-foo-marker" },
        forbidden: ["foo", "unique-foo-marker"],
      },
      {
        body: { provider_account_id: "unique-secret-marker" },
        forbidden: ["provider_account_id", "unique-secret-marker"],
      },
      {
        body: { displayName: "New", provider: "unique-provider-marker" },
        forbidden: ["unique-provider-marker"],
      },
    ];

    for (const { body, forbidden } of rejectedBodies) {
      const response = await updateBindingRequest(baseUrl, binding.id, body);
      assertStructuredValidationError(response);
      const serialized = JSON.stringify(response.body);
      for (const marker of forbidden) {
        assert.doesNotMatch(serialized, new RegExp(marker));
      }
    }

    const emptyBodyResponse = await updateBindingRequest(baseUrl, binding.id, {});
    assertStructuredValidationError(emptyBodyResponse);
    assert.deepEqual(emptyBodyResponse.body, {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid provider binding request.",
        details: {},
      },
    });

    const rawBodies = [
      JSON.stringify([]),
      JSON.stringify(null),
      JSON.stringify("primitive"),
      JSON.stringify(123),
      JSON.stringify(true),
    ];

    for (const rawBody of rawBodies) {
      const response = await updateBindingRawRequest(baseUrl, binding.id, rawBody);
      assertStructuredValidationError(response);
      assertNoLeaks(response.body, "patch-allowlist-secret-123456");
    }

    const malformedJson = await updateBindingRawRequest(baseUrl, binding.id, "{not-json");
    assertStructuredValidationError(malformedJson);

    assert.equal(state.bindings[0].display_name, "New name");
    assert.equal(state.bindings[0].provider_account_id, "patch-allowlist-secret-123456");
    assert.equal(state.auditRows.length, 1);
  });
});

test("codeClip provider binding operator update hides unavailable bindings", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const foreign = addBinding({
      eventCode: "CP-UPDATE",
      providerAccountId: "update-foreign-secret-123456",
      vertical: "codepod",
    });

    const missing = await updateBindingRequest(baseUrl, "999999", { displayName: "Name" });
    const foreignResponse = await updateBindingRequest(baseUrl, foreign.id, { displayName: "Name" });

    assertProviderBindingNotFound(missing);
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(foreignResponse.body, { ok: false, error: "Provider binding not found" });
    assertNoLeaks(foreignResponse.body, "update-foreign-secret-123456");
  });
});

test("codeClip provider binding path IDs distinguish invalid input from missing bindings", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-ID-MATRIX",
      providerAccountId: "id-matrix-secret-123456",
      displayName: "Before",
    });
    binding.id = "9007199254740993";
    const invalidIds = ["abc", "bind-1", "0", "-1", "1.5", "9223372036854775808"];

    const routes = [
      (id) => getBindingRequest(baseUrl, id),
      (id) => updateBindingRequest(baseUrl, id, { displayName: "Ignored" }),
      (id) => disableBindingRequest(baseUrl, id),
      (id) => reactivateBindingRequest(baseUrl, id),
      (id) => bindingAuditRequest(baseUrl, id),
    ];

    state.fail = true;
    try {
      for (const invalidId of invalidIds) {
        for (const request of routes) {
          const response = await request(invalidId);
          assertStructuredValidationError(response);
          assertNoLeaks(response.body, "id-matrix-secret-123456");
        }
      }
    } finally {
      state.fail = false;
    }

    assert.equal(state.bindings[0].display_name, "Before");
    assert.equal(state.bindings[0].status, "active");
    assert.equal(state.auditRows.length, 0);

    const missingId = "999999";
    assertProviderBindingNotFound(await getBindingRequest(baseUrl, missingId));
    assertProviderBindingNotFound(
      await updateBindingRequest(baseUrl, missingId, { displayName: "Missing" })
    );
    assertProviderBindingNotFound(await disableBindingRequest(baseUrl, missingId));
    assertProviderBindingNotFound(await reactivateBindingRequest(baseUrl, missingId));
    assertProviderBindingNotFound(await bindingAuditRequest(baseUrl, missingId));

    const validLargeId = await getBindingRequest(baseUrl, "9007199254740993");
    assert.equal(validLargeId.status, 200);
    assert.equal(validLargeId.body.binding.id, "9007199254740993");
    assert.equal(validLargeId.body.binding.providerAccountId, undefined);
    assertNoLeaks(validLargeId.body, "id-matrix-secret-123456");
  });
});

test("codeClip provider binding operator reactivates disabled binding in place", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-REACTIVATE",
      providerAccountId: "reactivate-secret-123456",
      status: "disabled",
    });

    const response = await reactivateBindingRequest(baseUrl, binding.id);

    assert.equal(response.status, 200);
    assert.equal(response.body.reactivated, true);
    assert.equal(response.body.binding.id, binding.id);
    assert.equal(response.body.binding.status, "active");
    assert.equal(response.body.binding.disabledAt, null);
    assert.equal(state.bindings.length, 1);
    assert.equal(state.bindings[0].id, binding.id);
    assert.equal(state.bindings[0].disabled_at, null);
    assert.equal(state.auditRows.length, 1);
    assert.equal(state.auditRows[0].action, "reactivated");
    assert.equal(state.auditRows[0].before_state.status, "disabled");
    assert.equal(state.auditRows[0].after_state.status, "active");
    assertNoLeaks(response.body, "reactivate-secret-123456");
  });
});

test("codeClip provider binding operator reactivation is idempotent for active binding", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-REACTIVATE-IDEM",
      providerAccountId: "reactivate-idem-secret-123456",
    });

    const response = await reactivateBindingRequest(baseUrl, binding.id);

    assert.equal(response.status, 200);
    assert.equal(response.body.reactivated, false);
    assert.equal(response.body.binding.id, binding.id);
    assert.equal(response.body.binding.status, "active");
    assert.equal(state.bindings.length, 1);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "reactivate-idem-secret-123456");
  });
});

test("codeClip provider binding operator reactivation conflicts with another active binding", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const disabled = addBinding({
      eventCode: "CC-REACTIVATE-A",
      providerAccountId: "reactivate-conflict-secret-123456",
      status: "disabled",
    });
    const competing = addBinding({
      eventCode: "CC-REACTIVATE-B",
      providerAccountId: "reactivate-conflict-secret-123456",
    });
    const beforeDisabled = { ...disabled };
    const beforeCompeting = { ...competing };

    const response = await reactivateBindingRequest(baseUrl, disabled.id);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "REACTIVATION_CONFLICT");
    assert.equal(response.body.error.message, "This provider account is already connected.");
    assert.equal(state.bindings[0].status, "disabled");
    assert.equal(state.bindings[0].disabled_at, beforeDisabled.disabled_at);
    assert.equal(state.bindings[0].event_code, beforeDisabled.event_code);
    assert.equal(state.bindings[0].provider_account_id, beforeDisabled.provider_account_id);
    assert.equal(state.bindings[1].status, beforeCompeting.status);
    assert.equal(state.bindings[1].event_code, beforeCompeting.event_code);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "reactivate-conflict-secret-123456");
  });
});

test("codeClip provider binding reactivation race commits one winner and one audit", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const providerAccountId = "reactivate-race-secret-123456";
    const firstCandidate = addBinding({
      eventCode: "CC-REACTIVATE-RACE-A",
      providerAccountId,
      status: "disabled",
    });
    const secondCandidate = addBinding({
      eventCode: "CC-REACTIVATE-RACE-B",
      providerAccountId,
      status: "disabled",
    });
    const beforeById = new Map([
      [String(firstCandidate.id), { ...firstCandidate }],
      [String(secondCandidate.id), { ...secondCandidate }],
    ]);
    const nextBindingIdBeforeRace = state.nextBindingId;
    state.reactivateRaceProviderAccountId = providerAccountId;

    const results = await Promise.all([
      reactivateBindingRequest(baseUrl, firstCandidate.id),
      reactivateBindingRequest(baseUrl, secondCandidate.id),
    ]);

    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 1);

    const success = results.find((result) => result.status === 200);
    const conflict = results.find((result) => result.status === 409);
    const winnerId = String(success.body.binding.id);
    const loserId = [firstCandidate.id, secondCandidate.id]
      .map(String)
      .find((id) => id !== winnerId);
    const winner = state.bindings.find((row) => String(row.id) === winnerId);
    const loser = state.bindings.find((row) => String(row.id) === loserId);
    const loserBefore = beforeById.get(loserId);
    const active = state.bindings.filter(
      (row) => row.provider_account_id === providerAccountId && row.status === "active"
    );
    const disabled = state.bindings.filter(
      (row) => row.provider_account_id === providerAccountId && row.status === "disabled"
    );
    const reactivatedAudits = state.auditRows.filter((row) => row.action === "reactivated");

    assert.equal(success.body.reactivated, true);
    assert.equal(conflict.body.error.code, "REACTIVATION_CONFLICT");
    assert.equal(conflict.body.error.details.provider, "meta");
    assert.equal(conflict.body.error.details.eventCode, winner.event_code);
    if (conflict.body.error.details.bindingId !== undefined) {
      assert.equal(conflict.body.error.details.bindingId, winner.id);
    }
    if (conflict.body.error.details.channel !== undefined) {
      assert.equal(conflict.body.error.details.channel, winner.channel);
    }
    if (conflict.body.error.details.status !== undefined) {
      assert.equal(conflict.body.error.details.status, winner.status);
    }
    assert.equal(active.length, 1);
    assert.equal(disabled.length, 1);
    assert.equal(winner.status, "active");
    assert.equal(loser.status, "disabled");
    assert.equal(loser.disabled_at, loserBefore.disabled_at);
    assert.equal(loser.event_code, loserBefore.event_code);
    assert.equal(loser.provider_account_id, loserBefore.provider_account_id);
    assert.equal(reactivatedAudits.length, 1);
    assert.equal(reactivatedAudits[0].binding_id, winnerId);
    assert.equal(
      state.auditRows.some((row) => String(row.binding_id) === loserId),
      false
    );
    assert.equal(state.nextBindingId, nextBindingIdBeforeRace);
    assertNoLeaks(conflict.body, providerAccountId);
    assertNoLeaks(state.auditRows, providerAccountId);
  });
});

test("codeClip provider binding operator reactivation writes no audit on unique conflict", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const disabled = addBinding({
      eventCode: "CC-REACTIVATE-23505",
      providerAccountId: "reactivate-23505-secret-123456",
      status: "disabled",
    });
    const before = { ...disabled };
    state.failReactivateUniqueViolation = true;

    const response = await reactivateBindingRequest(baseUrl, disabled.id);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "REACTIVATION_CONFLICT");
    assert.equal(response.body.error.message, "This provider account is already connected.");
    assert.equal(response.body.error.details.eventCode, "CC-REACTIVATE-23505-WINNER");
    assert.equal(response.body.error.details.channel, "instagram");
    assert.equal(response.body.error.details.status, "active");
    assert.equal(state.bindings[0].status, before.status);
    assert.equal(state.bindings[0].disabled_at, before.disabled_at);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "reactivate-23505-secret-123456");
  });
});

test("codeClip provider binding operator rolls back reactivation when audit insert fails", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const binding = addBinding({
      eventCode: "CC-REACTIVATE-AUDIT-FAIL",
      providerAccountId: "reactivate-audit-fail-123456",
      status: "disabled",
    });
    const before = { ...binding };
    state.failAudit = true;

    const response = await reactivateBindingRequest(baseUrl, binding.id);

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      ok: false,
      error: "Provider binding operation unavailable",
    });
    assert.deepEqual(state.transactionLog, [
      "BEGIN",
      "SAVEPOINT codeclip_provider_binding_reactivate",
      "RELEASE SAVEPOINT codeclip_provider_binding_reactivate",
      "ROLLBACK",
    ]);
    assert.equal(state.bindings[0].status, before.status);
    assert.equal(state.bindings[0].disabled_at, before.disabled_at);
    assert.equal(state.auditRows.length, 0);
    assertNoLeaks(response.body, "reactivate-audit-fail-123456");
  });
});

test("codeClip provider binding operator reactivation hides unavailable bindings and empty updates", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    const foreign = addBinding({
      eventCode: "CP-REACTIVATE",
      providerAccountId: "reactivate-foreign-secret-123456",
      vertical: "codepod",
      status: "disabled",
    });
    const noRows = addBinding({
      eventCode: "CC-REACTIVATE-NOROW",
      providerAccountId: "reactivate-norow-secret-123456",
      status: "disabled",
    });

    const missing = await reactivateBindingRequest(baseUrl, "999999");
    const foreignResponse = await reactivateBindingRequest(baseUrl, foreign.id);
    state.reactivateReturnsNoRows = true;
    const noRowsResponse = await reactivateBindingRequest(baseUrl, noRows.id);

    assertProviderBindingNotFound(missing);
    assert.equal(foreignResponse.status, 404);
    assert.deepEqual(foreignResponse.body, { ok: false, error: "Provider binding not found" });
    assert.equal(noRowsResponse.status, 404);
    assert.deepEqual(noRowsResponse.body, { ok: false, error: "Provider binding not found" });
    assertNoLeaks(foreignResponse.body, "reactivate-foreign-secret-123456");
    assertNoLeaks(noRowsResponse.body, "reactivate-norow-secret-123456");
  });
});

test("codeClip provider binding audit routes list binding and Episode history safely", async () => {
  await withAuthorizedServer(async (baseUrl) => {
    addEvent("CC-AUDIT-ROUTE");
    addEvent("CC-AUDIT-EMPTY");
    addEvent("CP-AUDIT", "codepod");
    const created = await createBindingRequest(
      baseUrl,
      "CC-AUDIT-ROUTE",
      validBody({ providerAccountId: "audit-route-secret-123456" })
    );
    await updateBindingRequest(baseUrl, created.body.binding.id, { displayName: "Updated" });

    const byBinding = await bindingAuditRequest(baseUrl, created.body.binding.id);
    const byEpisode = await eventAuditRequest(baseUrl, "CC-AUDIT-ROUTE", "?limit=1");
    const empty = await eventAuditRequest(baseUrl, "CC-AUDIT-EMPTY");
    const missingBinding = await bindingAuditRequest(baseUrl, "999999");
    const missingEvent = await eventAuditRequest(baseUrl, "CC-MISSING");
    const foreignEvent = await eventAuditRequest(baseUrl, "CP-AUDIT");

    assert.equal(byBinding.status, 200);
    assert.deepEqual(
      byBinding.body.events.map((event) => event.action),
      ["display_name_updated", "created"]
    );
    assert.equal(byBinding.body.events[0].actorType, "operator_key");
    assert.equal(byBinding.body.events[0].actorId, null);
    assert.equal(byBinding.body.events[0].afterState.providerAccountId, undefined);
    assert.equal(byEpisode.status, 200);
    assert.equal(byEpisode.body.events.length, 1);
    assert.equal(byEpisode.body.events[0].action, "display_name_updated");
    assert.equal(empty.body.ok, true);
    assert.equal(empty.body.eventCode, "CC-AUDIT-EMPTY");
    assert.deepEqual(empty.body.items, []);
    assert.deepEqual(empty.body.events, []);
    assert.deepEqual(empty.body.page, { limit: 50, nextCursor: null, hasMore: false });
    assertProviderBindingNotFound(missingBinding);
    assert.equal(missingEvent.status, 404);
    assert.equal(foreignEvent.status, 404);
    assertNoLeaks(byBinding.body, "audit-route-secret-123456");
    assertNoLeaks(byEpisode.body, "audit-route-secret-123456");
  });
});

test("codeClip provider binding audit route fails closed when admin key is not configured", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: undefined }, async () => {
    await withServer(async (baseUrl) => {
      const binding = addBinding({
        eventCode: "CC-AUDIT-NO-CONFIG",
        providerAccountId: "audit-no-config-secret-123456",
      });

      const response = await bindingAuditRequest(baseUrl, binding.id, "", {});

      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        ok: false,
        error: "Operator inspection unavailable",
      });
      assertNoLeaks(response.body, "audit-no-config-secret-123456");
    });
  });
});

test("codeClip provider binding audit routes enforce auth, limits, and public-safe failures", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: ADMIN_KEY }, async () => {
    await withServer(async (baseUrl) => {
      addEvent("CC-AUDIT-LIMIT");
      const binding = addBinding({
        eventCode: "CC-AUDIT-LIMIT",
        providerAccountId: "audit-limit-secret-123456",
      });
      state.auditRows.push({
        id: "1",
        vertical: "codeclip",
        binding_id: binding.id,
        event_code: "CC-AUDIT-LIMIT",
        provider: "meta",
        channel: "instagram",
        action: "created",
        actor_type: "operator",
        actor_id: "admin",
        before_state: null,
        after_state: { maskedAccountId: "••••3456" },
        metadata: {},
        created_at: "2026-07-15T00:20:00.000Z",
      });

      const missingKey = await bindingAuditRequest(baseUrl, binding.id, "", {});
      const wrongKey = await bindingAuditRequest(baseUrl, binding.id, "", { "x-admin-key": "wrong-key" });
      const invalidLimit = await bindingAuditRequest(baseUrl, binding.id, "?limit=10abc");
      const cappedLimit = await eventAuditRequest(baseUrl, "CC-AUDIT-LIMIT", "?limit=250");
      state.fail = true;
      const unavailable = await bindingAuditRequest(baseUrl, binding.id);

      assert.equal(missingKey.status, 401);
      assert.equal(wrongKey.status, 401);
      assert.equal(invalidLimit.status, 400);
      assert.deepEqual(invalidLimit.body, {
        ok: false,
        error: "Invalid provider binding audit request",
      });
      assert.equal(cappedLimit.status, 200);
      assert.equal(cappedLimit.body.events.length, 1);
      assert.equal(unavailable.status, 503);
      assert.deepEqual(unavailable.body, {
        ok: false,
        error: "Provider binding audit unavailable",
      });
      assertNoLeaks(invalidLimit.body, "audit-limit-secret-123456");
      assertNoLeaks(unavailable.body, "audit-limit-secret-123456");
    });
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
    const read = await getBindingRequest(baseUrl, binding.id);
    const update = await updateBindingRequest(baseUrl, binding.id, { displayName: "Name" });
    const reactivate = await reactivateBindingRequest(baseUrl, binding.id);

    for (const response of [create, list, disable, read, update, reactivate]) {
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        ok: false,
        error: "Provider binding operation unavailable",
      });
      assertNoLeaks(response.body, "fail-secret-123456");
    }
  });
});
