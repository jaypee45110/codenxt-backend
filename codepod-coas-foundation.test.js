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

test('codePod COAS foundation normalizes keyword AudienceEntry', () => {
  const result = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: ' CP-KEYWORD ',
    eventId: ' event-codepod-keyword ',
    keyword: ' LISTEN ',
    messageId: ' message-codepod-keyword ',
    provider: ' test ',
    providerAccountId: ' account-codepod-keyword ',
    requestedVertical: ' codepod ',
    receivedAt: '2026-07-01T00:02:00.000Z',
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
    vertical: 'codepod',
    entryCode: 'CP-KEYWORD',
    eventCode: 'CP-KEYWORD',
    eventId: 'event-codepod-keyword',
    keyword: 'LISTEN',
    messageId: 'message-codepod-keyword',
    provider: 'test',
    providerAccountId: 'account-codepod-keyword',
    requestedVertical: 'codepod',
    source: 'keyword',
    transport: 'message',
    receivedAt: '2026-07-01T00:02:00.000Z',
    metadata: {
      vertical: 'codepod',
    },
  });
  assert.deepEqual(result.audienceIntent, {
    vertical: 'codepod',
    intentType: 'keyword',
    entryCode: 'CP-KEYWORD',
    eventCode: 'CP-KEYWORD',
    keyword: 'LISTEN',
    messageId: 'message-codepod-keyword',
    provider: 'test',
    providerAccountId: 'account-codepod-keyword',
    source: 'keyword',
    transport: 'message',
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

test('codePod COAS foundation rejects missing keyword entry code', () => {
  const result = codePod.service.normalizeCodePodKeywordAudienceEntry({
    keyword: 'LISTEN',
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

test('codePod COAS foundation rejects missing keyword', () => {
  const result = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: 'CP-MISSING-KEYWORD',
  });

  assert.equal(result.ok, false);
  assert.equal(result.audienceEntry, null);
  assert.equal(result.audienceIntent, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );
});

test('codePod keyword AudienceEntry foundation stays native and isolated', () => {
  const result = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: 'CP-KEYWORD-ISOLATION',
    keyword: 'LISTEN',
    openClip: 'must be ignored',
    clipPlus: 'must be ignored',
    clipXtra: 'must be ignored',
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.equal(result.ok, true);
  assert.equal(result.audienceEntry.vertical, 'codepod');
  assert.equal(result.audienceEntry.source, 'keyword');
  assert.equal(result.audienceEntry.transport, 'message');
  assert.equal(result.audienceIntent.vertical, 'codepod');
  assert.equal(result.audienceIntent.source, 'keyword');
  assert.equal(result.audienceIntent.transport, 'message');

  const serializedOutput = JSON.stringify({
    audienceEntry: result.audienceEntry,
    audienceIntent: result.audienceIntent,
  });
  const keywordFoundationSource = codePod.service.normalizeCodePodKeywordAudienceEntry.toString();
  for (const forbidden of ['OpenClip', 'Clip+', 'ClipXtra', 'openClip', 'clipPlus', 'clipXtra', 'Screen Video', 'screenVideoUrl']) {
    assert.equal(serializedOutput.includes(forbidden), false);
    assert.equal(keywordFoundationSource.includes(forbidden), false);
  }
});

test('codePod COAS foundation builds observational keyword Interaction snapshot', () => {
  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: ' CP-KEYWORD-INTERACTION ',
    eventId: ' event-codepod-keyword-interaction ',
    keyword: ' LISTEN ',
    messageId: ' message-codepod-keyword-interaction ',
    provider: ' test ',
    providerAccountId: ' account-codepod-keyword-interaction ',
    requestedVertical: ' codepod ',
    receivedAt: '2026-07-01T00:02:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  const interaction = codePod.service.createCodePodKeywordInteractionSnapshot({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    timestamp: '2026-07-01T00:03:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  assert.deepEqual(interaction, {
    interactionId: null,
    vertical: 'codepod',
    interactionType: 'keyword',
    eventCode: 'CP-KEYWORD-INTERACTION',
    eventId: 'event-codepod-keyword-interaction',
    entryCode: 'CP-KEYWORD-INTERACTION',
    keyword: 'LISTEN',
    messageId: 'message-codepod-keyword-interaction',
    provider: 'test',
    providerAccountId: 'account-codepod-keyword-interaction',
    source: 'keyword',
    transport: 'message',
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    state: 'observed',
    stateTransitions: [],
    timestamp: '2026-07-01T00:03:00.000Z',
    routingOutcome: 'MATCH',
  });
  assert.equal(interaction.ip, undefined);
  assert.equal(interaction.userAgent, undefined);
  assert.equal(interaction.rawPayload, undefined);
  assert.equal(interaction.phone, undefined);
  assert.equal(interaction.handle, undefined);
});

test('codePod COAS foundation does not build keyword Interaction snapshot without eventCode or keyword', () => {
  const missingEventCode = codePod.service.createCodePodKeywordInteractionSnapshot({
    keyword: 'LISTEN',
  });
  const missingKeyword = codePod.service.createCodePodKeywordInteractionSnapshot({
    eventCode: 'CP-MISSING-KEYWORD-INTERACTION',
  });

  assert.equal(missingEventCode, null);
  assert.equal(missingKeyword, null);
});

test('codePod keyword Interaction foundation stays native and isolated', () => {
  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: 'CP-KEYWORD-INTERACTION-ISOLATION',
    keyword: 'LISTEN',
  });
  const interaction = codePod.service.createCodePodKeywordInteractionSnapshot({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    openClip: 'must be ignored',
    clipPlus: 'must be ignored',
    clipXtra: 'must be ignored',
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.equal(interaction.vertical, 'codepod');
  assert.equal(interaction.source, 'keyword');
  assert.equal(interaction.transport, 'message');
  assert.equal(interaction.keyword, 'LISTEN');

  const serializedOutput = JSON.stringify(interaction);
  const keywordInteractionSource = codePod.service.createCodePodKeywordInteractionSnapshot.toString();
  for (const forbidden of ['OpenClip', 'Clip+', 'ClipXtra', 'openClip', 'clipPlus', 'clipXtra', 'Screen Video', 'screenVideoUrl']) {
    assert.equal(serializedOutput.includes(forbidden), false);
    assert.equal(keywordInteractionSource.includes(forbidden), false);
  }
});

test('codePod COAS foundation builds keyword RoutingOutcome', () => {
  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: ' CP-KEYWORD-ROUTING ',
    eventId: ' event-codepod-keyword-routing ',
    keyword: ' LISTEN ',
    messageId: ' message-codepod-keyword-routing ',
    provider: ' test ',
    providerAccountId: ' account-codepod-keyword-routing ',
    requestedVertical: ' codepod ',
  });
  const interaction = codePod.service.createCodePodKeywordInteractionSnapshot({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    timestamp: '2026-07-01T00:04:00.000Z',
  });

  const outcome = codePod.service.createCodePodKeywordRoutingOutcome({ interaction });

  assert.deepEqual(outcome, {
    vertical: 'codepod',
    source: 'keyword',
    transport: 'message',
    routingOutcome: 'MATCH',
    interactionType: 'keyword',
    eventCode: 'CP-KEYWORD-ROUTING',
    entryCode: 'CP-KEYWORD-ROUTING',
    keyword: 'LISTEN',
    eventId: 'event-codepod-keyword-routing',
    messageId: 'message-codepod-keyword-routing',
    provider: 'test',
    providerAccountId: 'account-codepod-keyword-routing',
  });
});

test('codePod COAS foundation does not build keyword RoutingOutcome without eventCode or keyword', () => {
  const missingEventCode = codePod.service.createCodePodKeywordRoutingOutcome({
    keyword: 'LISTEN',
  });
  const missingKeyword = codePod.service.createCodePodKeywordRoutingOutcome({
    eventCode: 'CP-MISSING-ROUTING-KEYWORD',
  });

  assert.equal(missingEventCode, null);
  assert.equal(missingKeyword, null);
});

test('codePod keyword RoutingOutcome foundation stays native and isolated', () => {
  const outcome = codePod.service.createCodePodKeywordRoutingOutcome({
    eventCode: 'CP-KEYWORD-ROUTING-ISOLATION',
    keyword: 'LISTEN',
    openClip: 'must be ignored',
    clipPlus: 'must be ignored',
    clipXtra: 'must be ignored',
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.equal(outcome.vertical, 'codepod');
  assert.equal(outcome.source, 'keyword');
  assert.equal(outcome.transport, 'message');
  assert.equal(outcome.routingOutcome, 'MATCH');
  assert.equal(outcome.interactionType, 'keyword');
  assert.equal(outcome.keyword, 'LISTEN');

  const serializedOutput = JSON.stringify(outcome);
  const keywordRoutingSource = codePod.service.createCodePodKeywordRoutingOutcome.toString();
  for (const forbidden of ['OpenClip', 'Clip+', 'ClipXtra', 'openClip', 'clipPlus', 'clipXtra', 'Screen Video', 'screenVideoUrl']) {
    assert.equal(serializedOutput.includes(forbidden), false);
    assert.equal(keywordRoutingSource.includes(forbidden), false);
  }
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

test('codePod COAS foundation builds scan RoutingOutcome', () => {
  const normalized = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: ' CP-SCAN-ROUTING ',
    eventId: ' event-codepod-scan-routing ',
    scanId: ' scan-codepod-routing ',
    requestedVertical: ' codepod ',
  });
  const interaction = codePod.service.createCodePodInteractionSnapshot({
    eventCode: ' CP-SCAN-ROUTING ',
    eventId: ' event-codepod-scan-routing ',
    scanId: ' scan-codepod-routing ',
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    timestamp: '2026-07-01T00:05:00.000Z',
  });

  const outcome = codePod.service.createCodePodScanRoutingOutcome({ interaction });

  assert.deepEqual(outcome, {
    vertical: 'codepod',
    source: 'scan',
    transport: 'http',
    routingOutcome: 'MATCH',
    interactionType: 'scan',
    eventCode: 'CP-SCAN-ROUTING',
    entryCode: 'CP-SCAN-ROUTING',
    eventId: 'event-codepod-scan-routing',
    scanId: 'scan-codepod-routing',
  });
});

test('codePod COAS foundation does not build scan RoutingOutcome without eventCode', () => {
  const outcome = codePod.service.createCodePodScanRoutingOutcome({
    scanId: 'scan-missing-event-code',
  });

  assert.equal(outcome, null);
});

test('codePod scan RoutingOutcome foundation stays native and isolated', () => {
  const outcome = codePod.service.createCodePodScanRoutingOutcome({
    eventCode: 'CP-SCAN-ROUTING-ISOLATION',
    scanId: 'scan-routing-isolation',
    openClip: 'must be ignored',
    clipPlus: 'must be ignored',
    clipXtra: 'must be ignored',
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.equal(outcome.vertical, 'codepod');
  assert.equal(outcome.source, 'scan');
  assert.equal(outcome.transport, 'http');
  assert.equal(outcome.routingOutcome, 'MATCH');
  assert.equal(outcome.interactionType, 'scan');
  assert.equal(outcome.scanId, 'scan-routing-isolation');

  const serializedOutput = JSON.stringify(outcome);
  const scanRoutingSource = codePod.service.createCodePodScanRoutingOutcome.toString();
  for (const forbidden of ['OpenClip', 'Clip+', 'ClipXtra', 'openClip', 'clipPlus', 'clipXtra', 'Screen Video', 'screenVideoUrl']) {
    assert.equal(serializedOutput.includes(forbidden), false);
    assert.equal(scanRoutingSource.includes(forbidden), false);
  }
});

test('codePod COAS foundation does not build Interaction snapshot without eventCode', () => {
  const interaction = codePod.service.createCodePodInteractionSnapshot({
    scanId: 'scan-missing-event-code',
  });

  assert.equal(interaction, null);
});

test('codePod COAS foundation builds observational AudienceContext snapshot', () => {
  const normalized = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: ' CP-CONTEXT ',
    eventId: ' event-codepod-context ',
    scanId: ' scan-codepod-context ',
    requestedVertical: ' codepod ',
    receivedAt: '2026-07-01T00:00:00.000Z',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  const context = codePod.service.createCodePodAudienceContextSnapshot({
    eventCode: ' CP-CONTEXT ',
    eventId: ' event-codepod-context ',
    scanId: ' scan-codepod-context ',
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    rawPayload: { ignored: true },
    phone: '+4712345678',
    handle: '@participant',
  });

  assert.deepEqual(context, {
    vertical: 'codepod',
    contextType: 'audience',
    eventCode: 'CP-CONTEXT',
    eventId: 'event-codepod-context',
    scanId: 'scan-codepod-context',
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    source: 'scan',
    transport: 'http',
    metadata: {
      vertical: 'codepod',
    },
  });
  assert.equal(context.ip, undefined);
  assert.equal(context.userAgent, undefined);
  assert.equal(context.rawPayload, undefined);
  assert.equal(context.phone, undefined);
  assert.equal(context.handle, undefined);
});

test('codePod COAS foundation does not build AudienceContext snapshot without eventCode', () => {
  const context = codePod.service.createCodePodAudienceContextSnapshot({
    scanId: 'scan-missing-event-code',
  });

  assert.equal(context, null);
});

test('codePod COAS foundation builds shared runtime chain for scan', () => {
  const normalized = codePod.service.normalizeCodePodScanAudienceEntry({
    eventCode: ' CP-SCAN-CHAIN ',
    eventId: ' event-codepod-scan-chain ',
    scanId: ' scan-codepod-chain ',
    requestedVertical: ' codepod ',
  });

  const chain = codePod.service.buildCodePodRuntimeChain({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    rawScans: 12,
    uniqueScans: 9,
    scanRank: 4,
    tier: ' silver ',
    timestamp: '2026-07-01T00:06:00.000Z',
  });

  assert.equal(chain.audienceEntry, normalized.audienceEntry);
  assert.equal(chain.audienceIntent, normalized.audienceIntent);
  assert.equal(chain.interaction.vertical, 'codepod');
  assert.equal(chain.interaction.interactionType, 'scan');
  assert.equal(chain.interaction.eventCode, 'CP-SCAN-CHAIN');
  assert.equal(chain.interaction.scanId, 'scan-codepod-chain');
  assert.equal(chain.routingOutcome.vertical, 'codepod');
  assert.equal(chain.routingOutcome.source, 'scan');
  assert.equal(chain.routingOutcome.transport, 'http');
  assert.equal(chain.routingOutcome.routingOutcome, 'MATCH');
  assert.equal(chain.audienceContext.vertical, 'codepod');
  assert.equal(chain.audienceContext.source, 'scan');
  assert.equal(chain.audienceContext.transport, 'http');
});

test('codePod COAS foundation builds shared runtime chain for keyword', () => {
  const normalized = codePod.service.normalizeCodePodKeywordAudienceEntry({
    eventCode: ' CP-KEYWORD-CHAIN ',
    eventId: ' event-codepod-keyword-chain ',
    keyword: ' LISTEN ',
    messageId: ' message-codepod-keyword-chain ',
    provider: ' test ',
    providerAccountId: ' account-codepod-keyword-chain ',
    requestedVertical: ' codepod ',
    rawPayload: { ignored: true },
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    phone: '+4712345678',
    handle: '@participant',
  });

  const chain = codePod.service.buildCodePodRuntimeChain({
    audienceEntry: normalized.audienceEntry,
    audienceIntent: normalized.audienceIntent,
    timestamp: '2026-07-01T00:07:00.000Z',
    rawPayload: { ignored: true },
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    phone: '+4712345678',
    handle: '@participant',
  });

  assert.equal(chain.audienceEntry, normalized.audienceEntry);
  assert.equal(chain.audienceIntent, normalized.audienceIntent);
  assert.equal(chain.interaction.vertical, 'codepod');
  assert.equal(chain.interaction.interactionType, 'keyword');
  assert.equal(chain.interaction.eventCode, 'CP-KEYWORD-CHAIN');
  assert.equal(chain.interaction.keyword, 'LISTEN');
  assert.equal(chain.routingOutcome.vertical, 'codepod');
  assert.equal(chain.routingOutcome.source, 'keyword');
  assert.equal(chain.routingOutcome.transport, 'message');
  assert.equal(chain.routingOutcome.routingOutcome, 'MATCH');
  assert.equal(chain.audienceContext.vertical, 'codepod');
  assert.equal(chain.audienceContext.source, 'keyword');
  assert.equal(chain.audienceContext.transport, 'message');
  assert.equal(chain.audienceContext.keyword, 'LISTEN');

  const serializedOutput = JSON.stringify(chain);
  for (const forbidden of ['rawPayload', '127.0.0.1', 'test-agent', '+4712345678', '@participant', 'OpenClip', 'Clip+', 'ClipXtra', 'openClip', 'clipPlus', 'clipXtra', 'Screen Video', 'screenVideoUrl']) {
    assert.equal(serializedOutput.includes(forbidden), false);
  }
});
