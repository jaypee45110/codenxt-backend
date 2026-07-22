const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const operationsModulePath = require.resolve("./verticals/codeclip/youtube-websub-operations");
const bindingsModulePath = require.resolve("./verticals/codeclip/provider-account-bindings");
const originalBindings = require(bindingsModulePath);

const queryClient = { name: "youtube-websub-operator-route-pool" };
const calls = [];
let operationError = null;
let operationResults = {};
let bindingRows = [];
let operatorEvent = { code: "CC-ROUTE", vertical: "codeclip" };

class StubOperationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodeClipYouTubeWebSubOperationError";
    this.code = code;
  }
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
    getCampaignByCode: async (eventCode) => {
      calls.push(["getCampaignByCode", eventCode]);
      return operatorEvent && operatorEvent.code === eventCode ? operatorEvent : null;
    },
  },
};

require.cache[operationsModulePath] = {
  id: operationsModulePath,
  filename: operationsModulePath,
  loaded: true,
  exports: {
    CodeClipYouTubeWebSubOperationError: StubOperationError,
    createCodeClipYouTubeWebSubSubscriptionOperation: async (body, options) => {
      calls.push(["create", body, options]);
      if (operationError) throw operationError;
      return operationResults.create;
    },
    listCodeClipYouTubeWebSubSubscriptionStatuses: async (filters, options) => {
      calls.push(["list", filters, options]);
      if (operationError) throw operationError;
      return operationResults.list;
    },
    getCodeClipYouTubeWebSubSubscriptionStatus: async (callbackId, options) => {
      calls.push(["get", callbackId, options]);
      if (operationError) throw operationError;
      return operationResults.get;
    },
    renewCodeClipYouTubeWebSubSubscriptionOperation: async (callbackId, body, options) => {
      calls.push(["renew", callbackId, body, options]);
      if (operationError) throw operationError;
      return operationResults.renew;
    },
    unsubscribeCodeClipYouTubeWebSubSubscriptionOperation: async (callbackId, body, options) => {
      calls.push(["unsubscribe", callbackId, body, options]);
      if (operationError) throw operationError;
      return operationResults.unsubscribe;
    },
  },
};

require.cache[bindingsModulePath] = {
  id: bindingsModulePath,
  filename: bindingsModulePath,
  loaded: true,
  exports: {
    ...originalBindings,
    listCodeClipProviderAccountBindingsForEvent: async (eventCode, options) => {
      calls.push(["listBindingsForEvent", eventCode, options]);
      return bindingRows;
    },
    getCodeClipProviderAccountBindingById: async (bindingId, options) => {
      calls.push(["getBindingById", bindingId, options]);
      return bindingRows.find((binding) => String(binding.id) === String(bindingId)) || null;
    },
    toPublicCodeClipProviderBinding: (binding) => ({
      id: binding.id,
      eventCode: binding.eventCode,
      provider: binding.provider,
      channel: binding.channel,
      maskedAccountId: "****************6789",
      status: binding.status,
      displayName: binding.displayName || "",
    }),
  },
};

process.env.CODECLIP_ADMIN_KEY = "route-admin-secret";
const { app } = require("./server");

function reset(results = {}) {
  calls.length = 0;
  operationError = null;
  operationResults = {
    create: {
      ok: true,
      code: "subscription_pending",
      status: "pending_subscribe",
      subscription: { callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" },
    },
    list: [{ callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" }],
    get: { callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" },
    renew: {
      ok: true,
      code: "renewal_pending",
      status: "pending_renewal",
      subscription: { callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" },
    },
    unsubscribe: {
      ok: true,
      code: "unsubscribe_pending",
      status: "pending_unsubscribe",
      subscription: { callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" },
    },
    ...results,
  };
  bindingRows = [
    {
      id: "123",
      eventCode: "CC-ROUTE",
      provider: "youtube",
      channel: "youtube",
      providerAccountId: "UCrouteSafeChannel123456789",
      status: "active",
      displayName: "Main YouTube",
    },
  ];
  operatorEvent = { code: "CC-ROUTE", vertical: "codeclip" };
}

function callApp({ method = "GET", path, body = null, adminKey = "route-admin-secret" }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "localhost",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    };
    if (adminKey !== null) req.headers["x-admin-key"] = adminKey;

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

function assertNoSecretLeak(response) {
  const text = response.text;
  for (const forbidden of ["route-admin-secret", "root-secret", "derived-secret", "hub.secret"]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

test("YouTube WebSub operator routes require admin key", async () => {
  reset();
  const missing = await callApp({
    method: "GET",
    path: "/internal/codeclip/youtube-websub/subscriptions",
    adminKey: null,
  });
  const wrong = await callApp({
    method: "GET",
    path: "/internal/codeclip/youtube-websub/subscriptions",
    adminKey: "wrong",
  });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(calls.length, 0);
});

test("YouTube WebSub create route calls operation with body and database pool", async () => {
  reset();
  const response = await callApp({
    method: "POST",
    path: "/internal/codeclip/youtube-websub/subscriptions",
    body: {
      eventCode: "CC-ROUTE",
      providerAccountId: "UCrouteSafeChannel123456789",
      leaseSeconds: 864000,
    },
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.code, "subscription_pending");
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1].eventCode, "CC-ROUTE");
  assert.equal(calls[0][2].queryClient, queryClient);
  assertNoSecretLeak(response);
});

test("YouTube WebSub binding create route resolves raw account server-side", async () => {
  reset();
  const response = await callApp({
    method: "POST",
    path: "/internal/codeclip/provider-bindings/123/youtube-websub/subscription",
    body: { leaseSeconds: 864000, providerAccountId: "attacker-input" },
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.code, "subscription_pending");
  assert.deepEqual(calls.map((call) => call[0]), ["getBindingById", "create"]);
  assert.equal(calls[0][2].queryClient, queryClient);
  assert.equal(calls[1][1].eventCode, "CC-ROUTE");
  assert.equal(calls[1][1].providerAccountId, "UCrouteSafeChannel123456789");
  assert.equal(calls[1][1].leaseSeconds, 864000);
  assertNoSecretLeak(response);
});

test("YouTube WebSub list and get routes are read-only operation calls", async () => {
  reset();
  const list = await callApp({
    path: "/internal/codeclip/youtube-websub/subscriptions?status=active&providerAccountId=UCrouteSafeChannel123456789",
  });
  const get = await callApp({
    path: "/internal/codeclip/youtube-websub/subscriptions/yt_route_cb",
  });

  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items, operationResults.list);
  assert.equal(calls[0][0], "list");
  assert.equal(calls[0][1].status, "active");
  assert.equal(calls[0][2].queryClient, queryClient);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.subscription, operationResults.get);
  assert.equal(calls[1][0], "get");
  assert.equal(calls[1][1], "yt_route_cb");
});

test("YouTube WebSub episode route joins public bindings with subscription status", async () => {
  reset({
    list: [{
      callbackId: "yt_route_cb",
      providerAccountId: "UCrouteSafeChannel123456789",
      topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrouteSafeChannel123456789",
      status: "active",
      operatorStatus: "active",
      leaseExpiresAt: "2026-07-20T00:00:00.000Z",
      lastOperation: { mode: "subscribe", resultCode: "hub_request_accepted" },
    }],
  });
  const response = await callApp({
    path: "/internal/codeclip/events/CC-ROUTE/youtube-websub/subscriptions?includeDisabled=true",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.eventCode, "CC-ROUTE");
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].binding.provider, "youtube");
  assert.equal(response.body.items[0].binding.maskedAccountId, "****************6789");
  assert.equal(response.body.items[0].binding.providerAccountId, undefined);
  assert.equal(response.body.items[0].subscription.callbackId, "yt_route_cb");
  assert.equal(response.body.items[0].subscription.providerAccountId, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["getCampaignByCode", "listBindingsForEvent", "list"]);
  assert.equal(calls[1][1], "CC-ROUTE");
  assert.equal(calls[1][2].includeDisabled, true);
  assert.equal(calls[2][1].providerAccountId, "UCrouteSafeChannel123456789");
  assertNoSecretLeak(response);
});

test("YouTube WebSub renew and unsubscribe routes call operation without exposing secrets", async () => {
  reset();
  const renew = await callApp({
    method: "POST",
    path: "/internal/codeclip/youtube-websub/subscriptions/yt_route_cb/renew",
    body: { leaseSeconds: 864000 },
  });
  const unsubscribe = await callApp({
    method: "POST",
    path: "/internal/codeclip/youtube-websub/subscriptions/yt_route_cb/unsubscribe",
    body: {},
  });

  assert.equal(renew.status, 202);
  assert.equal(renew.body.code, "renewal_pending");
  assert.equal(calls[0][0], "renew");
  assert.equal(calls[0][1], "yt_route_cb");
  assert.equal(calls[0][3].queryClient, queryClient);
  assert.equal(unsubscribe.status, 202);
  assert.equal(unsubscribe.body.code, "unsubscribe_pending");
  assert.equal(calls[1][0], "unsubscribe");
  assertNoSecretLeak(renew);
  assertNoSecretLeak(unsubscribe);
});

test("YouTube WebSub renew route maps missing dispatch claim to conflict", async () => {
  reset({
    renew: {
      ok: false,
      code: "subscription_state_conflict",
      status: "pending_renewal",
      dispatchClaimed: false,
      subscription: { callbackId: "yt_route_cb", providerAccountId: "UCrouteSafeChannel123456789" },
    },
  });
  const response = await callApp({
    method: "POST",
    path: "/internal/codeclip/youtube-websub/subscriptions/yt_route_cb/renew",
    body: {},
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "subscription_state_conflict");
  assert.equal(calls[0][0], "renew");
  assertNoSecretLeak(response);
});

test("YouTube WebSub operator routes map public-safe operation errors", async () => {
  reset();
  operationError = new StubOperationError("authentication_unavailable");
  const response = await callApp({
    method: "POST",
    path: "/internal/codeclip/youtube-websub/subscriptions",
    body: { eventCode: "CC-ROUTE" },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: "YouTube WebSub subscription operation failed",
    code: "authentication_unavailable",
  });
  assertNoSecretLeak(response);
});
