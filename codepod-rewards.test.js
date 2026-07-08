const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePod = require('./verticals/codepod');

const codePodServiceSource = fs.readFileSync(
  path.join(__dirname, 'verticals', 'codepod', 'service.js'),
  'utf8'
);

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

test('codePod reward source of truth stays native and isolated', async () => {
  const event = {};
  const digitalSouvenir = codePod.service.normalizeCodePodDigitalSouvenir({
    general: {
      enabled: true,
      title: 'Native Digital Souvenir',
      type: 'url',
      contentUrl: 'https://codepod.example/digital-souvenir',
      quantity: 0,
    },
    openClip: {
      enabled: true,
      title: 'codeClip reward must be ignored',
    },
    clipPlus: {
      enabled: true,
      title: 'codeClip Clip+ must be ignored',
    },
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.deepEqual(Object.keys(digitalSouvenir).sort(), ['general', 'gold', 'goldXtra', 'silver']);
  assert.equal(Object.hasOwn(digitalSouvenir, 'openClip'), false);
  assert.equal(Object.hasOwn(digitalSouvenir, 'clipPlus'), false);
  assert.equal(Object.hasOwn(digitalSouvenir, 'clipXtra'), false);
  assert.equal(Object.hasOwn(digitalSouvenir, 'screenVideoUrl'), false);

  const assignment = await codePod.service.assignCodePodDigitalSouvenirTier(
    'CP-SOURCE-GUARDRAIL',
    'scan-native-source',
    digitalSouvenir,
    event
  );

  assert.equal(assignment.tier, 'general');
  assert.equal(assignment.unlimited, true);
  assert.equal(event._codepodDigitalSouvenirAssigned.general, 1);

  const partnerReward = codePod.service.normalizeCodePodPartnerReward({
    active: true,
    quantity: 1,
    title: 'Native GoldXtra',
    openClip: { title: 'codeClip reward must be ignored' },
    clipXtra: { title: 'codeClip ClipXtra must be ignored' },
    screenVideoUrl: 'https://screen-video.example/legacy.mp4',
  });

  assert.equal(partnerReward.rewardType, 'partner_reward');
  assert.equal(partnerReward.tier, 'gold');
  assert.equal(partnerReward.displayTier, 'GoldXtra');
  assert.equal(Object.hasOwn(partnerReward, 'openClip'), false);
  assert.equal(Object.hasOwn(partnerReward, 'clipXtra'), false);
  assert.equal(Object.hasOwn(partnerReward, 'screenVideoUrl'), false);

  assert.match(codePodServiceSource, /normalizeCodePodDigitalSouvenir/);
  assert.match(codePodServiceSource, /assignCodePodGoldXtra/);
  assert.equal(codePodServiceSource.includes('normalizeCodeClipRewards'), false);
  assert.equal(codePodServiceSource.includes('openClip'), false);
  assert.equal(codePodServiceSource.includes('clipPlus'), false);
  assert.equal(codePodServiceSource.includes('clipXtra'), false);
  assert.equal(codePodServiceSource.includes('screenVideoUrl'), false);
  assert.equal(codePodServiceSource.includes('generate-screen-video'), false);
  assert.equal(codePodServiceSource.includes('runScreenVideoGenerator'), false);
});
