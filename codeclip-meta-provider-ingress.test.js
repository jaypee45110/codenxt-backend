const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createRedisStub } = require("./test-helpers/redis-stub");

const previousRedisUrl = process.env.REDIS_URL;
const previousMetaSecret = process.env.CODECLIP_META_WEBHOOK_SECRET;
const previousPostLimit = process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT;
const previousPreLimit = process.env.CODECLIP_META_PROVIDER_PRE_RATE_LIMIT;

process.env.REDIS_URL = "redis://codeclip-meta-provider-test";
process.env.CODECLIP_META_WEBHOOK_SECRET = "codeclip-meta-route-secret";
process.env.CODECLIP_META_PROVIDER_POST_RATE_LIMIT = "2";
process.env.CODECLIP_META_PROVIDER_PRE_RATE_LIMIT = "100";

const redis = createRedisStub();
const redisModulePath = require.resolve("./redis");
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: redis,
};

const { after } = require("node:test");
const { app } = require("./server");

after(() => {
  restoreEnv("REDIS_URL", previousRedisUrl);
  restoreEnv("CODECLIP_META_WEBHOOK_SECRET", previousMetaSecret);
  restoreEnv("CODECLIP_META_PROVIDER_POST_RATE_LIMIT", previousPostLimit);
  restoreEnv("CODECLIP_META_PROVIDER_PRE_RATE_LIMIT", previousPreLimit);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withTestServer(run) {
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
    listeningServer.on("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function signMetaBody(rawBody, secret = process.env.CODECLIP_META_WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function metaHeaders(rawBody) {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": `sha256=${signMetaBody(rawBody)}`,
  };
}

function metaBody({ messageId, accountId, senderId = "sender-1", text = " vip " }) {
  return JSON.stringify({
    entry: [
      {
        id: accountId,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: accountId },
            message: {
              mid: messageId,
              text,
            },
          },
        ],
      },
    ],
  });
}

async function createCodeClipMetaEvent(baseUrl, { accountId, keyword = "VIP" }) {
  const code = `CC-META-${Date.now()}-${Math.random().toString(16).slice(2)}`.toUpperCase();
  const response = await fetch(`${baseUrl}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vertical: "codeclip",
      code,
      name: "codeClip Meta provider ingress test",
      startAt: "2099-01-01T10:00:00.000Z",
      unlockAt: "2099-01-01T10:00:00.000Z",
      endAt: "2099-01-01T11:00:00.000Z",
      activationMethod: "keyword",
      activationKeyword: keyword,
      activationChannels: ["Messenger"],
      providerAccountIds: [accountId],
      rewards: {
        openClip: {
          enabled: true,
          title: "OpenClip",
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  return code;
}

function assertNoProviderInternals(payload) {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const term of [
    "secret",
    "signature",
    "rawbody",
    "x-hub-signature-256",
    "verificationmode",
    "audienceentry",
    "audienceintent",
    "routingoutcome",
    "rewardassignmentsnapshot",
    "codepod",
    "codetone",
  ]) {
    assert.equal(serialized.includes(term), false);
  }
}

test("signed Meta request reaches existing codeClip provider runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-valid-${Date.now()}`;
    const keyword = `VALID-${Date.now()}`;
    const code = await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-valid-${Date.now()}`,
      accountId,
      text: keyword,
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.eventCode, code);
    assertNoProviderInternals(payload);
  });
});

test("completed duplicate Meta delivery reuses stored public response", async () => {
  await withTestServer(async (baseUrl) => {
    const accountId = `page-duplicate-${Date.now()}`;
    const keyword = `DUPLICATE-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId, keyword });
    const rawBody = metaBody({
      messageId: `meta-duplicate-${Date.now()}`,
      accountId,
      text: keyword,
    });

    const first = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const second = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const firstPayload = await first.json();
    const secondPayload = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(secondPayload, firstPayload);
    assertNoProviderInternals(secondPayload);
  });
});

test("Meta post-verification rate limit is provider-account scoped", async () => {
  await withTestServer(async (baseUrl) => {
    const accountA = `page-rate-a-${Date.now()}`;
    const accountB = `page-rate-b-${Date.now()}`;
    const keywordA = `RATEA-${Date.now()}`;
    const keywordB = `RATEB-${Date.now()}`;
    await createCodeClipMetaEvent(baseUrl, { accountId: accountA, keyword: keywordA });
    await createCodeClipMetaEvent(baseUrl, { accountId: accountB, keyword: keywordB });

    for (const senderId of ["sender-a", "sender-b"]) {
      const rawBody = metaBody({
        messageId: `meta-rate-a-${senderId}-${Date.now()}`,
        accountId: accountA,
        senderId,
        text: keywordA,
      });
      const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
        method: "POST",
        headers: metaHeaders(rawBody),
        body: rawBody,
      });
      assert.equal(response.status, 200);
    }

    const limitedBody = metaBody({
      messageId: `meta-rate-a-third-${Date.now()}`,
      accountId: accountA,
      senderId: "sender-c",
      text: keywordA,
    });
    const limited = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(limitedBody),
      body: limitedBody,
    });
    const limitedPayload = await limited.json();

    assert.equal(limited.status, 429);
    assert.deepEqual(limitedPayload, {
      ok: false,
      error: "Too many requests. Please try again shortly.",
    });
    assertNoProviderInternals(limitedPayload);

    const accountBBody = metaBody({
      messageId: `meta-rate-b-${Date.now()}`,
      accountId: accountB,
      text: keywordB,
    });
    const accountBResponse = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(accountBBody),
      body: accountBBody,
    });

    assert.equal(accountBResponse.status, 200);
  });
});

test("verified Meta payload without provider account is rejected before runtime", async () => {
  await withTestServer(async (baseUrl) => {
    const rawBody = JSON.stringify({
      messageId: `meta-missing-account-${Date.now()}`,
      text: "VIP",
      sender: { id: "sender-only" },
    });
    const response = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: "POST",
      headers: metaHeaders(rawBody),
      body: rawBody,
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, {
      ok: false,
      error: "Invalid provider keyword payload",
    });
    assertNoProviderInternals(payload);
  });
});
