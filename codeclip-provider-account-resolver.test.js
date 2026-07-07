const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCodeClipProviderAccount,
} = require("./verticals/codeclip/provider-account-resolver");

test("codeClip provider account resolver requires provider", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      body: { providerAccountId: "account-1" },
    }),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );
});

test("codeClip provider account resolver reads generic providerAccountId", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: " custom ",
      body: { providerAccountId: " account-1 " },
    }),
    {
      ok: true,
      provider: "custom",
      providerAccountId: "account-1",
    }
  );
});

test("codeClip provider account resolver reads generic providerAccount and metadata", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "custom",
      body: { providerAccount: " account-2 " },
    }),
    {
      ok: true,
      provider: "custom",
      providerAccountId: "account-2",
    }
  );

  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "custom",
      metadata: { providerAccountId: " account-3 " },
    }),
    {
      ok: true,
      provider: "custom",
      providerAccountId: "account-3",
    }
  );
});

test("codeClip provider account resolver reads SMS To", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "sms",
      body: { To: " +15551234567 " },
    }),
    {
      ok: true,
      provider: "sms",
      providerAccountId: "+15551234567",
    }
  );
});

test("codeClip provider account resolver reads SMS MessagingServiceSid", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "sms",
      body: { MessagingServiceSid: " MG123 " },
    }),
    {
      ok: true,
      provider: "sms",
      providerAccountId: "MG123",
    }
  );
});

test("codeClip provider account resolver reads SMS header", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "sms",
      headers: { "X-Provider-Account-Id": " sms-account-1 " },
    }),
    {
      ok: true,
      provider: "sms",
      providerAccountId: "sms-account-1",
    }
  );
});

test("codeClip provider account resolver reads Meta recipient id", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "meta",
      body: { recipient: { id: " page-1 " } },
    }),
    {
      ok: true,
      provider: "meta",
      providerAccountId: "page-1",
    }
  );
});

test("codeClip provider account resolver reads Meta entry id", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "meta",
      body: { entry: [{ id: " page-2 " }] },
    }),
    {
      ok: true,
      provider: "meta",
      providerAccountId: "page-2",
    }
  );
});

test("codeClip provider account resolver reads Meta nested recipient id", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "meta",
      body: {
        entry: [
          {
            messaging: [
              {
                recipient: { id: " page-3 " },
              },
            ],
          },
        ],
      },
    }),
    {
      ok: true,
      provider: "meta",
      providerAccountId: "page-3",
    }
  );
});

test("codeClip provider account resolver reads Meta objectId and header", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "meta",
      body: { objectId: " page-4 " },
    }),
    {
      ok: true,
      provider: "meta",
      providerAccountId: "page-4",
    }
  );

  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "meta",
      headers: { "x-provider-account-id": " page-5 " },
    }),
    {
      ok: true,
      provider: "meta",
      providerAccountId: "page-5",
    }
  );
});

test("codeClip provider account resolver uses test provider fallback", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: " test ",
      body: {},
    }),
    {
      ok: true,
      provider: "test",
      providerAccountId: "test",
    }
  );
});

test("codeClip provider account resolver returns no account for unknown provider without account data", () => {
  assert.deepEqual(
    resolveCodeClipProviderAccount({
      provider: "custom",
      body: {},
    }),
    { ok: false, reason: "NO_PROVIDER_ACCOUNT" }
  );
});
