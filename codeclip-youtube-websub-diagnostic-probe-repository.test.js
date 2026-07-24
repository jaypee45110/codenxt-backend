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

function rowFromUpdateParams(params) {
  return probeRow({
    id: params[0],
    probe_id: params[1],
    callback_id: params[2],
    provider: params[3],
    channel: params[4],
    channel_id: params[5],
    topic: params[6],
    status: params[7],
    pending_mode: params[8],
    secret_version: params[9],
    lease_expires_at: params[10],
    verified_at: params[11],
    first_verified_at: params[12],
    last_notification_at: params[13],
    unsubscribed_at: params[14],
    cleanup_required: params[15],
    subscription_may_exist: params[16],
    failed_operation: params[17],
    failed_reason_code: params[18],
    diagnostic_metadata: JSON.parse(params[19]),
    created_at: params[20],
    updated_at: params[21],
  });
}

function makeLifecycleClient(initialRows, options = {}) {
  const state = { rows: Array.isArray(initialRows) ? initialRows : [initialRows] };
  const client = makeClient((sql, params) => {
    if (/SAVEPOINT codeclip_youtube_websub_diagnostic_lifecycle/.test(sql)) {
      if (options.lifecycleSavepointFailure) {
        const error = new Error("SAVEPOINT can only be used in transaction blocks");
        error.code = "25P01";
        throw error;
      }
      return { rows: [] };
    }
    if (/RELEASE SAVEPOINT codeclip_youtube_websub_diagnostic_lifecycle/.test(sql)) return { rows: [] };
    if (/FOR UPDATE/.test(sql)) return { rows: state.rows };
    if (/UPDATE codeclip_youtube_websub_diagnostic_probes/.test(sql)) {
      if (options.zeroUpdate) return { rows: [] };
      const updated = rowFromUpdateParams(params);
      state.rows = [updated];
      return { rows: [updated] };
    }
    return { rows: [] };
  }, { isolation: options.isolation });
  client.state = state;
  return client;
}

function activeRow(overrides = {}) {
  return probeRow({
    status: "active",
    pending_mode: null,
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:05:00.000Z",
    updated_at: "2026-07-24T10:05:00.000Z",
    subscription_may_exist: true,
    ...overrides,
  });
}

function pendingUnsubscribeRow(overrides = {}) {
  return probeRow({
    status: "pending_unsubscribe",
    pending_mode: "unsubscribe",
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:05:00.000Z",
    updated_at: "2026-07-24T10:15:00.000Z",
    subscription_may_exist: true,
    diagnostic_metadata: { cleanup: { requestedAt: "2026-07-24T10:15:00.000Z" } },
    ...overrides,
  });
}

function failedCleanupRow(overrides = {}) {
  return probeRow({
    status: "failed",
    pending_mode: null,
    cleanup_required: true,
    subscription_may_exist: true,
    failed_operation: "subscribe",
    failed_reason_code: "hub_request_failed",
    updated_at: "2026-07-24T10:11:00.000Z",
    diagnostic_metadata: {
      lastFailure: {
        operation: "subscribe",
        reasonCode: "hub_request_failed",
        failedAt: "2026-07-24T10:11:00.000Z",
        cleanupRequired: true,
        subscriptionMayExist: true,
      },
    },
    ...overrides,
  });
}

test("B3 normal lifecycle transitions through dispatch verification notification unsubscribe and cleanup", async () => {
  const client = makeLifecycleClient(probeRow());
  const dispatched = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:01:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
    staleAfterAt: "2026-07-24T10:06:00.000Z",
    leaseSeconds: 86400,
  }, { queryClient: client });
  assert.equal(dispatched.status, "updated");
  assert.equal(dispatched.row.status, "pending_subscribe");
  assert.equal(dispatched.row.diagnosticMetadata.lastDispatch.mode, "subscribe");

  const accepted = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
    probeId: PROBE_ID,
    acceptedAt: "2026-07-24T10:02:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.status, "accepted");
  assert.equal(accepted.row.status, "pending_subscribe");

  const verified = await repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived({
    probeId: PROBE_ID,
    verifiedAt: "2026-07-24T10:03:00.000Z",
    leaseSeconds: 86400,
    topic: TOPIC,
    channelId: CHANNEL_ID,
  }, { queryClient: client });
  assert.equal(verified.row.status, "active");
  assert.equal(verified.row.pendingMode, null);

  const notified = await repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:05:00.000Z",
    titleHash: "abcdef123456",
  }, { queryClient: client });
  assert.equal(notified.row.status, "active");
  assert.equal(notified.row.lastNotificationAt, "2026-07-24T10:05:00.000Z");

  const unsubDispatch = await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:06:00.000Z",
    attemptId: "attempt_unsubscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  assert.equal(unsubDispatch.row.status, "pending_unsubscribe");
  assert.equal(unsubDispatch.row.pendingMode, "unsubscribe");

  await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
    probeId: PROBE_ID,
    acceptedAt: "2026-07-24T10:07:00.000Z",
    attemptId: "attempt_unsubscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  const cleaned = await repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted({
    probeId: PROBE_ID,
    completedAt: "2026-07-24T10:08:00.000Z",
  }, { queryClient: client });
  assert.equal(cleaned.row.status, "unsubscribed");
  assert.equal(cleaned.row.pendingMode, null);
  assert.equal(cleaned.row.subscriptionMayExist, false);
  assertNoFullSecrets(cleaned.public);
});

test("B3 cleanup required always enters failed and unsubscribe dispatch is only pending_unsubscribe entry", async () => {
  const client = makeLifecycleClient(activeRow());
  const cleanup = await repository.markCodeClipYouTubeWebSubDiagnosticCleanupRequired({
    probeId: PROBE_ID,
    requiredAt: "2026-07-24T10:20:00.000Z",
    reasonCode: "diagnostic_cleanup_required",
  }, { queryClient: client });
  assert.equal(cleanup.row.status, "failed");
  assert.equal(cleanup.row.cleanupRequired, true);
  assert.equal(cleanup.row.subscriptionMayExist, true);
  assert.equal(cleanup.row.pendingMode, null);

  const dispatched = await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:21:00.000Z",
    attemptId: "attempt_unsubscribe_cleanup",
    attemptNumber: 1,
  }, { queryClient: client });
  assert.equal(dispatched.row.status, "pending_unsubscribe");
});

test("B3 cleanupRequired true with subscriptionMayExist false is rejected", async () => {
  const client = makeLifecycleClient(activeRow());
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticCleanupRequired({
      probeId: PROBE_ID,
      requiredAt: "2026-07-24T10:20:00.000Z",
      reasonCode: "diagnostic_cleanup_required",
      subscriptionMayExist: false,
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "validation_error" }
  );
});

test("B3 monotonic verification notification updatedAt and cleanup timestamps do not move backward", async () => {
  const client = makeLifecycleClient(activeRow({
    verified_at: "2026-07-24T10:10:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-26T10:10:00.000Z",
    last_notification_at: "2026-07-24T10:12:00.000Z",
    updated_at: "2026-07-24T10:12:00.000Z",
  }));
  const verified = await repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived({
    probeId: PROBE_ID,
    verifiedAt: "2026-07-24T10:09:00.000Z",
    leaseSeconds: 60,
    topic: TOPIC,
    channelId: CHANNEL_ID,
  }, { queryClient: client });
  assert.equal(verified.status, "idempotent");
  assert.equal(verified.row.verifiedAt, "2026-07-24T10:10:00.000Z");
  assert.equal(verified.row.firstVerifiedAt, "2026-07-24T10:05:00.000Z");
  assert.equal(verified.row.leaseExpiresAt, "2026-07-26T10:10:00.000Z");
  assert.equal(verified.row.updatedAt, "2026-07-24T10:12:00.000Z");

  const notified = await repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:01:00.000Z",
    updatedAt: "2026-07-24T10:01:30.000Z",
    observedAt: "2026-07-24T10:11:00.000Z",
    titleHash: "abcdef123456",
  }, { queryClient: client });
  assert.equal(notified.row.lastNotificationAt, "2026-07-24T10:12:00.000Z");

  const unsubscribed = makeLifecycleClient(probeRow({
    status: "unsubscribed",
    pending_mode: null,
    lease_expires_at: null,
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    unsubscribed_at: "2026-07-24T10:30:00.000Z",
    subscription_may_exist: false,
    updated_at: "2026-07-24T10:30:00.000Z",
  }));
  const cleanup = await repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted({
    probeId: PROBE_ID,
    completedAt: "2026-07-24T10:31:00.000Z",
  }, { queryClient: unsubscribed });
  assert.equal(cleanup.status, "idempotent");
  assert.equal(cleanup.row.unsubscribedAt, "2026-07-24T10:30:00.000Z");
});

test("B3 dispatch attempts enforce idempotent stale mismatch and active replacement rules", async () => {
  const started = probeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "started",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        staleAfterAt: "2026-07-24T10:30:00.000Z",
        dispatchedAt: "2026-07-24T10:20:00.000Z",
      },
    },
    updated_at: "2026-07-24T10:20:00.000Z",
  });
  const same = makeLifecycleClient(started);
  const idempotent = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:21:00.000Z",
    attemptId: "attempt_subscribe_2",
    attemptNumber: 2,
  }, { queryClient: same });
  assert.equal(idempotent.status, "idempotent");

  const lower = makeLifecycleClient(started);
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:21:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: lower }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const sameNumberDifferentId = makeLifecycleClient(started);
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:21:00.000Z",
      attemptId: "attempt_subscribe_other",
      attemptNumber: 2,
    }, { queryClient: sameNumberDifferentId }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const activeReplacement = makeLifecycleClient(started);
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:21:00.000Z",
      attemptId: "attempt_subscribe_3",
      attemptNumber: 3,
    }, { queryClient: activeReplacement }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const terminal = makeLifecycleClient(probeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "accepted",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        acceptedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  const next = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:21:00.000Z",
    attemptId: "attempt_subscribe_3",
    attemptNumber: 3,
  }, { queryClient: terminal });
  assert.equal(next.status, "updated");
  assert.equal(next.row.diagnosticMetadata.lastDispatch.attemptNumber, 3);
});

test("B3 accepted result must match current attempt and stale accepted is rejected", async () => {
  const client = makeLifecycleClient(probeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "started",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        dispatchedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
      probeId: PROBE_ID,
      acceptedAt: "2026-07-24T10:22:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
});

test("B3 illegal transitions fail closed", async () => {
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
      probeId: PROBE_ID,
      channelId: CHANNEL_ID,
      videoId: "Q8yMabcVtxc",
      publishedAt: "2026-07-24T10:01:00.000Z",
      updatedAt: "2026-07-24T10:01:30.000Z",
      observedAt: "2026-07-24T10:11:00.000Z",
    }, { queryClient: makeLifecycleClient(probeRow()) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted({
      probeId: PROBE_ID,
      completedAt: "2026-07-24T10:11:00.000Z",
    }, { queryClient: makeLifecycleClient(activeRow()) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
});

test("B3 locks exact identity with FOR UPDATE and split brain probe/callback fails closed", async () => {
  const client = makeLifecycleClient([
    probeRow({ id: "1", probe_id: PROBE_ID, callback_id: "diag_yt_otherCallback1234" }),
    probeRow({ id: "2", probe_id: "diag_otherProbe123", callback_id: CALLBACK_ID }),
  ]);
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      callbackId: CALLBACK_ID,
      dispatchedAt: "2026-07-24T10:01:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
  assert.ok(client.calls.some((call) => /FOR UPDATE/.test(call.sql)));
});

test("B3 update returning zero rows fails closed with repository_state_conflict", async () => {
  const client = makeLifecycleClient(probeRow(), { zeroUpdate: true });
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:01:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
  const update = client.calls.find((call) => /UPDATE codeclip_youtube_websub_diagnostic_probes/.test(call.sql));
  assert.match(update.sql, /WHERE id = \$1/);
});

test("B3 malformed persisted dispatch metadata fails closed", async () => {
  const client = makeLifecycleClient(probeRow({
    diagnostic_metadata: { lastDispatch: { mode: "subscribe", status: "started", attemptId: "bad", attemptNumber: null } },
  }));
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:01:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "invalid_repository_row" }
  );
});

test("B3 success return status is updated or idempotent and public remains sanitized", async () => {
  const client = makeLifecycleClient(probeRow());
  const first = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:01:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  const second = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:02:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  assert.deepEqual([first.status, second.status], ["updated", "idempotent"]);
  assert.notEqual(first.status, "conflict");
  assertNoFullSecrets(first.public);
});


test("B3 failed dispatch attempts cannot later be accepted and duplicate accepted remains idempotent", async () => {
  const failedSubscribe = makeLifecycleClient(probeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "failed",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        failedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
      probeId: PROBE_ID,
      acceptedAt: "2026-07-24T10:21:00.000Z",
      attemptId: "attempt_subscribe_2",
      attemptNumber: 2,
    }, { queryClient: failedSubscribe }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const failedUnsubscribe = makeLifecycleClient(probeRow({
    status: "pending_unsubscribe",
    pending_mode: "unsubscribe",
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:05:00.000Z",
    subscription_may_exist: true,
    diagnostic_metadata: {
      lastDispatch: {
        mode: "unsubscribe",
        status: "failed",
        attemptId: "attempt_unsubscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        failedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
      probeId: PROBE_ID,
      acceptedAt: "2026-07-24T10:21:00.000Z",
      attemptId: "attempt_unsubscribe_2",
      attemptNumber: 2,
    }, { queryClient: failedUnsubscribe }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const acceptedSubscribe = makeLifecycleClient(probeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "accepted",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        acceptedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  const duplicate = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
    probeId: PROBE_ID,
    acceptedAt: "2026-07-24T10:21:00.000Z",
    attemptId: "attempt_subscribe_2",
    attemptNumber: 2,
  }, { queryClient: acceptedSubscribe });
  assert.equal(duplicate.status, "idempotent");
});

test("B3 verification idempotency preserves metadata unless monotonic fields advance", async () => {
  const lastVerification = {
    mode: "subscribe",
    leaseSeconds: 86400,
    verifiedAt: "2026-07-24T10:10:00.000Z",
  };
  const client = makeLifecycleClient(activeRow({
    verified_at: "2026-07-24T10:10:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:10:00.000Z",
    updated_at: "2026-07-24T10:10:00.000Z",
    diagnostic_metadata: { lastVerification },
  }));

  const older = await repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived({
    probeId: PROBE_ID,
    verifiedAt: "2026-07-24T10:09:00.000Z",
    leaseSeconds: 60,
    topic: TOPIC,
    channelId: CHANNEL_ID,
  }, { queryClient: client });
  assert.equal(older.status, "idempotent");
  assert.deepEqual(older.row.diagnosticMetadata.lastVerification, lastVerification);

  const identical = await repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived({
    probeId: PROBE_ID,
    verifiedAt: "2026-07-24T10:10:00.000Z",
    leaseSeconds: 86400,
    topic: TOPIC,
    channelId: CHANNEL_ID,
  }, { queryClient: client });
  assert.equal(identical.status, "idempotent");
  assert.deepEqual(identical.row.diagnosticMetadata.lastVerification, lastVerification);

  const newer = await repository.markCodeClipYouTubeWebSubDiagnosticVerificationReceived({
    probeId: PROBE_ID,
    verifiedAt: "2026-07-24T10:20:00.000Z",
    leaseSeconds: 86400,
    topic: TOPIC,
    channelId: CHANNEL_ID,
  }, { queryClient: client });
  assert.equal(newer.status, "updated");
  assert.equal(newer.row.verifiedAt, "2026-07-24T10:20:00.000Z");
  assert.equal(newer.row.leaseExpiresAt, "2026-07-25T10:20:00.000Z");
  assert.deepEqual(newer.row.diagnosticMetadata.lastVerification, {
    mode: "subscribe",
    leaseSeconds: 86400,
    verifiedAt: "2026-07-24T10:20:00.000Z",
  });
});

test("B3 notification observation preserves newer metadata and rejects same-timestamp conflicts", async () => {
  const lastNotification = {
    observationIdentity: `youtube:${CHANNEL_ID}:Q8yMabcVtxc:published:2026-07-24T10:04:00.000Z`,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:12:00.000Z",
    titleHash: "abcdef123456",
    duplicate: false,
  };
  const client = makeLifecycleClient(activeRow({
    last_notification_at: "2026-07-24T10:12:00.000Z",
    updated_at: "2026-07-24T10:12:00.000Z",
    diagnostic_metadata: { lastNotification },
  }));

  const older = await repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "OldVideo123",
    publishedAt: "2026-07-24T10:01:00.000Z",
    updatedAt: "2026-07-24T10:01:30.000Z",
    observedAt: "2026-07-24T10:11:00.000Z",
    titleHash: "bbbbbbbb",
  }, { queryClient: client });
  assert.equal(older.status, "idempotent");
  assert.deepEqual(older.row.diagnosticMetadata.lastNotification, lastNotification);

  const identical = await repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:12:00.000Z",
    titleHash: "abcdef123456",
  }, { queryClient: client });
  assert.equal(identical.status, "idempotent");
  assert.deepEqual(identical.row.diagnosticMetadata.lastNotification, lastNotification);

  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
      probeId: PROBE_ID,
      channelId: CHANNEL_ID,
      videoId: "Other12345",
      publishedAt: "2026-07-24T10:06:00.000Z",
      updatedAt: "2026-07-24T10:06:30.000Z",
      observedAt: "2026-07-24T10:12:00.000Z",
      titleHash: "cccccccc",
    }, { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );

  const newer = await repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "NewVid1234",
    publishedAt: "2026-07-24T10:13:00.000Z",
    updatedAt: "2026-07-24T10:13:30.000Z",
    observedAt: "2026-07-24T10:13:45.000Z",
    titleHash: "dddddddd",
  }, { queryClient: client });
  assert.equal(newer.status, "updated");
  assert.equal(newer.row.lastNotificationAt, "2026-07-24T10:13:45.000Z");
  assert.equal(newer.row.diagnosticMetadata.lastNotification.videoId, "NewVid1234");
});

test("B3 cleanup completed is monotonic for updatedAt and cleanup metadata", async () => {
  const client = makeLifecycleClient(probeRow({
    status: "pending_unsubscribe",
    pending_mode: "unsubscribe",
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:05:00.000Z",
    subscription_may_exist: true,
    updated_at: "2026-07-24T10:30:00.000Z",
    diagnostic_metadata: { cleanup: { requestedAt: "2026-07-24T10:20:00.000Z", confirmedAt: "2026-07-24T10:29:00.000Z" } },
  }));
  const cleanup = await repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted({
    probeId: PROBE_ID,
    completedAt: "2026-07-24T10:25:00.000Z",
  }, { queryClient: client });
  assert.equal(cleanup.row.status, "unsubscribed");
  assert.equal(cleanup.row.unsubscribedAt, "2026-07-24T10:25:00.000Z");
  assert.equal(cleanup.row.updatedAt, "2026-07-24T10:30:00.000Z");
  assert.equal(cleanup.row.diagnosticMetadata.cleanup.confirmedAt, "2026-07-24T10:29:00.000Z");

  const duplicate = await repository.markCodeClipYouTubeWebSubDiagnosticCleanupCompleted({
    probeId: PROBE_ID,
    completedAt: "2026-07-24T10:31:00.000Z",
  }, { queryClient: client });
  assert.equal(duplicate.status, "idempotent");
  assert.equal(duplicate.row.unsubscribedAt, "2026-07-24T10:25:00.000Z");
  assert.equal(duplicate.row.diagnosticMetadata.cleanup.confirmedAt, "2026-07-24T10:29:00.000Z");
});

test("B3 subscribe failure records failed state and duplicate failure is idempotent", async () => {
  const client = makeLifecycleClient(probeRow());
  const failed = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeFailed({
    probeId: PROBE_ID,
    failedAt: "2026-07-24T10:10:00.000Z",
    reasonCode: "hub_request_failed",
    cleanupRequired: true,
    subscriptionMayExist: true,
  }, { queryClient: client });
  assert.equal(failed.status, "updated");
  assert.equal(failed.row.status, "failed");
  assert.equal(failed.row.failedOperation, "subscribe");
  assert.equal(failed.row.cleanupRequired, true);

  const duplicate = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeFailed({
    probeId: PROBE_ID,
    failedAt: "2026-07-24T10:11:00.000Z",
    reasonCode: "hub_request_failed",
    cleanupRequired: true,
    subscriptionMayExist: true,
  }, { queryClient: client });
  assert.equal(duplicate.status, "idempotent");
});

test("B3 unsubscribe accepted duplicate is idempotent", async () => {
  const client = makeLifecycleClient(probeRow({
    status: "pending_unsubscribe",
    pending_mode: "unsubscribe",
    verified_at: "2026-07-24T10:05:00.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    lease_expires_at: "2026-07-25T10:05:00.000Z",
    subscription_may_exist: true,
    diagnostic_metadata: {
      lastDispatch: {
        mode: "unsubscribe",
        status: "accepted",
        attemptId: "attempt_unsubscribe_1",
        attemptNumber: 1,
        retryEligible: false,
        acceptedAt: "2026-07-24T10:20:00.000Z",
      },
    },
  }));
  const duplicate = await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
    probeId: PROBE_ID,
    acceptedAt: "2026-07-24T10:21:00.000Z",
    attemptId: "attempt_unsubscribe_1",
    attemptNumber: 1,
  }, { queryClient: client });
  assert.equal(duplicate.status, "idempotent");
});

test("B3 lifecycle lookup supports callback-only and matching probe plus callback identities", async () => {
  const byCallback = makeLifecycleClient(probeRow());
  const callbackOnly = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    callbackId: CALLBACK_ID,
    dispatchedAt: "2026-07-24T10:01:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: byCallback });
  assert.equal(callbackOnly.status, "updated");
  assert.match(byCallback.calls.find((call) => /FOR UPDATE/.test(call.sql)).sql, /callback_id = \$1/);

  const both = makeLifecycleClient(probeRow());
  const bothIdentities = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    dispatchedAt: "2026-07-24T10:01:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: both });
  assert.equal(bothIdentities.status, "updated");
});

test("B3 supplied lifecycle transaction contract is enforced", async () => {
  const readCommitted = makeLifecycleClient(probeRow());
  const success = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
    probeId: PROBE_ID,
    dispatchedAt: "2026-07-24T10:01:00.000Z",
    attemptId: "attempt_subscribe_1",
    attemptNumber: 1,
  }, { queryClient: readCommitted });
  assert.equal(success.status, "updated");
  assert.equal(readCommitted.calls.some((call) => /^BEGIN/.test(call.sql)), false);
  assert.equal(readCommitted.calls.some((call) => call.sql === "COMMIT" || call.sql === "ROLLBACK"), false);

  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:01:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: makeLifecycleClient(probeRow(), { lifecycleSavepointFailure: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_required" }
  );

  await assert.rejects(
    () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeDispatched({
      probeId: PROBE_ID,
      dispatchedAt: "2026-07-24T10:01:00.000Z",
      attemptId: "attempt_subscribe_1",
      attemptNumber: 1,
    }, { queryClient: makeLifecycleClient(probeRow(), { isolation: "repeatable read" }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_isolation_unsupported" }
  );
});
