const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const {
  createCodeClipYouTubeOAuthState,
  decodeCodeClipYouTubeOAuthStatePayloadUnsafe,
} = require("./verticals/codeclip/youtube-oauth-state");
const {
  CodeClipProviderAccountBindingError,
} = require("./verticals/codeclip/provider-account-bindings");
const {
  CodeClipYouTubeOAuthClientError,
} = require("./verticals/codeclip/youtube-oauth-client");
const {
  startCodeClipYouTubeConnection,
  completeCodeClipYouTubeConnection,
  getCodeClipYouTubeConnectionStatus,
  mapConnectionError,
} = require("./verticals/codeclip/youtube-connection");

const EVENT_CODE = "CC-YT-CONNECT";
const CHANNEL_ID = "UCvalidChannelId1234567890";
const SECRET = "state-signing-secret-test-value";
const CLIENT_SECRET = "google-client-secret-test-value";
const ACCESS_TOKEN = "google-access-token-test-value";
const REFRESH_TOKEN = "google-refresh-token-test-value";
const AUTH_CODE = "google-auth-code-test-value";

function env(overrides = {}) {
  return {
    CODECLIP_YOUTUBE_OAUTH_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    CODECLIP_YOUTUBE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    CODECLIP_YOUTUBE_OAUTH_CALLBACK_URL:
      "https://api.example.test/api/codeclip/providers/youtube/oauth/callback",
    CODECLIP_YOUTUBE_OAUTH_STATE_SECRET: SECRET,
    CODECLIP_YOUTUBE_OAUTH_RETURN_URL: "https://app.example.test/checkout/youtube",
    ...overrides,
  };
}

function event(code = EVENT_CODE) {
  return {
    event_code: code,
    vertical: "codeclip",
    raw_event: {
      code,
      vertical: "codeclip",
      dashboardAccessKey: "creator-dashboard-key",
    },
  };
}

function assertNoLeak(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    AUTH_CODE,
    CLIENT_SECRET,
    SECRET,
    "raw_google_response",
    "SELECT *",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("YouTube OAuth start validates episode, builds URL, and ignores providerAccountId injection", async () => {
  const recorded = [];
  const response = await startCodeClipYouTubeConnection(
    {
      eventCode: EVENT_CODE,
      returnUrl: "https://app.example.test/checkout/youtube",
      providerAccountId: "UCattackerChannel123456789",
    },
    {
      env: env(),
      now: new Date("2026-07-19T00:00:00.000Z"),
      generateNonce: () => "nonce-start-test",
      getEventByCode: async (eventCode) => event(eventCode),
      queryClient: { name: "start-query-client" },
      recordOAuthState: async (payload) => recorded.push(payload),
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.provider, "youtube");
  const url = new URL(response.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), env().CODECLIP_YOUTUBE_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), env().CODECLIP_YOUTUBE_OAUTH_CALLBACK_URL);
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.readonly");
  assert.equal(url.searchParams.has("providerAccountId"), false);
  assert.equal(recorded[0].eventCode, EVENT_CODE);
  assert.equal(recorded[0].provider, "youtube");
  assert.equal(recorded[0].vertical, "codeclip");
  const payload = decodeCodeClipYouTubeOAuthStatePayloadUnsafe(url.searchParams.get("state"));
  assert.equal(payload.eventCode, EVENT_CODE);
  assert.equal(payload.nonce, "nonce-start-test");
  assert.equal(payload.providerAccountId, undefined);
  assertNoLeak(response);
});

test("YouTube OAuth start rejects unknown episode before config dependency", async () => {
  await assert.rejects(
    () =>
      startCodeClipYouTubeConnection(
        {
          eventCode: "CC-MISSING",
          returnUrl: "https://app.example.test/checkout/youtube",
        },
        {
          env: {},
          getEventByCode: async () => null,
          recordOAuthState: async () => {},
        }
      ),
    (error) => error.code === "youtube_episode_not_found"
  );
});

test("YouTube OAuth start fails public-safe when config is missing", async () => {
  await assert.rejects(
    () =>
      startCodeClipYouTubeConnection(
        {
          eventCode: EVENT_CODE,
          returnUrl: "https://app.example.test/checkout/youtube",
        },
        {
          env: env({ CODECLIP_YOUTUBE_OAUTH_CLIENT_SECRET: "" }),
          getEventByCode: async () => event(),
          recordOAuthState: async () => {},
        }
      ),
    (error) => error.code === "youtube_oauth_unavailable"
  );
});

function validState(now = new Date("2026-07-19T00:00:00.000Z")) {
  return createCodeClipYouTubeOAuthState({
    eventCode: EVENT_CODE,
    returnUrl: "https://app.example.test/checkout/youtube",
    secret: SECRET,
    now,
    nonce: "nonce-callback-test",
  });
}

function callbackOptions(overrides = {}) {
  const calls = [];
  const txClient = { name: "tx-client" };
  return {
    calls,
    env: env(),
    now: new Date("2026-07-19T00:01:00.000Z"),
    queryClient: { name: "pool" },
    getEventByCode: async (eventCode) => event(eventCode),
    consumeOAuthState: async (payload) => {
      calls.push(["consume", payload.nonce, payload.eventCode]);
      return { consumed: true };
    },
    exchangeCode: async ({ code }) => {
      calls.push(["exchange", code]);
      return {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        raw: "raw_google_response",
      };
    },
    fetchChannel: async ({ accessToken }) => {
      calls.push(["channel", accessToken]);
      return {
        channelId: CHANNEL_ID,
        displayName: "Creator Channel",
        thumbnailUrl: "https://yt.example.test/thumb.jpg",
      };
    },
    runTransaction: async (work) => work({ queryClient: txClient }),
    createBinding: async (binding, options) => {
      calls.push(["binding", binding, options.queryClient]);
      return {
        created: true,
        row: {
          id: "binding-1",
          vertical: "codeclip",
          eventCode: binding.eventCode,
          provider: binding.provider,
          channel: binding.channel,
          providerAccountId: binding.providerAccountId,
          status: "active",
          displayName: binding.displayName,
          createdAt: "2026-07-19T00:01:01.000Z",
          updatedAt: "2026-07-19T00:01:01.000Z",
        },
      };
    },
    appendBindingAudit: async (audit) => calls.push(["bindingAudit", audit]),
    getOpenSubscriptionByProviderAccountId: async (providerAccountId) => {
      calls.push(["getSubscription", providerAccountId]);
      return null;
    },
    createPendingSubscription: async (subscription, options) => {
      calls.push(["createSubscription", subscription, options.queryClient]);
      return {
        callbackId: subscription.callbackId,
        provider: "youtube",
        channel: "youtube",
        providerAccountId: subscription.providerAccountId,
        status: "pending_subscribe",
        pendingMode: "subscribe",
        secretVersion: "v1",
        lastVerifiedAt: null,
        leaseExpiresAt: null,
      };
    },
    recordSubscriptionAudit: async (audit) => calls.push(["subscriptionAudit", audit]),
    ...overrides,
  };
}

test("YouTube OAuth callback binds authoritative channel and creates pending subscription", async () => {
  const { state } = validState();
  const options = callbackOptions();
  const result = await completeCodeClipYouTubeConnection(
    {
      code: AUTH_CODE,
      state,
      channelId: "UCattackerChannel123456789",
    },
    options
  );

  assert.equal(result.ok, true);
  assert.equal(result.connection.connectionStatus, "connected");
  assert.equal(result.connection.channelDisplayName, "Creator Channel");
  assert.equal(result.connection.subscriptionStatus, "pending_subscribe");
  assert.equal(result.connection.verifiedAt, null);
  const bindingCall = options.calls.find((call) => call[0] === "binding");
  assert.equal(bindingCall[1].providerAccountId, CHANNEL_ID);
  assert.equal(bindingCall[1].eventCode, EVENT_CODE);
  assert.equal(bindingCall[1].displayName, "Creator Channel");
  const subscriptionCall = options.calls.find((call) => call[0] === "createSubscription");
  assert.equal(subscriptionCall[1].providerAccountId, CHANNEL_ID);
  assert.equal(subscriptionCall[1].metadata.eventCode, EVENT_CODE);
  assert.equal(subscriptionCall[1].metadata.bindingId, "binding-1");
  assert.notEqual(subscriptionCall[1].status, "active");
  assertNoLeak(result);
  const auditCall = options.calls.find((call) => call[0] === "bindingAudit");
  assertNoLeak(auditCall);
});

test("YouTube OAuth callback is idempotent for same episode and channel", async () => {
  const { state } = validState();
  const options = callbackOptions({
    createBinding: async (binding) => ({
      created: false,
      existing: true,
      row: {
        id: "binding-1",
        vertical: "codeclip",
        eventCode: binding.eventCode,
        provider: "youtube",
        channel: "youtube",
        providerAccountId: binding.providerAccountId,
        status: "active",
        displayName: binding.displayName,
      },
    }),
    getOpenSubscriptionByProviderAccountId: async (providerAccountId) => ({
      callbackId: "yt_existing",
      provider: "youtube",
      channel: "youtube",
      providerAccountId,
      status: "pending_subscribe",
      pendingMode: "subscribe",
    }),
  });
  const result = await completeCodeClipYouTubeConnection(
    { code: AUTH_CODE, state },
    options
  );
  assert.equal(result.bindingCreated, false);
  assert.equal(result.subscriptionCreated, false);
  assert.equal(result.connection.subscriptionStatus, "pending_subscribe");
});

test("YouTube OAuth callback rejects invalid, expired, and replayed state", async () => {
  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: "invalid-state" },
        callbackOptions()
      ),
    (error) => error.code === "youtube_oauth_state_invalid"
  );

  const expired = validState(new Date("2026-07-19T00:00:00.000Z"));
  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: expired.state },
        callbackOptions({ now: new Date("2026-07-19T00:20:01.000Z") })
      ),
    (error) => error.code === "youtube_oauth_state_expired"
  );

  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: validState().state },
        callbackOptions({
          consumeOAuthState: async () => ({ consumed: false, reason: "replayed" }),
        })
      ),
    (error) => error.code === "youtube_oauth_replayed"
  );
});

test("YouTube OAuth callback maps denial, token failure, missing channel, and ambiguous channel", async () => {
  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { error: "access_denied", state: validState().state },
        callbackOptions()
      ),
    (error) => error.code === "youtube_authorization_denied"
  );

  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: validState().state },
        callbackOptions({
          exchangeCode: async () => {
            throw new CodeClipYouTubeOAuthClientError(
              "youtube_connection_unavailable",
              "token failed"
            );
          },
        })
      ),
    (error) => mapConnectionError(error).code === "youtube_connection_unavailable"
  );

  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: validState().state },
        callbackOptions({
          fetchChannel: async () => {
            throw new CodeClipYouTubeOAuthClientError(
              "youtube_channel_not_found",
              "not found"
            );
          },
        })
      ),
    (error) => mapConnectionError(error).code === "youtube_channel_not_found"
  );

  await assert.rejects(
    () =>
      completeCodeClipYouTubeConnection(
        { code: AUTH_CODE, state: validState().state },
        callbackOptions({
          fetchChannel: async () => {
            throw new CodeClipYouTubeOAuthClientError(
              "youtube_channel_ambiguous",
              "ambiguous"
            );
          },
        })
      ),
    (error) => mapConnectionError(error).code === "youtube_channel_ambiguous"
  );
});

test("YouTube binding conflict maps to public-safe 409 code", async () => {
  const error = new CodeClipProviderAccountBindingError(
    "PROVIDER_ACCOUNT_BINDING_CONFLICT",
    "provider account is already bound",
    { eventCode: "CC-OTHER", bindingId: "binding-other" }
  );
  assert.equal(mapConnectionError(error).code, "youtube_binding_conflict");
});

test("YouTube connection status is public-safe read model", async () => {
  const result = await getCodeClipYouTubeConnectionStatus(
    { eventCode: EVENT_CODE },
    {
      queryClient: { name: "status-client" },
      getEventByCode: async () => event(),
      listBindingsForEvent: async () => [
        {
          id: "binding-1",
          vertical: "codeclip",
          eventCode: EVENT_CODE,
          provider: "youtube",
          channel: "youtube",
          providerAccountId: CHANNEL_ID,
          status: "active",
          displayName: "Creator Channel",
        },
      ],
      getOpenSubscriptionByProviderAccountId: async () => ({
        callbackId: "yt_existing",
        provider: "youtube",
        channel: "youtube",
        providerAccountId: CHANNEL_ID,
        status: "pending_subscribe",
        pendingMode: "subscribe",
        lastVerifiedAt: null,
        leaseExpiresAt: null,
      }),
    }
  );

  assert.deepEqual(Object.keys(result.connection).sort(), [
    "bindingStatus",
    "channelDisplayName",
    "connectionStatus",
    "errorCode",
    "leaseExpiresAt",
    "maskedChannelId",
    "provider",
    "reconnectRequired",
    "requested",
    "selected",
    "subscriptionStatus",
    "verifiedAt",
  ]);
  assert.equal(result.connection.provider, "youtube");
  assert.equal(result.connection.bindingStatus, "active");
  assert.equal(result.connection.subscriptionStatus, "pending_subscribe");
  assertNoLeak(result);
});

function callApp({ method = "POST", path, body = null, headers = {} }) {
  const { app } = require("./server");
  return new Promise((resolve, reject) => {
    const payload = body === null ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "localhost",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      ...headers,
    };

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => {
      res.headers[String(name).toLowerCase()] = value;
    };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => {
      delete res.headers[String(name).toLowerCase()];
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: text ? JSON.parse(text) : null,
      });
    };

    app.handle(req, res, reject);
  });
}

test("YouTube creator-facing start route rejects missing creator authorization", async () => {
  const response = await callApp({
    method: "POST",
    path: "/api/codeclip/events/CC-UNAUTH/providers/youtube/connect",
    body: { returnUrl: "https://app.example.test/checkout/youtube" },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    ok: false,
    error: { code: "creator_connection_unauthorized" },
  });
  assertNoLeak(response.body);
});
