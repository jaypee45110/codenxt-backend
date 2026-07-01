const test = require('node:test');
const assert = require('node:assert/strict');

const codeClipService = require('./verticals/codeclip/service');
const { getCodeClipInteractions, getCodeClipInteractionSummary } = require('./db');

test('successful codeClip scan builds validated Interaction state machine data', async () => {
  const eventCode = 'CC-STATE-TEST';
  const eventId = 'event-state-test';
  const scanId = 'scan-state-test';
  const rewards = {
    openClip: { enabled: true },
    clip: { enabled: true },
    clipPlus: { enabled: true },
  };
  const rewardAssignments = {
    openClip: { assigned: true, tier: 'openClip' },
    clip: { assigned: true, tier: 'clip' },
    clipPlus: { assigned: true, tier: 'clipPlus' },
    clipXtra: { assigned: false },
  };

  let eventScanPayload = null;
  let persistedInteraction = null;

  const result = await codeClipService.handleCodeClipScan({
    event: {
      id: eventId,
      code: eventCode,
      endAt: '2099-12-31T23:59:59.000Z',
      rewards,
    },
    eventCode,
    eventId,
    scanId,
    rawScans: 3,
    uniqueScans: 2,
    scanRank: 2,
    audienceEntry: {
      entryCode: eventCode,
      scanId,
      requestedVertical: 'codeclip',
      source: 'scan',
      transport: 'http',
      userAgent: 'test-agent',
      ip: '127.0.0.1',
      receivedAt: '2026-07-01T00:00:00.000Z',
    },
    redis: null,
    codeClipVertical: {
      routes: {
        parseCodeClipRewardsMeta(event) {
          return event;
        },
      },
      assignment: {
        async assignCodeClipRewards() {
          return rewardAssignments;
        },
      },
    },
    async persistFinalScan(finalTier, extraPayload, interaction) {
      eventScanPayload = { finalTier, extraPayload, interaction };
    },
    async saveCodeClipInteraction(interaction) {
      persistedInteraction = interaction;
      return { id: 1, interaction_state: interaction.state, routing_outcome: interaction.routingOutcome };
    },
    async saveCodeClipXtraRedemption() {
      throw new Error('ClipXtra should not be persisted when not assigned');
    },
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.payload.success, true);
  assert.equal(result.payload.tier, 'clipPlus');

  assert.ok(persistedInteraction, 'saveCodeClipInteraction should receive an Interaction');
  assert.equal(persistedInteraction.state, 'processed');
  assert.equal(persistedInteraction.routingOutcome, 'MATCH');
  assert.ok(Array.isArray(persistedInteraction.stateTransitions));
  assert.deepEqual(
    persistedInteraction.stateTransitions.map((transition) => transition.to),
    ['received', 'routed', 'reward_assigned', 'processed']
  );

  assert.ok(eventScanPayload, 'event scan payload should be built');
  assert.equal(eventScanPayload.finalTier, 'clipPlus');
  assert.equal(eventScanPayload.interaction, persistedInteraction);
  assert.ok(eventScanPayload.extraPayload.interaction);
  assert.equal(eventScanPayload.extraPayload.interaction.eventCode, eventCode);
  assert.equal(eventScanPayload.extraPayload.interaction.scanId, scanId);
  assert.equal(eventScanPayload.extraPayload.interaction.state, 'processed');
  assert.equal(eventScanPayload.extraPayload.interaction.routingOutcome, 'MATCH');
  assert.equal(eventScanPayload.extraPayload.interaction.audienceEntry.entryCode, eventCode);
  assert.equal(eventScanPayload.extraPayload.interaction.audienceEntry.userAgent, undefined);
  assert.equal(eventScanPayload.extraPayload.interaction.audienceEntry.ip, undefined);
});

test('codeClip no-match interaction uses unmatched state machine data', () => {
  const eventCode = 'CC-MISSING-STATE-TEST';
  const scanId = 'scan-missing-state-test';

  const interaction = codeClipService.buildNoCampaignMatchInteraction({
    eventCode,
    scanId,
    audienceEntry: {
      entryCode: eventCode,
      scanId,
      requestedVertical: 'codeclip',
      source: 'scan',
      transport: 'http',
      userAgent: 'test-agent',
      ip: '127.0.0.1',
      receivedAt: '2026-07-01T00:00:00.000Z',
    },
  });

  assert.equal(interaction.eventCode, eventCode);
  assert.equal(interaction.eventId, null);
  assert.equal(interaction.scanId, scanId);
  assert.equal(interaction.state, 'unmatched');
  assert.equal(interaction.routingOutcome, 'NO_CAMPAIGN_MATCH');
  assert.ok(Array.isArray(interaction.stateTransitions));
  assert.deepEqual(
    interaction.stateTransitions.map((transition) => transition.to),
    ['received', 'unmatched']
  );
  assert.equal(interaction.audienceEntry.entryCode, eventCode);
  assert.equal(interaction.audienceEntry.userAgent, undefined);
  assert.equal(interaction.audienceEntry.ip, undefined);
  assert.equal(interaction.rewardAssignments, undefined);
});

test('codeClip interaction read helper normalizes limit and raw payload shape', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            event_code: params[0],
            scan_id: 'scan-read-model-test',
            routing_outcome: 'MATCH',
            interaction_state: 'processed',
            raw_payload: JSON.stringify({
              eventCode: params[0],
              scanId: 'scan-read-model-test',
              state: 'processed',
            }),
          },
        ],
      };
    },
  };

  const rows = await getCodeClipInteractions('CC-READ-MODEL-TEST', 999, fakeClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'CC-READ-MODEL-TEST');
  assert.equal(calls[0].params[1], 500);
  assert.match(calls[0].sql, /ORDER BY created_at DESC/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_code, 'CC-READ-MODEL-TEST');
  assert.equal(rows[0].raw_payload.state, 'processed');
  assert.equal(rows[0].rawPayload.scanId, 'scan-read-model-test');
});

test('codeClip interaction summary helper returns routing and state counts', async () => {
  const calls = [];
  const latestInteractionAt = new Date('2026-07-01T12:00:00.000Z');
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            match_count: 3,
            no_campaign_match_count: 2,
            processed_count: 3,
            unmatched_count: 2,
            latest_interaction_at: latestInteractionAt,
          },
        ],
      };
    },
  };

  const summary = await getCodeClipInteractionSummary('CC-SUMMARY-TEST', fakeClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'CC-SUMMARY-TEST');
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE routing_outcome = 'MATCH'\)/);
  assert.match(calls[0].sql, /MAX\(created_at\) AS latest_interaction_at/);
  assert.deepEqual(summary.routingOutcomes, {
    MATCH: 3,
    NO_CAMPAIGN_MATCH: 2,
  });
  assert.deepEqual(summary.interactionStates, {
    processed: 3,
    unmatched: 2,
  });
  assert.equal(summary.latestInteractionAt, latestInteractionAt);
});
