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
              recipient: { id: " page-1 " },
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
  assert.equal(result.envelope.channel, "messenger");
});

test("codeClip provider envelope normalizer fails closed on Messenger account id conflict", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "page",
        entry: [
          {
            id: "page-A",
            messaging: [
              {
                sender: { id: "user-1" },
                recipient: { id: "page-B" },
                message: { mid: "mid-conflict", text: "hello" },
              },
            ],
          },
        ],
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "PROVIDER_ACCOUNT_ID_CONFLICT" }
  );
});

test("codeClip provider envelope normalizer accepts Messenger with only entry id", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "page",
      entry: [
        {
          id: "page-only-entry",
          messaging: [
            {
              sender: { id: "user-1" },
              message: { mid: "mid-entry-only", text: "hello" },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.providerAccountId, "page-only-entry");
  assert.equal(result.envelope.channel, "messenger");
});

test("codeClip provider envelope normalizer accepts Messenger with only messaging recipient id", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "user-1" },
              recipient: { id: "page-only-recipient" },
              message: { mid: "mid-recip-only", text: "hello" },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.providerAccountId, "page-only-recipient");
  assert.equal(result.envelope.channel, "messenger");
});

test("codeClip provider envelope normalizer normalizes Meta Instagram Messaging payload", () => {
  const {
    resolveMetaProviderChannel,
  } = require("./verticals/codeclip/provider-envelope-normalizer");

  const body = {
    object: "instagram",
    entry: [
      {
        id: " ig-business-1 ",
        messaging: [
          {
            sender: { id: " ig-user-1 " },
            recipient: { id: " ig-business-1 " },
            message: {
              mid: " ig-mid-1 ",
              text: " CLIP ",
            },
          },
        ],
      },
    ],
  };

  assert.deepEqual(resolveMetaProviderChannel(body), {
    ok: true,
    channel: "instagram",
  });

  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.channel, "instagram");
  assert.equal(result.envelope.messageId, "ig-mid-1");
  assert.equal(result.envelope.text, "CLIP");
  assert.equal(result.envelope.providerAccountId, "ig-business-1");
  assert.equal(result.envelope.recipientId, "ig-business-1");
  assert.equal(result.envelope.senderId, "ig-user-1");
});

test("codeClip provider envelope normalizer fails closed on Instagram account id conflict", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "instagram",
        entry: [
          {
            id: "ig-A",
            messaging: [
              {
                sender: { id: "ig-user-1" },
                recipient: { id: "ig-B" },
                message: { mid: "ig-mid-conflict", text: "hello" },
              },
            ],
          },
        ],
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "PROVIDER_ACCOUNT_ID_CONFLICT" }
  );
});

test("codeClip provider envelope normalizer accepts Instagram with only entry id", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "instagram",
      entry: [
        {
          id: "ig-only-entry",
          messaging: [
            {
              sender: { id: "ig-user-1" },
              message: { mid: "ig-mid-entry-only", text: "hello" },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.providerAccountId, "ig-only-entry");
  assert.equal(result.envelope.channel, "instagram");
});

test("codeClip provider envelope normalizer accepts Instagram with only messaging recipient id", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "ig-user-1" },
              recipient: { id: "ig-only-recipient" },
              message: { mid: "ig-mid-recip-only", text: "hello" },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.providerAccountId, "ig-only-recipient");
  assert.equal(result.envelope.channel, "instagram");
});

test("codeClip provider envelope normalizer fails closed for unknown Meta object", () => {
  const {
    resolveMetaProviderChannel,
  } = require("./verticals/codeclip/provider-envelope-normalizer");

  const body = {
    object: "something_else",
    entry: [
      {
        id: "x-1",
        messaging: [
          {
            sender: { id: "s-1" },
            recipient: { id: "x-1" },
            message: { mid: "m-1", text: "hello" },
          },
        ],
      },
    ],
  };

  assert.deepEqual(resolveMetaProviderChannel(body), {
    ok: false,
    reason: "UNSUPPORTED_META_OBJECT",
  });
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body,
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "UNSUPPORTED_META_OBJECT" }
  );
});

test("codeClip provider envelope normalizer fails closed for unknown Meta object without messaging", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "user",
        entry: [{ id: "x-1" }],
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "UNSUPPORTED_META_OBJECT" }
  );
});

test("codeClip provider envelope normalizer fails closed for ambiguous Meta body without object or messaging shape", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        messageId: "message-1",
        text: "hello",
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "UNSUPPORTED_META_OBJECT" }
  );
});

test("codeClip provider envelope normalizer fails closed for Instagram without account id", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "instagram",
        entry: [
          {
            messaging: [
              {
                sender: { id: "ig-user-1" },
                message: { mid: "ig-mid-2", text: "hello" },
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

test("codeClip provider envelope normalizer fails closed for Instagram without text", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "instagram",
        entry: [
          {
            id: "ig-business-1",
            messaging: [
              {
                sender: { id: "ig-user-1" },
                recipient: { id: "ig-business-1" },
                message: { mid: "ig-mid-3" },
              },
            ],
          },
        ],
      },
      receivedAt: RECEIVED_AT,
    }),
    { ok: false, reason: "TEXT_REQUIRED" }
  );
});

test("codeClip provider envelope normalizer normalizes Meta page object as messenger channel", () => {
  const result = normalizeCodeClipProviderEnvelope({
    provider: "meta",
    body: {
      object: "page",
      entry: [
        {
          id: "page-2",
          messaging: [
            {
              sender: { id: "user-2" },
              recipient: { id: "page-2" },
              message: { mid: "mid-page-2", text: "hello" },
            },
          ],
        },
      ],
    },
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.channel, "messenger");
  assert.equal(result.envelope.providerAccountId, "page-2");
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
  assert.equal(result.envelope.channel, "whatsapp");
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

test("codeClip provider envelope normalizer requires text for Messenger messaging shape", () => {
  assert.deepEqual(
    normalizeCodeClipProviderEnvelope({
      provider: "meta",
      body: {
        object: "page",
        entry: [
          {
            id: "page-1",
            messaging: [
              {
                sender: { id: "user-1" },
                recipient: { id: "page-1" },
                message: { mid: "message-1" },
              },
            ],
          },
        ],
      },
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
