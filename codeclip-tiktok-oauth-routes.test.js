const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const connectionModulePath = require.resolve(
  "./verticals/codeclip/tiktok/oauth-connection"
);

const queryClient = { name: "codeclip-tiktok-oauth-route-test-pool" };
const startCalls = [];
const completeCalls = [];
let startResult = null;
let startError = null;
let completeResult = null;
let completeError = null;

class StubConnectionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CodeClipTikTokOAuthConnectionError";
    this.code = code;
    this.details = {};
  }
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
    getCampaignByCode: async () => ({
      event_code: "CC-TIKTOK-1",
      vertical: "codeclip",
    }),
  },
};

require.cache[connectionModulePath] = {
  id: connectionModulePath,
  filename: connectionModulePath,
  loaded: true,
  exports: {
    CodeClipTikTokOAuthConnectionError: StubConnectionError,
    startCodeClipTikTokOAuthConnection: async (input, options) => {
      startCalls.push({ input, options });
      if (startError) throw startError;
      return startResult;
    },
    completeCodeClipTikTokOAuthConnection: async (input, options) => {
      completeCalls.push({ input, options });
      if (completeError) throw completeError;
      return completeResult;
    },
  },
};

process.env.CODECLIP_ADMIN_KEY = "tiktok-route-admin-secret";
delete require.cache[require.resolve("./server")];
const { app } = require("./server");

const START_ROUTE = "/api/codeclip/providers/tiktok/oauth/start";
const CALLBACK_ROUTE = "/api/codeclip/providers/tiktok/oauth/callback";
const AUTH_CODE = "route-auth-code-secret";
const RAW_STATE = "route-state-secret";
const OPEN_ID = "route-open-id-secret";
const RETURN_SAFE = "https://app.example.test/checkout/tiktok";

function resetMocks() {
  startCalls.length = 0;
  completeCalls.length = 0;
  startResult = {
    ok: true,
    authorizationUrl:
      "https://www.tiktok.com/v2/auth/authorize/?client_key=ck&state=s&scope=user.info.basic",
    expiresAt: "2026-08-05T12:10:00.000Z",
  };
  startError = null;
  completeResult = {
    ok: true,
    status: "connected",
    redirectUrl: `${RETURN_SAFE}?tiktok=connected`,
    eventCode: "CC-TIKTOK-1",
  };
  completeError = null;
}

function callApp({
  method = "GET",
  path,
  body = null,
  adminKey = "tiktok-route-admin-secret",
}) {
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
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      resolve({
        status: res.statusCode,
        headers: res.headers,
        text,
        body: parsed,
      });
    };

    app.handle(req, res, reject);
  });
}

test("start route requires admin auth", async () => {
  resetMocks();
  const missing = await callApp({
    method: "POST",
    path: START_ROUTE,
    body: {
      eventCode: "CC-TIKTOK-1",
      environment: "sandbox",
      returnUrl: RETURN_SAFE,
    },
    adminKey: null,
  });
  assert.equal(missing.status, 401);
  assert.equal(startCalls.length, 0);
});

test("start route returns authorization URL without raw state", async () => {
  resetMocks();
  const response = await callApp({
    method: "POST",
    path: START_ROUTE,
    body: {
      eventCode: "CC-TIKTOK-1",
      environment: "sandbox",
      returnUrl: RETURN_SAFE,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.authorizationUrl, "string");
  assert.equal(typeof response.body.expiresAt, "string");
  assert.equal(Object.hasOwn(response.body, "rawState"), false);
  assert.equal(Object.hasOwn(response.body, "state"), false);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].input.eventCode, "CC-TIKTOK-1");
  assert.equal(startCalls[0].options.queryClient, queryClient);
});

test("start route maps config errors safely", async () => {
  resetMocks();
  startError = new StubConnectionError("TIKTOK_CONFIG_NOT_AVAILABLE", "not configured");
  const response = await callApp({
    method: "POST",
    path: START_ROUTE,
    body: {
      eventCode: "CC-TIKTOK-1",
      environment: "sandbox",
      returnUrl: RETURN_SAFE,
    },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
  assert.equal(response.text.includes(AUTH_CODE), false);
});

test("callback route is public and redirects on success", async () => {
  resetMocks();
  const response = await callApp({
    method: "GET",
    path: `${CALLBACK_ROUTE}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(RAW_STATE)}&eventCode=ATTACKER&returnUrl=${encodeURIComponent("https://evil.example.test/")}`,
    adminKey: null,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${RETURN_SAFE}?tiktok=connected`);
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].input.code, AUTH_CODE);
  assert.equal(completeCalls[0].input.state, RAW_STATE);
  assert.equal(completeCalls[0].options.queryClient, queryClient);
  assert.equal(String(response.headers.location).includes(AUTH_CODE), false);
  assert.equal(String(response.headers.location).includes(RAW_STATE), false);
  assert.equal(String(response.headers.location).includes(OPEN_ID), false);
  assert.equal(response.text.includes(AUTH_CODE), false);
});

test("callback cancellation redirects safely", async () => {
  resetMocks();
  completeResult = {
    ok: false,
    status: "authorization_cancelled",
    redirectUrl: `${RETURN_SAFE}?tiktok=authorization_cancelled`,
    eventCode: "CC-TIKTOK-1",
  };
  const response = await callApp({
    method: "GET",
    path: `${CALLBACK_ROUTE}?state=${encodeURIComponent(RAW_STATE)}&error=access_denied&error_description=${encodeURIComponent("User cancelled")}`,
    adminKey: null,
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    `${RETURN_SAFE}?tiktok=authorization_cancelled`
  );
  assert.equal(response.text.includes("User cancelled"), false);
  assert.equal(String(response.headers.location).includes("User cancelled"), false);
});

test("callback binding conflict redirects", async () => {
  resetMocks();
  completeResult = {
    ok: false,
    status: "binding_conflict",
    redirectUrl: `${RETURN_SAFE}?tiktok=binding_conflict`,
    errorCode: "BINDING_CONFLICT",
  };
  const response = await callApp({
    method: "GET",
    path: `${CALLBACK_ROUTE}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(RAW_STATE)}`,
    adminKey: null,
  });
  assert.equal(response.status, 302);
  assert.match(String(response.headers.location), /tiktok=binding_conflict/);
});

test("callback internal failure returns safe JSON without secrets", async () => {
  resetMocks();
  completeError = new StubConnectionError(
    "OAUTH_STATE_NOT_FOUND",
    `missing ${AUTH_CODE} ${RAW_STATE} ${OPEN_ID}`
  );
  const response = await callApp({
    method: "GET",
    path: `${CALLBACK_ROUTE}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(RAW_STATE)}`,
    adminKey: null,
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, "OAUTH_STATE_NOT_FOUND");
  assert.equal(response.text.includes(AUTH_CODE), false);
  assert.equal(response.text.includes(RAW_STATE), false);
  assert.equal(response.text.includes(OPEN_ID), false);
});
