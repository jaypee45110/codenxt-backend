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

function observationIdentity({ channelId = CHANNEL_ID, videoId = "Q8yMabcVtxc", publishedAt = "2026-07-24T10:04:00.000Z" } = {}) {
  return repository.buildDiagnosticObservationIdentity({ channelId, videoId, publishedAt });
}

function observationInput(overrides = {}) {
  return {
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    channelId: CHANNEL_ID,
    topic: TOPIC,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:12:00.000Z",
    titleHash: "abcdef123456",
    contentType: "application/atom+xml",
    ...overrides,
  };
}

function observationRow(overrides = {}) {
  const row = {
    id: "77",
    probe_id: PROBE_ID,
    observed_callback_id: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    channel_id: CHANNEL_ID,
    topic: TOPIC,
    observation_identity: observationIdentity(),
    entry_id: null,
    video_id: "Q8yMabcVtxc",
    published_at: "2026-07-24T10:04:00.000Z",
    entry_updated_at: "2026-07-24T10:04:30.000Z",
    first_observed_at: "2026-07-24T10:12:00.000Z",
    last_observed_at: "2026-07-24T10:12:00.000Z",
    seen_count: 1,
    notification_hash: null,
    title_hash: "abcdef123456",
    content_type: "application/atom+xml",
    diagnostic_metadata: {
      latest: {
        observationIdentity: observationIdentity(),
        channelId: CHANNEL_ID,
        videoId: "Q8yMabcVtxc",
        publishedAt: "2026-07-24T10:04:00.000Z",
        updatedAt: "2026-07-24T10:04:30.000Z",
        observedAt: "2026-07-24T10:12:00.000Z",
        titleHash: "abcdef123456",
        duplicate: false,
      },
    },
    created_at: "2026-07-24T10:12:00.000Z",
    updated_at: "2026-07-24T10:12:00.000Z",
    ...overrides,
  };
  return row;
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

function diagnosticObservationCheckRows(options = {}) {
  const scenario = options.checkScenario || (options.semanticChecks ? "semantic" : "missing");
  if (scenario === "semantic") {
    return [
      { conname: "auto_provider_check", definition: "CHECK ((provider = 'youtube'::text))" },
      { conname: "auto_channel_check", definition: "CHECK ((channel = 'youtube'::text))" },
      { conname: "auto_metadata_check", definition: "CHECK ((jsonb_typeof(diagnostic_metadata) = 'object'::text))" },
      { conname: "auto_seen_count_check", definition: "CHECK ((seen_count >= 1))" },
      { conname: "auto_observed_time_check", definition: "CHECK ((last_observed_at >= first_observed_at))" },
      { conname: "auto_updated_check", definition: "CHECK ((updated_at >= created_at))" },
    ];
  }
  if (scenario === "semanticProvider") {
    return [{ conname: "auto_provider_check", definition: "CHECK ((provider = 'youtube'::text))" }];
  }
  if (scenario === "semanticChannel") {
    return [{ conname: "auto_channel_check", definition: "CHECK ((channel = 'youtube'::text))" }];
  }
  if (scenario === "semanticMetadata") {
    return [{ conname: "auto_metadata_check", definition: "CHECK ((jsonb_typeof(diagnostic_metadata) = 'object'::text))" }];
  }
  const weakDefinitions = {
    invertedProvider: "CHECK ((provider <> 'youtube'::text))",
    nullableProvider: "CHECK (((provider IS NULL) OR (provider = 'youtube'::text)))",
    providerAndExtra: "CHECK (((provider = 'youtube'::text) AND (provider <> ''::text)))",
    wrongProviderConstant: "CHECK ((provider = 'vimeo'::text))",
    wrongProviderColumn: "CHECK ((channel = 'youtube'::text))",
    invertedChannel: "CHECK ((channel <> 'youtube'::text))",
    channelAndExtra: "CHECK (((channel = 'youtube'::text) AND (channel <> ''::text)))",
    metadataAndExtra: "CHECK (((jsonb_typeof(diagnostic_metadata) = 'object'::text) AND (diagnostic_metadata <> '{}'::jsonb)))",
    nullableSeenCount: "CHECK (((seen_count IS NULL) OR (seen_count >= 1)))",
    invertedSeenCount: "CHECK ((seen_count < 1))",
    seenCountAndExtra: "CHECK (((seen_count >= 1) AND (seen_count < 100)))",
    missingObservedTimePart: "CHECK ((last_observed_at >= created_at))",
    invertedObservedTime: "CHECK ((last_observed_at < first_observed_at))",
    observedTimeAndExtra: "CHECK (((last_observed_at >= first_observed_at) AND (created_at IS NOT NULL)))",
    nullableUpdated: "CHECK (((updated_at IS NULL) OR (updated_at >= created_at)))",
    updatedAndExtra: "CHECK (((updated_at >= created_at) AND (created_at IS NOT NULL)))",
  };
  if (weakDefinitions[scenario]) {
    return [{ conname: `weak_${scenario}`, definition: weakDefinitions[scenario] }];
  }
  return [];
}

function makeDiagnosticEnsureClient(options = {}) {
  let migrationDoCount = 0;
  const uniqueRows = {
    semantic: [{
      indisunique: true,
      indisvalid: true,
      indisready: true,
      is_partial: false,
      is_expression: false,
      indnkeyatts: 2,
      indnatts: 2,
      columns: ["probe_id", "observation_identity"],
      has_invalid_attribute: false,
    }],
    partial: [{
      indisunique: true,
      indisvalid: true,
      indisready: true,
      is_partial: true,
      is_expression: false,
      indnkeyatts: 2,
      indnatts: 2,
      columns: ["probe_id", "observation_identity"],
      has_invalid_attribute: false,
    }],
    expression: [{
      indisunique: true,
      indisvalid: true,
      indisready: true,
      is_partial: false,
      is_expression: true,
      indnkeyatts: 2,
      indnatts: 2,
      columns: ["probe_id", "observation_identity"],
      has_invalid_attribute: false,
    }],
    invalid: [{
      indisunique: true,
      indisvalid: false,
      indisready: false,
      is_partial: false,
      is_expression: false,
      indnkeyatts: 2,
      indnatts: 2,
      columns: ["probe_id", "observation_identity"],
      has_invalid_attribute: false,
    }],
    reversed: [{
      indisunique: true,
      indisvalid: true,
      indisready: true,
      is_partial: false,
      is_expression: false,
      indnkeyatts: 2,
      indnatts: 2,
      columns: ["observation_identity", "probe_id"],
      has_invalid_attribute: false,
    }],
    include: [{
      indisunique: true,
      indisvalid: true,
      indisready: true,
      is_partial: false,
      is_expression: false,
      indnkeyatts: 2,
      indnatts: 3,
      columns: ["probe_id", "observation_identity", "included_context"],
      has_invalid_attribute: false,
    }],
    missing: [],
  };
  const client = makeClient((sql, params) => {
    if (/pg_advisory_xact_lock/.test(sql)) {
      assert.deepEqual(params, [2036220848, 20260724]);
      return { rows: [] };
    }
    if (/DO \$\$/.test(sql) && /duplicate B4 observation identities/.test(sql)) {
      migrationDoCount += 1;
      if (options.failMigrationAt === migrationDoCount) {
        throw new Error(options.failMigrationMessage || "codeclip_youtube_websub_diagnostic_observations contains duplicate B4 observation identities");
      }
      return { rows: [] };
    }
    if (/FROM pg_constraint c/.test(sql) && /pg_get_constraintdef/.test(sql) && /contype = 'c'/.test(sql)) {
      return { rows: diagnosticObservationCheckRows(options) };
    }
    if (/FROM pg_constraint c/.test(sql) && /c\.conname = \$1/.test(sql)) {
      return { rows: options.canonicalConstraintExists ? [{ conname: params[0] }] : [] };
    }
    if (/FROM pg_index i/.test(sql) && /array_agg\(a\.attname ORDER BY key\.key_ordinal\)/.test(sql)) {
      const uniqueScenario = options.uniqueScenario || (options.semanticUnique ? "semantic" : "missing");
      client.uniqueScenarioChecked = uniqueScenario;
      client.uniqueQuery = sql;
      return { rows: uniqueRows[uniqueScenario] || [] };
    }
    return { rows: [] };
  });
  return client;
}

async function runDiagnosticProbeTableEnsure(options = {}) {
  const client = makeDiagnosticEnsureClient(options);
  await db.ensureCodeClipYouTubeWebSubDiagnosticProbeTables(client);
  return client;
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

function rowFromObservationInsertParams(params) {
  return observationRow({
    probe_id: params[0],
    observed_callback_id: params[1],
    provider: params[2],
    channel: params[3],
    channel_id: params[4],
    topic: params[5],
    observation_identity: params[6],
    entry_id: params[7],
    video_id: params[8],
    published_at: params[9],
    entry_updated_at: params[10],
    first_observed_at: params[11],
    last_observed_at: params[12],
    seen_count: params[13],
    notification_hash: params[14],
    title_hash: params[15],
    content_type: params[16],
    diagnostic_metadata: JSON.parse(params[17]),
    created_at: params[18],
    updated_at: params[19],
  });
}

function rowFromObservationUpdateParams(existing, params) {
  const isUpdated = params[9] === true;
  return observationRow({
    ...existing,
    observed_callback_id: existing.observed_callback_id || params[1],
    entry_id: existing.entry_id || params[2],
    entry_updated_at: params[3],
    last_observed_at: params[4],
    seen_count: Number(existing.seen_count) + 1,
    notification_hash: existing.notification_hash || params[5],
    title_hash: isUpdated ? params[6] : existing.title_hash,
    content_type: isUpdated ? params[7] : existing.content_type,
    diagnostic_metadata: JSON.parse(params[8]),
    updated_at: Date.parse(params[10]) > Date.parse(existing.updated_at) ? params[10] : existing.updated_at,
  });
}

function makeLifecycleClient(initialRows, options = {}) {
  const state = {
    rows: Array.isArray(initialRows) ? initialRows : [initialRows],
    observations: Array.isArray(options.observations) ? options.observations : [],
  };
  const client = makeClient((sql, params) => {
    if (/SAVEPOINT codeclip_youtube_websub_diagnostic_(lifecycle|observation)/.test(sql)) {
      if (options.lifecycleSavepointFailure || options.observationSavepointFailure) {
        const error = new Error("SAVEPOINT can only be used in transaction blocks");
        error.code = "25P01";
        throw error;
      }
      return { rows: [] };
    }
    if (/RELEASE SAVEPOINT codeclip_youtube_websub_diagnostic_(lifecycle|observation)/.test(sql)) return { rows: [] };
    if (/ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_observation/.test(sql)) return { rows: [] };
    if (/FROM codeclip_youtube_websub_diagnostic_observations/.test(sql) && /FOR UPDATE/.test(sql)) {
      if (options.splitObservationRows) return { rows: [observationRow(), observationRow({ id: "78" })] };
      return { rows: state.observations.filter((row) => row.probe_id === params[0] && row.observation_identity === params[1]) };
    }
    if (/INSERT INTO codeclip_youtube_websub_diagnostic_observations/.test(sql)) {
      if (options.zeroObservationInsert) return { rows: [] };
      if (options.throwObservationInsert) throw new Error("observation insert failed");
      const inserted = rowFromObservationInsertParams(params);
      state.observations = [inserted, ...state.observations];
      return { rows: [inserted] };
    }
    if (/UPDATE codeclip_youtube_websub_diagnostic_observations/.test(sql)) {
      if (options.zeroObservationUpdate) return { rows: [] };
      const existing = state.observations.find((row) => String(row.id) === String(params[0]));
      const updated = rowFromObservationUpdateParams(existing || observationRow({ id: String(params[0]) }), params);
      state.observations = state.observations.map((row) => String(row.id) === String(params[0]) ? updated : row);
      return { rows: [updated] };
    }
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

  const notified = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:05:00.000Z",
    titleHash: "abcdef123456",
  }, { queryClient: client });
  assert.equal(notified.probe.status, "active");
  assert.equal(notified.probe.lastNotificationAt, "2026-07-24T10:05:00.000Z");

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

  const notified = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:01:00.000Z",
    updatedAt: "2026-07-24T10:01:30.000Z",
    observedAt: "2026-07-24T10:11:00.000Z",
    titleHash: "abcdef123456",
  }, { queryClient: client });
  assert.equal(notified.probe.lastNotificationAt, "2026-07-24T10:12:00.000Z");

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

test("B5 subscribe accepted reconciles verified active race for the same dispatch attempt", async () => {
  const activeVerified = activeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "started",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        dispatchedAt: "2026-07-24T10:20:00.000Z",
        leaseSeconds: 864000,
      },
      lastVerification: {
        mode: "subscribe",
        verifiedAt: "2026-07-24T10:20:01.000Z",
        leaseSeconds: 864000,
      },
    },
    verified_at: "2026-07-24T10:20:01.000Z",
    first_verified_at: "2026-07-24T10:20:01.000Z",
    lease_expires_at: "2026-08-03T10:20:01.000Z",
    updated_at: "2026-07-24T10:20:01.000Z",
  });
  const client = makeLifecycleClient(activeVerified);

  const accepted = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    acceptedAt: "2026-07-24T10:20:02.000Z",
    attemptId: "attempt_subscribe_2",
    attemptNumber: 2,
    resultCode: "hub_request_accepted",
  }, { queryClient: client });

  assert.equal(accepted.status, "updated");
  assert.equal(accepted.row.status, "active");
  assert.equal(accepted.row.pendingMode, null);
  assert.equal(accepted.row.verifiedAt, "2026-07-24T10:20:01.000Z");
  assert.equal(accepted.row.firstVerifiedAt, "2026-07-24T10:20:01.000Z");
  assert.equal(accepted.row.leaseExpiresAt, "2026-08-03T10:20:01.000Z");
  assert.equal(accepted.row.cleanupRequired, false);
  assert.equal(accepted.row.subscriptionMayExist, true);
  assert.equal(accepted.row.failedOperation, null);
  assert.equal(accepted.row.failedReasonCode, null);
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.status, "accepted");
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.acceptedAt, "2026-07-24T10:20:02.000Z");
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.resultCode, "hub_request_accepted");
  assert.equal(accepted.row.diagnosticMetadata.lastVerification.mode, "subscribe");

  const repeated = await repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    acceptedAt: "2026-07-24T10:20:02.000Z",
    attemptId: "attempt_subscribe_2",
    attemptNumber: 2,
    resultCode: "hub_request_accepted",
  }, { queryClient: client });
  assert.equal(repeated.status, "idempotent");
  assert.equal(repeated.row.diagnosticMetadata.lastDispatch.status, "accepted");
});

test("B5 subscribe accepted active race fails closed without exact lifecycle correlation", async () => {
  const activeVerified = activeRow({
    diagnostic_metadata: {
      lastDispatch: {
        mode: "subscribe",
        status: "started",
        attemptId: "attempt_subscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        dispatchedAt: "2026-07-24T10:20:00.000Z",
      },
      lastVerification: {
        mode: "subscribe",
        verifiedAt: "2026-07-24T10:20:01.000Z",
        leaseSeconds: 864000,
      },
    },
  });
  const cases = [
    {
      name: "different attempt id",
      row: activeVerified,
      input: { attemptId: "attempt_subscribe_other", attemptNumber: 2 },
    },
    {
      name: "different attempt number",
      row: activeVerified,
      input: { attemptId: "attempt_subscribe_2", attemptNumber: 3 },
    },
    {
      name: "different dispatch mode",
      row: activeRow({
        diagnostic_metadata: {
          ...activeVerified.diagnostic_metadata,
          lastDispatch: { ...activeVerified.diagnostic_metadata.lastDispatch, mode: "unsubscribe" },
        },
      }),
      input: { attemptId: "attempt_subscribe_2", attemptNumber: 2 },
    },
    {
      name: "missing subscribe verification",
      row: activeRow({
        diagnostic_metadata: {
          lastDispatch: activeVerified.diagnostic_metadata.lastDispatch,
        },
      }),
      input: { attemptId: "attempt_subscribe_2", attemptNumber: 2 },
    },
    {
      name: "non subscribe verification",
      row: activeRow({
        diagnostic_metadata: {
          ...activeVerified.diagnostic_metadata,
          lastVerification: { ...activeVerified.diagnostic_metadata.lastVerification, mode: "unsubscribe" },
        },
      }),
      input: { attemptId: "attempt_subscribe_2", attemptNumber: 2 },
    },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      () => repository.markCodeClipYouTubeWebSubDiagnosticSubscribeAccepted({
        probeId: PROBE_ID,
        callbackId: CALLBACK_ID,
        acceptedAt: "2026-07-24T10:20:02.000Z",
        resultCode: "hub_request_accepted",
        ...testCase.input,
      }, { queryClient: makeLifecycleClient(testCase.row) }),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" },
      testCase.name
    );
  }
});

test("B5 unsubscribe accepted reconciles verified terminal race for the same dispatch attempt", async () => {
  const unsubscribedVerified = probeRow({
    status: "unsubscribed",
    pending_mode: null,
    lease_expires_at: null,
    verified_at: "2026-07-24T10:20:01.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    unsubscribed_at: "2026-07-24T10:20:01.000Z",
    cleanup_required: false,
    subscription_may_exist: false,
    updated_at: "2026-07-24T10:20:01.000Z",
    diagnostic_metadata: {
      lastDispatch: {
        mode: "unsubscribe",
        status: "started",
        attemptId: "attempt_unsubscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        dispatchedAt: "2026-07-24T10:20:00.000Z",
      },
      lastVerification: {
        mode: "unsubscribe",
        verifiedAt: "2026-07-24T10:20:01.000Z",
      },
      cleanup: {
        requestedAt: "2026-07-24T10:20:00.000Z",
        confirmedAt: "2026-07-24T10:20:01.000Z",
      },
    },
  });
  const client = makeLifecycleClient(unsubscribedVerified);

  const accepted = await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    acceptedAt: "2026-07-24T10:20:02.000Z",
    attemptId: "attempt_unsubscribe_2",
    attemptNumber: 2,
    resultCode: "hub_request_accepted",
  }, { queryClient: client });

  assert.equal(accepted.status, "updated");
  assert.equal(accepted.row.status, "unsubscribed");
  assert.equal(accepted.row.pendingMode, null);
  assert.equal(accepted.row.unsubscribedAt, "2026-07-24T10:20:01.000Z");
  assert.equal(accepted.row.leaseExpiresAt, null);
  assert.equal(accepted.row.cleanupRequired, false);
  assert.equal(accepted.row.subscriptionMayExist, false);
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.status, "accepted");
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.acceptedAt, "2026-07-24T10:20:02.000Z");
  assert.equal(accepted.row.diagnosticMetadata.lastDispatch.resultCode, "hub_request_accepted");
  assert.equal(accepted.row.diagnosticMetadata.lastVerification.mode, "unsubscribe");

  const repeated = await repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    acceptedAt: "2026-07-24T10:20:02.000Z",
    attemptId: "attempt_unsubscribe_2",
    attemptNumber: 2,
    resultCode: "hub_request_accepted",
  }, { queryClient: client });
  assert.equal(repeated.status, "idempotent");
  assert.equal(repeated.row.diagnosticMetadata.lastDispatch.status, "accepted");
});

test("B5 unsubscribe accepted terminal race fails closed without exact lifecycle correlation", async () => {
  const terminalVerified = probeRow({
    status: "unsubscribed",
    pending_mode: null,
    lease_expires_at: null,
    verified_at: "2026-07-24T10:20:01.000Z",
    first_verified_at: "2026-07-24T10:05:00.000Z",
    unsubscribed_at: "2026-07-24T10:20:01.000Z",
    cleanup_required: false,
    subscription_may_exist: false,
    updated_at: "2026-07-24T10:20:01.000Z",
    diagnostic_metadata: {
      lastDispatch: {
        mode: "unsubscribe",
        status: "started",
        attemptId: "attempt_unsubscribe_2",
        attemptNumber: 2,
        retryEligible: false,
        dispatchedAt: "2026-07-24T10:20:00.000Z",
      },
      lastVerification: {
        mode: "unsubscribe",
        verifiedAt: "2026-07-24T10:20:01.000Z",
      },
    },
  });
  const cases = [
    {
      name: "different attempt id",
      row: terminalVerified,
      input: { attemptId: "attempt_unsubscribe_other", attemptNumber: 2 },
    },
    {
      name: "different attempt number",
      row: terminalVerified,
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 3 },
    },
    {
      name: "different dispatch mode",
      row: probeRow({
        ...terminalVerified,
        diagnostic_metadata: {
          ...terminalVerified.diagnostic_metadata,
          lastDispatch: { ...terminalVerified.diagnostic_metadata.lastDispatch, mode: "subscribe" },
        },
      }),
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 2 },
    },
    {
      name: "missing unsubscribe verification",
      row: probeRow({
        ...terminalVerified,
        diagnostic_metadata: {
          lastDispatch: terminalVerified.diagnostic_metadata.lastDispatch,
        },
      }),
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 2 },
    },
    {
      name: "non unsubscribe verification",
      row: probeRow({
        ...terminalVerified,
        diagnostic_metadata: {
          ...terminalVerified.diagnostic_metadata,
          lastVerification: { ...terminalVerified.diagnostic_metadata.lastVerification, mode: "subscribe" },
        },
      }),
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 2 },
    },
    {
      name: "subscription still may exist",
      row: probeRow({ ...terminalVerified, subscription_may_exist: true }),
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 2 },
    },
    {
      name: "cleanup still required",
      row: probeRow({ ...terminalVerified, cleanup_required: true }),
      input: { attemptId: "attempt_unsubscribe_2", attemptNumber: 2 },
    },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      () => repository.markCodeClipYouTubeWebSubDiagnosticUnsubscribeAccepted({
        probeId: PROBE_ID,
        callbackId: CALLBACK_ID,
        acceptedAt: "2026-07-24T10:20:02.000Z",
        resultCode: "hub_request_accepted",
        ...testCase.input,
      }, { queryClient: makeLifecycleClient(testCase.row) }),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" },
      testCase.name
    );
  }
});

test("B3 illegal transitions fail closed", async () => {
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
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
  }), { observations: [observationRow()] });

  const older = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "OldVideo123",
    publishedAt: "2026-07-24T10:01:00.000Z",
    updatedAt: "2026-07-24T10:01:30.000Z",
    observedAt: "2026-07-24T10:11:00.000Z",
    titleHash: "bbbbbbbb",
  }, { queryClient: client });
  assert.equal(older.status, "recorded");
  assert.deepEqual(older.probe.diagnosticMetadata.lastNotification, lastNotification);

  const identical = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "Q8yMabcVtxc",
    publishedAt: "2026-07-24T10:04:00.000Z",
    updatedAt: "2026-07-24T10:04:30.000Z",
    observedAt: "2026-07-24T10:12:00.000Z",
    titleHash: "abcdef123456",
    contentType: "application/atom+xml",
  }, { queryClient: client });
  assert.equal(identical.status, "duplicate");
  assert.deepEqual(identical.probe.diagnosticMetadata.lastNotification, lastNotification);

  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
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

  const newer = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation({
    probeId: PROBE_ID,
    channelId: CHANNEL_ID,
    videoId: "NewVid1234",
    publishedAt: "2026-07-24T10:13:00.000Z",
    updatedAt: "2026-07-24T10:13:30.000Z",
    observedAt: "2026-07-24T10:13:45.000Z",
    titleHash: "dddddddd",
  }, { queryClient: client });
  assert.equal(newer.status, "recorded");
  assert.equal(newer.probe.lastNotificationAt, "2026-07-24T10:13:45.000Z");
  assert.equal(newer.probe.diagnosticMetadata.lastNotification.videoId, "NewVid1234");
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


test("B4 first diagnostic notification observation is atomic and recorded", async () => {
  const client = makeLifecycleClient(activeRow());
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: client });
  assert.equal(result.status, "recorded");
  assert.equal(result.observation.seenCount, 1);
  assert.equal(result.observation.firstObservedAt, "2026-07-24T10:12:00.000Z");
  assert.equal(result.probe.lastNotificationAt, "2026-07-24T10:12:00.000Z");
  assertNoFullSecrets(result.publicProbe);
  assertNoFullSecrets(result.publicObservation);
  const ordered = callNames(client.calls);
  assert.ok(ordered.findIndex((sql) => /SELECT \* FROM codeclip_youtube_websub_diagnostic_probes/.test(sql) && /FOR UPDATE/.test(sql)) < ordered.findIndex((sql) => /INSERT INTO codeclip_youtube_websub_diagnostic_observations/.test(sql)));
  assert.ok(ordered.findIndex((sql) => /INSERT INTO codeclip_youtube_websub_diagnostic_observations/.test(sql)) < ordered.findIndex((sql) => /UPDATE codeclip_youtube_websub_diagnostic_probes/.test(sql)));
});

test("B4 duplicate observation increments seenCount and preserves firstObservedAt", async () => {
  const client = makeLifecycleClient(activeRow({ last_notification_at: "2026-07-24T10:12:00.000Z" }), {
    observations: [observationRow()],
  });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: client });
  assert.equal(result.status, "duplicate");
  assert.equal(result.observation.seenCount, 2);
  assert.equal(result.observation.firstObservedAt, "2026-07-24T10:12:00.000Z");
  assert.equal(result.probe.lastNotificationAt, "2026-07-24T10:12:00.000Z");
});

test("B4 stale benign replay is duplicate and does not overwrite probe metadata", async () => {
  const latest = {
    observationIdentity: observationIdentity(),
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
    diagnostic_metadata: { lastNotification: latest },
  }), { observations: [observationRow()] });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ observedAt: "2026-07-24T10:11:00.000Z" }), { queryClient: client });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.probe.diagnosticMetadata.lastNotification, latest);
});

test("B4 newer observation updates observation row and probe summary", async () => {
  const client = makeLifecycleClient(activeRow({ last_notification_at: "2026-07-24T10:12:00.000Z" }), {
    observations: [observationRow()],
  });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({
    updatedAt: "2026-07-24T10:13:30.000Z",
    observedAt: "2026-07-24T10:14:00.000Z",
    titleHash: "dddddddd",
  }), { queryClient: client });
  assert.equal(result.status, "updated");
  assert.equal(result.observation.seenCount, 2);
  assert.equal(result.observation.lastObservedAt, "2026-07-24T10:14:00.000Z");
  assert.equal(result.probe.lastNotificationAt, "2026-07-24T10:14:00.000Z");
  assert.equal(result.probe.diagnosticMetadata.lastNotification.titleHash, "dddddddd");
});

test("B4 same timestamp conflicting payload and immutable/hash mismatches fail before replay count", async () => {
  const client = makeLifecycleClient(activeRow({ last_notification_at: "2026-07-24T10:12:00.000Z" }), { observations: [observationRow()] });
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ titleHash: "bbbbbbbb" }), { queryClient: client }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
  assert.equal(client.state.observations[0].seen_count, 1);

  const hashClient = makeLifecycleClient(activeRow(), { observations: [observationRow({ notification_hash: "aaaaaaaa" })] });
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ notificationHash: "bbbbbbbb" }), { queryClient: hashClient }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
  assert.equal(hashClient.state.observations[0].seen_count, 1);
});

test("B4 callback ingress context is diagnostic and not observation identity", async () => {
  const otherCallback = "diag_yt_otherCallback9999";
  const client = makeLifecycleClient(activeRow({ last_notification_at: "2026-07-24T10:12:00.000Z" }), { observations: [observationRow()] });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ observedCallbackId: otherCallback }), { queryClient: client });
  assert.equal(result.status, "duplicate");
  assert.equal(result.observation.observationIdentity, observationIdentity());
  assert.equal(result.observation.observedCallbackId, CALLBACK_ID);
});

test("B4 observation identity builder is authoritative and deterministic", () => {
  assert.equal(observationIdentity(), "youtube:UCvwiNkgNuGuizjo33NZhzPg:Q8yMabcVtxc:published:2026-07-24T10:04:00.000Z");
  assert.equal(repository.buildDiagnosticObservationIdentity({ channelId: CHANNEL_ID, videoId: "Q8yMabcVtxc", publishedAt: "2026-07-24T10:04:00.000Z" }), observationIdentity());
});

test("B4 different probes can record the same observation identity", async () => {
  const otherProbe = "diag_probeOther123";
  const client = makeLifecycleClient(activeRow({ probe_id: otherProbe }), { observations: [observationRow()] });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ probeId: otherProbe }), { queryClient: client });
  assert.equal(result.status, "recorded");
  assert.equal(result.observation.probeId, otherProbe);
  assert.equal(result.observation.observationIdentity, observationIdentity());
});

test("B4 inactive probe and split-brain are rejected before observation write", async () => {
  const inactive = makeLifecycleClient(probeRow());
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: inactive }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
  assert.equal(inactive.calls.some((call) => /INSERT INTO codeclip_youtube_websub_diagnostic_observations/.test(call.sql)), false);

  const split = makeLifecycleClient([
    activeRow({ id: "1", probe_id: PROBE_ID, callback_id: "diag_yt_otherCallback1234" }),
    activeRow({ id: "2", probe_id: "diag_otherProbe123", callback_id: CALLBACK_ID }),
  ]);
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: split }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
});

test("B4 observation and probe returning zero rows fail closed", async () => {
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { zeroObservationInsert: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { observations: [observationRow()], zeroObservationUpdate: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { zeroUpdate: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
});

test("B4 malformed persisted observation fails closed", async () => {
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { observations: [observationRow({ diagnostic_metadata: [] })] }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "invalid_repository_row" }
  );
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { splitObservationRows: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
});

test("B4 supplied and owned transaction contracts are preserved", async () => {
  const supplied = makeLifecycleClient(activeRow());
  const success = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: supplied });
  assert.equal(success.status, "recorded");
  assert.equal(supplied.calls.some((call) => /^BEGIN/.test(call.sql)), false);
  assert.equal(supplied.calls.some((call) => call.sql === "COMMIT" || call.sql === "ROLLBACK"), false);

  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { observationSavepointFailure: true }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_required" }
  );
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: makeLifecycleClient(activeRow(), { isolation: "serializable" }) }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "transaction_isolation_unsupported" }
  );

  const ownedClient = makeLifecycleClient(activeRow());
  const restore = installPool(ownedClient);
  try {
    const owned = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput());
    assert.equal(owned.status, "recorded");
  } finally {
    restore();
  }
  assert.ok(callNames(ownedClient.calls).includes("BEGIN ISOLATION LEVEL READ COMMITTED"));
  assert.ok(callNames(ownedClient.calls).includes("COMMIT"));
});

test("B4 atomicity rolls back repository-owned savepoint on observation/probe failure", async () => {
  const observationFailure = makeLifecycleClient(activeRow(), { throwObservationInsert: true });
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: observationFailure }),
    /observation insert failed/
  );
  assert.ok(observationFailure.calls.some((call) => /ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_observation/.test(call.sql)));

  const probeFailure = makeLifecycleClient(activeRow(), { zeroUpdate: true });
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: probeFailure }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
  );
  assert.ok(probeFailure.calls.some((call) => /ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_observation/.test(call.sql)));
});

test("B4 public API owns notification persistence and serializers stay public safe", async () => {
  assert.equal(repository.markCodeClipYouTubeWebSubDiagnosticNotificationObserved, undefined);
  const client = makeLifecycleClient(activeRow());
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(), { queryClient: client });
  assertNoFullSecrets(result.publicProbe);
  assertNoFullSecrets(result.publicObservation);
  assert.equal(JSON.stringify(result.publicProbe).includes("observations"), false);
  assert.equal(JSON.stringify(result.publicProbe).includes("seenCount"), false);
});

test("B4 schema ensure backfills legacy observation columns and validates final invariants", async () => {
  const client = await runDiagnosticProbeTableEnsure();
  const sql = client.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /SELECT pg_advisory_xact_lock\(\$1, \$2\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_updated_at TIMESTAMPTZ/);
  assert.match(sql, /column_name = 'first_seen_at'/);
  assert.match(sql, /column_name = 'last_seen_at'/);
  assert.match(sql, /first_observed_at = COALESCE\(first_observed_at, %1\$s, created_at, NOW\(\)\)/);
  assert.match(sql, /last_observed_at = COALESCE\(last_observed_at, %2\$s, first_observed_at, %1\$s, created_at, NOW\(\)\)/);
  assert.match(sql, /entry_updated_at = COALESCE\(entry_updated_at, %3\$s, published_at, last_observed_at, %2\$s, first_observed_at, %1\$s, created_at, NOW\(\)\)/);
  assert.match(sql, /to_char\(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/);
  assert.match(sql, /contains duplicate B4 observation identities/);
  assert.match(sql, /ALTER COLUMN first_observed_at SET NOT NULL/);
  assert.match(sql, /ALTER COLUMN last_observed_at SET NOT NULL/);
  assert.match(sql, /ALTER COLUMN entry_updated_at SET NOT NULL/);
});

test("B4 schema ensure skips constraint changes when semantic checks and unique index already exist", async () => {
  const client = await runDiagnosticProbeTableEnsure({ checkScenario: "semantic", uniqueScenario: "semantic" });
  const sql = client.calls.map((call) => call.sql).join("\n");
  const advisory = client.calls.find((call) => /pg_advisory_xact_lock/.test(call.sql));
  assert.deepEqual(advisory.params, [2036220848, 20260724]);
  assert.equal(/DROP CONSTRAINT/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_provider_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_channel_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_metadata_object_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_seen_count_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_observed_time_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_updated_check/.test(sql), false);
  assert.equal(/ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_unique/.test(sql), false);
});

for (const [checkScenario, acceptedConstraint, rejectedConstraints] of [
  ["semanticProvider", "provider_check", ["channel_check", "metadata_object_check"]],
  ["semanticChannel", "channel_check", ["provider_check", "metadata_object_check"]],
  ["semanticMetadata", "metadata_object_check", ["provider_check", "channel_check"]],
]) {
  test(`B4 schema ensure accepts only the correct ${checkScenario} CHECK kind`, async () => {
    const client = await runDiagnosticProbeTableEnsure({ checkScenario, uniqueScenario: "semantic" });
    const sql = client.calls.map((call) => call.sql).join("\n");
    assert.equal(new RegExp(`ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_${acceptedConstraint}`).test(sql), false);
    for (const constraint of rejectedConstraints) {
      assert.match(sql, new RegExp(`ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_${constraint}`));
    }
  });
}

for (const [checkScenario, expectedCanonical] of [
  ["invertedProvider", "provider_check"],
  ["nullableProvider", "provider_check"],
  ["providerAndExtra", "provider_check"],
  ["wrongProviderConstant", "provider_check"],
  ["wrongProviderColumn", "provider_check"],
  ["invertedChannel", "channel_check"],
  ["channelAndExtra", "channel_check"],
  ["metadataAndExtra", "metadata_object_check"],
  ["nullableSeenCount", "seen_count_check"],
  ["invertedSeenCount", "seen_count_check"],
  ["seenCountAndExtra", "seen_count_check"],
  ["missingObservedTimePart", "observed_time_check"],
  ["invertedObservedTime", "observed_time_check"],
  ["observedTimeAndExtra", "observed_time_check"],
  ["nullableUpdated", "updated_check"],
  ["updatedAndExtra", "updated_check"],
]) {
  test(`B4 schema ensure rejects weak CHECK catalog state ${checkScenario}`, async () => {
    const client = await runDiagnosticProbeTableEnsure({ checkScenario, uniqueScenario: "semantic" });
    const sql = client.calls.map((call) => call.sql).join("\n");
    assert.match(sql, new RegExp(`ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_${expectedCanonical}`));
    assert.equal(/DROP CONSTRAINT/.test(sql), false);
  });
}

for (const uniqueScenario of ["partial", "expression", "invalid", "reversed", "include", "missing"]) {
  test(`B4 schema ensure rejects ${uniqueScenario} unique catalog state as observation identity equivalent`, async () => {
    const client = await runDiagnosticProbeTableEnsure({ checkScenario: "semantic", uniqueScenario });
    const sql = client.calls.map((call) => call.sql).join("\n");
    assert.equal(client.uniqueScenarioChecked, uniqueScenario);
    assert.match(client.uniqueQuery, /i\.indisunique/);
    assert.match(client.uniqueQuery, /i\.indisvalid/);
    assert.match(client.uniqueQuery, /i\.indisready/);
    assert.match(client.uniqueQuery, /i\.indpred IS NOT NULL AS is_partial/);
    assert.match(client.uniqueQuery, /i\.indexprs IS NOT NULL AS is_expression/);
    assert.match(client.uniqueQuery, /i\.indnkeyatts/);
    assert.match(client.uniqueQuery, /i\.indnatts/);
    assert.match(client.uniqueQuery, /array_agg\(a\.attname ORDER BY key\.key_ordinal\) AS columns/);
    assert.match(sql, /ADD CONSTRAINT codeclip_youtube_websub_diagnostic_observations_unique UNIQUE \(probe_id, observation_identity\)/);
  });
}

for (const [label, message] of [
  ["unmigratable null fields", "codeclip_youtube_websub_diagnostic_observations contains rows that cannot be migrated to B4 schema"],
  ["invalid invariants", "codeclip_youtube_websub_diagnostic_observations contains rows that violate B4 diagnostic observation invariants"],
  ["duplicate identities", "codeclip_youtube_websub_diagnostic_observations contains duplicate B4 observation identities"],
]) {
  test(`B4 schema ensure rolls back and stops after ${label}`, async () => {
    const client = makeDiagnosticEnsureClient({ failMigrationAt: 1, failMigrationMessage: message });
    await assert.rejects(
      () => db.ensureCodeClipYouTubeWebSubDiagnosticProbeTables(client),
      new RegExp(message)
    );
    const names = callNames(client.calls);
    assert.ok(names.includes("BEGIN"));
    assert.equal(names.includes("COMMIT"), false);
    assert.ok(names.includes("ROLLBACK"));
    assert.equal(client.calls.some((call) => /ALTER COLUMN first_observed_at SET NOT NULL/.test(call.sql)), false);
    assert.equal(client.calls.some((call) => /CREATE INDEX IF NOT EXISTS codeclip_youtube_websub_diagnostic_observations_probe_seen_idx/.test(call.sql)), false);
  });
}

test("B4 newer entryUpdatedAt with older observedAt updates observation without regressing probe summary", async () => {
  const latest = {
    observationIdentity: observationIdentity(),
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
    diagnostic_metadata: { lastNotification: latest },
  }), { observations: [observationRow()] });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({
    observedAt: "2026-07-24T10:11:00.000Z",
    updatedAt: "2026-07-24T10:15:00.000Z",
    titleHash: "bbbbbbbb",
  }), { queryClient: client });
  assert.equal(result.status, "updated");
  assert.equal(result.observation.lastObservedAt, "2026-07-24T10:12:00.000Z");
  assert.equal(result.observation.entryUpdatedAt, "2026-07-24T10:15:00.000Z");
  assert.equal(result.observation.seenCount, 2);
  assert.equal(result.probe.lastNotificationAt, "2026-07-24T10:12:00.000Z");
  assert.deepEqual(result.probe.diagnosticMetadata.lastNotification, latest);
});

test("B4 compatible older observation timestamps remain duplicate", async () => {
  const client = makeLifecycleClient(activeRow({ last_notification_at: "2026-07-24T10:12:00.000Z" }), {
    observations: [observationRow()],
  });
  const result = await repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({
    observedAt: "2026-07-24T10:11:00.000Z",
    updatedAt: "2026-07-24T10:03:00.000Z",
  }), { queryClient: client });
  assert.equal(result.status, "duplicate");
  assert.equal(result.observation.seenCount, 2);
  assert.equal(result.observation.entryUpdatedAt, "2026-07-24T10:04:30.000Z");
});

test("B4 immutable topic channel and entry mismatches roll back before counters or probe update", async () => {
  for (const overrides of [
    { topic: `http://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa` },
    { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" },
  ]) {
    const client = makeLifecycleClient(activeRow(), { observations: [observationRow()] });
    await assert.rejects(
      () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput(overrides), { queryClient: client }),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
    );
    assert.equal(client.state.observations[0].seen_count, 1);
    assert.equal(client.calls.some((call) => /UPDATE codeclip_youtube_websub_diagnostic_probes/.test(call.sql)), false);
    assert.ok(client.calls.some((call) => /ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_observation/.test(call.sql)));
  }

  const entryClient = makeLifecycleClient(activeRow(), {
    observations: [observationRow({ entry_id: "yt:video:old-entry" })],
  });
  await assert.rejects(
    () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput({ entryId: "yt:video:new-entry" }), { queryClient: entryClient }),
    { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "state_conflict" }
  );
  assert.equal(entryClient.state.observations[0].seen_count, 1);
  assert.equal(entryClient.calls.some((call) => /UPDATE codeclip_youtube_websub_diagnostic_probes/.test(call.sql)), false);
  assert.ok(entryClient.calls.some((call) => /ROLLBACK TO SAVEPOINT codeclip_youtube_websub_diagnostic_observation/.test(call.sql)));
});

test("B4 owned transaction rolls back fully when probe update fails after observation write", async () => {
  const ownedClient = makeLifecycleClient(activeRow(), { zeroUpdate: true });
  const restore = installPool(ownedClient);
  try {
    await assert.rejects(
      () => repository.recordCodeClipYouTubeWebSubDiagnosticNotificationObservation(observationInput()),
      { name: "CodeClipYouTubeWebSubDiagnosticProbeRepositoryError", code: "repository_state_conflict" }
    );
  } finally {
    restore();
  }
  const names = callNames(ownedClient.calls);
  assert.ok(names.includes("BEGIN ISOLATION LEVEL READ COMMITTED"));
  assert.ok(names.includes("ROLLBACK"));
  assert.equal(names.includes("COMMIT"), false);
  assert.equal(ownedClient.calls.some((call) => /INSERT INTO codeclip_youtube_websub_diagnostic_observations/.test(call.sql)), true);
});
