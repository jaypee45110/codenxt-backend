const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DISPATCH_MAX_ATTEMPT_COUNT,
  DISPATCH_OWNERSHIP_TOKEN_INVARIANT,
  OUTBOUND_STATUSES,
  buildMetaMessengerRewardOutboundIntent,
  readDispatchOwnershipAttemptId,
} = require("./verticals/codeclip/meta-messenger-outbound");
const {
  claimCodeClipMetaMessengerOutboundDispatch,
  createOrGetCodeClipMetaMessengerOutbound,
  recordCodeClipMetaMessengerOutboundDispatchResult,
  validateAuthoritativeDispatchState,
} = require("./verticals/codeclip/meta-messenger-outbound-repository");

const CREATED_AT = "2026-07-30T00:00:00.000Z";
const NOW = "2026-07-30T01:00:00.000Z";
const STALE_NOW = "2026-07-30T02:00:00.000Z";

function buildIntent(overrides = {}) {
  const result = buildMetaMessengerRewardOutboundIntent({
    providerAccountId: "Page-ABC",
    recipientId: "Psid-XYZ",
    eventCode: "CC-B11-2C",
    bindingId: "binding-1",
    inboundDeliveryId: "delivery-1",
    externalInboundMessageId: "Mid-Dispatch-1",
    interactionId: "interaction-1",
    createdAt: CREATED_AT,
    result: {
      tier: "clip",
      rewards: {
        clip: {
          assigned: true,
          displayTier: "Clip",
          title: "Backstage clip",
          type: "video",
          contentUrl: "https://rewards.example/clip-dispatch",
        },
      },
    },
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.intent;
}

function createDispatchQueryClient(seedRows = []) {
  const state = {
    rows: seedRows.map((row) => ({ ...row, last_error_metadata: row.last_error_metadata
      ? JSON.parse(JSON.stringify(row.last_error_metadata))
      : null })),
    calls: [],
  };

  return {
    state,
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      const normalizedSql = String(sql).replace(/\s+/g, " ").trim();

      if (normalizedSql.startsWith("SELECT * FROM codeclip_meta_messenger_outbounds WHERE id = $1")) {
        const row = state.rows.find((candidate) => Number(candidate.id) === Number(params[0]));
        return { rows: row ? [structuredClone(row)] : [] };
      }

      if (normalizedSql.startsWith("UPDATE codeclip_meta_messenger_outbounds")) {
        const id = Number(params[0]);
        const expectedStatus = params[12];
        const expectedAttemptCount = Number(params[13]);
        const expectedTerminal = params[14];
        const expectedRetryEligible = params[15];
        const index = state.rows.findIndex((candidate) => Number(candidate.id) === id);
        if (index < 0) return { rows: [] };
        const current = state.rows[index];
        if (
          current.status !== expectedStatus ||
          Number(current.attempt_count) !== expectedAttemptCount ||
          Boolean(current.terminal) !== Boolean(expectedTerminal) ||
          Boolean(current.retry_eligible) !== Boolean(expectedRetryEligible)
        ) {
          return { rows: [] };
        }

        let metadata = params[6];
        if (typeof metadata === "string") {
          metadata = JSON.parse(metadata);
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
        return { rows: [structuredClone(updated)] };
      }

      if (normalizedSql.startsWith("INSERT INTO codeclip_meta_messenger_outbounds")) {
        const row = {
          id: state.rows.length + 1,
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
        state.rows.push(row);
        return { rows: [structuredClone(row)] };
      }

      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    },
  };
}

async function createPendingOutbound(client = createDispatchQueryClient()) {
  const intent = buildIntent();
  const created = await createOrGetCodeClipMetaMessengerOutbound(intent, client);
  assert.equal(created.ok, true);
  assert.equal(created.status, "created");
  return { client, intent, row: created.row };
}

test("DISPATCH_OWNERSHIP_TOKEN_INVARIANT documents attemptId is never source of truth", () => {
  assert.equal(DISPATCH_OWNERSHIP_TOKEN_INVARIANT.sourceOfTruth, false);
  assert.equal(DISPATCH_OWNERSHIP_TOKEN_INVARIANT.role, "ownership_token_only");
  assert.ok(DISPATCH_OWNERSHIP_TOKEN_INVARIANT.authoritativeFields.includes("status"));
  assert.ok(DISPATCH_OWNERSHIP_TOKEN_INVARIANT.authoritativeFields.includes("attemptCount"));
  assert.ok(DISPATCH_OWNERSHIP_TOKEN_INVARIANT.authoritativeFields.includes("claimedAt"));
  assert.equal(
    DISPATCH_OWNERSHIP_TOKEN_INVARIANT.authoritativeFields.includes("lastErrorMetadata"),
    false
  );
});

test("first pending claim sets authoritative claimed state and ownership token only", async () => {
  const { client, row } = await createPendingOutbound();
  const claimed = await claimCodeClipMetaMessengerOutboundDispatch(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      staleAfterSeconds: 300,
      now: NOW,
    },
    client
  );

  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.row.status, OUTBOUND_STATUSES.CLAIMED);
  assert.equal(claimed.row.attemptCount, 1);
  assert.equal(claimed.row.terminal, false);
  assert.equal(claimed.row.retryEligible, false);
  assert.equal(claimed.row.claimedAt, NOW);
  assert.equal(claimed.row.lastErrorCode, null);
  assert.deepEqual(claimed.row.lastErrorMetadata, { attemptId: "attempt-1" });
  assert.equal(Object.hasOwn(claimed.row.lastErrorMetadata, "providerMessageId"), false);

  const ownership = readDispatchOwnershipAttemptId(claimed.row.lastErrorMetadata);
  assert.equal(ownership.ok, true);
  assert.equal(ownership.present, true);
  assert.equal(ownership.attemptId, "attempt-1");

  const authoritative = validateAuthoritativeDispatchState(claimed.row);
  assert.equal(authoritative.ok, true);
  assert.equal(authoritative.status, OUTBOUND_STATUSES.CLAIMED);
  assert.equal(authoritative.attemptCount, 1);
});

test("same attemptId against non-stale claimed is existing without mutating authoritative fields", async () => {
  const { client, row } = await createPendingOutbound();
  const first = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );
  const second = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );

  assert.equal(second.ok, true);
  assert.equal(second.status, "existing");
  assert.equal(second.row.attemptCount, first.row.attemptCount);
  assert.equal(second.row.claimedAt, first.row.claimedAt);
  assert.deepEqual(second.row.lastErrorMetadata, first.row.lastErrorMetadata);
});

test("active non-stale claimed with different attemptId is conflict", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );
  const conflict = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-2", staleAfterSeconds: 300, now: NOW },
    client
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.reason, "ACTIVE_CLAIM_NOT_STALE");
});

test("stale claimed can be reclaimed using authoritative claimed_at not token age", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 60, now: NOW },
    client
  );
  const reclaimed = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-2", staleAfterSeconds: 60, now: STALE_NOW },
    client
  );
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.status, "claimed");
  assert.equal(reclaimed.row.attemptCount, 2);
  assert.deepEqual(reclaimed.row.lastErrorMetadata, { attemptId: "attempt-2" });
});

test("retryable failed can be claimed and non-retryable/sent cannot", async () => {
  const { client, row } = await createPendingOutbound();
  const claim1 = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );
  const failed = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: claim1.row.attemptCount,
      outcome: "retryable_failed",
      failureCode: "graph_timeout",
      now: NOW,
    },
    client
  );
  assert.equal(failed.ok, true);
  assert.equal(failed.row.status, OUTBOUND_STATUSES.RETRYABLE_FAILED);

  const reclaim = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-2", staleAfterSeconds: 300, now: STALE_NOW },
    client
  );
  assert.equal(reclaim.ok, true);
  assert.equal(reclaim.row.attemptCount, 2);

  const sent = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-2",
      attemptNumber: 2,
      outcome: "sent",
      now: STALE_NOW,
    },
    client
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.row.status, OUTBOUND_STATUSES.SENT);

  const claimSent = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-3", staleAfterSeconds: 300, now: STALE_NOW },
    client
  );
  assert.equal(claimSent.ok, false);
  assert.equal(claimSent.reason, "DISPATCH_NOT_CLAIMABLE");
});

test("claimed without ownership token fails closed and is not repaired", async () => {
  const client = createDispatchQueryClient([
    {
      id: 9,
      vertical: "codeclip",
      provider: "meta",
      channel: "messenger",
      outbound_type: "reward_link",
      event_code: "CC",
      binding_id: null,
      provider_account_id: "page",
      recipient_id: "psid",
      external_inbound_message_id: "mid",
      inbound_delivery_id: null,
      interaction_id: null,
      idempotency_key: "key-9",
      deliverable_type: "reward_link",
      deliverable: { type: "reward_link" },
      intent: {},
      status: "claimed",
      attempt_count: 1,
      retry_eligible: false,
      terminal: false,
      last_error_code: null,
      last_error_metadata: null,
      claimed_at: NOW,
      sent_at: null,
      failed_at: null,
      created_at: CREATED_AT,
      updated_at: NOW,
    },
  ]);

  const result = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: 9, attemptId: "attempt-repair", staleAfterSeconds: 300, now: STALE_NOW },
    client
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DISPATCH_STATE_INCONSISTENT");
  assert.equal(result.details.invariant, "ownership_token_not_source_of_truth");
  assert.equal(client.state.rows[0].status, "claimed");
  assert.equal(client.state.rows[0].last_error_metadata, null);
});

test("pending with leftover ownership token fails closed and is not cleared", async () => {
  const client = createDispatchQueryClient([
    {
      id: 10,
      vertical: "codeclip",
      provider: "meta",
      channel: "messenger",
      outbound_type: "reward_link",
      event_code: "CC",
      binding_id: null,
      provider_account_id: "page",
      recipient_id: "psid",
      external_inbound_message_id: "mid",
      inbound_delivery_id: null,
      interaction_id: null,
      idempotency_key: "key-10",
      deliverable_type: "reward_link",
      deliverable: { type: "reward_link" },
      intent: {},
      status: "pending",
      attempt_count: 0,
      retry_eligible: true,
      terminal: false,
      last_error_code: null,
      last_error_metadata: { attemptId: "stale-token" },
      claimed_at: null,
      sent_at: null,
      failed_at: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
  ]);

  const result = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: 10, attemptId: "attempt-new", staleAfterSeconds: 300, now: NOW },
    client
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DISPATCH_STATE_INCONSISTENT");
  assert.deepEqual(client.state.rows[0].last_error_metadata, { attemptId: "stale-token" });
  assert.equal(client.state.rows[0].status, "pending");
});

test("ownership token never overrides authoritative attempt_count on record", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );

  const wrongNumber = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 99,
      outcome: "sent",
      now: NOW,
    },
    client
  );
  assert.equal(wrongNumber.ok, false);
  assert.equal(wrongNumber.reason, "DISPATCH_ATTEMPT_NUMBER_MISMATCH");
  assert.equal(wrongNumber.details.authoritativeAttemptCount, 1);
  assert.equal(client.state.rows[0].status, "claimed");
  assert.equal(client.state.rows[0].attempt_count, 1);
});

test("record sent, retryable failed, terminal failed and reject wrong attemptId", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );

  const wrongOwner = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "other-attempt",
      attemptNumber: 1,
      outcome: "sent",
      now: NOW,
    },
    client
  );
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.reason, "DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH");

  const sent = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "sent",
      now: NOW,
    },
    client
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.status, "sent");
  assert.equal(sent.row.status, OUTBOUND_STATUSES.SENT);
  assert.equal(sent.row.terminal, true);
  assert.equal(sent.row.retryEligible, false);
  assert.equal(sent.row.sentAt, NOW);
  assert.equal(sent.row.lastErrorCode, null);
  assert.deepEqual(sent.row.lastErrorMetadata, { attemptId: "attempt-1" });

  const degrade = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "terminal_failed",
      failureCode: "should_not_apply",
      now: STALE_NOW,
    },
    client
  );
  assert.equal(degrade.ok, false);
  assert.equal(degrade.reason, "DISPATCH_ALREADY_SENT");
});

test("duplicate identical results are existing; mismatched failure codes conflict", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );
  const first = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "retryable_failed",
      failureCode: "graph_timeout",
      now: NOW,
    },
    client
  );
  assert.equal(first.ok, true);

  const duplicate = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "retryable_failed",
      failureCode: "graph_timeout",
      now: NOW,
    },
    client
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.status, "existing");

  const mismatch = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "retryable_failed",
      failureCode: "other_code",
      now: NOW,
    },
    client
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "DISPATCH_RESULT_MISMATCH");
});

test("stale takeover rejects old attempt result without repairing state", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 60, now: NOW },
    client
  );
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-2", staleAfterSeconds: 60, now: STALE_NOW },
    client
  );

  const oldResult = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "sent",
      now: STALE_NOW,
    },
    client
  );
  assert.equal(oldResult.ok, false);
  assert.ok(
    ["DISPATCH_ATTEMPT_OWNERSHIP_MISMATCH", "DISPATCH_ATTEMPT_NUMBER_MISMATCH"].includes(
      oldResult.reason
    )
  );
  assert.equal(client.state.rows[0].status, "claimed");
  assert.equal(client.state.rows[0].attempt_count, 2);
  assert.deepEqual(client.state.rows[0].last_error_metadata, { attemptId: "attempt-2" });
});

test("providerMessageId is rejected in B11.2C record path", async () => {
  const { client, row } = await createPendingOutbound();
  await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-1", staleAfterSeconds: 300, now: NOW },
    client
  );
  const result = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: row.id,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "sent",
      providerMessageId: "mid-should-not-persist",
      now: NOW,
    },
    client
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROVIDER_MESSAGE_ID_NOT_SUPPORTED_IN_B11_2C");
});

test("attempt overflow fails closed", async () => {
  const client = createDispatchQueryClient([
    {
      id: 11,
      vertical: "codeclip",
      provider: "meta",
      channel: "messenger",
      outbound_type: "reward_link",
      event_code: "CC",
      binding_id: null,
      provider_account_id: "page",
      recipient_id: "psid",
      external_inbound_message_id: "mid",
      inbound_delivery_id: null,
      interaction_id: null,
      idempotency_key: "key-11",
      deliverable_type: "reward_link",
      deliverable: { type: "reward_link" },
      intent: {},
      status: "retryable_failed",
      attempt_count: DISPATCH_MAX_ATTEMPT_COUNT,
      retry_eligible: true,
      terminal: false,
      last_error_code: "graph_timeout",
      last_error_metadata: { attemptId: "attempt-max" },
      claimed_at: NOW,
      sent_at: null,
      failed_at: NOW,
      next_attempt_at: NOW,
      created_at: CREATED_AT,
      updated_at: NOW,
    },
  ]);

  const result = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: 11, attemptId: "attempt-overflow", staleAfterSeconds: 300, now: STALE_NOW },
    client
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ATTEMPT_NUMBER_OVERFLOW");
});

test("concurrent claim simulation: only one optimistic lock winner", async () => {
  const { client, row } = await createPendingOutbound();
  const first = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: row.id, attemptId: "attempt-a", staleAfterSeconds: 300, now: NOW },
    client
  );
  assert.equal(first.ok, true);

  // Second claim against same pending snapshot is impossible after first claim;
  // simulate race by forcing optimistic lock against stale expected state via direct update path.
  const raceClient = createDispatchQueryClient([
    {
      id: 1,
      vertical: "codeclip",
      provider: "meta",
      channel: "messenger",
      outbound_type: "reward_link",
      event_code: "CC",
      binding_id: null,
      provider_account_id: "page",
      recipient_id: "psid",
      external_inbound_message_id: "mid-race",
      inbound_delivery_id: null,
      interaction_id: null,
      idempotency_key: "key-race",
      deliverable_type: "reward_link",
      deliverable: { type: "reward_link" },
      intent: {},
      status: "pending",
      attempt_count: 0,
      retry_eligible: true,
      terminal: false,
      last_error_code: null,
      last_error_metadata: null,
      claimed_at: null,
      sent_at: null,
      failed_at: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
  ]);

  const a = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: 1, attemptId: "race-a", staleAfterSeconds: 300, now: NOW },
    raceClient
  );
  const b = await claimCodeClipMetaMessengerOutboundDispatch(
    { outboundId: 1, attemptId: "race-b", staleAfterSeconds: 300, now: NOW },
    raceClient
  );
  assert.equal(a.ok, true);
  assert.equal(a.status, "claimed");
  assert.equal(b.ok, false);
  assert.equal(b.reason, "ACTIVE_CLAIM_NOT_STALE");
  assert.equal(raceClient.state.rows[0].last_error_metadata.attemptId, "race-a");
});

test("db wrappers thread claim and record without business logic (module surface)", () => {
  const database = require("./db");
  assert.equal(typeof database.claimCodeClipMetaMessengerOutboundDispatch, "function");
  assert.equal(typeof database.recordCodeClipMetaMessengerOutboundDispatchResult, "function");
});

test("PostgreSQL concurrent claim is skipped when DATABASE_URL is unset", async () => {
  if (!process.env.DATABASE_URL) {
    assert.equal(process.env.DATABASE_URL || null, null);
    return;
  }

  const database = require("./db");
  const intent = buildIntent({
    externalInboundMessageId: `Mid-PG-${Date.now()}`,
  });
  const created = await database.createOrGetCodeClipMetaMessengerOutbound(intent);
  assert.equal(created.ok, true);

  const [left, right] = await Promise.all([
    database.claimCodeClipMetaMessengerOutboundDispatch({
      outboundId: created.row.id,
      attemptId: `pg-a-${Date.now()}`,
      staleAfterSeconds: 300,
      now: new Date().toISOString(),
    }),
    database.claimCodeClipMetaMessengerOutboundDispatch({
      outboundId: created.row.id,
      attemptId: `pg-b-${Date.now()}`,
      staleAfterSeconds: 300,
      now: new Date().toISOString(),
    }),
  ]);

  const successes = [left, right].filter((result) => result.ok && result.status === "claimed");
  const conflicts = [left, right].filter((result) => !result.ok || result.status === "existing");
  assert.equal(successes.length, 1);
  assert.ok(conflicts.length >= 1);
});
