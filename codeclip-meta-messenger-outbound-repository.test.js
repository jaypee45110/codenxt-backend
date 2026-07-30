const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMetaMessengerRewardOutboundIntent,
} = require("./verticals/codeclip/meta-messenger-outbound");
const {
  buildExpectedIdempotencyKey,
  claimCodeClipMetaMessengerOutboundDispatch,
  createOrGetCodeClipMetaMessengerOutbound,
  ensureCodeClipMetaMessengerOutboundSchema,
  findForbiddenPersistenceKeys,
  getCodeClipMetaMessengerOutboundById,
  getCodeClipMetaMessengerOutboundByIdempotencyKey,
  listEligibleCodeClipMetaMessengerOutboundIds,
  recordCodeClipMetaMessengerOutboundDispatchResult,
} = require("./verticals/codeclip/meta-messenger-outbound-repository");

const CREATED_AT = "2026-07-29T00:00:00.000Z";

function rewardResult(overrides = {}) {
  return {
    tier: "clip",
    rewards: {
      clip: {
        assigned: true,
        displayTier: "Clip",
        title: "Backstage clip",
        type: "video",
        contentUrl: "https://rewards.example/clip-123",
        ...overrides.reward,
      },
    },
    ...overrides.result,
  };
}

function intentInput(overrides = {}) {
  return {
    providerAccountId: "Page-ABC",
    recipientId: "Psid-XYZ",
    eventCode: "CC-B11",
    bindingId: "binding-1",
    inboundDeliveryId: "delivery-1",
    externalInboundMessageId: "Mid-ABC-123",
    interactionId: "interaction-1",
    createdAt: CREATED_AT,
    result: rewardResult(),
    ...overrides,
  };
}

function buildIntent(overrides = {}) {
  const result = buildMetaMessengerRewardOutboundIntent(intentInput(overrides));
  assert.equal(result.ok, true);
  return result.intent;
}

function rowFromIntent(intent, id = 1) {
  return {
    id,
    vertical: "codeclip",
    provider: "meta",
    channel: "messenger",
    outbound_type: "reward_link",
    event_code: intent.eventCode,
    binding_id: intent.bindingId,
    provider_account_id: intent.providerAccountId,
    recipient_id: intent.recipientId,
    external_inbound_message_id: intent.externalInboundMessageId,
    inbound_delivery_id: intent.inboundDeliveryId,
    interaction_id: intent.interactionId,
    idempotency_key: intent.idempotencyKey,
    deliverable_type: intent.deliverable.type,
    deliverable: intent.deliverable,
    intent,
    status: "pending",
    attempt_count: 0,
    retry_eligible: true,
    terminal: false,
    last_error_code: null,
    last_error_metadata: null,
    claimed_at: null,
    sent_at: null,
    failed_at: null,
    next_attempt_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function rowFromInsertParams(params, id = 1) {
  return {
    id,
    vertical: params[0],
    provider: params[1],
    channel: params[2],
    outbound_type: params[3],
    event_code: params[4],
    binding_id: params[5],
    provider_account_id: params[6],
    recipient_id: params[7],
    external_inbound_message_id: params[8],
    inbound_delivery_id: params[9],
    interaction_id: params[10],
    idempotency_key: params[11],
    deliverable_type: params[12],
    deliverable: JSON.parse(params[13]),
    intent: JSON.parse(params[14]),
    status: params[15],
    attempt_count: params[16],
    retry_eligible: params[17],
    terminal: params[18],
    last_error_code: null,
    last_error_metadata: null,
    claimed_at: null,
    sent_at: null,
    failed_at: null,
    next_attempt_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function createFakeQueryClient(options = {}) {
  const state = {
    rows: [...(options.rows || [])],
    calls: [],
    nextId: 1,
    failReadback: options.failReadback || null,
    readbackNotFound: Boolean(options.readbackNotFound),
  };

  return {
    state,
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      const normalizedSql = String(sql).replace(/\s+/g, " ").trim();

      if (
        normalizedSql.startsWith("CREATE TABLE") ||
        normalizedSql.startsWith("CREATE INDEX") ||
        normalizedSql.startsWith("ALTER TABLE") ||
        normalizedSql.includes("DROP CONSTRAINT") ||
        normalizedSql.includes("ADD CONSTRAINT")
      ) {
        return { rows: [] };
      }

      if (normalizedSql.startsWith("UPDATE codeclip_meta_messenger_outbounds")) {
        const id = Number(params[0]);
        const index = state.rows.findIndex((row) => Number(row.id) === id);
        if (index < 0) return { rows: [] };
        const current = state.rows[index];
        if (
          current.status !== params[12] ||
          Number(current.attempt_count) !== Number(params[13]) ||
          Boolean(current.terminal) !== Boolean(params[14]) ||
          Boolean(current.retry_eligible) !== Boolean(params[15])
        ) {
          return { rows: [] };
        }
        let metadata = params[6];
        if (typeof metadata === "string") {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            metadata = null;
          }
        }
        const updated = {
          ...current,
          status: params[1],
          attempt_count: Number(params[2]),
          retry_eligible: Boolean(params[3]),
          terminal: Boolean(params[4]),
          last_error_code: params[5],
          last_error_metadata: metadata,
          claimed_at: params[7],
          sent_at: params[8],
          failed_at: params[9],
          next_attempt_at: params[10],
          updated_at: params[11],
        };
        state.rows[index] = updated;
        return { rows: [updated] };
      }

      if (normalizedSql.startsWith("INSERT INTO codeclip_meta_messenger_outbounds")) {
        const key = params[11];
        const existing = state.rows.find((row) => row.idempotency_key === key);
        if (existing) return { rows: [] };

        const row = rowFromInsertParams(params, state.nextId);
        state.nextId += 1;
        state.rows.push(row);
        return { rows: [row] };
      }

      if (normalizedSql.includes("WHERE idempotency_key = $1")) {
        if (state.failReadback) throw state.failReadback;
        if (state.readbackNotFound) return { rows: [] };
        const row = state.rows.find((candidate) => candidate.idempotency_key === params[0]);
        return { rows: row ? [row] : [] };
      }

      if (normalizedSql.includes("WHERE id = $1") && normalizedSql.startsWith("SELECT *")) {
        const row = state.rows.find((candidate) => Number(candidate.id) === Number(params[0]));
        return { rows: row ? [row] : [] };
      }

      if (normalizedSql.startsWith("SELECT id FROM codeclip_meta_messenger_outbounds")) {
        const nowMs = Date.parse(params[2]);
        const limit = Number(params[3]);
        const ids = state.rows
          .filter((row) => {
            if (row.status === "pending") return true;
            if (row.status !== "retryable_failed") return false;
            if (!row.retry_eligible || row.terminal) return false;
            if (!row.next_attempt_at) return false;
            return Date.parse(row.next_attempt_at) <= nowMs;
          })
          .sort((a, b) => {
            const aKey = Date.parse(a.next_attempt_at || a.created_at);
            const bKey = Date.parse(b.next_attempt_at || b.created_at);
            if (aKey !== bKey) return aKey - bKey;
            return Number(a.id) - Number(b.id);
          })
          .slice(0, limit)
          .map((row) => ({ id: row.id }));
        return { rows: ids };
      }

      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    },
  };
}

function insertCalls(client) {
  return client.state.calls.filter((call) =>
    String(call.sql).includes("INSERT INTO codeclip_meta_messenger_outbounds")
  );
}

test("schema ensure is idempotent and defines B11.2A constraints", async () => {
  const client = createFakeQueryClient();
  await ensureCodeClipMetaMessengerOutboundSchema(client);
  await ensureCodeClipMetaMessengerOutboundSchema(client);

  const sql = client.state.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS codeclip_meta_messenger_outbounds/);
  assert.match(sql, /UNIQUE \(idempotency_key\)/);
  assert.match(sql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(sql, /CHECK \(provider = 'meta'\)/);
  assert.match(sql, /CHECK \(channel = 'messenger'\)/);
  assert.match(sql, /CHECK \(outbound_type = 'reward_link'\)/);
  assert.match(sql, /CHECK \(attempt_count >= 0\)/);
  assert.match(sql, /pending/);
  assert.match(sql, /claimed/);
  assert.match(sql, /sent/);
  assert.match(sql, /retryable_failed/);
  assert.match(sql, /terminal_failed/);
  assert.match(sql, /deliverable JSONB NOT NULL/);
  assert.match(sql, /intent JSONB NOT NULL/);
  assert.match(sql, /provider_account_id/);
  assert.match(sql, /external_inbound_message_id/);
  assert.match(sql, /next_attempt_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS next_attempt_at/);
  assert.match(sql, /codeclip_meta_messenger_outbounds_eligible_idx/);
  assert.match(sql, /provider_sent_unconfirmed/);
  assert.match(sql, /codeclip_meta_messenger_outbounds_status_chk/);
  assert.match(sql, /codeclip_meta_messenger_outbounds_flags_chk/);
});

test("valid B11.1 intent is created and normalized", async () => {
  const intent = buildIntent();
  const client = createFakeQueryClient();
  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);

  assert.equal(result.ok, true);
  assert.equal(result.status, "created");
  assert.equal(result.created, true);
  assert.equal(result.row.providerAccountId, "Page-ABC");
  assert.equal(result.row.recipientId, "Psid-XYZ");
  assert.equal(result.row.externalInboundMessageId, "Mid-ABC-123");
  assert.equal(result.row.attemptCount, 0);
  assert.equal(result.row.retryEligible, true);
  assert.equal(result.row.terminal, false);
  assert.deepEqual(result.row.deliverable, intent.deliverable);
  assert.deepEqual(result.row.intent, intent);
  assert.equal(Object.hasOwn(result.row.intent, "suppliedIdempotencyKey"), false);
  assert.equal(Object.hasOwn(result.row.intent, "expectedIdempotencyKey"), false);
});

test("identical replay returns existing row with same id", async () => {
  const intent = buildIntent();
  const client = createFakeQueryClient();
  const created = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  const replay = await createOrGetCodeClipMetaMessengerOutbound(intent, client);

  assert.equal(created.status, "created");
  assert.equal(replay.ok, true);
  assert.equal(replay.status, "existing");
  assert.equal(replay.existing, true);
  assert.equal(replay.row.id, created.row.id);
  assert.equal(client.state.rows.length, 1);
});

test("divergent immutable data with same idempotency key is a conflict", async () => {
  const intent = buildIntent();
  const existingIntent = buildIntent({ recipientId: "Different-Psid" });
  existingIntent.idempotencyKey = intent.idempotencyKey;
  const client = createFakeQueryClient({ rows: [rowFromIntent(existingIntent)] });

  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  assert.equal(result.ok, false);
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "IDEMPOTENCY_IMMUTABLE_CONFLICT");
});

test("correlation metadata differences do not cause immutable conflict or hidden update", async () => {
  const intent = buildIntent();
  const existingIntent = {
    ...intent,
    inboundDeliveryId: "older-delivery",
    interactionId: "older-interaction",
  };
  const client = createFakeQueryClient({ rows: [rowFromIntent(existingIntent)] });

  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  assert.equal(result.ok, true);
  assert.equal(result.status, "existing");
  assert.equal(result.row.inboundDeliveryId, "older-delivery");
  assert.equal(result.row.interactionId, "older-interaction");
});

test("invalid and incomplete intents are rejected before INSERT", async () => {
  const client = createFakeQueryClient();
  const missingMessage = buildIntent();
  missingMessage.externalInboundMessageId = "";
  const missingResult = await createOrGetCodeClipMetaMessengerOutbound(missingMessage, client);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.status, "invalid_intent");

  const manipulated = buildIntent();
  manipulated.idempotencyKey = "codeclip:meta:messenger:outbound:Page-ABC:other:reward_link";
  const manipulatedResult = await createOrGetCodeClipMetaMessengerOutbound(manipulated, client);
  assert.equal(manipulatedResult.ok, false);
  assert.equal(manipulatedResult.reason, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(insertCalls(client).length, 0);
});

test("expected idempotency key is calculated separately and supplied key is not repaired", async () => {
  const intent = buildIntent();
  const expected = buildExpectedIdempotencyKey(intent);
  assert.equal(expected, intent.idempotencyKey);

  const client = createFakeQueryClient();
  const manipulated = { ...intent, idempotencyKey: "tampered-key" };
  const result = await createOrGetCodeClipMetaMessengerOutbound(manipulated, client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(insertCalls(client).length, 0);
});

test("whitespace is trimmed and provider identifiers remain case-sensitive", async () => {
  const intent = buildIntent({
    providerAccountId: " Page-MixedCase ",
    recipientId: " Psid-MixedCase ",
    externalInboundMessageId: " Mid-MixedCase ",
  });
  const client = createFakeQueryClient();
  const result = await createOrGetCodeClipMetaMessengerOutbound(
    {
      ...intent,
      providerAccountId: " Page-MixedCase ",
      recipientId: " Psid-MixedCase ",
      externalInboundMessageId: " Mid-MixedCase ",
    },
    client
  );

  assert.equal(result.ok, true);
  assert.equal(result.row.providerAccountId, "Page-MixedCase");
  assert.equal(result.row.recipientId, "Psid-MixedCase");
  assert.equal(result.row.externalInboundMessageId, "Mid-MixedCase");
  assert.match(result.row.idempotencyKey, /Page-MixedCase:Mid-MixedCase/);
  assert.doesNotMatch(result.row.idempotencyKey, /page-mixedcase/);
});

test("get by id and idempotency key return normalized rows and not-found semantics", async () => {
  const intent = buildIntent();
  const client = createFakeQueryClient({ rows: [rowFromIntent(intent, 7)] });

  const byId = await getCodeClipMetaMessengerOutboundById(7, client);
  assert.equal(byId.ok, true);
  assert.equal(byId.status, "found");
  assert.equal(byId.row.id, 7);

  const byKey = await getCodeClipMetaMessengerOutboundByIdempotencyKey(intent.idempotencyKey, client);
  assert.equal(byKey.ok, true);
  assert.equal(byKey.row.id, 7);

  const missing = await getCodeClipMetaMessengerOutboundById(99, client);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "not_found");

  const invalidId = await getCodeClipMetaMessengerOutboundById("not-a-number", client);
  assert.equal(invalidId.ok, false);
  assert.equal(invalidId.status, "invalid_id");

  const invalidKey = await getCodeClipMetaMessengerOutboundByIdempotencyKey("", client);
  assert.equal(invalidKey.ok, false);
  assert.equal(invalidKey.status, "invalid_idempotency_key");
});

test("concurrent create attempts produce one durable row", async () => {
  const intent = buildIntent();
  const client = createFakeQueryClient();
  const results = await Promise.all([
    createOrGetCodeClipMetaMessengerOutbound(intent, client),
    createOrGetCodeClipMetaMessengerOutbound(intent, client),
    createOrGetCodeClipMetaMessengerOutbound(intent, client),
  ]);

  assert.equal(results.filter((result) => result.status === "created").length, 1);
  assert.equal(results.filter((result) => result.status === "existing").length, 2);
  assert.equal(client.state.rows.length, 1);
});

test("database failure during conflict readback is preserved", async () => {
  const intent = buildIntent();
  const existing = rowFromIntent(intent);
  const error = new Error("readback database unavailable");
  const client = createFakeQueryClient({ rows: [existing], failReadback: error });

  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "REPOSITORY_ERROR");
  assert.equal(result.error, error);
});

test("not-found after conflict readback is separate from database failure", async () => {
  const intent = buildIntent();
  const existing = rowFromIntent(intent);
  const client = createFakeQueryClient({ rows: [existing], readbackNotFound: true });

  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "IDEMPOTENCY_CONFLICT_READ_NOT_FOUND");
  assert.equal(result.error, null);
});

test("data hygiene rejects concrete secret fields without false positives for metadata", async () => {
  const allowed = {
    type: "reward_link",
    rewardTier: "clip",
    url: "https://rewards.example/clip-123",
    metadata: {
      message: "internal metadata label",
      recipient: "internal metadata owner",
      payload: { source: "reward-catalog" },
    },
  };
  assert.deepEqual(findForbiddenPersistenceKeys(allowed), []);

  for (const field of ["accessToken", "access_token", "authorization", "Authorization", "clientSecret", "client_secret", "appSecret", "app_secret", "messaging_type"]) {
    const intent = buildIntent();
    intent.deliverable = {
      ...intent.deliverable,
      metadata: {
        ...intent.deliverable.metadata,
        [field]: "secret-value",
      },
    };
    const client = createFakeQueryClient();
    const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
    assert.equal(result.ok, false, field);
    assert.equal(result.reason, "FORBIDDEN_PERSISTENCE_FIELD", field);
    assert.equal(insertCalls(client).length, 0, field);
  }
});

test("stored records do not contain Graph transport payload or auth material", async () => {
  const intent = buildIntent();
  const client = createFakeQueryClient();
  const result = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  const serialized = JSON.stringify(result.row);

  assert.doesNotMatch(serialized, /accessToken|access_token|authorization|clientSecret|client_secret|appSecret|app_secret/);
  assert.doesNotMatch(serialized, /messaging_type/);
  assert.doesNotMatch(serialized, /graph\.facebook|graph\.meta/i);
});

test("record provider_sent_unconfirmed is authoritative hold state without providerMessageId", async () => {
  const claimed = {
    ...rowFromIntent(buildIntent()),
    id: 42,
    status: "claimed",
    attempt_count: 2,
    retry_eligible: false,
    terminal: false,
    last_error_metadata: { attemptId: "attempt-hold" },
    claimed_at: CREATED_AT,
    next_attempt_at: null,
  };
  const client = createFakeQueryClient({ rows: [claimed] });

  const recorded = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 42,
      attemptId: "attempt-hold",
      attemptNumber: 2,
      outcome: "provider_sent_unconfirmed",
      failureCode: "provider_sent_unconfirmed",
      now: CREATED_AT,
    },
    client
  );
  assert.equal(recorded.ok, true);
  assert.equal(recorded.status, "provider_sent_unconfirmed");
  assert.equal(recorded.row.status, "provider_sent_unconfirmed");
  assert.equal(recorded.row.terminal, false);
  assert.equal(recorded.row.retryEligible, false);
  assert.equal(recorded.row.nextAttemptAt, null);
  assert.equal(recorded.row.lastErrorCode, "provider_sent_unconfirmed");
  assert.deepEqual(recorded.row.lastErrorMetadata, { attemptId: "attempt-hold" });
  assert.doesNotMatch(JSON.stringify(recorded.row), /mid\.|providerMessageId|message_id/);

  const idempotent = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 42,
      attemptId: "attempt-hold",
      attemptNumber: 2,
      outcome: "provider_sent_unconfirmed",
      now: CREATED_AT,
    },
    client
  );
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.existing, true);

  const wrongOwner = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 42,
      attemptId: "other-attempt",
      attemptNumber: 2,
      outcome: "provider_sent_unconfirmed",
      now: CREATED_AT,
    },
    client
  );
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.reason, "DISPATCH_STATE_INCONSISTENT");

  const resent = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 42,
      attemptId: "attempt-hold",
      attemptNumber: 2,
      outcome: "sent",
      now: CREATED_AT,
    },
    client
  );
  assert.equal(resent.ok, false);
  assert.equal(resent.reason, "DISPATCH_DELIVERY_UNCONFIRMED");

  const claimRejected = await claimCodeClipMetaMessengerOutboundDispatch(
    {
      outboundId: 42,
      attemptId: "attempt-new",
      staleAfterSeconds: 300,
      now: CREATED_AT,
    },
    client
  );
  assert.equal(claimRejected.ok, false);
  assert.equal(claimRejected.reason, "DISPATCH_NOT_CLAIMABLE");
  assert.equal(claimRejected.details.status, "provider_sent_unconfirmed");

  const listed = await listEligibleCodeClipMetaMessengerOutboundIds({
    limit: 10,
    now: CREATED_AT,
    queryClient: client,
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.ids.includes(42), false);
});
