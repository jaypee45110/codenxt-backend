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
  assert.equal(persistedInteraction.rewardAssignments, rewardAssignments);
  assert.ok(persistedInteraction.rewardAssignmentSnapshot);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.eventCode, eventCode);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.eventId, eventId);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.scanId, scanId);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.interactionState, 'processed');
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.routingOutcome, 'MATCH');
  assert.deepEqual(
    persistedInteraction.rewardAssignmentSnapshot.assignments.map((assignment) => assignment.tier),
    ['openClip', 'clip', 'clipPlus', 'clipXtra']
  );
  assert.equal(
    persistedInteraction.rewardAssignmentSnapshot.assignments.find((assignment) => assignment.tier === 'clipPlus').assigned,
    true
  );
  assert.equal(
    persistedInteraction.rewardAssignmentSnapshot.assignments.find((assignment) => assignment.tier === 'clipXtra').assigned,
    false
  );
  assert.equal(result.payload.rewardAssignmentSnapshot, undefined);
  assert.equal(result.payload.interaction, undefined);

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

test('codeClip RewardAssignment snapshot normalizes existing tier assignments', () => {
  const openClipAssignment = {
    assigned: true,
    tier: 'openClip',
    displayTier: 'OpenClip',
    title: 'Open reward',
    type: 'image',
    contentUrl: 'https://example.test/open.png',
    contentFileName: 'open.png',
    assignedCount: 0,
    quantity: 0,
    remaining: null,
    unlimited: true,
    assignedAt: '2026-07-01T00:00:00.000Z',
  };
  const exhaustedClipAssignment = {
    assigned: false,
    tier: 'clip',
    displayTier: 'Clip',
    exhausted: true,
    noReward: true,
    quantity: 2,
    assignedCount: 3,
    remaining: 0,
  };
  const clipXtraAssignment = {
    active: true,
    rewardType: 'clip_xtra',
    tier: 'clipXtra',
    displayTier: 'ClipXtra',
    partnerName: 'Partner',
    product: 'Product',
    title: 'ClipXtra reward',
    quantity: 5,
    redemptionLocation: 'Desk',
    redemptionDeadline: '2099-12-31',
    redemptionInstructions: 'Show token',
    partnerLogo: 'https://example.test/logo.png',
    partnerLogoFileName: 'logo.png',
    assigned: true,
    redemptionToken: 'CX-TESTTOKEN',
    assignedCount: 1,
    remaining: 4,
    assignedAt: '2026-07-01T00:01:00.000Z',
  };

  const snapshot = codeClipService.createRewardAssignmentSnapshot({
    eventCode: 'CC-REWARD-SNAPSHOT',
    eventId: 'event-reward-snapshot',
    scanId: 'scan-reward-snapshot',
    state: 'processed',
    routingOutcome: 'MATCH',
    rewardAssignments: {
      openClip: openClipAssignment,
      clip: exhaustedClipAssignment,
      clipXtra: clipXtraAssignment,
    },
  });

  assert.equal(snapshot.eventCode, 'CC-REWARD-SNAPSHOT');
  assert.equal(snapshot.eventId, 'event-reward-snapshot');
  assert.equal(snapshot.scanId, 'scan-reward-snapshot');
  assert.equal(snapshot.interactionState, 'processed');
  assert.equal(snapshot.routingOutcome, 'MATCH');
  assert.equal(snapshot.assignments.length, 3);

  const openClip = snapshot.assignments.find((assignment) => assignment.tier === 'openClip');
  assert.equal(openClip.displayTier, 'OpenClip');
  assert.equal(openClip.assigned, true);
  assert.equal(openClip.type, 'image');
  assert.equal(openClip.contentUrl, 'https://example.test/open.png');
  assert.equal(openClip.unlimited, true);
  assert.equal(openClip.remaining, null);
  assert.equal(openClip.rawAssignment, openClipAssignment);

  const clip = snapshot.assignments.find((assignment) => assignment.tier === 'clip');
  assert.equal(clip.assigned, false);
  assert.equal(clip.exhausted, true);
  assert.equal(clip.noReward, true);
  assert.equal(clip.quantity, 2);
  assert.equal(clip.assignedCount, 3);
  assert.equal(clip.remaining, 0);
  assert.equal(clip.rawAssignment, exhaustedClipAssignment);

  const clipXtra = snapshot.assignments.find((assignment) => assignment.tier === 'clipXtra');
  assert.equal(clipXtra.assigned, true);
  assert.equal(clipXtra.rewardType, 'clip_xtra');
  assert.equal(clipXtra.redemptionToken, 'CX-TESTTOKEN');
  assert.equal(clipXtra.partnerName, 'Partner');
  assert.equal(clipXtra.product, 'Product');
  assert.equal(clipXtra.redemptionLocation, 'Desk');
  assert.equal(clipXtra.redemptionDeadline, '2099-12-31');
  assert.equal(clipXtra.redemptionInstructions, 'Show token');
  assert.equal(clipXtra.partnerLogo, 'https://example.test/logo.png');
  assert.equal(clipXtra.partnerLogoFileName, 'logo.png');
  assert.equal(clipXtra.rawAssignment, clipXtraAssignment);
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
