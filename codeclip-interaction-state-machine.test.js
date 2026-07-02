const test = require('node:test');
const assert = require('node:assert/strict');

const codeClipService = require('./verticals/codeclip/service');
const { buildCodeClipReport } = require('./verticals/codeclip/report');
const {
  getCodeClipInteractions,
  getCodeClipInteractionSummary,
  saveCodeClipRewardAssignments,
  getCodeClipRewardAssignments,
  getCodeClipRewardAssignmentSummary,
} = require('./db');

function assertAudienceIntentContract(intent, expectedType) {
  assert.ok(intent, 'audienceIntent should exist');
  assert.equal(intent.type, expectedType);
  assert.ok(intent.source, 'audienceIntent.source should exist');
  assert.ok(intent.transport, 'audienceIntent.transport should exist');
  assert.ok(intent.requestedVertical, 'audienceIntent.requestedVertical should exist');
  assert.equal(intent.metadata, undefined);
}

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
  let persistedRewardAssignmentSnapshot = null;

  const result = await codeClipService.handleCodeClipScan({
    event: {
      id: eventId,
      code: eventCode,
      vertical: 'codeclip',
      venue: 'Test Venue',
      city: 'Oslo',
      startAt: '2099-12-31T18:00:00.000Z',
      unlockAt: '2099-12-31T18:30:00.000Z',
      endAt: '2099-12-31T23:59:59.000Z',
      activationMethod: 'both',
      activationKeyword: 'GOLD',
      activationChannels: ['Instagram', 'Messenger'],
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
    audienceIntent: {
      type: 'scan',
      entryCode: eventCode,
      scanId,
      requestedVertical: 'codeclip-intent',
      source: 'scan-intent',
      transport: 'http-intent',
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
    async saveCodeClipRewardAssignments(snapshot) {
      persistedRewardAssignmentSnapshot = snapshot;
      return snapshot.assignments;
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
  assert.ok(persistedInteraction.audienceContext);
  assert.deepEqual(persistedInteraction.audienceContext.campaign, {
    eventCode,
    eventId,
    vertical: 'codeclip',
    venue: 'Test Venue',
    city: 'Oslo',
    startAt: '2099-12-31T18:00:00.000Z',
    unlockAt: '2099-12-31T18:30:00.000Z',
    endAt: '2099-12-31T23:59:59.000Z',
  });
  assert.deepEqual(persistedInteraction.audienceContext.activation, {
    method: 'both',
    keyword: 'GOLD',
    channels: ['Instagram', 'Messenger'],
  });
  assert.deepEqual(persistedInteraction.audienceContext.entry, {
    source: 'scan-intent',
    transport: 'http-intent',
    requestedVertical: 'codeclip-intent',
  });
  assertAudienceIntentContract(persistedInteraction.audienceIntent, 'scan');
  assert.deepEqual(persistedInteraction.audienceIntent, {
    type: 'scan',
    entryCode: eventCode,
    scanId,
    requestedVertical: 'codeclip-intent',
    source: 'scan-intent',
    transport: 'http-intent',
  });
  assert.equal(persistedInteraction.audienceIntent.userAgent, undefined);
  assert.equal(persistedInteraction.audienceIntent.ip, undefined);
  assert.deepEqual(persistedInteraction.audienceContext.rewardContext, {
    hasOpenClip: true,
    hasClip: true,
    hasClipPlus: true,
    hasClipXtra: false,
  });
  assert.equal(persistedInteraction.audienceContext.entry.userAgent, undefined);
  assert.equal(persistedInteraction.audienceContext.entry.ip, undefined);
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
  assert.equal(persistedRewardAssignmentSnapshot, persistedInteraction.rewardAssignmentSnapshot);
  assert.equal(result.payload.rewardAssignmentSnapshot, undefined);
  assert.equal(result.payload.audienceContext, undefined);
  assert.equal(result.payload.audienceIntent, undefined);
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

test('successful codeClip keyword entry builds internal Interaction without event scan persistence', async () => {
  const eventCode = 'CC-KEYWORD-RUNTIME';
  const eventId = 'event-keyword-runtime';
  const messageId = 'message-keyword-runtime';
  const rewards = {
    openClip: { enabled: true },
    clipPlus: { enabled: true },
  };
  const rewardAssignments = {
    openClip: { assigned: true, tier: 'openClip' },
    clipPlus: { assigned: true, tier: 'clipPlus' },
    clipXtra: { assigned: false },
  };

  let eventScanWriteAttempted = false;
  let persistedInteraction = null;
  let persistedRewardAssignmentSnapshot = null;

  const result = await codeClipService.handleCodeClipKeywordEntry({
    event: {
      id: eventId,
      code: eventCode,
      vertical: 'codeclip',
      venue: 'Keyword Venue',
      city: 'Bergen',
      startAt: '2099-12-31T18:00:00.000Z',
      unlockAt: '2099-12-31T18:30:00.000Z',
      endAt: '2099-12-31T23:59:59.000Z',
      activationMethod: 'keyword',
      activationKeyword: 'GOLD',
      activationChannels: ['Instagram'],
      rewards,
    },
    eventCode,
    eventId,
    keyword: '  GOLD  ',
    messageId,
    requestedVertical: ' codeclip ',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { text: 'GOLD', provider: 'test' },
    messageBody: 'GOLD',
    handle: '@participant',
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
    async persistFinalScan() {
      eventScanWriteAttempted = true;
    },
    async saveCodeClipInteraction(interaction) {
      persistedInteraction = interaction;
      return { id: 2, interaction_state: interaction.state, routing_outcome: interaction.routingOutcome };
    },
    async saveCodeClipRewardAssignments(snapshot) {
      persistedRewardAssignmentSnapshot = snapshot;
      return snapshot.assignments;
    },
    async saveCodeClipXtraRedemption() {
      throw new Error('ClipXtra should not be persisted when not assigned');
    },
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.payload.success, true);
  assert.equal(eventScanWriteAttempted, false);

  assert.ok(persistedInteraction, 'saveCodeClipInteraction should receive a keyword Interaction');
  assert.equal(persistedInteraction.eventCode, eventCode);
  assert.equal(persistedInteraction.eventId, eventId);
  assert.equal(persistedInteraction.scanId, messageId);
  assert.equal(persistedInteraction.state, 'processed');
  assert.equal(persistedInteraction.routingOutcome, 'MATCH');
  assert.deepEqual(persistedInteraction.audienceEntry, {
    entryCode: eventCode,
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
    receivedAt: persistedInteraction.audienceEntry.receivedAt,
  });
  assertAudienceIntentContract(persistedInteraction.audienceIntent, 'keyword');
  assert.deepEqual(persistedInteraction.audienceIntent, {
    type: 'keyword',
    entryCode: eventCode,
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
  });
  assert.equal(persistedInteraction.audienceEntry.ip, undefined);
  assert.equal(persistedInteraction.audienceEntry.userAgent, undefined);
  assert.equal(persistedInteraction.audienceEntry.rawPayload, undefined);
  assert.equal(persistedInteraction.audienceIntent.ip, undefined);
  assert.equal(persistedInteraction.audienceIntent.userAgent, undefined);
  assert.equal(persistedInteraction.audienceIntent.rawPayload, undefined);
  assert.ok(persistedInteraction.audienceContext);
  assert.deepEqual(persistedInteraction.audienceContext.entry, {
    source: 'keyword',
    transport: 'message',
    requestedVertical: 'codeclip',
  });
  assert.deepEqual(persistedInteraction.audienceContext.activation, {
    method: 'keyword',
    keyword: 'GOLD',
    channels: ['Instagram'],
  });
  assert.ok(persistedInteraction.rewardAssignmentSnapshot);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot, persistedRewardAssignmentSnapshot);
  assert.equal(persistedInteraction.rewardAssignmentSnapshot.scanId, messageId);
  assert.deepEqual(
    persistedInteraction.rewardAssignmentSnapshot.assignments.map((assignment) => assignment.tier),
    ['openClip', 'clipPlus', 'clipXtra']
  );
  assert.equal(result.payload.audienceEntry, undefined);
  assert.equal(result.payload.audienceIntent, undefined);
  assert.equal(result.payload.audienceContext, undefined);
  assert.equal(result.payload.rewardAssignmentSnapshot, undefined);
});

test('codeClip keyword entry rejects missing keyword without persistence', async () => {
  let eventScanWriteAttempted = false;
  let interactionPersisted = false;
  let rewardAssignmentsPersisted = false;

  const result = await codeClipService.handleCodeClipKeywordEntry({
    event: {
      id: 'event-keyword-invalid',
      code: 'CC-KEYWORD-INVALID',
      vertical: 'codeclip',
      endAt: '2099-12-31T23:59:59.000Z',
      rewards: {},
    },
    eventCode: 'CC-KEYWORD-INVALID',
    eventId: 'event-keyword-invalid',
    keyword: '   ',
    messageId: 'message-keyword-invalid',
    requestedVertical: 'codeclip',
    redis: null,
    codeClipVertical: {
      routes: {
        parseCodeClipRewardsMeta() {
          throw new Error('invalid keyword should not reach reward metadata parsing');
        },
      },
      assignment: {
        async assignCodeClipRewards() {
          throw new Error('invalid keyword should not assign rewards');
        },
      },
    },
    async persistFinalScan() {
      eventScanWriteAttempted = true;
    },
    async saveCodeClipInteraction() {
      interactionPersisted = true;
    },
    async saveCodeClipRewardAssignments() {
      rewardAssignmentsPersisted = true;
    },
  });

  assert.equal(result.httpStatus, 400);
  assert.equal(result.payload.success, false);
  assert.deepEqual(
    result.payload.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );
  assert.equal(eventScanWriteAttempted, false);
  assert.equal(interactionPersisted, false);
  assert.equal(rewardAssignmentsPersisted, false);
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
  assertAudienceIntentContract(interaction.audienceIntent, 'scan');
  assert.deepEqual(interaction.audienceIntent, {
    type: 'scan',
    entryCode: eventCode,
    scanId,
    requestedVertical: 'codeclip',
    source: 'scan',
    transport: 'http',
  });
  assert.equal(interaction.audienceIntent.userAgent, undefined);
  assert.equal(interaction.audienceIntent.ip, undefined);
  assert.ok(interaction.audienceContext);
  assert.equal(interaction.audienceContext.campaign.eventCode, eventCode);
  assert.equal(interaction.audienceContext.campaign.eventId, null);
  assert.equal(interaction.audienceContext.campaign.vertical, null);
  assert.deepEqual(interaction.audienceContext.activation, {
    method: '',
    keyword: '',
    channels: [],
  });
  assert.deepEqual(interaction.audienceContext.entry, {
    source: 'scan',
    transport: 'http',
    requestedVertical: 'codeclip',
  });
  assert.deepEqual(interaction.audienceContext.rewardContext, {
    hasOpenClip: false,
    hasClip: false,
    hasClipPlus: false,
    hasClipXtra: false,
  });
  assert.equal(interaction.audienceContext.entry.userAgent, undefined);
  assert.equal(interaction.audienceContext.entry.ip, undefined);
  assert.equal(interaction.rewardAssignments, undefined);
});

test('codeClip scan EntryAdapter normalizes sanitized AudienceEntry and AudienceIntent', () => {
  const valid = codeClipService.normalizeScanAudienceEntry({
    entryCode: 'CC-ENTRY-ADAPTER',
    scanId: 'scan-entry-adapter',
    requestedVertical: ' codeclip ',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.warnings, []);
  assert.deepEqual(valid.audienceEntry, {
    entryCode: 'CC-ENTRY-ADAPTER',
    scanId: 'scan-entry-adapter',
    requestedVertical: 'codeclip',
    source: 'scan',
    transport: 'http',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });
  assertAudienceIntentContract(valid.audienceIntent, 'scan');
  assert.deepEqual(valid.audienceIntent, {
    type: 'scan',
    entryCode: 'CC-ENTRY-ADAPTER',
    scanId: 'scan-entry-adapter',
    requestedVertical: 'codeclip',
    source: 'scan',
    transport: 'http',
  });
  assert.equal(valid.audienceEntry.ip, undefined);
  assert.equal(valid.audienceEntry.userAgent, undefined);
  assert.equal(valid.audienceIntent.ip, undefined);
  assert.equal(valid.audienceIntent.userAgent, undefined);

  const missingEntryCode = codeClipService.normalizeScanAudienceEntry({
    scanId: 'scan-missing-entry-code',
    requestedVertical: 'codeclip',
  });

  assert.equal(missingEntryCode.ok, false);
  assert.equal(missingEntryCode.audienceEntry, null);
  assert.equal(missingEntryCode.audienceIntent, null);
  assert.deepEqual(
    missingEntryCode.errors.map((error) => error.code),
    ['ENTRY_CODE_REQUIRED']
  );

  const missingScanId = codeClipService.normalizeScanAudienceEntry({
    entryCode: 'CC-MISSING-SCAN-ID',
    requestedVertical: 'codeclip',
  });

  assert.equal(missingScanId.ok, true);
  assert.equal(missingScanId.audienceEntry.scanId, '');
  assertAudienceIntentContract(missingScanId.audienceIntent, 'scan');
  assert.equal(missingScanId.audienceIntent.scanId, '');
  assert.deepEqual(
    missingScanId.warnings.map((warning) => warning.code),
    ['SCAN_ID_MISSING']
  );

  const unknownVertical = codeClipService.normalizeScanAudienceEntry({
    entryCode: 'CC-UNKNOWN-VERTICAL',
    scanId: 'scan-unknown-vertical',
    requestedVertical: 'mysteryVertical',
  });

  assert.equal(unknownVertical.ok, true);
  assert.equal(unknownVertical.audienceEntry.requestedVertical, 'mysteryvertical');
  assertAudienceIntentContract(unknownVertical.audienceIntent, 'scan');
  assert.equal(unknownVertical.audienceIntent.requestedVertical, 'mysteryvertical');
  assert.deepEqual(
    unknownVertical.warnings.map((warning) => warning.code),
    ['UNKNOWN_VERTICAL']
  );
});

test('codeClip keyword EntryAdapter normalizes sanitized AudienceEntry and AudienceIntent', () => {
  const valid = codeClipService.normalizeKeywordAudienceEntry({
    entryCode: ' CC-KEYWORD-ADAPTER ',
    keyword: '  GOLD  ',
    requestedVertical: ' codeclip ',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { text: 'GOLD', provider: 'test' },
    messageBody: 'GOLD',
    phone: '+4712345678',
    email: 'participant@example.com',
    handle: '@participant',
    profileId: 'profile-123',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.warnings, []);
  assert.deepEqual(valid.audienceEntry, {
    entryCode: 'CC-KEYWORD-ADAPTER',
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });
  assertAudienceIntentContract(valid.audienceIntent, 'keyword');
  assert.deepEqual(valid.audienceIntent, {
    type: 'keyword',
    entryCode: 'CC-KEYWORD-ADAPTER',
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
  });
  assert.equal(valid.audienceEntry.ip, undefined);
  assert.equal(valid.audienceEntry.userAgent, undefined);
  assert.equal(valid.audienceEntry.rawPayload, undefined);
  assert.equal(valid.audienceEntry.messageBody, undefined);
  assert.equal(valid.audienceEntry.phone, undefined);
  assert.equal(valid.audienceEntry.email, undefined);
  assert.equal(valid.audienceEntry.handle, undefined);
  assert.equal(valid.audienceEntry.profileId, undefined);
  assert.equal(valid.audienceIntent.ip, undefined);
  assert.equal(valid.audienceIntent.userAgent, undefined);
  assert.equal(valid.audienceIntent.rawPayload, undefined);
  assert.equal(valid.audienceIntent.messageBody, undefined);
  assert.equal(valid.audienceIntent.phone, undefined);
  assert.equal(valid.audienceIntent.email, undefined);
  assert.equal(valid.audienceIntent.handle, undefined);
  assert.equal(valid.audienceIntent.profileId, undefined);

  const missingEntryCode = codeClipService.normalizeKeywordAudienceEntry({
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
  });

  assert.equal(missingEntryCode.ok, false);
  assert.equal(missingEntryCode.audienceEntry, null);
  assert.equal(missingEntryCode.audienceIntent, null);
  assert.deepEqual(
    missingEntryCode.errors.map((error) => error.code),
    ['ENTRY_CODE_REQUIRED']
  );

  const missingKeyword = codeClipService.normalizeKeywordAudienceEntry({
    entryCode: 'CC-MISSING-KEYWORD',
    requestedVertical: 'codeclip',
  });

  assert.equal(missingKeyword.ok, false);
  assert.equal(missingKeyword.audienceEntry, null);
  assert.equal(missingKeyword.audienceIntent, null);
  assert.deepEqual(
    missingKeyword.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );

  const unknownVertical = codeClipService.normalizeKeywordAudienceEntry({
    entryCode: 'CC-UNKNOWN-KEYWORD-VERTICAL',
    keyword: 'GOLD',
    requestedVertical: 'mysteryVertical',
  });

  assert.equal(unknownVertical.ok, true);
  assert.equal(unknownVertical.audienceEntry.requestedVertical, 'mysteryvertical');
  assertAudienceIntentContract(unknownVertical.audienceIntent, 'keyword');
  assert.equal(unknownVertical.audienceIntent.requestedVertical, 'mysteryvertical');
  assert.deepEqual(
    unknownVertical.warnings.map((warning) => warning.code),
    ['UNKNOWN_VERTICAL']
  );
});

test('codeClip EntryAdapter registry normalizes known entry types and rejects unknown types', () => {
  const scan = codeClipService.normalizeAudienceEntry(' scan ', {
    entryCode: 'CC-REGISTRY-SCAN',
    scanId: 'scan-registry',
    requestedVertical: ' codeclip ',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    receivedAt: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(scan.ok, true);
  assert.deepEqual(scan.errors, []);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.audienceEntry, {
    entryCode: 'CC-REGISTRY-SCAN',
    scanId: 'scan-registry',
    requestedVertical: 'codeclip',
    source: 'scan',
    transport: 'http',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });
  assertAudienceIntentContract(scan.audienceIntent, 'scan');
  assert.deepEqual(scan.audienceIntent, {
    type: 'scan',
    entryCode: 'CC-REGISTRY-SCAN',
    scanId: 'scan-registry',
    requestedVertical: 'codeclip',
    source: 'scan',
    transport: 'http',
  });
  assert.equal(scan.audienceEntry.ip, undefined);
  assert.equal(scan.audienceEntry.userAgent, undefined);
  assert.equal(scan.audienceEntry.rawPayload, undefined);
  assert.equal(scan.audienceIntent.ip, undefined);
  assert.equal(scan.audienceIntent.userAgent, undefined);
  assert.equal(scan.audienceIntent.rawPayload, undefined);

  const keyword = codeClipService.normalizeAudienceEntry(' KEYWORD ', {
    entryCode: 'CC-REGISTRY-KEYWORD',
    keyword: '  GOLD  ',
    requestedVertical: ' codeclip ',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    messageBody: 'GOLD',
    handle: '@participant',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(keyword.ok, true);
  assert.deepEqual(keyword.errors, []);
  assert.deepEqual(keyword.warnings, []);
  assert.deepEqual(keyword.audienceEntry, {
    entryCode: 'CC-REGISTRY-KEYWORD',
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
    receivedAt: '2026-07-01T00:00:00.000Z',
  });
  assertAudienceIntentContract(keyword.audienceIntent, 'keyword');
  assert.deepEqual(keyword.audienceIntent, {
    type: 'keyword',
    entryCode: 'CC-REGISTRY-KEYWORD',
    keyword: 'GOLD',
    requestedVertical: 'codeclip',
    source: 'keyword',
    transport: 'message',
  });
  assert.equal(keyword.audienceEntry.ip, undefined);
  assert.equal(keyword.audienceEntry.userAgent, undefined);
  assert.equal(keyword.audienceEntry.rawPayload, undefined);
  assert.equal(keyword.audienceEntry.messageBody, undefined);
  assert.equal(keyword.audienceEntry.handle, undefined);
  assert.equal(keyword.audienceIntent.ip, undefined);
  assert.equal(keyword.audienceIntent.userAgent, undefined);
  assert.equal(keyword.audienceIntent.rawPayload, undefined);
  assert.equal(keyword.audienceIntent.messageBody, undefined);
  assert.equal(keyword.audienceIntent.handle, undefined);

  const unknown = codeClipService.normalizeAudienceEntry('link', {
    entryCode: 'CC-UNKNOWN-ENTRY',
  });

  assert.equal(unknown.ok, false);
  assert.equal(unknown.audienceEntry, null);
  assert.equal(unknown.audienceIntent, null);
  assert.deepEqual(
    unknown.errors.map((error) => error.code),
    ['ENTRY_ADAPTER_NOT_FOUND']
  );

  const missing = codeClipService.normalizeAudienceEntry('', {
    entryCode: 'CC-MISSING-ENTRY-TYPE',
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.audienceEntry, null);
  assert.equal(missing.audienceIntent, null);
  assert.deepEqual(
    missing.errors.map((error) => error.code),
    ['ENTRY_TYPE_REQUIRED']
  );
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

test('saveCodeClipRewardAssignments persists normalized assignment rows with idempotency shape', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            event_code: params[0],
            scan_id: params[2],
            tier: params[6],
            redemption_token: params[22],
            raw_payload: params[31],
          },
        ],
      };
    },
  };
  const snapshot = {
    eventCode: 'CC-REWARD-PERSIST',
    eventId: 'event-reward-persist',
    scanId: 'scan-reward-persist',
    interactionState: 'processed',
    routingOutcome: 'MATCH',
    audienceContext: {
      entry: {
        source: 'scan',
        transport: 'http',
        requestedVertical: 'codeclip',
      },
      activation: {
        method: 'both',
        keyword: 'GOLD',
        channels: ['Instagram'],
      },
    },
    assignments: [
      {
        tier: 'openClip',
        displayTier: 'OpenClip',
        assigned: true,
        title: 'Open reward',
        quantity: 0,
        assignedCount: 0,
        remaining: null,
        unlimited: true,
        assignedAt: '2026-07-01T00:00:00.000Z',
        rawAssignment: { tier: 'openClip', assigned: true },
      },
      {
        tier: 'clipXtra',
        displayTier: 'ClipXtra',
        assigned: true,
        rewardType: 'clip_xtra',
        redemptionToken: 'CX-REWARD-PERSIST',
        partnerName: 'Partner',
        title: 'ClipXtra reward',
        assignedAt: '2026-07-01T00:01:00.000Z',
        rawAssignment: { tier: 'clipXtra', assigned: true },
      },
    ],
  };

  assert.deepEqual(await saveCodeClipRewardAssignments({}, fakeClient), []);
  assert.deepEqual(await saveCodeClipRewardAssignments({ eventCode: 'CC-MISSING-SCAN' }, fakeClient), []);
  assert.deepEqual(await saveCodeClipRewardAssignments({
    eventCode: 'CC-EMPTY-ASSIGNMENTS',
    scanId: 'scan-empty-assignments',
    assignments: [],
  }, fakeClient), []);

  const rows = await saveCodeClipRewardAssignments(snapshot, fakeClient);

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO codeclip_reward_assignments/);
  assert.match(calls[0].sql, /ON CONFLICT \(event_code, scan_id, tier\)/);
  assert.match(calls[0].sql, /\$32::jsonb/);
  assert.equal(calls[0].params[0], 'CC-REWARD-PERSIST');
  assert.equal(calls[0].params[1], 'event-reward-persist');
  assert.equal(calls[0].params[2], 'scan-reward-persist');
  assert.equal(calls[0].params[4], 'processed');
  assert.equal(calls[0].params[5], 'MATCH');
  assert.equal(calls[0].params[6], 'openClip');
  assert.equal(calls[0].params[8], true);
  assert.equal(calls[0].params[16], 0);
  assert.equal(calls[0].params[18], null);
  assert.equal(calls[0].params[19], true);

  assert.equal(calls[1].params[6], 'clipXtra');
  assert.equal(calls[1].params[11], 'clip_xtra');
  assert.equal(calls[1].params[22], 'CX-REWARD-PERSIST');
  assert.equal(calls[1].params[23], 'Partner');

  const clipXtraRawPayload = JSON.parse(calls[1].params[31]);
  assert.equal(clipXtraRawPayload.eventCode, 'CC-REWARD-PERSIST');
  assert.equal(clipXtraRawPayload.scanId, 'scan-reward-persist');
  assert.deepEqual(clipXtraRawPayload.audienceContext.entry, {
    source: 'scan',
    transport: 'http',
    requestedVertical: 'codeclip',
  });
  assert.deepEqual(clipXtraRawPayload.audienceContext.activation, {
    method: 'both',
    keyword: 'GOLD',
    channels: ['Instagram'],
  });
  assert.equal(clipXtraRawPayload.assignment.redemptionToken, 'CX-REWARD-PERSIST');
  assert.equal(clipXtraRawPayload.assignment.rawAssignment.tier, 'clipXtra');

  assert.equal(rows.length, 2);
  assert.equal(rows[1].redemption_token, 'CX-REWARD-PERSIST');
});

test('codeClip reward assignment read helper normalizes limit and raw payload shape', async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            event_code: params[0],
            scan_id: 'scan-reward-read-test',
            tier: 'clipXtra',
            assigned: true,
            redemption_token: 'CX-READ-TEST',
            raw_payload: JSON.stringify({
              eventCode: params[0],
              scanId: 'scan-reward-read-test',
              assignment: {
                tier: 'clipXtra',
                redemptionToken: 'CX-READ-TEST',
              },
            }),
          },
        ],
      };
    },
  };

  assert.deepEqual(await getCodeClipRewardAssignments('', 100, fakeClient), []);

  const rows = await getCodeClipRewardAssignments('CC-REWARD-READ-TEST', 999, fakeClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'CC-REWARD-READ-TEST');
  assert.equal(calls[0].params[1], 500);
  assert.match(calls[0].sql, /FROM codeclip_reward_assignments/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_code, 'CC-REWARD-READ-TEST');
  assert.equal(rows[0].tier, 'clipXtra');
  assert.equal(rows[0].raw_payload.assignment.redemptionToken, 'CX-READ-TEST');
  assert.equal(rows[0].rawPayload.scanId, 'scan-reward-read-test');
});

test('codeClip reward assignment summary helper returns assignment counts', async () => {
  const calls = [];
  const latestAssignmentAt = new Date('2026-07-01T13:00:00.000Z');
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            total_count: 6,
            assigned_count: 4,
            unassigned_count: 2,
            exhausted_count: 1,
            no_reward_count: 1,
            open_clip_count: 2,
            clip_count: 1,
            clip_plus_count: 1,
            clip_xtra_count: 2,
            open_clip_assigned_count: 2,
            clip_assigned_count: 0,
            clip_plus_assigned_count: 1,
            clip_xtra_assigned_count: 1,
            clip_xtra_with_token_count: 1,
            latest_assignment_at: latestAssignmentAt,
          },
        ],
      };
    },
  };

  assert.deepEqual(await getCodeClipRewardAssignmentSummary('', fakeClient), {
    totalAssignments: 0,
    assignedCount: 0,
    unassignedCount: 0,
    exhaustedCount: 0,
    noRewardCount: 0,
    tiers: {
      openClip: 0,
      clip: 0,
      clipPlus: 0,
      clipXtra: 0,
    },
    assignedByTier: {
      openClip: 0,
      clip: 0,
      clipPlus: 0,
      clipXtra: 0,
    },
    clipXtraWithTokenCount: 0,
    latestAssignmentAt: null,
  });

  const summary = await getCodeClipRewardAssignmentSummary('CC-REWARD-SUMMARY-TEST', fakeClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'CC-REWARD-SUMMARY-TEST');
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE assigned = TRUE\)/);
  assert.match(calls[0].sql, /FROM codeclip_reward_assignments/);
  assert.deepEqual(summary, {
    totalAssignments: 6,
    assignedCount: 4,
    unassignedCount: 2,
    exhaustedCount: 1,
    noRewardCount: 1,
    tiers: {
      openClip: 2,
      clip: 1,
      clipPlus: 1,
      clipXtra: 2,
    },
    assignedByTier: {
      openClip: 2,
      clip: 0,
      clipPlus: 1,
      clipXtra: 1,
    },
    clipXtraWithTokenCount: 1,
    latestAssignmentAt,
  });
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

test('codeClip report helper builds compatible rows from MATCH interactions only', async () => {
  const report = await buildCodeClipReport('CC-REPORT-TEST', {
    async getCodeClipInteractions() {
      return [
        {
          event_code: 'CC-REPORT-TEST',
          event_id: 'event-report-test',
          scan_id: 'scan-match',
          scan_rank: 7,
          tier: 'clipPlus',
          routing_outcome: 'MATCH',
          interaction_state: 'processed',
          stateTransitions: [{ to: 'processed' }],
          rawPayload: {
            interaction: { shouldNotLeak: true },
            stateTransitions: [{ to: 'processed' }],
          },
          created_at: '2026-07-01T10:00:00.000Z',
        },
        {
          event_code: 'CC-REPORT-TEST',
          scan_id: 'scan-no-match',
          routing_outcome: 'NO_CAMPAIGN_MATCH',
          interaction_state: 'unmatched',
          created_at: '2026-07-01T10:01:00.000Z',
        },
      ];
    },
    async getCodeClipRewardAssignments() {
      return [
        {
          event_code: 'CC-REPORT-TEST',
          scan_id: 'scan-match',
          tier: 'clipXtra',
          assigned: true,
          reward_type: 'clip_xtra',
          redemption_token: 'CX-REPORT-TEST',
          rawPayload: {
            scanId: 'scan-match',
            assignment: { tier: 'clipXtra', redemptionToken: 'CX-REPORT-TEST' },
          },
        },
      ];
    },
    async getCodeClipRewardAssignmentSummary() {
      return {
        assignedByTier: { openClip: 1, clip: 1, clipPlus: 1, clipXtra: 1 },
        clipXtraWithTokenCount: 1,
      };
    },
    async getEventScanSummary() {
      return { scans: 99, uniqueScans: 88 };
    },
    async getEventRegistrations() {
      return [{ event_code: 'CC-REPORT-TEST', scan_id: 'scan-match', phone: '+4712345678' }];
    },
    async getEventRegistrationSummary() {
      return { registrations: 1 };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.vertical, 'codeclip');
  assert.equal(report.rows.length, 1);
  assert.equal(report.scans, report.rows);
  assert.equal(report.rows[0].scanId, 'scan-match');
  assert.equal(report.rows[0].phone, '+4712345678');
  assert.equal(report.rows[0].goldXtraAssigned, true);
  assert.equal(report.rows[0].redemptionToken, 'CX-REPORT-TEST');
  assert.equal(report.rows[0].displayTier, 'ClipXtra');
  assert.equal(report.metrics.scans, 1);
  assert.equal(report.metrics.uniqueScans, 1);
  assert.equal(report.metrics.goldXtraAssigned, 1);
  assert.equal(report.metrics.clipXtraAssigned, 1);
  assert.equal(report.rows[0].rawPayload, undefined);
  assert.equal(report.rows[0].raw_payload, undefined);
  assert.equal(report.rows[0].interaction, undefined);
  assert.equal(report.rows[0].stateTransitions, undefined);
  assert.equal(report.rows[0].interaction_state, undefined);
});

test('codeClip report helper falls back to compatible empty rows without MATCH interactions', async () => {
  const report = await buildCodeClipReport('CC-REPORT-FALLBACK', {
    async getCodeClipInteractions() {
      return [
        {
          event_code: 'CC-REPORT-FALLBACK',
          scan_id: 'scan-no-match',
          routing_outcome: 'NO_CAMPAIGN_MATCH',
          interaction_state: 'unmatched',
        },
      ];
    },
    async getCodeClipRewardAssignments() {
      return [];
    },
    async getCodeClipRewardAssignmentSummary() {
      return {};
    },
    async getEventScanSummary() {
      return { scans: 3, uniqueScans: 2 };
    },
    async getEventRegistrations() {
      return [];
    },
    async getEventRegistrationSummary() {
      return { registrations: 0 };
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.vertical, 'codeclip');
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.scans, []);
  assert.equal(report.totalScans, 3);
  assert.equal(report.uniqueScans, 2);
  assert.equal(report.metrics.scans, 3);
  assert.equal(report.metrics.uniqueScans, 2);
  assert.equal(report.metrics.goldXtraAssigned, 0);
});

test('codeClip report helper matches stable legacy report compatibility fields', async () => {
  const legacyLikeReport = {
    ok: true,
    vertical: 'codepod',
    eventCode: 'CC-REPORT-PARITY',
    totalScans: 1,
    uniqueScans: 1,
    joins: 1,
    registrationCount: 1,
    rows: [
      {
        eventCode: 'CC-REPORT-PARITY',
        eventId: 'event-report-parity',
        scanId: 'scan-parity',
        phone: '+4799999999',
        scanRank: 4,
        timestamp: '2026-07-01T11:00:00.000Z',
        tier: 'clipPlus',
        digitalSouvenirTier: 'clipPlus',
        displayTier: 'ClipXtra',
        rewardType: 'clip_xtra',
        goldXtraAssigned: true,
        redemptionToken: 'CX-PARITY',
        redemptionStatus: '',
        source: 'qr',
      },
    ],
    registrations: [
      {
        eventCode: 'CC-REPORT-PARITY',
        eventId: 'event-report-parity',
        scanId: 'scan-parity',
        phone: '+4799999999',
        timestamp: '2026-07-01T11:01:00.000Z',
        tier: '',
        displayTier: '',
        source: 'inside',
      },
    ],
    metrics: {
      scans: 1,
      uniqueScans: 1,
      joins: 1,
      registrations: 1,
      goldXtraAssigned: 1,
    },
  };
  legacyLikeReport.scans = legacyLikeReport.rows;

  const report = await buildCodeClipReport('CC-REPORT-PARITY', {
    async getCodeClipInteractions() {
      return [
        {
          event_code: 'CC-REPORT-PARITY',
          event_id: 'event-report-parity',
          scan_id: 'scan-parity',
          scan_rank: 4,
          tier: 'clipPlus',
          routing_outcome: 'MATCH',
          interaction_state: 'processed',
          stateTransitions: [{ to: 'processed' }],
          rawPayload: { stateTransitions: [{ to: 'processed' }] },
          created_at: '2026-07-01T11:00:00.000Z',
        },
        {
          event_code: 'CC-REPORT-PARITY',
          scan_id: 'scan-no-match-parity',
          routing_outcome: 'NO_CAMPAIGN_MATCH',
          interaction_state: 'unmatched',
          created_at: '2026-07-01T11:02:00.000Z',
        },
      ];
    },
    async getCodeClipRewardAssignments() {
      return [
        {
          event_code: 'CC-REPORT-PARITY',
          scan_id: 'scan-parity',
          tier: 'clipXtra',
          assigned: true,
          reward_type: 'clip_xtra',
          redemption_token: 'CX-PARITY',
        },
      ];
    },
    async getCodeClipRewardAssignmentSummary() {
      return {
        assignedByTier: { openClip: 1, clip: 1, clipPlus: 1, clipXtra: 1 },
        clipXtraWithTokenCount: 1,
      };
    },
    async getEventScanSummary() {
      return { scans: 1, uniqueScans: 1 };
    },
    async getEventRegistrations() {
      return [
        {
          event_code: 'CC-REPORT-PARITY',
          event_id: 'event-report-parity',
          scan_id: 'scan-parity',
          phone: '+4799999999',
          created_at: '2026-07-01T11:01:00.000Z',
        },
      ];
    },
    async getEventRegistrationSummary() {
      return { registrations: 1 };
    },
  });

  assert.equal(report.vertical, 'codeclip');
  assert.equal(report.totalScans, legacyLikeReport.totalScans);
  assert.equal(report.uniqueScans, legacyLikeReport.uniqueScans);
  assert.equal(report.joins, legacyLikeReport.joins);
  assert.equal(report.registrationCount, legacyLikeReport.registrationCount);
  assert.equal(report.rows.length, legacyLikeReport.rows.length);
  assert.equal(report.scans, report.rows);
  assert.equal(report.metrics.scans, legacyLikeReport.metrics.scans);
  assert.equal(report.metrics.uniqueScans, legacyLikeReport.metrics.uniqueScans);
  assert.equal(report.metrics.joins, legacyLikeReport.metrics.joins);
  assert.equal(report.metrics.goldXtraAssigned, legacyLikeReport.metrics.goldXtraAssigned);

  const row = report.rows[0];
  const legacyRow = legacyLikeReport.rows[0];
  assert.equal(row.scanId, legacyRow.scanId);
  assert.equal(row.tier, legacyRow.tier);
  assert.equal(row.displayTier, legacyRow.displayTier);
  assert.equal(row.rewardType, legacyRow.rewardType);
  assert.equal(row.redemptionToken, legacyRow.redemptionToken);
  assert.equal(report.rows.find((item) => item.scanId === 'scan-no-match-parity'), undefined);
  assert.equal(row.rawPayload, undefined);
  assert.equal(row.raw_payload, undefined);
  assert.equal(row.interaction, undefined);
  assert.equal(row.stateTransitions, undefined);
  assert.equal(row.interaction_state, undefined);
});

test('codeClip report helper keeps codePod legacy report data isolated', async () => {
  const legacyCodePodReport = {
    ok: true,
    vertical: 'codepod',
    eventCode: 'CP-REPORT-ISOLATION',
    totalScans: 1,
    uniqueScans: 1,
    joins: 0,
    registrationCount: 0,
    rows: [
      {
        eventCode: 'CP-REPORT-ISOLATION',
        scanId: 'scan-codepod-isolation',
        tier: 'gold',
        displayTier: 'GoldXtra',
        rewardType: 'partner_reward',
        goldXtraAssigned: true,
        redemptionToken: 'GX-ISOLATION',
      },
    ],
    metrics: {
      scans: 1,
      uniqueScans: 1,
      joins: 0,
      goldXtraAssigned: 1,
    },
  };
  legacyCodePodReport.scans = legacyCodePodReport.rows;

  const codeClipReport = await buildCodeClipReport('CC-REPORT-ISOLATION', {
    async getCodeClipInteractions() {
      return [
        {
          event_code: 'CC-REPORT-ISOLATION',
          event_id: 'event-codeclip-isolation',
          scan_id: 'scan-codeclip-isolation',
          scan_rank: 1,
          tier: 'clipPlus',
          routing_outcome: 'MATCH',
          interaction_state: 'processed',
          rawPayload: {
            interaction: { shouldNotLeak: true },
            stateTransitions: [{ to: 'processed' }],
          },
          created_at: '2026-07-01T12:00:00.000Z',
        },
        {
          event_code: 'CC-REPORT-ISOLATION',
          scan_id: 'scan-codeclip-no-match',
          routing_outcome: 'NO_CAMPAIGN_MATCH',
          interaction_state: 'unmatched',
          created_at: '2026-07-01T12:01:00.000Z',
        },
      ];
    },
    async getCodeClipRewardAssignments() {
      return [
        {
          event_code: 'CC-REPORT-ISOLATION',
          scan_id: 'scan-codeclip-isolation',
          tier: 'clipXtra',
          assigned: true,
          reward_type: 'clip_xtra',
          redemption_token: 'CX-ISOLATION',
        },
      ];
    },
    async getCodeClipRewardAssignmentSummary() {
      return {
        assignedByTier: { openClip: 1, clip: 1, clipPlus: 1, clipXtra: 1 },
        clipXtraWithTokenCount: 1,
      };
    },
    async getEventScanSummary() {
      return { scans: 1, uniqueScans: 1 };
    },
    async getEventRegistrations() {
      return [];
    },
    async getEventRegistrationSummary() {
      return { registrations: 0 };
    },
  });

  assert.equal(codeClipReport.vertical, 'codeclip');
  assert.equal(codeClipReport.eventCode, 'CC-REPORT-ISOLATION');
  assert.equal(codeClipReport.rows.length, 1);
  assert.equal(codeClipReport.scans, codeClipReport.rows);
  assert.ok(codeClipReport.metrics);
  assert.equal(codeClipReport.metrics.scans, 1);
  assert.equal(codeClipReport.metrics.uniqueScans, 1);
  assert.equal(codeClipReport.metrics.goldXtraAssigned, 1);
  assert.equal(codeClipReport.rows[0].scanId, 'scan-codeclip-isolation');
  assert.equal(codeClipReport.rows[0].redemptionToken, 'CX-ISOLATION');
  assert.equal(codeClipReport.rows.find((row) => row.scanId === 'scan-codeclip-no-match'), undefined);
  assert.equal(codeClipReport.rows.find((row) => row.scanId === legacyCodePodReport.rows[0].scanId), undefined);
  assert.equal(codeClipReport.rows[0].rawPayload, undefined);
  assert.equal(codeClipReport.rows[0].raw_payload, undefined);
  assert.equal(codeClipReport.rows[0].interaction, undefined);
  assert.equal(codeClipReport.rows[0].stateTransitions, undefined);
  assert.equal(codeClipReport.rows[0].interaction_state, undefined);

  assert.equal(legacyCodePodReport.vertical, 'codepod');
  assert.equal(legacyCodePodReport.eventCode, 'CP-REPORT-ISOLATION');
  assert.equal(legacyCodePodReport.rows.length, 1);
  assert.equal(legacyCodePodReport.scans, legacyCodePodReport.rows);
  assert.equal(legacyCodePodReport.rows[0].redemptionToken, 'GX-ISOLATION');
  assert.equal(legacyCodePodReport.metrics.goldXtraAssigned, 1);
});
