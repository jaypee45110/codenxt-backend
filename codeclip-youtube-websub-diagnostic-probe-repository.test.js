const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("./db");
const repository = require("./verticals/codeclip/youtube-websub-diagnostic-probe-repository");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const TOPIC = `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const CREATED_AT = "2026-07-24T10:00:00.000Z";
const UPDATED_AT = "2026-07-24T10:00:00.000Z";
const PROBE_ID = "diag_probeRepo123";
const CALLBACK_ID = "diag_yt_callbackRepo1234";

function probeInput(overrides = {}) {
  return {
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    channelId: CHANNEL_ID,
    topic: TOPIC,
    secretVersion: "diag-v1",
    now: CREATED_AT,
    ...overrides,
  };
}

function probeRow(overrides = {}) {
  return {
    id: "42",
    probe_id: PROBE_ID,
    callback_id: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    channel_id: CHANNEL_ID,
    topic: TOPIC,
    status: "pending_subscribe",
    pending_mode: "subscribe",
    secret_version: "diag-v1",
    lease_expires_at: null,
    verified_at: null,
    first_verified_at: null,
    last_notification_at: null,
    unsubscribed_at: null,
    cleanup_required: false,
    subscription_may_exist: true,
    failed_operation: null,
    failed_reason_code: null,
    diagnostic_metadata: {},
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function uniqueViolation(constraint) {
  const error = new Error("duplicate key value violates unique constraint");
  error.code = "23505";
  error.constraint = constraint;
  return error;
}

function makeClient(handler, options = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ sql: statement, params });
      if (statement === "SHOW transaction_isolation") {
        return { rows: [{ transaction_isolation: options.isolation || "read committed" }] };
      }
      return handler(statement, params, calls);
    },
  };
  return client;
}

function installPool(client) {
  const original = db.pool;
  db.pool = {
    async connect() {
      client.calls.push({ sql: "connect", params: [] });
      return {
        query: client.query.bind(client),
        release() {
          client.calls.push({ sql: "release", params: [] });
        },
      };
    },
  };
  return () => {
    db.pool = original;
  };
}

function callNames(calls) {
  return calls.map((call) => call.sql.trim().replace(/\s+/g, " "));
}

function assertNoFullSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(PROBE_ID), false);
  assert.equal(serialized.includes(CALLBACK_ID), false);
  assert.equal(serialized.includes("diag-v1"), false);
}

async function createWithRows({ constraint = null, rows = [], input = probeInput(), clientOptions = {} } = {}) {
  const client = makeClient((sql) => {
    if (/SAVEPOINT codeclip_youtube_websub_diagnostic_create/.test(sql)) return { rows: [] };
    if (/INSERT INTO codeclip_youtube_websub_diagnostic_probes/.test(sql)) {
      if (constraint) throw uniqueViolation(constraint);
      return { rows: [probeRow()] };
    }
    if (/SELECT \*/.test(sql) && /probe_id = \$1/.test(sql) && /callback_id = \$2/.test(sql)) {
      return { rows };
    }
    if (/RELEASE SAVEPOINT codeclip_youtube_websub_diagnostic_create/.test(sql)) return { rows: [] };
    if (/ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_create/.test(sql)) return { rows: [] };
    return { rows: [] };
  }, clientOptions);
  const result = await repository.createCodeClipYouTubeWebSubDiagnosticProbe(input, { queryClient: client });
  return { result, client };
}

test("owned transaction uses READ COMMITTED, commits, and releases on success", async () => {
  const client = makeClient((sql) => {
    if (/INSERT INTO codeclip_youtube_websub_diagnostic_probes/.test(sql)) return { rows: [probeRow()] };
    return { rows: [] };
  });
  const restore = installPool(client);
  try {
    const result = await repository.createCodeClipYouTubeWebSubDiagnosticProbe(probeInput());
    assert.equal(result.status, "created");
  } finally {
    restore();
  }
  assert.deepEqual(callNames(client.calls).filter((sql) => [
    "connect",
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
    "ROLLBACK",
    "release",
  ].includes(sql)), [
    "connect",
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "COMMIT",
    "release",
  ]);
});

test("owned transaction rolls back and releases on failure", async () => {
  const client = makeClient((sql) => {
    if (/INSERT INTO codeclip_youtube_websub_diagnostic_probes/.test(sql)) throw new Error("boom");
    return { rows: [] };
  });
  const restore = installPool(client);
  try {
    await assert.rejects(() => repository.createCodeClipYouTubeWebSubDiagnosticProbe(probeInput()), /boom/);
  } finally {
    restore();
  }
  assert.ok(callNames(client.calls).includes("ROLLBACK"));
  assert.equal(callNames(client.calls).at(-1), "release");
});

test("supplied READ COMMITTED transaction is accepted without BEGIN COMMIT or full ROLLBACK", async () => {
  const { result, client } = await createWithRows();
  assert.equal(result.status, "created");
  const names = callNames(client.calls);
  assert.ok(names.includes("SHOW transaction_isolation"));
  assert.equal(names.includes("BEGIN ISOLATION LEVEL READ COMMITTED"), false);
  assert.equal(names.includes("COMMIT"), false);
  assert.equal(names.includes("ROLLBACK"), false);
});

for (const isolation of ["repeatable read", "serializable"]) {
  test(`supplied ${isolation.toUpperCase()} transaction is rejected`, async () => {
    const client = makeClient(() => ({ rows: [] }), { isolation });
    await assert.rejects(
      () => repository.createCodeClipYouTubeWebSubDiagnosticProbe(probeInput(), { queryClient: client }),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_isolation_unsupported" }
    );
    assert.equal(client.calls.some((call) => /INSERT INTO/.test(call.sql)), false);
  });
}

test("supplied client without an active transaction maps savepoint failure to transaction_required", async () => {
  const client = makeClient((sql) => {
    if (/SAVEPOINT/.test(sql)) {
      const error = new Error("SAVEPOINT can only be used in transaction blocks");
      error.code = "25P01";
      throw error;
    }
    return { rows: [] };
  });
  await assert.rejects(
    () => repository.createCodeClipYouTubeWebSubDiagnosticProbe(probeInput(), { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_required" }
  );
});

test("handled unique violation leaves caller transaction usable", async () => {
  const { result, client } = await createWithRows({
    constraint: repository.PROBE_ID_CONSTRAINT,
    rows: [probeRow()],
  });
  assert.equal(result.status, "existing");
  await client.query("SELECT 1");
  assert.ok(callNames(client.calls).includes("ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_create"));
  assert.ok(callNames(client.calls).includes("SELECT 1"));
});

test("normal create returns public-safe created row", async () => {
  const { result } = await createWithRows();
  assert.equal(result.status, "created");
  assert.equal(result.row.probeId, PROBE_ID);
  assertNoFullSecrets(result.public);
});

for (const [label, constraint] of [
  ["probe-id", repository.PROBE_ID_CONSTRAINT],
  ["callback-id", repository.CALLBACK_ID_CONSTRAINT],
  ["open-topic", repository.OPEN_TOPIC_CONSTRAINT],
]) {
  test(`identical create via ${label} conflict returns existing`, async () => {
    const { result } = await createWithRows({ constraint, rows: [probeRow()] });
    assert.equal(result.status, "existing");
    assertNoFullSecrets(result.public);
  });
}

test("probe identity mismatch maps to identity_conflict", async () => {
  await assert.rejects(
    () => createWithRows({
      constraint: repository.PROBE_ID_CONSTRAINT,
      rows: [probeRow({ callback_id: "diag_yt_otherCallback1234" })],
    }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "identity_conflict" }
  );
});

test("callback identity mismatch maps to identity_conflict", async () => {
  await assert.rejects(
    () => createWithRows({
      constraint: repository.CALLBACK_ID_CONSTRAINT,
      rows: [probeRow({ probe_id: "diag_otherProbe123" })],
    }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "identity_conflict" }
  );
});

test("open topic with another identity maps to open_probe_conflict", async () => {
  await assert.rejects(
    () => createWithRows({
      constraint: repository.OPEN_TOPIC_CONSTRAINT,
      rows: [probeRow({ probe_id: "diag_otherProbe123", callback_id: "diag_yt_otherCallback1234" })],
    }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "open_probe_conflict" }
  );
});

test("split-brain conflict rows fail closed with repository_state_conflict", async () => {
  await assert.rejects(
    () => createWithRows({
      constraint: repository.PROBE_ID_CONSTRAINT,
      rows: [
        probeRow({ id: "10", callback_id: "diag_yt_otherCallback1234" }),
        probeRow({ id: "11", probe_id: "diag_otherProbe123", callback_id: CALLBACK_ID }),
      ],
    }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
});

test("unknown unique constraint fails closed and does not classify existing", async () => {
  const client = makeClient((sql) => {
    if (/SAVEPOINT/.test(sql) || /ROLLBACK TO SAVEPOINT/.test(sql) || /RELEASE SAVEPOINT/.test(sql)) return { rows: [] };
    if (/INSERT INTO/.test(sql)) throw uniqueViolation("unknown_unique_constraint");
    return { rows: [] };
  });
  await assert.rejects(
    () => repository.createCodeClipYouTubeWebSubDiagnosticProbe(probeInput(), { queryClient: client }),
    /duplicate key/
  );
  assert.equal(client.calls.some((call) => /SELECT \*/.test(call.sql)), false);
});

test("unresolved known conflict fails closed", async () => {
  await assert.rejects(
    () => createWithRows({ constraint: repository.PROBE_ID_CONSTRAINT, rows: [] }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "create_conflict_unresolved" }
  );
});

test("open-topic lookup uses open lifecycle predicate and ignores terminal failed/unsubscribed rows", async () => {
  const { result, client } = await createWithRows({
    constraint: repository.OPEN_TOPIC_CONSTRAINT,
    rows: [probeRow()],
  });
  assert.equal(result.status, "existing");
  const lookup = client.calls.find((call) => /FROM codeclip_youtube_websub_diagnostic_probes/.test(call.sql));
  assert.match(lookup.sql, /status IN \('pending_subscribe', 'active', 'pending_unsubscribe'\)/);
  assert.match(lookup.sql, /status = 'failed'\s+AND cleanup_required = TRUE\s+AND subscription_may_exist = TRUE/);
  assert.doesNotMatch(lookup.sql, /status IN \('pending_subscribe', 'active', 'pending_unsubscribe', 'failed'\)/);
});

test("cleanup-eligible failed row blocks open topic", async () => {
  await assert.rejects(
    () => createWithRows({
      constraint: repository.OPEN_TOPIC_CONSTRAINT,
      rows: [probeRow({
        probe_id: "diag_otherProbe123",
        callback_id: "diag_yt_otherCallback1234",
        status: "failed",
        pending_mode: null,
        cleanup_required: true,
        subscription_may_exist: true,
        failed_operation: "subscribe",
        failed_reason_code: "hub_request_failed",
      })],
    }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "open_probe_conflict" }
  );
});

test("cursor encode/decode round trips BigInt-safe compound cursor", () => {
  const id = "9007199254740993";
  const cursor = repository.encodeDiagnosticProbeCursor({ id, created_at: CREATED_AT });
  assert.deepEqual(repository.decodeDiagnosticProbeCursor(cursor), { createdAt: CREATED_AT, id });
});

test("cursor only accepts exact supported fields", () => {
  const extra = Buffer.from(JSON.stringify({ v: 1, createdAt: CREATED_AT, id: "1", extra: true })).toString("base64url");
  assert.throws(
    () => repository.decodeDiagnosticProbeCursor(extra),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "validation_error" }
  );
});

for (const [label, raw] of [
  ["invalid base64", "%%%%"],
  ["invalid json", Buffer.from("not-json").toString("base64url")],
  ["unsupported version", Buffer.from(JSON.stringify({ v: 2, createdAt: CREATED_AT, id: "1" })).toString("base64url")],
  ["non-canonical timestamp", Buffer.from(JSON.stringify({ v: 1, createdAt: "2026-07-24T10:00:00Z", id: "1" })).toString("base64url")],
  ["zero id", Buffer.from(JSON.stringify({ v: 1, createdAt: CREATED_AT, id: "0" })).toString("base64url")],
  ["negative id", Buffer.from(JSON.stringify({ v: 1, createdAt: CREATED_AT, id: "-1" })).toString("base64url")],
  ["id above bigint", Buffer.from(JSON.stringify({ v: 1, createdAt: CREATED_AT, id: "9223372036854775808" })).toString("base64url")],
]) {
  test(`cursor rejects ${label}`, () => {
    assert.throws(
      () => repository.decodeDiagnosticProbeCursor(raw),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "validation_error" }
    );
  });
}

test("list uses compound ordering, cursor predicate, limit plus one, and nextCursor", async () => {
  const rows = [
    probeRow({ id: "102", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-24T10:00:00.000Z" }),
    probeRow({ id: "101", probe_id: "diag_probeRepo124", callback_id: "diag_yt_callbackRepo1235", created_at: "2026-07-24T10:00:00.000Z", updated_at: "2026-07-24T10:00:00.000Z" }),
    probeRow({ id: "100", probe_id: "diag_probeRepo125", callback_id: "diag_yt_callbackRepo1236", created_at: "2026-07-24T09:59:00.000Z", updated_at: "2026-07-24T09:59:00.000Z" }),
  ];
  const client = makeClient((sql) => {
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.match(sql, /\(created_at, id\) < \(\$1, \$2\)/);
    assert.match(sql, /LIMIT \$3/);
    return { rows };
  });
  const cursor = repository.encodeDiagnosticProbeCursor({ created_at: "2026-07-24T10:01:00.000Z", id: "103" });
  const result = await repository.listCodeClipYouTubeWebSubDiagnosticProbes({ cursor, limit: 2 }, { queryClient: client });
  assert.equal(result.probes.length, 2);
  assert.ok(result.nextCursor);
  assert.deepEqual(repository.decodeDiagnosticProbeCursor(result.nextCursor), {
    createdAt: "2026-07-24T10:00:00.000Z",
    id: "101",
  });
  assertNoFullSecrets(result);
});

test("get by probe and callback return public-safe serialized rows", async () => {
  const client = makeClient((sql) => {
    if (/WHERE probe_id = \$1/.test(sql) || /WHERE callback_id = \$1/.test(sql)) return { rows: [probeRow()] };
    return { rows: [] };
  });
  const byProbe = await repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId(PROBE_ID, { queryClient: client });
  const byCallback = await repository.getCodeClipYouTubeWebSubDiagnosticProbeByCallbackId(CALLBACK_ID, { queryClient: client });
  assertNoFullSecrets(byProbe.public);
  assertNoFullSecrets(byCallback.public);
});

test("invalid database row fails closed with invalid_repository_row", async () => {
  const client = makeClient((sql) => {
    if (/WHERE probe_id = \$1/.test(sql)) return { rows: [probeRow({ created_at: null })] };
    return { rows: [] };
  });
  await assert.rejects(
    () => repository.getCodeClipYouTubeWebSubDiagnosticProbeByProbeId(PROBE_ID, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "invalid_repository_row" }
  );
});
