const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const {
  ensureCodePodKeywordInteractionsTable,
  getCodePodKeywordInteraction,
  getCodePodKeywordInteractionSummary,
  insertCodePodKeywordInteraction,
} = require("./db");

test("codePod keyword schema initialization is separate from request helpers", async () => {
  const schemaCalls = [];
  const fakeClient = {
    async query(sql) {
      schemaCalls.push(sql);
      return { rows: [] };
    },
  };

  await ensureCodePodKeywordInteractionsTable(fakeClient);

  assert.equal(schemaCalls.length, 2);
  assert.match(schemaCalls[0], /CREATE TABLE IF NOT EXISTS codepod_keyword_interactions/);
  assert.match(schemaCalls[0], /UNIQUE \(event_code, message_id\)/);
  assert.doesNotMatch(insertCodePodKeywordInteraction.toString(), /ensureCodePodKeywordInteractionsTable|CREATE TABLE/);
  assert.doesNotMatch(getCodePodKeywordInteraction.toString(), /ensureCodePodKeywordInteractionsTable|CREATE TABLE/);

  const serverSource = readFileSync(require.resolve("./server"), "utf8");
  assert.match(
    serverSource,
    /ensureCodePodKeywordInteractionsTable\(\)\.catch/
  );
});

test("codePod keyword insert persists native Interaction and Digital Souvenir assignment", async () => {
  const calls = [];
  const interaction = {
    vertical: "codepod",
    interactionType: "keyword",
    source: "keyword",
    transport: "message",
    eventCode: "CP-KEYWORD-PERSIST",
    keyword: "LISTEN",
    messageId: "message-keyword-persist",
  };
  const rewardAssignment = {
    tier: "silver",
    assignedCount: 1,
    quantity: 2,
    remaining: 1,
    unlimited: false,
    exhausted: false,
    noReward: false,
  };
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          event_code: params[0],
          event_id: params[1],
          message_id: params[2],
          vertical: "codepod",
          source: "keyword",
          interaction_type: "keyword",
          keyword: params[3],
          routing_outcome: params[4],
          tier: params[5],
          assignment_status: params[6],
          interaction: params[7],
          reward_assignment: params[8],
        }],
      };
    },
  };

  const row = await insertCodePodKeywordInteraction({
    eventCode: "CP-KEYWORD-PERSIST",
    eventId: "event-keyword-persist",
    messageId: "message-keyword-persist",
    keyword: "LISTEN",
    routingOutcome: "MATCH",
    tier: "silver",
    assignmentStatus: "assigned",
    interaction,
    rewardAssignment,
    occurredAt: "2026-07-09T00:00:00.000Z",
  }, fakeClient);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO codepod_keyword_interactions/);
  assert.match(calls[0].sql, /ON CONFLICT \(event_code, message_id\) DO NOTHING/);
  assert.doesNotMatch(calls[0].sql, /DO UPDATE/);
  assert.doesNotMatch(calls[0].sql, /CREATE TABLE/);
  assert.deepEqual(JSON.parse(calls[0].params[7]), interaction);
  assert.deepEqual(JSON.parse(calls[0].params[8]), rewardAssignment);
  assert.deepEqual(row.interaction, interaction);
  assert.deepEqual(row.rewardAssignment, rewardAssignment);

  const serialized = JSON.stringify(row);
  for (const forbidden of [
    "goldXtra",
    "partnerReward",
    "redemptionToken",
    "scanId",
    "Screen Video",
    "screenVideoUrl",
    "PrintPoster",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("codePod keyword read uses eventCode and messageId without DDL", async () => {
  const calls = [];
  const rewardAssignment = {
    tier: "general",
    assignedCount: 2,
    quantity: 0,
    remaining: null,
    unlimited: true,
    exhausted: false,
    noReward: false,
  };
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          event_code: params[0],
          message_id: params[1],
          interaction_type: "keyword",
          source: "keyword",
          interaction: JSON.stringify({
            vertical: "codepod",
            interactionType: "keyword",
            source: "keyword",
          }),
          reward_assignment: JSON.stringify(rewardAssignment),
        }],
      };
    },
  };

  const row = await getCodePodKeywordInteraction(
    "CP-KEYWORD-READ",
    "message-keyword-read",
    fakeClient
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM codepod_keyword_interactions/);
  assert.doesNotMatch(calls[0].sql, /CREATE TABLE/);
  assert.deepEqual(calls[0].params, [
    "CP-KEYWORD-READ",
    "message-keyword-read",
  ]);
  assert.equal(row.interaction.interactionType, "keyword");
  assert.deepEqual(row.rewardAssignment, rewardAssignment);
});

test("codePod keyword insert returns null on idempotency conflict", async () => {
  const fakeClient = {
    async query() {
      return { rows: [] };
    },
  };

  const row = await insertCodePodKeywordInteraction({
    eventCode: "CP-KEYWORD-CONFLICT",
    messageId: "message-keyword-conflict",
    keyword: "LISTEN",
  }, fakeClient);

  assert.equal(row, null);
});

test("codePod keyword report summary aggregates only native keyword interactions", async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          total_interactions: "7",
          assigned: "5",
          no_reward: "1",
          exhausted: "1",
          tier_gold: "2",
          tier_silver: "2",
          tier_general: "1",
        }],
      };
    },
  };

  const summary = await getCodePodKeywordInteractionSummary(
    "CP-KEYWORD-REPORT",
    fakeClient
  );

  assert.deepEqual(summary, {
    totalInteractions: 7,
    assigned: 5,
    noReward: 1,
    exhausted: 1,
    tiers: {
      gold: 2,
      silver: 2,
      general: 1,
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["CP-KEYWORD-REPORT"]);
  assert.match(calls[0].sql, /FROM codepod_keyword_interactions/);
  assert.match(calls[0].sql, /event_code = \$1/);
  assert.match(calls[0].sql, /vertical = 'codepod'/);
  assert.match(calls[0].sql, /source = 'keyword'/);
  assert.match(calls[0].sql, /interaction_type = 'keyword'/);
  assert.doesNotMatch(calls[0].sql, /event_scans/);

  const serialized = JSON.stringify(summary);
  for (const forbidden of [
    "interaction",
    "reward_assignment",
    "goldXtra",
    "partnerReward",
    "redemption",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("codePod keyword report summary returns safe zero values without data access", async () => {
  const noClientSummary = await getCodePodKeywordInteractionSummary(
    "CP-KEYWORD-EMPTY",
    null
  );
  const noEventSummary = await getCodePodKeywordInteractionSummary("", {
    async query() {
      throw new Error("query should not run");
    },
  });
  const expected = {
    totalInteractions: 0,
    assigned: 0,
    noReward: 0,
    exhausted: 0,
    tiers: {
      gold: 0,
      silver: 0,
      general: 0,
    },
  };

  assert.deepEqual(noClientSummary, expected);
  assert.deepEqual(noEventSummary, expected);
});

test("codePod keyword report summary normalizes null aggregate values", async () => {
  const summary = await getCodePodKeywordInteractionSummary(
    "CP-KEYWORD-NULLS",
    {
      async query() {
        return {
          rows: [{
            total_interactions: null,
            assigned: null,
            no_reward: null,
            exhausted: null,
            tier_gold: null,
            tier_silver: null,
            tier_general: null,
          }],
        };
      },
    }
  );

  assert.deepEqual(summary, {
    totalInteractions: 0,
    assigned: 0,
    noReward: 0,
    exhausted: 0,
    tiers: {
      gold: 0,
      silver: 0,
      general: 0,
    },
  });
});
