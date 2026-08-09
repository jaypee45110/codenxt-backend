const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH =
  "./verticals/codeclip/provider-polling/production-credential-refresh-registry";

test("production credential refresh registry public API is exact", () => {
  const registryModule = require(MODULE_PATH);
  assert.deepEqual(Object.keys(registryModule).sort(), [
    "createCodeClipProductionCredentialRefreshRegistry",
  ]);

  const registry = registryModule.createCodeClipProductionCredentialRefreshRegistry();
  assert.deepEqual(Object.keys(registry).sort(), ["get", "list"]);
  assert.equal(typeof registry.get("tiktok"), "function");
  assert.equal(registry.get("youtube"), null);
  assert.deepEqual(registry.list(), [{ provider: "tiktok" }]);
});

test("production credential refresh registry passes runtime options safely", async () => {
  const registryPath = require.resolve(MODULE_PATH);
  const tiktokRefreshPath = require.resolve(
    "./verticals/codeclip/tiktok/credential-refresh"
  );
  const originals = new Map(
    [registryPath, tiktokRefreshPath].map((key) => [key, require.cache[key]])
  );
  const calls = [];

  delete require.cache[registryPath];
  require.cache[tiktokRefreshPath] = {
    id: tiktokRefreshPath,
    filename: tiktokRefreshPath,
    loaded: true,
    exports: {
      refreshCodeClipTikTokCredential: async (input, options) => {
        calls.push({ input, options });
        return { ok: true, status: "refreshed", credentialId: input.credentialId };
      },
    },
  };

  try {
    const {
      createCodeClipProductionCredentialRefreshRegistry,
    } = require(MODULE_PATH);
    const fetchImpl = async () => ({});
    const registry = createCodeClipProductionCredentialRefreshRegistry({
      tiktok: { fetchImpl, timeoutMs: 1234 },
    });
    const result = await registry.get("tiktok")(
      { credentialId: "9", owner: "worker.refresh" },
      { queryClient: { query: async () => ({ rows: [] }) }, env: { SAFE: "1" } }
    );

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.credentialId, "9");
    assert.equal(calls[0].options.fetchImpl, fetchImpl);
    assert.equal(calls[0].options.timeoutMs, 1234);
    assert.equal(calls[0].options.env.SAFE, "1");
  } finally {
    delete require.cache[registryPath];
    for (const [key, value] of originals) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  }
});
