const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizeCodeClipProviderPollAdapterInput,
  normalizeCodeClipProviderPollAdapterResult,
} = require("./verticals/codeclip/provider-polling/adapter-contract");
const {
  createCodeClipProductionPollAdapterRegistry,
} = require("./verticals/codeclip/provider-polling/production-adapter-registry");

const TOKEN = "registry-tiktok-token-secret";

function responsePage() {
  return {
    data: { videos: [], cursor: 0, has_more: false },
    error: { code: "ok", message: "", log_id: "" },
  };
}

function fetchHarness() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      headers: { get: () => "application/json" },
      async text() {
        return JSON.stringify(responsePage());
      },
    };
  };
  return { fetchImpl, calls };
}

function input() {
  return normalizeCodeClipProviderPollAdapterInput({
    provider: "tiktok",
    environment: "sandbox",
    providerAccountId: "OpenId_TikTok_Account_1",
    accessToken: TOKEN,
    checkpoint: {},
    now: "2026-08-05T12:00:00.000Z",
    limit: 25,
  });
}

test("production adapter registry public API is exact", () => {
  const mod = require("./verticals/codeclip/provider-polling/production-adapter-registry");
  assert.deepEqual(Object.keys(mod).sort(), [
    "createCodeClipProductionPollAdapterRegistry",
  ]);
});

test("factory creates isolated registries with TikTok only", () => {
  const first = createCodeClipProductionPollAdapterRegistry();
  const second = createCodeClipProductionPollAdapterRegistry();
  assert.deepEqual(first.list().map((d) => d.provider), ["tiktok"]);
  assert.deepEqual(second.list().map((d) => d.provider), ["tiktok"]);
  assert.notEqual(first.get("tiktok"), second.get("tiktok"));
  assert.throws(() => first.get("youtube"), /no poll adapter registered/i);
});

test("TikTok descriptor is frozen and no global duplicate state leaks", () => {
  const registry = createCodeClipProductionPollAdapterRegistry();
  const descriptor = registry.get("tiktok");
  assert.equal(Object.isFrozen(descriptor), true);
  assert.deepEqual(Object.keys(descriptor).sort(), ["poll", "provider"]);
  assert.equal(typeof descriptor.poll, "function");
  const listed = registry.list();
  listed.push({ provider: "youtube", poll: () => {} });
  assert.deepEqual(registry.list().map((d) => d.provider), ["tiktok"]);

  const another = createCodeClipProductionPollAdapterRegistry();
  assert.deepEqual(another.list().map((d) => d.provider), ["tiktok"]);
});

test("injected TikTok HTTP dependencies reach adapter", async () => {
  const harness = fetchHarness();
  const registry = createCodeClipProductionPollAdapterRegistry({
    tiktok: { fetchImpl: harness.fetchImpl, timeoutMs: 1000 },
  });
  const result = normalizeCodeClipProviderPollAdapterResult(
    await registry.get("tiktok").poll(input()),
    { provider: "tiktok" }
  );
  assert.equal(result.ok, true);
  assert.equal(harness.calls.length, 1);
  assert.equal(JSON.parse(harness.calls[0].init.body).max_count, 20);
  assert.equal(harness.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test("production registry has no server, worker, YouTube, or env side effects", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "verticals/codeclip/provider-polling/production-adapter-registry.js"
    ),
    "utf8"
  );
  assert.equal(/require\(["'].*server|require\(["'].*youtube|process\.env|setInterval|listen\(/i.test(source), false);
  assert.equal(/createCodeClipProviderPollAdapterRegistry/.test(source), true);
  assert.equal(/createCodeClipTikTokPollAdapter/.test(source), true);
});
