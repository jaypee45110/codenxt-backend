const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const subscriptionModulePath = path.resolve(
  __dirname,
  "verticals/codeclip/youtube-websub-subscriptions.js"
);
const callbackModulePath = path.resolve(
  __dirname,
  "verticals/codeclip/youtube-websub-callback.js"
);

const CHANNEL_ID = "UCabcdefghijklmno12345678";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const NOW = "2026-07-17T10:00:00.000Z";
const EXISTING_BOUNDARY = "2026-07-01T00:00:00.000Z";

function subscription(overrides = {}) {
  return {
    id: "1",
    vertical: "codeclip",
    callbackId: "yt_cb_123",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    topic: TOPIC,
    status: "pending_subscribe",
    pendingMode: "subscribe",
    activationBoundaryAt: null,
    activationBoundaryVideoId: null,
    activatedAt: null,
    leaseStartedAt: null,
    leaseExpiresAt: null,
    lastVerifiedAt: null,
    ...overrides,
  };
}

function validSubscribeQuery(overrides = {}) {
  return {
    "hub.mode": "subscribe",
    "hub.topic": TOPIC,
    "hub.challenge": "challenge-value",
    "hub.lease_seconds": "86400",
    ...overrides,
  };
}

function validUnsubscribeQuery(overrides = {}) {
  return {
    "hub.mode": "unsubscribe",
    "hub.topic": TOPIC,
    "hub.challenge": "unsubscribe-challenge",
    ...overrides,
  };
}

function loadCallbackWithStub(state = {}) {
  delete require.cache[callbackModulePath];
  const originalSubscriptionModule = require.cache[subscriptionModulePath];
  const calls = {
    read: [],
    verified: [],
    unsubscribed: [],
  };

  const stub = {
    PENDING_MODES: {
      SUBSCRIBE: "subscribe",
      UNSUBSCRIBE: "unsubscribe",
    },
    SUBSCRIPTION_STATUSES: {
      PENDING_SUBSCRIBE: "pending_subscribe",
      ACTIVE: "active",
      PENDING_RENEWAL: "pending_renewal",
      EXPIRED: "expired",
      PENDING_UNSUBSCRIBE: "pending_unsubscribe",
      UNSUBSCRIBED: "unsubscribed",
      DISABLED: "disabled",
    },
    normalizeCallbackId(value) {
      const normalized = String(value || "").trim();
      if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
        throw new Error("invalid callback");
      }
      return normalized;
    },
    async getCodeClipYouTubeWebSubSubscriptionByCallbackId(callbackId, options = {}) {
      calls.read.push({ callbackId, options });
      if (state.readError) throw new Error("read failed");
      return Object.hasOwn(state, "subscription") ? state.subscription : subscription();
    },
    async markCodeClipYouTubeWebSubSubscriptionVerified(callbackId, options = {}) {
      calls.verified.push({ callbackId, options });
      if (state.updateError) throw new Error("update failed");
      if (state.updateNull) return null;
      return {
        ...(state.subscription ?? subscription()),
        status: "active",
        pendingMode: null,
      };
    },
    async markCodeClipYouTubeWebSubSubscriptionUnsubscribed(callbackId, options = {}) {
      calls.unsubscribed.push({ callbackId, options });
      if (state.updateError) throw new Error("update failed");
      if (state.updateNull) return null;
      return {
        ...(state.subscription ?? subscription()),
        status: "unsubscribed",
        pendingMode: null,
      };
    },
  };

  require.cache[subscriptionModulePath] = {
    id: subscriptionModulePath,
    filename: subscriptionModulePath,
    loaded: true,
    exports: stub,
  };

  const loaded = require(callbackModulePath);

  return {
    ...loaded,
    calls,
    restore() {
      delete require.cache[callbackModulePath];
      if (originalSubscriptionModule) {
        require.cache[subscriptionModulePath] = originalSubscriptionModule;
      } else {
        delete require.cache[subscriptionModulePath];
      }
    },
  };
}

function assertSuccessContract(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "accepted",
    "callbackId",
    "challenge",
    "httpStatus",
    "mode",
  ]);
  assert.equal(result.accepted, true);
  assert.equal(JSON.stringify(result).includes(CHANNEL_ID), false);
  assert.equal(JSON.stringify(result).includes(TOPIC), false);
  assert.equal(Object.hasOwn(result, "subscription"), false);
  assert.equal(Object.hasOwn(result, "leaseExpiresAt"), false);
}

function assertRejectContract(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "accepted",
    "callbackId",
    "httpStatus",
    "mode",
    "reasonCode",
  ]);
  assert.equal(result.accepted, false);
  assert.equal(Object.hasOwn(result, "challenge"), false);
  assert.equal(Object.hasOwn(result, "subscription"), false);
}

test("YouTube WebSub callback accepts valid subscribe and updates lease", async () => {
  const mod = loadCallbackWithStub();
  try {
    const result = await mod.verifyCodeClipYouTubeWebSubCallback(
      {
        callbackId: "yt_cb_123",
        query: validSubscribeQuery(),
        now: NOW,
      },
      { queryClient: "client" }
    );

    assertSuccessContract(result);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.challenge, "challenge-value");
    assert.equal(result.mode, "subscribe");
    assert.equal(result.callbackId, "yt_cb_123");
    assert.equal(mod.calls.verified.length, 1);
    assert.equal(mod.calls.unsubscribed.length, 0);
    assert.deepEqual(mod.calls.verified[0], {
      callbackId: "yt_cb_123",
      options: {
        verifiedAt: NOW,
        leaseStartedAt: NOW,
        leaseExpiresAt: "2026-07-18T10:00:00.000Z",
        queryClient: "client",
        activationBoundaryAt: NOW,
      },
    });
  } finally {
    mod.restore();
  }
});

test("YouTube WebSub callback accepts renewal without sending activationBoundaryAt", async () => {
  const mod = loadCallbackWithStub({
    subscription: subscription({
      status: "pending_renewal",
      pendingMode: "subscribe",
      activationBoundaryAt: EXISTING_BOUNDARY,
      activatedAt: EXISTING_BOUNDARY,
    }),
  });
  try {
    const result = await mod.verifyCodeClipYouTubeWebSubCallback(
      {
        callbackId: "yt_cb_123",
        query: validSubscribeQuery(),
        now: NOW,
      },
      { queryClient: "client" }
    );

    assertSuccessContract(result);
    assert.equal(mod.calls.verified.length, 1);
    assert.equal(mod.calls.verified[0].callbackId, "yt_cb_123");
    assert.equal(mod.calls.verified[0].options.verifiedAt, NOW);
    assert.equal(mod.calls.verified[0].options.leaseStartedAt, NOW);
    assert.equal(mod.calls.verified[0].options.leaseExpiresAt, "2026-07-18T10:00:00.000Z");
    assert.equal(Object.hasOwn(mod.calls.verified[0].options, "activationBoundaryAt"), false);
    assert.equal(JSON.stringify(result).includes(EXISTING_BOUNDARY), false);
  } finally {
    mod.restore();
  }
});

test("YouTube WebSub callback accepts unsubscribe without lease seconds", async () => {
  const mod = loadCallbackWithStub({
    subscription: subscription({
      status: "pending_unsubscribe",
      pendingMode: "unsubscribe",
    }),
  });
  try {
    const result = await mod.verifyCodeClipYouTubeWebSubCallback(
      {
        callbackId: "yt_cb_123",
        query: validUnsubscribeQuery(),
        now: NOW,
      },
      { queryClient: "client" }
    );

    assertSuccessContract(result);
    assert.equal(result.challenge, "unsubscribe-challenge");
    assert.equal(result.mode, "unsubscribe");
    assert.equal(mod.calls.unsubscribed.length, 1);
    assert.equal(mod.calls.verified.length, 0);
  } finally {
    mod.restore();
  }
});

test("YouTube WebSub callback rejects invalid callbackId before repository read", async () => {
  const mod = loadCallbackWithStub();
  try {
    const result = await mod.verifyCodeClipYouTubeWebSubCallback({
      callbackId: "../bad",
      query: validSubscribeQuery(),
      now: NOW,
    });

    assertRejectContract(result);
    assert.equal(result.reasonCode, "CALLBACK_ID_INVALID");
    assert.equal(mod.calls.read.length, 0);
    assert.equal(mod.calls.verified.length, 0);
  } finally {
    mod.restore();
  }
});

test("YouTube WebSub callback rejects missing subscription", async () => {
  const mod = loadCallbackWithStub({ subscription: null });
  try {
    const result = await mod.verifyCodeClipYouTubeWebSubCallback({
      callbackId: "yt_cb_123",
      query: validSubscribeQuery(),
      now: NOW,
    });

    assertRejectContract(result);
    assert.equal(result.httpStatus, 404);
    assert.equal(result.reasonCode, "SUBSCRIPTION_NOT_FOUND");
    assert.equal(mod.calls.verified.length, 0);
  } finally {
    mod.restore();
  }
});

test("YouTube WebSub callback rejects malformed request fields before update", async () => {
  const cases = [
    { query: validSubscribeQuery({ "hub.mode": "publish" }), reason: "MODE_INVALID" },
    { query: validSubscribeQuery({ "hub.challenge": "" }), reason: "CHALLENGE_INVALID" },
    { query: validSubscribeQuery({ "hub.challenge": "x".repeat(513) }), reason: "CHALLENGE_INVALID" },
    { query: validSubscribeQuery({ "hub.topic": "not-a-url" }), reason: "TOPIC_INVALID" },
    { query: validSubscribeQuery({ "hub.topic": TOPIC.replace("https://", "http://") }), reason: "TOPIC_INVALID" },
  ];

  for (const item of cases) {
    const mod = loadCallbackWithStub();
    try {
      const result = await mod.verifyCodeClipYouTubeWebSubCallback({
        callbackId: "yt_cb_123",
        query: item.query,
        now: NOW,
      });

      assertRejectContract(result);
      assert.equal(result.reasonCode, item.reason);
      assert.equal(mod.calls.verified.length, 0);
      assert.equal(mod.calls.unsubscribed.length, 0);
    } finally {
      mod.restore();
    }
  }
});

test("YouTube WebSub callback rejects topic and channel mismatches", async () => {
  const mismatchTopic = "https://www.youtube.com/feeds/videos.xml?channel_id=UCzzzzzzzzzzzzzzzzzzzzzz";
  const cases = [
    {
      state: {},
      query: validSubscribeQuery({ "hub.topic": mismatchTopic }),
      reason: "TOPIC_MISMATCH",
    },
    {
      state: {
        subscription: subscription({
          topic: mismatchTopic,
        }),
      },
      query: validSubscribeQuery({ "hub.topic": mismatchTopic }),
      reason: "TOPIC_MISMATCH",
    },
  ];

  for (const item of cases) {
    const mod = loadCallbackWithStub(item.state);
    try {
      const result = await mod.verifyCodeClipYouTubeWebSubCallback({
        callbackId: "yt_cb_123",
        query: item.query,
        now: NOW,
      });

      assertRejectContract(result);
      assert.equal(result.reasonCode, item.reason);
      assert.equal(mod.calls.verified.length, 0);
    } finally {
      mod.restore();
    }
  }
});

test("YouTube WebSub callback rejects wrong scope, mode mismatch, and invalid states", async () => {
  const cases = [
    {
      subscription: subscription({ vertical: "codepod" }),
      reason: "SUBSCRIPTION_SCOPE_INVALID",
    },
    {
      subscription: subscription({ provider: "meta" }),
      reason: "SUBSCRIPTION_SCOPE_INVALID",
    },
    {
      subscription: subscription({ channel: "instagram" }),
      reason: "SUBSCRIPTION_SCOPE_INVALID",
    },
    {
      subscription: subscription({ pendingMode: "unsubscribe" }),
      reason: "MODE_MISMATCH",
    },
    {
      subscription: subscription({ status: "active", pendingMode: "subscribe" }),
      reason: "SUBSCRIPTION_STATE_INVALID",
    },
  ];

  for (const item of cases) {
    const mod = loadCallbackWithStub({ subscription: item.subscription });
    try {
      const result = await mod.verifyCodeClipYouTubeWebSubCallback({
        callbackId: "yt_cb_123",
        query: validSubscribeQuery(),
        now: NOW,
      });

      assertRejectContract(result);
      assert.equal(result.reasonCode, item.reason);
      assert.equal(mod.calls.verified.length, 0);
    } finally {
      mod.restore();
    }
  }
});

test("YouTube WebSub callback rejects invalid subscribe lease values", async () => {
  const invalidValues = [undefined, "", "0", "-1", "1.5", "abc", String(60 * 60 * 24 * 30 + 1)];

  for (const value of invalidValues) {
    const mod = loadCallbackWithStub();
    try {
      const query = validSubscribeQuery();
      if (value === undefined) {
        delete query["hub.lease_seconds"];
      } else {
        query["hub.lease_seconds"] = value;
      }
      const result = await mod.verifyCodeClipYouTubeWebSubCallback({
        callbackId: "yt_cb_123",
        query,
        now: NOW,
      });

      assertRejectContract(result);
      assert.equal(result.reasonCode, "LEASE_INVALID");
      assert.equal(mod.calls.verified.length, 0);
    } finally {
      mod.restore();
    }
  }
});

test("YouTube WebSub callback fail-closes on repository read and update failures", async () => {
  for (const state of [{ readError: true }, { updateError: true }, { updateNull: true }]) {
    const mod = loadCallbackWithStub(state);
    try {
      const result = await mod.verifyCodeClipYouTubeWebSubCallback({
        callbackId: "yt_cb_123",
        query: validSubscribeQuery(),
        now: NOW,
      });

      assertRejectContract(result);
      assert.equal(result.httpStatus, 503);
      assert.equal(result.reasonCode, "REPOSITORY_UNAVAILABLE");
    } finally {
      mod.restore();
    }
  }
});
