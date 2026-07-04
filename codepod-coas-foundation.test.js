const test = require('node:test');
const assert = require('node:assert/strict');

const codePod = require('./verticals/codepod');

function createFakeRedis(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  const calls = [];

  return {
    calls,
    async get(key) {
      calls.push(['get', key]);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      calls.push(['set', key, value]);
      store.set(key, value);
      return 'OK';
    },
    async incr(key) {
      calls.push(['incr', key]);
      const next = Number(store.get(key) || 0) + 1;
      store.set(key, String(next));
      return next;
    },
    async decr(key) {
      calls.push(['decr', key]);
      const next = Number(store.get(key) || 0) - 1;
      store.set(key, String(next));
      return next;
    },
  };
}

test('codePod service normalizes DigitalSouvenir object input', () => {
  const goldXtra = { enabled: true, partner: 'ACME' };
  const result = codePod.service.normalizeCodePodDigitalSouvenir({
    general: {
      enabled: 'true',
      title: ' General clip ',
      url: ' https://cdn.example/general.png ',
      fileName: ' general.png ',
      quantity: '3.8',
    },
    silver: {
      enabled: true,
      title: ' Silver clip ',
      type: ' video ',
      contentUrl: ' https://cdn.example/silver.mp4 ',
      contentFileName: ' silver.mp4 ',
      quantity: -2,
    },
    gold: {
      enabled: false,
      quantity: 'not-a-number',
    },
    goldXtra,
  });

  assert.deepEqual(result.general, {
    enabled: true,
    title: 'General clip',
    type: 'image',
    contentUrl: 'https://cdn.example/general.png',
    contentFileName: 'general.png',
    quantity: 3,
  });
  assert.deepEqual(result.silver, {
    enabled: true,
    title: 'Silver clip',
    type: 'video',
    contentUrl: 'https://cdn.example/silver.mp4',
    contentFileName: 'silver.mp4',
    quantity: 0,
  });
  assert.deepEqual(result.gold, {
    enabled: false,
    title: '',
    type: 'image',
    contentUrl: '',
    contentFileName: '',
    quantity: 0,
  });
  assert.equal(result.goldXtra, goldXtra);
});

test('codePod service normalizes DigitalSouvenir JSON string input', () => {
  const result = codePod.service.normalizeCodePodDigitalSouvenir(JSON.stringify({
    general: {
      enabled: true,
      title: ' JSON souvenir ',
      url: ' https://cdn.example/json.png ',
      fileName: ' json.png ',
      quantity: '2',
    },
  }));

  assert.deepEqual(result.general, {
    enabled: true,
    title: 'JSON souvenir',
    type: 'image',
    contentUrl: 'https://cdn.example/json.png',
    contentFileName: 'json.png',
    quantity: 2,
  });
  assert.deepEqual(result.silver, {
    enabled: false,
    title: '',
    type: 'image',
    contentUrl: '',
    contentFileName: '',
    quantity: 0,
  });
  assert.deepEqual(result.goldXtra, {});
});

test('codePod service normalizes invalid DigitalSouvenir JSON string to defaults', () => {
  const result = codePod.service.normalizeCodePodDigitalSouvenir('{invalid-json');

  assert.deepEqual(result, {
    general: {
      enabled: false,
      title: '',
      type: 'image',
      contentUrl: '',
      contentFileName: '',
      quantity: 0,
    },
    silver: {
      enabled: false,
      title: '',
      type: 'image',
      contentUrl: '',
      contentFileName: '',
      quantity: 0,
    },
    gold: {
      enabled: false,
      title: '',
      type: 'image',
      contentUrl: '',
      contentFileName: '',
      quantity: 0,
    },
    goldXtra: {},
  });
});

test('codePod service local DigitalSouvenir assignment chooses gold before silver before general', async () => {
  const event = {};
  const digitalSouvenir = {
    gold: { quantity: 1 },
    silver: { quantity: 1 },
    general: { quantity: 0 },
  };

  const first = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-ORDER',
    'scan-gold',
    digitalSouvenir,
    event
  );
  const second = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-ORDER',
    'scan-silver',
    digitalSouvenir,
    event
  );
  const third = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-ORDER',
    'scan-general',
    digitalSouvenir,
    event
  );

  assert.equal(first.tier, 'gold');
  assert.equal(first.assignedCount, 1);
  assert.equal(first.remaining, 0);
  assert.equal(second.tier, 'silver');
  assert.equal(second.assignedCount, 1);
  assert.equal(second.remaining, 0);
  assert.equal(third.tier, 'general');
  assert.equal(third.unlimited, true);
  assert.equal(third.remaining, null);
});

test('codePod service local DigitalSouvenir assignment preserves same assignment for same scanId', async () => {
  const event = {};
  const digitalSouvenir = {
    gold: { quantity: 1 },
    silver: { quantity: 1 },
    general: { quantity: 0 },
  };

  const first = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-SAME-SCAN',
    'scan-same',
    digitalSouvenir,
    event
  );
  const second = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-SAME-SCAN',
    'scan-same',
    digitalSouvenir,
    event
  );

  assert.deepEqual(second, first);
  assert.equal(event._codepodDigitalSouvenirAssigned.gold, 1);
  assert.equal(event._codepodDigitalSouvenirAssigned.silver, 0);
  assert.equal(event._codepodDigitalSouvenirAssigned.general, 0);
});

test('codePod service local DigitalSouvenir assignment marks exhausted general', async () => {
  const event = {};
  const digitalSouvenir = {
    gold: { quantity: 0 },
    silver: { quantity: 0 },
    general: { quantity: 1 },
  };

  const first = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-EXHAUSTED',
    'scan-general-1',
    digitalSouvenir,
    event
  );
  const second = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-DS-EXHAUSTED',
    'scan-general-2',
    digitalSouvenir,
    event
  );

  assert.equal(first.tier, 'general');
  assert.equal(first.exhausted, false);
  assert.equal(first.noReward, false);
  assert.equal(second.tier, 'general');
  assert.equal(second.exhausted, true);
  assert.equal(second.noReward, true);
});

test('codePod service GoldXtra assignment returns null for inactive reward', async () => {
  const redis = createFakeRedis();
  const result = await codePod.service.assignCodePodGoldXtra(
    'CP-GX-INACTIVE',
    'scan-inactive',
    { active: false, quantity: 1 },
    {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-INACTIVE',
    }
  );

  assert.equal(result, null);
  assert.deepEqual(redis.calls, []);
});

test('codePod service GoldXtra assignment returns null without Redis, eventCode, or scanId', async () => {
  const reward = { active: true, quantity: 1 };
  const redis = createFakeRedis();

  assert.equal(await codePod.service.assignCodePodGoldXtra('CP-GX-MISSING', 'scan-1', reward), null);
  assert.equal(
    await codePod.service.assignCodePodGoldXtra('', 'scan-1', reward, {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-MISSING-EVENT',
    }),
    null
  );
  assert.equal(
    await codePod.service.assignCodePodGoldXtra('CP-GX-MISSING', '', reward, {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-MISSING-SCAN',
    }),
    null
  );
});

test('codePod service GoldXtra assignment increments counter, stores scan assignment, and returns token', async () => {
  const redis = createFakeRedis();
  const result = await codePod.service.assignCodePodGoldXtra(
    'CP-GX-ASSIGN',
    'scan-gx-assign',
    {
      active: true,
      quantity: 2,
      title: ' Gold Xtra ',
      partnerName: ' Partner ',
      product: ' Product ',
      redemptionLocation: ' Venue ',
      redemptionDeadline: '2099-01-01',
      redemptionInstructions: ' Show token ',
      partnerLogo: ' logo.png ',
      partnerLogoFileName: ' logo-file.png ',
    },
    {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-TOKEN-1',
    }
  );

  assert.equal(result.assigned, true);
  assert.equal(result.redemptionToken, 'GX-TOKEN-1');
  assert.equal(result.assignedCount, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.title, 'Gold Xtra');
  assert.equal(result.partnerName, 'Partner');
  assert.ok(redis.calls.some((call) => call[0] === 'incr' && call[1] === 'codepod:partnerReward:assigned:CP-GX-ASSIGN'));
  const storedScan = redis.calls.find((call) => call[0] === 'set' && call[1] === 'codepod:partnerReward:scan:CP-GX-ASSIGN:scan-gx-assign');
  assert.ok(storedScan);
  assert.equal(JSON.parse(storedScan[2]).redemptionToken, 'GX-TOKEN-1');
});

test('codePod service GoldXtra assignment reuses existing scan assignment', async () => {
  const redis = createFakeRedis({
    'codepod:partnerReward:assigned:CP-GX-REUSE': '2',
    'codepod:partnerReward:scan:CP-GX-REUSE:scan-reuse': JSON.stringify({
      assigned: true,
      assignedCount: 1,
      assignedAt: '2026-07-01T00:00:00.000Z',
      redemptionToken: 'GX-REUSED',
    }),
  });

  const result = await codePod.service.assignCodePodGoldXtra(
    'CP-GX-REUSE',
    'scan-reuse',
    { active: true, quantity: 5, title: 'Reusable' },
    {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => {
        throw new Error('token should not be regenerated');
      },
    }
  );

  assert.equal(result.assigned, true);
  assert.equal(result.redemptionToken, 'GX-REUSED');
  assert.equal(result.assignedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(result.assignedCount, 2);
  assert.equal(result.remaining, 3);
});

test('codePod service GoldXtra assignment decrements counter and returns null when exhausted', async () => {
  const redis = createFakeRedis({
    'codepod:partnerReward:assigned:CP-GX-EXHAUSTED': '1',
  });

  const result = await codePod.service.assignCodePodGoldXtra(
    'CP-GX-EXHAUSTED',
    'scan-exhausted',
    { active: true, quantity: 1 },
    {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-EXHAUSTED',
    }
  );

  assert.equal(result, null);
  assert.ok(redis.calls.some((call) => call[0] === 'incr' && call[1] === 'codepod:partnerReward:assigned:CP-GX-EXHAUSTED'));
  assert.ok(redis.calls.some((call) => call[0] === 'decr' && call[1] === 'codepod:partnerReward:assigned:CP-GX-EXHAUSTED'));
});

test('codePod service GoldXtra assignment backfills token for existing assigned scan', async () => {
  const redis = createFakeRedis({
    'codepod:partnerReward:assigned:CP-GX-BACKFILL': '3',
    'codepod:partnerReward:scan:CP-GX-BACKFILL:scan-backfill': JSON.stringify({
      assigned: true,
      assignedCount: 1,
      assignedAt: '2026-07-01T00:00:00.000Z',
    }),
  });

  const result = await codePod.service.assignCodePodGoldXtra(
    'CP-GX-BACKFILL',
    'scan-backfill',
    { active: true, quantity: 5 },
    {
      redis,
      redisEnabled: true,
      createGoldXtraToken: async () => 'GX-BACKFILLED',
    }
  );

  assert.equal(result.assigned, true);
  assert.equal(result.redemptionToken, 'GX-BACKFILLED');
  assert.equal(result.assignedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(result.assignedCount, 3);
  const storedScan = redis.calls.find((call) => call[0] === 'set' && call[1] === 'codepod:partnerReward:scan:CP-GX-BACKFILL:scan-backfill');
  assert.ok(storedScan);
  assert.equal(JSON.parse(storedScan[2]).redemptionToken, 'GX-BACKFILLED');
});

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
