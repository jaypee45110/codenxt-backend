const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProviderKeywordIdempotencyKey,
  claimProviderKeywordIdempotency,
  getProviderKeywordResponseKey,
  readProviderKeywordResponse,
  recordProviderKeywordResponse,
  safeParseProviderKeywordPayload,
  safeSerializeProviderKeywordPayload,
} = require('./verticals/codeclip/provider-idempotency');

function createFakeRedis() {
  const store = new Map();
  const calls = [];

  return {
    calls,
    async set(key, value, ...args) {
      calls.push({ method: 'set', key, value, args });

      if (args.includes('NX') && store.has(key)) {
        return null;
      }

      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      calls.push({ method: 'get', key });
      return store.get(key) || null;
    },
  };
}

test('codeClip provider keyword idempotency key normalizes identity fields', () => {
  const key = buildProviderKeywordIdempotencyKey({
    provider: ' SMS ',
    eventCode: ' CC-123 ',
    messageId: ' msg-1 ',
  });

  assert.equal(key, 'codeclip:provider:keyword:idempotency:sms:CC-123:msg-1');
  assert.equal(getProviderKeywordResponseKey(key), `${key}:response`);
  assert.equal(buildProviderKeywordIdempotencyKey({ eventCode: 'CC', messageId: 'msg-1' }), null);
  assert.equal(buildProviderKeywordIdempotencyKey({ provider: 'sms', messageId: 'msg-1' }), null);
  assert.equal(buildProviderKeywordIdempotencyKey({ provider: 'sms', eventCode: 'CC' }), null);
});

test('codeClip provider keyword payload serialization strips COAS internals', () => {
  const serialized = safeSerializeProviderKeywordPayload({
    success: true,
    eventCode: 'CC',
    messageId: 'msg-1',
    audienceEntry: { entryCode: 'CC' },
    audienceIntent: { type: 'keyword' },
    audienceContext: { entry: {} },
    rewardAssignmentSnapshot: { assignments: [] },
    persistenceStatus: { interaction: {} },
    persistenceDecision: { severity: 'ok' },
    persistenceGuaranteePolicy: { reason: 'persistence_ok' },
    persistenceAction: { action: 'continue' },
  });
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed, {
    success: true,
    eventCode: 'CC',
    messageId: 'msg-1',
  });
  assert.equal(safeParseProviderKeywordPayload('{not-json'), null);
});

test('codeClip provider keyword idempotency claims with Redis NX/EX and detects duplicate', async () => {
  const redis = createFakeRedis();
  const key = 'codeclip:provider:keyword:idempotency:sms:CC:msg-1';

  const first = await claimProviderKeywordIdempotency({ redis, key, ttlSeconds: 60 });
  const second = await claimProviderKeywordIdempotency({ redis, key, ttlSeconds: 60 });

  assert.deepEqual(first, { enabled: true, claimed: true });
  assert.deepEqual(second, { enabled: true, claimed: false });
  assert.deepEqual(redis.calls[0], {
    method: 'set',
    key,
    value: 'processing',
    args: ['NX', 'EX', 60],
  });
});

test('codeClip provider keyword idempotency allows fallback when Redis or key is missing', async () => {
  assert.deepEqual(
    await claimProviderKeywordIdempotency({ redis: null, key: 'key' }),
    { enabled: false, claimed: true }
  );
  assert.deepEqual(
    await claimProviderKeywordIdempotency({ redis: createFakeRedis(), key: '' }),
    { enabled: false, claimed: true }
  );
});

test('codeClip provider keyword response record/read uses response key and safe payload', async () => {
  const redis = createFakeRedis();
  const key = 'codeclip:provider:keyword:idempotency:test:CC:msg-1';
  const responseKey = getProviderKeywordResponseKey(key);

  const recorded = await recordProviderKeywordResponse({
    redis,
    key,
    payload: {
      success: true,
      eventCode: 'CC',
      messageId: 'msg-1',
      audienceIntent: { type: 'keyword' },
    },
    ttlSeconds: 120,
  });
  const payload = await readProviderKeywordResponse({ redis, key });

  assert.deepEqual(recorded, { recorded: true });
  assert.deepEqual(redis.calls[0], {
    method: 'set',
    key: responseKey,
    value: JSON.stringify({ success: true, eventCode: 'CC', messageId: 'msg-1' }),
    args: ['EX', 120],
  });
  assert.deepEqual(payload, {
    success: true,
    eventCode: 'CC',
    messageId: 'msg-1',
  });
  assert.deepEqual(
    await recordProviderKeywordResponse({ redis: null, key, payload: {} }),
    { recorded: false }
  );
  assert.equal(await readProviderKeywordResponse({ redis: null, key }), null);
});
