const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifyCodeClipProviderWebhook,
} = require("./verticals/codeclip/provider-webhook-verification");

function hmac(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

test("codeClip provider webhook verification requires provider", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      mode: "disabled",
    }),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );
});

test("codeClip provider webhook verification rejects unsupported provider", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "custom",
      mode: "disabled",
    }),
    { ok: false, reason: "UNSUPPORTED_PROVIDER" }
  );
});

test("codeClip provider webhook verification supports disabled mode", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: " Meta ",
      mode: "disabled",
    }),
    {
      ok: true,
      provider: "meta",
      verification: {
        provider: "meta",
        mode: "disabled",
        method: "disabled",
      },
    }
  );
});

test("codeClip provider webhook verification supports test provider header", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "test",
      mode: "test",
      headers: {
        "x-codeclip-test-signature": "valid",
      },
    }),
    {
      ok: true,
      provider: "test",
      verification: {
        provider: "test",
        mode: "test",
        method: "test-header",
      },
    }
  );
});

test("codeClip provider webhook verification rejects missing and invalid test header", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "test",
      mode: "test",
      headers: {},
    }),
    { ok: false, reason: "SIGNATURE_REQUIRED" }
  );

  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "test",
      mode: "test",
      headers: {
        "x-codeclip-test-signature": "invalid",
      },
    }),
    { ok: false, reason: "SIGNATURE_MISMATCH" }
  );
});

test("codeClip provider webhook verification hmac requires secret and signature", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "meta",
      mode: "hmac-sha256",
      rawBody: "body",
      headers: {
        "x-hub-signature-256": "sha256=abc",
      },
    }),
    { ok: false, reason: "SECRET_REQUIRED" }
  );

  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "meta",
      mode: "hmac-sha256",
      rawBody: "body",
      secret: "secret",
    }),
    { ok: false, reason: "SIGNATURE_REQUIRED" }
  );
});

test("codeClip provider webhook verification validates Meta hmac signature", () => {
  const rawBody = "{\"message\":\"CLIP\"}";
  const secret = "meta-secret";
  const signature = hmac(rawBody, secret);

  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "meta",
      mode: "hmac-sha256",
      rawBody,
      secret,
      headers: {
        "x-hub-signature-256": `sha256=${signature}`,
      },
    }),
    {
      ok: true,
      provider: "meta",
      verification: {
        provider: "meta",
        mode: "hmac-sha256",
        method: "hmac-sha256",
      },
    }
  );
});

test("codeClip provider webhook verification rejects invalid Meta hmac signature", () => {
  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "meta",
      mode: "hmac-sha256",
      rawBody: "body",
      secret: "secret",
      headers: {
        "x-hub-signature-256": "sha256=0000",
      },
    }),
    { ok: false, reason: "SIGNATURE_MISMATCH" }
  );
});

test("codeClip provider webhook verification validates SMS hmac signature", () => {
  const rawBody = "Body=CLIP";
  const secret = "sms-secret";
  const signature = hmac(rawBody, secret);

  assert.equal(
    verifyCodeClipProviderWebhook({
      provider: "sms",
      mode: "hmac-sha256",
      rawBody,
      secret,
      headers: {
        "x-provider-signature": signature,
      },
    }).ok,
    true
  );
});

test("codeClip provider webhook verification validates SMS sha256-prefixed signature", () => {
  const rawBody = "Body=OPEN";
  const secret = "sms-secret";
  const signature = hmac(rawBody, secret);

  assert.equal(
    verifyCodeClipProviderWebhook({
      provider: "sms",
      mode: "hmac-sha256",
      rawBody,
      secret,
      headers: {
        "x-provider-signature": `sha256=${signature}`,
      },
    }).ok,
    true
  );
});

test("codeClip provider webhook verification supports Buffer raw body", () => {
  const rawBody = Buffer.from("Body=VIP");
  const secret = "sms-secret";
  const signature = hmac(rawBody, secret);

  assert.equal(
    verifyCodeClipProviderWebhook({
      provider: "sms",
      mode: "hmac-sha256",
      rawBody,
      secret,
      headers: {
        "x-provider-signature": signature,
      },
    }).ok,
    true
  );
});

test("codeClip provider webhook verification rejects object raw body", () => {
  const secret = "sms-secret";
  const signature = hmac("body", secret);

  assert.deepEqual(
    verifyCodeClipProviderWebhook({
      provider: "sms",
      mode: "hmac-sha256",
      rawBody: { body: "CLIP" },
      secret,
      headers: {
        "x-provider-signature": signature,
      },
    }),
    { ok: false, reason: "RAW_BODY_REQUIRED" }
  );
});
