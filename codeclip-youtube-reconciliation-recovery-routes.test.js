const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const recoveryModulePath = require.resolve("./verticals/codeclip/youtube-reconciliation-recovery");

const queryClient = { name: "youtube-reconciliation-recovery-route-pool", query: async () => ({ rows: [] }) };
const calls = [];
let dryRunResult = { ok: true, status: "eligible", confirmationToken: "token", candidate: {} };
let executeResult = { ok: true, status: "execution_completed", candidate: {} };

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    pool: queryClient,
  },
};

require.cache[recoveryModulePath] = {
  id: recoveryModulePath,
  filename: recoveryModulePath,
  loaded: true,
  exports: {
    dryRunCodeClipYouTubeReconciliationRecovery: async (body, options) => {
      calls.push(["dry-run", body, options]);
      return dryRunResult;
    },
    executeCodeClipYouTubeReconciliationRecovery: async (body, options) => {
      calls.push(["execute", body, options]);
      return executeResult;
    },
  },
};

process.env.CODECLIP_ADMIN_KEY = "recovery-route-admin-secret";
const { app } = require("./server");

function reset() {
  calls.length = 0;
  dryRunResult = { ok: true, status: "eligible", confirmationToken: "token", candidate: {} };
  executeResult = { ok: true, status: "execution_completed", candidate: {} };
}

function callApp({
  method = "POST",
  path,
  body = {},
  rawBody = null,
  adminKey = "recovery-route-admin-secret",
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === null ? JSON.stringify(body) : rawBody;
    const req = Readable.from([payload]);
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
      resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
    };
    res.on("error", reject);
    app.handle(req, res);
  });
}

test("YouTube reconciliation recovery routes require codeClip admin key", async () => {
  reset();
  const denied = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    adminKey: null,
  });

  assert.equal(denied.status, 401);
  assert.equal(denied.headers["cache-control"], "no-store");
  assert.equal(calls.length, 0);

  const wrong = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    adminKey: "wrong-admin-key",
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["cache-control"], "no-store");
  assert.equal(calls.length, 0);
});

test("YouTube reconciliation recovery routes call operations with pool and no-store", async () => {
  reset();
  const dryRun = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    body: { provider: "youtube" },
  });
  const execute = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/execute",
    body: { provider: "youtube", confirm: true },
  });

  assert.equal(dryRun.status, 200);
  assert.equal(execute.status, 202);
  assert.equal(dryRun.headers["cache-control"], "no-store");
  assert.equal(execute.headers["cache-control"], "no-store");
  assert.equal(calls[0][0], "dry-run");
  assert.equal(calls[0][2].queryClient, queryClient);
  assert.equal(calls[0][2].adminSecret, "recovery-route-admin-secret");
  assert.equal(calls[1][0], "execute");
});

test("YouTube reconciliation recovery routes map safe operation statuses", async () => {
  reset();
  dryRunResult = { ok: false, status: "already_delivered", error: { code: "already_delivered", message: "safe" } };
  executeResult = { ok: false, status: "stale_confirmation", error: { code: "stale_confirmation", message: "safe" } };

  const dryRun = await callApp({ path: "/internal/codeclip/youtube-reconciliation/dry-run" });
  const execute = await callApp({ path: "/internal/codeclip/youtube-reconciliation/execute" });

  assert.equal(dryRun.status, 409);
  assert.equal(dryRun.body.code, "already_delivered");
  assert.equal(execute.status, 409);
  assert.equal(execute.body.code, "stale_confirmation");
});

test("YouTube reconciliation recovery routes reject unknown fields and malformed execute types", async () => {
  reset();

  const dryRunUnknown = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    body: {
      provider: "youtube",
      channelId: "UCvwiNkgNuGuizjo33NZhzPg",
      videoId: "LdSe5-sM5e0",
      eventCode: "CT-80410",
      externalMessageId: "youtube:UCvwiNkgNuGuizjo33NZhzPg:LdSe5-sM5e0:published",
      unexpected: true,
    },
  });
  assert.equal(dryRunUnknown.status, 400);
  assert.equal(dryRunUnknown.headers["cache-control"], "no-store");
  assert.equal(dryRunUnknown.body.code, "invalid_candidate");

  const executeUnknown = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/execute",
    body: {
      provider: "youtube",
      channelId: "UCvwiNkgNuGuizjo33NZhzPg",
      videoId: "LdSe5-sM5e0",
      eventCode: "CT-80410",
      externalMessageId: "youtube:UCvwiNkgNuGuizjo33NZhzPg:LdSe5-sM5e0:published",
      confirmationToken: "token",
      confirm: true,
      nested: { extra: true },
    },
  });
  assert.equal(executeUnknown.status, 400);
  assert.equal(executeUnknown.headers["cache-control"], "no-store");
  assert.equal(executeUnknown.body.code, "invalid_candidate");

  const badConfirm = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/execute",
    body: {
      provider: "youtube",
      channelId: "UCvwiNkgNuGuizjo33NZhzPg",
      videoId: "LdSe5-sM5e0",
      eventCode: "CT-80410",
      externalMessageId: "youtube:UCvwiNkgNuGuizjo33NZhzPg:LdSe5-sM5e0:published",
      confirmationToken: "token",
      confirm: "true",
    },
  });
  assert.equal(badConfirm.status, 400);
  assert.equal(badConfirm.body.code, "invalid_candidate");

  const badToken = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/execute",
    body: {
      provider: "youtube",
      channelId: "UCvwiNkgNuGuizjo33NZhzPg",
      videoId: "LdSe5-sM5e0",
      eventCode: "CT-80410",
      externalMessageId: "youtube:UCvwiNkgNuGuizjo33NZhzPg:LdSe5-sM5e0:published",
      confirmationToken: 42,
      confirm: true,
    },
  });
  assert.equal(badToken.status, 400);
  assert.equal(badToken.body.code, "invalid_candidate");

  assert.equal(calls.length, 0);
});

test("YouTube reconciliation recovery routes return no-store for operator secret and parser failures", async () => {
  reset();
  const previousSecret = process.env.CODECLIP_ADMIN_KEY;
  process.env.CODECLIP_ADMIN_KEY = "";
  const unavailable = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    adminKey: "recovery-route-admin-secret",
  });
  process.env.CODECLIP_ADMIN_KEY = previousSecret;

  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers["cache-control"], "no-store");
  assert.equal(calls.length, 0);

  const malformed = await callApp({
    path: "/internal/codeclip/youtube-reconciliation/dry-run",
    rawBody: "{\"provider\":\"youtube\"",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers["cache-control"], "no-store");
  assert.equal(malformed.body.code, "invalid_candidate");
  assert.equal(calls.length, 0);
});
