const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSmsKeywordProvider,
  normalizeTestProviderKeyword,
} = require('./verticals/codeclip/provider-adapters');

function assertProviderKeywordContract(result) {
  assert.ok(Object.hasOwn(result, 'ok'));
  assert.ok(Object.hasOwn(result, 'eventCode'));
  assert.ok(Object.hasOwn(result, 'keyword'));
  assert.ok(Object.hasOwn(result, 'messageId'));
  assert.ok(Object.hasOwn(result, 'warnings'));
  assert.ok(Object.hasOwn(result, 'errors'));
  assert.ok(Array.isArray(result.warnings));
  assert.ok(Array.isArray(result.errors));
}

test('codeClip test ProviderAdapter normalizes keyword provider input', () => {
  const valid = normalizeTestProviderKeyword({
    eventCode: ' CC ',
    text: ' GOLD ',
    messageId: ' msg-1 ',
    rawPayload: { text: 'GOLD' },
    handle: '@participant',
    profileId: 'profile-123',
    phone: '+4712345678',
    email: 'participant@example.com',
    userAgent: 'test-agent',
    ip: '127.0.0.1',
  });

  assertProviderKeywordContract(valid);
  assert.equal(valid.ok, true);
  assert.equal(valid.eventCode, 'CC');
  assert.equal(valid.keyword, 'GOLD');
  assert.equal(valid.messageId, 'msg-1');
  assert.deepEqual(valid.warnings, []);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.rawPayload, undefined);
  assert.equal(valid.handle, undefined);
  assert.equal(valid.profileId, undefined);
  assert.equal(valid.phone, undefined);
  assert.equal(valid.email, undefined);
  assert.equal(valid.userAgent, undefined);
  assert.equal(valid.ip, undefined);

  const missingEventCode = normalizeTestProviderKeyword({
    text: 'GOLD',
    messageId: 'msg-1',
  });
  assertProviderKeywordContract(missingEventCode);
  assert.equal(missingEventCode.ok, false);
  assert.deepEqual(
    missingEventCode.errors.map((error) => error.code),
    ['EVENT_CODE_REQUIRED']
  );

  const missingKeyword = normalizeTestProviderKeyword({
    eventCode: 'CC',
    messageId: 'msg-1',
  });
  assertProviderKeywordContract(missingKeyword);
  assert.equal(missingKeyword.ok, false);
  assert.deepEqual(
    missingKeyword.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );

  const missingMessageId = normalizeTestProviderKeyword({
    eventCode: 'CC',
    text: 'GOLD',
  });
  assertProviderKeywordContract(missingMessageId);
  assert.equal(missingMessageId.ok, false);
  assert.deepEqual(
    missingMessageId.errors.map((error) => error.code),
    ['MESSAGE_ID_REQUIRED']
  );
});

test('codeClip SMS ProviderAdapter normalizes keyword provider input', () => {
  const valid = normalizeSmsKeywordProvider({
    eventCode: ' CC ',
    Body: ' GOLD ',
    MessageSid: ' sms-1 ',
    From: '+4712345678',
    phone: '+4712345678',
    provider: 'sent',
    rawPayload: { Body: 'GOLD' },
  });

  assertProviderKeywordContract(valid);
  assert.equal(valid.ok, true);
  assert.equal(valid.eventCode, 'CC');
  assert.equal(valid.keyword, 'GOLD');
  assert.equal(valid.messageId, 'sms-1');
  assert.deepEqual(valid.warnings, []);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.From, undefined);
  assert.equal(valid.phone, undefined);
  assert.equal(valid.provider, undefined);
  assert.equal(valid.rawPayload, undefined);

  const bodyFallback = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    body: 'SILVER',
    messageId: 'sms-2',
  });
  assertProviderKeywordContract(bodyFallback);
  assert.equal(bodyFallback.ok, true);
  assert.equal(bodyFallback.keyword, 'SILVER');
  assert.equal(bodyFallback.messageId, 'sms-2');

  const textFallback = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    text: 'BRONZE',
    messageId: 'sms-3',
  });
  assertProviderKeywordContract(textFallback);
  assert.equal(textFallback.ok, true);
  assert.equal(textFallback.keyword, 'BRONZE');
  assert.equal(textFallback.messageId, 'sms-3');

  const missingEventCode = normalizeSmsKeywordProvider({
    Body: 'GOLD',
    MessageSid: 'sms-1',
  });
  assertProviderKeywordContract(missingEventCode);
  assert.equal(missingEventCode.ok, false);
  assert.deepEqual(
    missingEventCode.errors.map((error) => error.code),
    ['EVENT_CODE_REQUIRED']
  );

  const missingKeyword = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    MessageSid: 'sms-1',
  });
  assertProviderKeywordContract(missingKeyword);
  assert.equal(missingKeyword.ok, false);
  assert.deepEqual(
    missingKeyword.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );

  const missingMessageId = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    Body: 'GOLD',
  });
  assertProviderKeywordContract(missingMessageId);
  assert.equal(missingMessageId.ok, false);
  assert.deepEqual(
    missingMessageId.errors.map((error) => error.code),
    ['MESSAGE_ID_REQUIRED']
  );
});
