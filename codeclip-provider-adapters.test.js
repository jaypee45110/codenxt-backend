const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSmsKeywordProvider,
  normalizeTestProviderKeyword,
} = require('./verticals/codeclip/provider-adapters');

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
  assert.equal(missingEventCode.ok, false);
  assert.deepEqual(
    missingEventCode.errors.map((error) => error.code),
    ['EVENT_CODE_REQUIRED']
  );

  const missingKeyword = normalizeTestProviderKeyword({
    eventCode: 'CC',
    messageId: 'msg-1',
  });
  assert.equal(missingKeyword.ok, false);
  assert.deepEqual(
    missingKeyword.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );

  const missingMessageId = normalizeTestProviderKeyword({
    eventCode: 'CC',
    text: 'GOLD',
  });
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
  assert.equal(bodyFallback.ok, true);
  assert.equal(bodyFallback.keyword, 'SILVER');
  assert.equal(bodyFallback.messageId, 'sms-2');

  const textFallback = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    text: 'BRONZE',
    messageId: 'sms-3',
  });
  assert.equal(textFallback.ok, true);
  assert.equal(textFallback.keyword, 'BRONZE');
  assert.equal(textFallback.messageId, 'sms-3');

  const missingEventCode = normalizeSmsKeywordProvider({
    Body: 'GOLD',
    MessageSid: 'sms-1',
  });
  assert.equal(missingEventCode.ok, false);
  assert.deepEqual(
    missingEventCode.errors.map((error) => error.code),
    ['EVENT_CODE_REQUIRED']
  );

  const missingKeyword = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    MessageSid: 'sms-1',
  });
  assert.equal(missingKeyword.ok, false);
  assert.deepEqual(
    missingKeyword.errors.map((error) => error.code),
    ['KEYWORD_REQUIRED']
  );

  const missingMessageId = normalizeSmsKeywordProvider({
    eventCode: 'CC',
    Body: 'GOLD',
  });
  assert.equal(missingMessageId.ok, false);
  assert.deepEqual(
    missingMessageId.errors.map((error) => error.code),
    ['MESSAGE_ID_REQUIRED']
  );
});
