const test = require('node:test');
const assert = require('node:assert/strict');

const codePod = require('./verticals/codepod');

test('codePod COAS foundation normalizes scan AudienceEntry', () => {
  const result = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: ' CP-FOUNDATION ',
    eventId: ' event-codepod-foundation ',
    scanId: ' scan-codepod-foundation ',
    requestedVertical: ' codepod ',
    receivedAt: '2026-07-01T00:00:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.audienceEntry, {
    entryCode: 'CP-FOUNDATION',
    eventCode: 'CP-FOUNDATION',
    eventId: 'event-codepod-foundation',
    scanId: 'scan-codepod-foundation',
    requestedVertical: 'codepod',
    source: 'scan',
    transport: 'http',
    receivedAt: '2026-07-01T00:00:00.000Z',
    metadata: {
      vertical: 'codepod',
    },
  });
  assert.deepEqual(result.audienceIntent, {
    vertical: 'codepod',
    intentType: 'scan',
    entryCode: 'CP-FOUNDATION',
    eventCode: 'CP-FOUNDATION',
    scanId: 'scan-codepod-foundation',
    source: 'scan',
    transport: 'http',
  });
  assert.equal(result.audienceEntry.ip, undefined);
  assert.equal(result.audienceEntry.userAgent, undefined);
  assert.equal(result.audienceEntry.rawPayload, undefined);
  assert.equal(result.audienceEntry.phone, undefined);
  assert.equal(result.audienceEntry.handle, undefined);
  assert.equal(result.audienceIntent.ip, undefined);
  assert.equal(result.audienceIntent.userAgent, undefined);
  assert.equal(result.audienceIntent.rawPayload, undefined);
  assert.equal(result.audienceIntent.phone, undefined);
  assert.equal(result.audienceIntent.handle, undefined);
});

test('codePod COAS foundation rejects missing entry code', () => {
  const result = codePod.service.normalizeCodePodScanAudienceEntry({
    scanId: 'scan-missing-entry-code',
  });

  assert.equal(result.ok, false);
  assert.equal(result.audienceEntry, null);
  assert.equal(result.audienceIntent, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['ENTRY_CODE_REQUIRED']
  );
});

test('codePod COAS foundation warns on missing scanId', () => {
  const result = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: 'CP-MISSING-SCAN',
  });

  assert.equal(result.ok, true);
  assert.equal(result.audienceEntry.entryCode, 'CP-MISSING-SCAN');
  assert.equal(result.audienceEntry.scanId, undefined);
  assert.deepEqual(result.audienceIntent, {
    vertical: 'codepod',
    intentType: 'scan',
    entryCode: 'CP-MISSING-SCAN',
    eventCode: 'CP-MISSING-SCAN',
    source: 'scan',
    transport: 'http',
  });
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['SCAN_ID_MISSING']
  );
  assert.deepEqual(result.errors, []);
});

test('codePod COAS foundation defaults requestedVertical to codepod', () => {
  const result = codePod.service.normalizeCodePodScanAudienceEntry({
    entryCode: 'CP-DEFAULT-VERTICAL',
    scanId: 'scan-default-vertical',
  });

  assert.equal(result.ok, true);
  assert.equal(result.audienceEntry.requestedVertical, 'codepod');
  assert.equal(result.audienceIntent.vertical, 'codepod');
});

test('codePod COAS foundation builds observational Interaction snapshot', () => {
  const normalized = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: ' CP-INTERACTION ',
    eventId: ' event-codepod-interaction ',
    scanId: ' scan-codepod-interaction ',
    requestedVertical: ' codepod ',
    receivedAt: '2026-07-01T00:00:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  const interaction = codePod.service.createCodePodInteractionSnapshot({
    eventCode: ' CP-INTERACTION ',
    eventId: ' event-codepod-interaction ',
    scanId: ' scan-codepod-interaction ',
    rawScans: 10,
    uniqueScans: 7,
    scanRank: 3,
    tier: ' gold ',
    timestamp: '2026-07-01T00:01:00.000Z',
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  assert.deepEqual(interaction, {
    interactionId: null,
    vertical: 'codepod',
    interactionType: 'scan',
    eventCode: 'CP-INTERACTION',
    eventId: 'event-codepod-interaction',
    scanId: 'scan-codepod-interaction',
    rawScans: 10,
    uniqueScans: 7,
    scanRank: 3,
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    state: 'observed',
    stateTransitions: [],
    tier: 'gold',
    timestamp: '2026-07-01T00:01:00.000Z',
    routingOutcome: 'MATCH',
  });
  assert.equal(interaction.ip, undefined);
  assert.equal(interaction.userAgent, undefined);
  assert.equal(interaction.rawPayload, undefined);
  assert.equal(interaction.phone, undefined);
  assert.equal(interaction.handle, undefined);
});

test('codePod COAS foundation does not build Interaction snapshot without eventCode', () => {
  const interaction = codePod.service.createCodePodInteractionSnapshot({
    scanId: 'scan-missing-event-code',
  });

  assert.equal(interaction, null);
});
