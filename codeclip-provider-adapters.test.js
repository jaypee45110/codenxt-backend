const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProviderKeywordIngress,
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

test('codeClip provider keyword ingress selects registered ProviderAdapter', () => {
  const testProvider = normalizeProviderKeywordIngress(' test ', {
    eventCode: ' CC ',
    text: ' GOLD ',
    messageId: ' test-message-1 ',
    rawPayload: { text: 'GOLD' },
    handle: '@participant',
    profileId: 'profile-123',
    phone: '+4712345678',
    email: 'participant@example.com',
    userAgent: 'test-agent',
    ip: '127.0.0.1',
  });

  assertProviderKeywordContract(testProvider);
  assert.equal(testProvider.ok, true);
  assert.equal(testProvider.eventCode, 'CC');
  assert.equal(testProvider.keyword, 'GOLD');
  assert.equal(testProvider.messageId, 'test-message-1');
  assert.deepEqual(testProvider.warnings, []);
  assert.deepEqual(testProvider.errors, []);
  assert.equal(testProvider.rawPayload, undefined);
  assert.equal(testProvider.handle, undefined);
  assert.equal(testProvider.profileId, undefined);
  assert.equal(testProvider.phone, undefined);
  assert.equal(testProvider.email, undefined);
  assert.equal(testProvider.userAgent, undefined);
  assert.equal(testProvider.ip, undefined);

  const smsProvider = normalizeProviderKeywordIngress(' SMS ', {
    eventCode: ' CC ',
    Body: ' SILVER ',
    MessageSid: ' sms-message-1 ',
    From: '+4712345678',
    provider: 'sent',
    rawPayload: { Body: 'SILVER' },
  });

  assertProviderKeywordContract(smsProvider);
  assert.equal(smsProvider.ok, true);
  assert.equal(smsProvider.eventCode, 'CC');
  assert.equal(smsProvider.keyword, 'SILVER');
  assert.equal(smsProvider.messageId, 'sms-message-1');
  assert.equal(smsProvider.From, undefined);
  assert.equal(smsProvider.provider, undefined);
  assert.equal(smsProvider.rawPayload, undefined);

  const missingProvider = normalizeProviderKeywordIngress('', {
    eventCode: 'CC',
    text: 'GOLD',
    messageId: 'msg-1',
  });
  assertProviderKeywordContract(missingProvider);
  assert.equal(missingProvider.ok, false);
  assert.deepEqual(
    missingProvider.errors.map((error) => error.code),
    ['PROVIDER_REQUIRED']
  );

  const unknownProvider = normalizeProviderKeywordIngress('unknown', {
    eventCode: 'CC',
    text: 'GOLD',
    messageId: 'msg-1',
    rawPayload: { text: 'GOLD' },
    phone: '+4712345678',
  });
  assertProviderKeywordContract(unknownProvider);
  assert.equal(unknownProvider.ok, false);
  assert.deepEqual(
    unknownProvider.errors.map((error) => error.code),
    ['PROVIDER_ADAPTER_NOT_FOUND']
  );
  assert.equal(unknownProvider.rawPayload, undefined);
  assert.equal(unknownProvider.phone, undefined);
});
