const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NEXT_ATTEMPT_BASE_SECONDS,
  NEXT_ATTEMPT_CAP_SECONDS,
  OUTBOUND_STATUSES,
  computeCodeClipMetaMessengerNextAttemptAt,
} = require("./verticals/codeclip/meta-messenger-outbound");
const {
  claimCodeClipMetaMessengerOutboundDispatch,
  ensureCodeClipMetaMessengerOutboundSchema,
  listEligibleCodeClipMetaMessengerOutboundIds,
  recordCodeClipMetaMessengerOutboundDispatchResult,
} = require("./verticals/codeclip/meta-messenger-outbound-repository");

const CREATED_AT = "2026-07-30T00:00:00.000Z";
const NOW = "2026-07-30T01:00:00.000Z";
const FUTURE = "2026-07-30T03:00:00.000Z";

function claimedRow(overrides = {}) {
  return {
    id: 1,
    vertical: "codeclip",
    provider: "meta",
    channel: "messenger",
    outbound_type: "reward_link",
    event_code: "CC-F0A",
    binding_id: "binding-1",
    provider_account_id: "page-1",
    recipient_id: "psid-1",
    external_inbound_message_id: "mid-1",
    inbound_delivery_id: null,
    interaction_id: null,
    idempotency_key: "key-1",
    deliverable_type: "reward_link",
    deliverable: { type: "reward_link", rewardTier: "clip", url: "https://rewards.example/x" },
    intent: {},
    status: "claimed",
    attempt_count: 1,
    retry_eligible: false,
    terminal: false,
    last_error_code: null,
    last_error_metadata: { attemptId: "attempt-1" },
    claimed_at: NOW,
    sent_at: null,
    failed_at: null,
    next_attempt_at: null,
    created_at: CREATED_AT,
    updated_at: NOW,
    ...overrides,
  };
}

function createFakeQueryClient(seedRows = []) {
  const state = {
    rows: seedRows.map((row) => ({ ...row })),
    calls: [],
  };

  return {
    state,
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      const normalizedSql = String(sql).replace(/\s+/g, " ").trim();

      if (
        normalizedSql.startsWith("CREATE TABLE") ||
        normalizedSql.startsWith("CREATE INDEX") ||
        normalizedSql.startsWith("ALTER TABLE")
      ) {
        return { rows: [] };
      }

      if (normalizedSql.startsWith("SELECT * FROM codeclip_meta_messenger_outbounds WHERE id = $1")) {
        const row = state.rows.find((r) => Number(r.id) === Number(params[0]));
        return { rows: row ? [structuredClone(row)] : [] };
      }

      if (normalizedSql.startsWith("SELECT id FROM codeclip_meta_messenger_outbounds")) {
        const nowIso = params[2];
        const limit = Number(params[3]);
        const nowMs = Date.parse(nowIso);
        const eligible = state.rows
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
        return { rows: eligible };
      }

      if (normalizedSql.startsWith("UPDATE codeclip_meta_messenger_outbounds")) {
        const id = Number(params[0]);
        const expectedStatus = params[12];
        const expectedAttemptCount = Number(params[13]);
        const expectedTerminal = params[14];
        const expectedRetryEligible = params[15];
        const index = state.rows.findIndex((r) => Number(r.id) === id);
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
        if (typeof metadata === "string") metadata = JSON.parse(metadata);
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

      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    },
  };
}

test("computeCodeClipMetaMessengerNextAttemptAt uses exponential backoff with cap", () => {
  const a1 = computeCodeClipMetaMessengerNextAttemptAt({ now: NOW, attemptNumber: 1 });
  assert.equal(a1.ok, true);
  assert.equal(a1.delaySeconds, NEXT_ATTEMPT_BASE_SECONDS);
  assert.equal(a1.nextAttemptAt, "2026-07-30T01:00:30.000Z");

  const a2 = computeCodeClipMetaMessengerNextAttemptAt({ now: NOW, attemptNumber: 2 });
  assert.equal(a2.delaySeconds, 60);

  const a3 = computeCodeClipMetaMessengerNextAttemptAt({ now: NOW, attemptNumber: 3 });
  assert.equal(a3.delaySeconds, 120);

  const high = computeCodeClipMetaMessengerNextAttemptAt({ now: NOW, attemptNumber: 20 });
  assert.equal(high.ok, true);
  assert.equal(high.delaySeconds, NEXT_ATTEMPT_CAP_SECONDS);
});

test("computeCodeClipMetaMessengerNextAttemptAt honors Retry-After and rejects invalid values", () => {
  const larger = computeCodeClipMetaMessengerNextAttemptAt({
    now: NOW,
    attemptNumber: 1,
    retryAfterSeconds: 120,
  });
  assert.equal(larger.ok, true);
  assert.equal(larger.delaySeconds, 120);

  const smaller = computeCodeClipMetaMessengerNextAttemptAt({
    now: NOW,
    attemptNumber: 3,
    retryAfterSeconds: 10,
  });
  assert.equal(smaller.ok, true);
  assert.equal(smaller.delaySeconds, 120);

  const invalid = computeCodeClipMetaMessengerNextAttemptAt({
    now: NOW,
    attemptNumber: 1,
    retryAfterSeconds: "nope",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "RETRY_AFTER_SECONDS_INVALID");

  const zero = computeCodeClipMetaMessengerNextAttemptAt({
    now: NOW,
    attemptNumber: 1,
    retryAfterSeconds: 0,
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, "RETRY_AFTER_SECONDS_INVALID");

  const badAttempt = computeCodeClipMetaMessengerNextAttemptAt({
    now: NOW,
    attemptNumber: 0,
  });
  assert.equal(badAttempt.ok, false);
});

test("schema ensure is idempotent for next_attempt_at and eligible index", async () => {
  const client = createFakeQueryClient();
  await ensureCodeClipMetaMessengerOutboundSchema(client);
  await ensureCodeClipMetaMessengerOutboundSchema(client);
  const sql = client.state.calls.map((c) => c.sql).join("\n");
  assert.match(sql, /next_attempt_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS next_attempt_at/);
  assert.match(sql, /codeclip_meta_messenger_outbounds_eligible_idx/);
});

test("record retryable_failed sets next_attempt_at; sent and terminal clear it", async () => {
  const client = createFakeQueryClient([claimedRow()]);
  const retryable = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 1,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "retryable_failed",
      failureCode: "graph_timeout",
      failureMetadata: { durationMs: 5 },
      now: NOW,
    },
    client
  );
  assert.equal(retryable.ok, true);
  assert.equal(retryable.row.status, OUTBOUND_STATUSES.RETRYABLE_FAILED);
  assert.equal(retryable.row.nextAttemptAt, "2026-07-30T01:00:30.000Z");

  const client2 = createFakeQueryClient([claimedRow()]);
  const sent = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 1,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "sent",
      now: NOW,
    },
    client2
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.row.nextAttemptAt, null);

  const client3 = createFakeQueryClient([claimedRow()]);
  const terminal = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 1,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "terminal_failed",
      failureCode: "graph_bad_request",
      now: NOW,
    },
    client3
  );
  assert.equal(terminal.ok, true);
  assert.equal(terminal.row.nextAttemptAt, null);
});

test("record fails closed when retryAfterSeconds is present but invalid", async () => {
  const client = createFakeQueryClient([claimedRow()]);
  const result = await recordCodeClipMetaMessengerOutboundDispatchResult(
    {
      outboundId: 1,
      attemptId: "attempt-1",
      attemptNumber: 1,
      outcome: "retryable_failed",
      failureCode: "graph_rate_limited",
      failureMetadata: { retryAfterSeconds: "soon" },
      now: NOW,
    },
    client
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RETRY_AFTER_SECONDS_INVALID");
  assert.equal(client.state.rows[0].status, "claimed");
  assert.equal(client.state.rows[0].next_attempt_at, null);
});

test("claim enforces retry schedule and clears next_attempt_at on success", async () => {
  const futureClient = createFakeQueryClient([
    claimedRow({
      status: "retryable_failed",
      retry_eligible: true,
      terminal: false,
      attempt_count: 1,
      last_error_code: "graph_timeout",
      last_error_metadata: { attemptId: "attempt-1" },
      failed_at: NOW,
      next_attempt_at: FUTURE,
    }),
  ]);
  const early = await claimCodeClipMetaMessengerOutboundDispatch(
    {
      outboundId: 1,
      attemptId: "attempt-2",
      staleAfterSeconds: 300,
      now: NOW,
    },
    futureClient
  );
  assert.equal(early.ok, false);
  assert.equal(early.reason, "RETRY_NOT_READY");
  assert.equal(early.details.nextAttemptAt, FUTURE);

  const nullSchedule = await claimCodeClipMetaMessengerOutboundDispatch(
    {
      outboundId: 1,
      attemptId: "attempt-2",
      staleAfterSeconds: 300,
      now: NOW,
    },
    createFakeQueryClient([
      claimedRow({
        status: "retryable_failed",
        retry_eligible: true,
        terminal: false,
        attempt_count: 1,
        last_error_metadata: { attemptId: "attempt-1" },
        failed_at: NOW,
        next_attempt_at: null,
      }),
    ])
  );
  assert.equal(nullSchedule.ok, false);
  assert.equal(nullSchedule.reason, "RETRY_SCHEDULE_INVALID");

  const readyClient = createFakeQueryClient([
    claimedRow({
      status: "retryable_failed",
      retry_eligible: true,
      terminal: false,
      attempt_count: 1,
      last_error_metadata: { attemptId: "attempt-1" },
      failed_at: NOW,
      next_attempt_at: NOW,
    }),
  ]);
  const claimed = await claimCodeClipMetaMessengerOutboundDispatch(
    {
      outboundId: 1,
      attemptId: "attempt-2",
      staleAfterSeconds: 300,
      now: NOW,
    },
    readyClient
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.row.attemptCount, 2);
  assert.equal(claimed.row.nextAttemptAt, null);
});

test("listEligible selects pending and ready retryable only with stable order", async () => {
  const client = createFakeQueryClient([
    claimedRow({
      id: 10,
      status: "pending",
      attempt_count: 0,
      retry_eligible: true,
      terminal: false,
      last_error_metadata: null,
      claimed_at: null,
      next_attempt_at: null,
      created_at: "2026-07-30T00:10:00.000Z",
    }),
    claimedRow({
      id: 2,
      status: "retryable_failed",
      attempt_count: 1,
      retry_eligible: true,
      terminal: false,
      last_error_metadata: { attemptId: "a" },
      failed_at: NOW,
      next_attempt_at: "2026-07-30T00:05:00.000Z",
      created_at: "2026-07-30T00:01:00.000Z",
    }),
    claimedRow({
      id: 3,
      status: "retryable_failed",
      attempt_count: 1,
      retry_eligible: true,
      terminal: false,
      last_error_metadata: { attemptId: "b" },
      failed_at: NOW,
      next_attempt_at: FUTURE,
      created_at: "2026-07-30T00:02:00.000Z",
    }),
    claimedRow({
      id: 4,
      status: "retryable_failed",
      attempt_count: 1,
      retry_eligible: true,
      terminal: false,
      last_error_metadata: { attemptId: "c" },
      failed_at: NOW,
      next_attempt_at: null,
      created_at: "2026-07-30T00:03:00.000Z",
    }),
    claimedRow({
      id: 5,
      status: "claimed",
      attempt_count: 1,
      next_attempt_at: null,
      claimed_at: "2026-07-29T00:00:00.000Z",
    }),
    claimedRow({
      id: 6,
      status: "sent",
      terminal: true,
      retry_eligible: false,
      sent_at: NOW,
      next_attempt_at: null,
    }),
  ]);

  const listed = await listEligibleCodeClipMetaMessengerOutboundIds({
    limit: 10,
    now: NOW,
    queryClient: client,
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.ids, [2, 10]);

  const limited = await listEligibleCodeClipMetaMessengerOutboundIds({
    limit: 1,
    now: NOW,
    queryClient: client,
  });
  assert.deepEqual(limited.ids, [2]);

  const invalidLimit = await listEligibleCodeClipMetaMessengerOutboundIds({
    limit: 0,
    now: NOW,
    queryClient: client,
  });
  assert.equal(invalidLimit.ok, false);
  assert.equal(invalidLimit.reason, "ELIGIBLE_LIMIT_INVALID");
});

test("db wrapper exports listEligibleCodeClipMetaMessengerOutboundIds", () => {
  const database = require("./db");
  assert.equal(typeof database.listEligibleCodeClipMetaMessengerOutboundIds, "function");
});

test("listEligible result never includes secrets deliverable or recipient", async () => {
  const client = createFakeQueryClient([
    claimedRow({
      id: 1,
      status: "pending",
      attempt_count: 0,
      last_error_metadata: null,
      claimed_at: null,
      next_attempt_at: null,
    }),
  ]);
  const listed = await listEligibleCodeClipMetaMessengerOutboundIds({
    limit: 10,
    now: NOW,
    queryClient: client,
  });
  const serialized = JSON.stringify(listed);
  assert.doesNotMatch(serialized, /psid|rewards\.example|accessToken|Bearer/i);
  assert.deepEqual(listed.ids, [1]);
});
