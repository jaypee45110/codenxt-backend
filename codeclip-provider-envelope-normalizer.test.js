const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCodeClipProviderEnvelope,
} = require("./verticals/codeclip/provider-envelope-normalizer");

const RECEIVED_AT = "2026-07-07T00:00:00.000Z";

test("codeClip provider envelope normalizer requires provider", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      body: { providerEventId: "event-1", text: "CLIP" },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );
});

test("codeClip provider envelope normalizer rejects unsupported provider", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "custom",
      body: { providerEventId: "event-1", text: "CLIP" },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "UNSUPPORTED_PROVIDER" }
  );
});

test("codeClip provider envelope normalizer normalizes test provider payload", () => {
  const rawBody = {
    providerEventId: " event-1 ",
    text: " CLIP ",
    providerAccountId: " account-1 ",
    senderId: " sender-1 ",
    recipientId: " recipient-1 ",
    channel: " test-channel ",
  };
  const rawHeaders = { "x-test": "1" };
  const rawQuery = { debug: "1" };
  const metadata = { source: "unit" };

  const result = normalizeCodeClipProviderEnvelope({
    provider: " Test ",
    body: rawBody,
    headers: rawHeaders,
    query: rawQuery,
    metadata,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "test");
  assert.equal(result.envelope.provider, "test");
  assert.equal(result.envelope.rawProvider, " Test ");
  assert.equal(result.envelope.rawBody, rawBody);
  assert.equal(result.envelope.rawHeaders, rawHeaders);
  assert.equal(result.envelope.rawQuery, rawQuery);
  assert.equal(result.envelope.receivedAt, RECEIVED_AT);
  assert.equal(result.envelope.messageId, "event-1");
  assert.equal(result.envelope.text, "CLIP");
  assert.equal(result.envelope.providerAccountId, "account-1");
  assert.equal(result.envelope.senderId, "sender-1");
  assert.equal(result.envelope.recipientId, "recipient-1");
  assert.equal(result.envelope.channel, "test-channel");
  assert.equal(result.envelope.metadata, metadata);
});

test("codeClip provider envelope normalizer uses test provider account fallback", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "test",
    body: {
      messageId: "event-2",
      keyword: "OPEN",
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.providerAccountId, "test");
  assert.equal(result.envelope.text, "OPEN");
});

test("codeClip provider envelope normalizer normalizes SMS Twilio-like payload", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "sms",
    body: {
      MessageSid: " SM123 ",
      Body: " CLIP ",
      To: " +15550000001 ",
      From: " +15550000002 ",
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.messageId, "SM123");
  assert.equal(result.envelope.text, "CLIP");
  assert.equal(result.envelope.providerAccountId, "+15550000001");
  assert.equal(result.envelope.recipientId, "+15550000001");
  assert.equal(result.envelope.senderId, "+15550000002");
  assert.equal(result.envelope.channel, "sms");
});

test("codeClip provider envelope normalizer normalizes lowercase SMS payload", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "sms",
    body: {
      messageSid: " sm-lower ",
      body: " WOW ",
      messagingServiceSid: " service-1 ",
      from: " sender-1 ",
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.messageId, "sm-lower");
  assert.equal(result.envelope.text, "WOW");
  assert.equal(result.envelope.providerAccountId, "service-1");
  assert.equal(result.envelope.senderId, "sender-1");
});

test("codeClip provider envelope normalizer normalizes Meta Messenger-like payload", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      entry: [
        {
          id: " page-1 ",
          messaging: [
            {
              sender: { id: " user-1 " },
              recipient: { id: " page-recipient-1 " },
              message: {
                mid: " mid-1 ",
                text: " CLIP ",
              },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.messageId, "mid-1");
  assert.equal(result.envelope.text, "CLIP");
  assert.equal(result.envelope.providerAccountId, "page-1");
  assert.equal(result.envelope.recipientId, "page-1");
  assert.equal(result.envelope.senderId, "user-1");
  assert.equal(result.envelope.channel, "meta");
});

test("codeClip provider envelope normalizer normalizes Meta WhatsApp-like changes payload", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: " waba-1 ",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  phone_number_id: " phone-number-1 ",
                },
                messages: [
                  {
                    id: " wa-message-1 ",
                    from: " wa-sender-1 ",
                    text: { body: " VIP " },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.messageId, "wa-message-1");
  assert.equal(result.envelope.text, "VIP");
  assert.equal(result.envelope.providerAccountId, "phone-number-1");
  assert.notEqual(result.envelope.providerAccountId, "waba-1");
  assert.equal(result.envelope.senderId, "wa-sender-1");
  assert.equal(result.envelope.channel, "meta");
});

test("codeClip provider envelope normalizer fails closed for WhatsApp without phone number id", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  messages: [
                    {
                      id: "wa-message-1",
                      from: "wa-sender-1",
                      text: { body: "VIP" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "PROVIDER_ACCOUNT_ID_REQUIRED" }
  );
});

test("codeClip provider envelope normalizer requires message id", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "sms",
      body: { Body: "CLIP" },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "MESSAGE_ID_REQUIRED" }
  );
});

test("codeClip provider envelope normalizer requires text", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: { messageId: "message-1" },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "TEXT_REQUIRED" }
  );
});

test("codeClip provider envelope normalizer preserves text casing after trimming", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "test",
    body: {
      providerEventId: "event-3",
      text: " MixedCase ",
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.text, "MixedCase");
});
