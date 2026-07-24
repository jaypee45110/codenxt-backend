const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);
const opsModulePath = require.resolve("./verticals/codeclip/youtube-websub-diagnostic-operations");
const callbackModulePath = require.resolve("./verticals/codeclip/youtube-websub-diagnostic-callback");

const queryClient = { name: "diagnostic-route-pool" };
const calls = [];
let operationResults = {};
let operationError = null;
let callbackResults = {};
let callbackError = null;

class StubDiagnosticOperationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodeClipYouTubeWebSubDiagnosticOperationError";
    this.code = code;
  }
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: { ...originalDb, pool: queryClient },
};

require.cache[opsModulePath] = {
  id: opsModulePath,
  filename: opsModulePath,
  loaded: true,
  exports: {
    CodeClipYouTubeWebSubDiagnosticOperationError: StubDiagnosticOperationError,
    createCodeClipYouTubeWebSubDiagnosticProbeOperation: async (body, options) => {
      calls.push(["start", body, options]);
      if (operationError) throw operationError;
      return operationResults.start;
    },
    getCodeClipYouTubeWebSubDiagnosticProbeStatus: async (probeId, options) => {
      calls.push(["status", probeId, options]);
      if (operationError) throw operationError;
      return operationResults.status;
    },
    unsubscribeCodeClipYouTubeWebSubDiagnosticProbeOperation: async (probeId, body, options) => {
      calls.push(["cleanup", probeId, body, options]);
      if (operationError) throw operationError;
      return operationResults.cleanup;
    },
  },
};

require.cache[callbackModulePath] = {
  id: callbackModulePath,
  filename: callbackModulePath,
  loaded: true,
  exports: {
    verifyCodeClipYouTubeWebSubDiagnosticCallback: async (input, options) => {
      calls.push(["verify", input, options]);
      if (callbackError) throw callbackError;
      return callbackResults.verify;
    },
    processCodeClipYouTubeWebSubDiagnosticNotification: async (input, options) => {
      calls.push(["post", input, options]);
      if (callbackError) throw callbackError;
      return callbackResults.post;
    },
  },
};

process.env.CODECLIP_ADMIN_KEY = "route-admin-secret";
const { app } = require("./server");

function reset() {
  calls.length = 0;
  operationError = null;
  callbackError = null;
  operationResults = {
    start: { ok: true, code: "diagnostic_subscribe_pending", probe: { probeId: "diag_probeRoute123", callbackId: "diag_y...1234" } },
    status: { ok: true, probe: { probeId: "diag_probeRoute123", callbackId: "diag_y...1234", observationCount: 0 } },
    cleanup: { ok: true, code: "diagnostic_unsubscribe_pending", probe: { probeId: "diag_probeRoute123" } },
  };
  callbackResults = {
    verify: { accepted: true, httpStatus: 200, challenge: "challenge-text" },
    post: { accepted: true, httpStatus: 204, publicBody: null },
  };
}

function callApp({ method = "GET", path, body = null, headers = {}, adminKey = "route-admin-secret" }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body)
      ? body
      : Buffer.from(body === null ? "" : JSON.stringify(body));
    const req = Readable.from(payload.length ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: "attacker.example",
      "content-type": Buffer.isBuffer(body) ? "application/atom+xml" : "application/json",
      "content-length": String(payload.length),
      ...headers,
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
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => { delete res.headers[String(name).toLowerCase()]; };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch {}
      resolve({ status: res.statusCode, headers: res.headers, text, body: parsed });
    };
    app.handle(req, res, reject);
  });
}

test("diagnostic internal routes require admin key and call operations with database pool", async () => {
  reset();
  const denied = await callApp({ method: "POST", path: "/internal/codeclip/youtube-websub/diagnostic-probes", body: { channelId: "UCvwiNkgNuGuizjo33NZhzPg" }, adminKey: null });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);

  const started = await callApp({ method: "POST", path: "/internal/codeclip/youtube-websub/diagnostic-probes", body: { channelId: "UCvwiNkgNuGuizjo33NZhzPg", callbackId: "attacker" } });
  assert.equal(started.status, 202);
  assert.equal(started.headers["cache-control"], "no-store");
  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].channelId, "UCvwiNkgNuGuizjo33NZhzPg");
  assert.equal(calls[0][2].queryClient, queryClient);

  const status = await callApp({ path: "/internal/codeclip/youtube-websub/diagnostic-probes/diag_probeRoute123" });
  assert.equal(status.status, 200);
  assert.equal(calls[1][0], "status");

  const cleanup = await callApp({ method: "POST", path: "/internal/codeclip/youtube-websub/diagnostic-probes/diag_probeRoute123/unsubscribe", body: {} });
  assert.equal(cleanup.status, 202);
  assert.equal(calls[2][0], "cleanup");
  assert.equal(JSON.stringify(cleanup.body).includes("route-admin-secret"), false);
});

test("diagnostic GET callback returns text challenge and POST returns 204", async () => {
  reset();
  const get = await callApp({
    path: "/api/codeclip/diagnostics/youtube/websub/diag_yt_callbackRoute1234?hub.mode=subscribe&hub.topic=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fchannel_id%3DUCvwiNkgNuGuizjo33NZhzPg&hub.challenge=challenge-text&hub.lease_seconds=86400",
    adminKey: null,
  });
  assert.equal(get.status, 200);
  assert.equal(get.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(get.text, "challenge-text");
  assert.equal(calls[0][0], "verify");

  const post = await callApp({
    method: "POST",
    path: "/api/codeclip/diagnostics/youtube/websub/diag_yt_callbackRoute1234",
    body: Buffer.from("<feed/>"),
    headers: { "content-type": "application/atom+xml" },
    adminKey: null,
  });
  assert.equal(post.status, 204);
  assert.equal(post.text, "");
  assert.equal(calls[1][0], "post");
  assert.equal(Buffer.isBuffer(calls[1][1].rawBody), true);
});

test("diagnostic callback rejects wrong path without hitting runtime", async () => {
  reset();
  const response = await callApp({
    method: "POST",
    path: "/api/codeclip/diagnostics/youtube/websub/diag_yt_callbackRoute1234/extra",
    body: Buffer.from("<feed/>"),
    headers: { "content-type": "application/atom+xml" },
    adminKey: null,
  });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});
