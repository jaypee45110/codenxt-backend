const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const MODULE_PATH = "./verticals/codeclip/provider-polling/worker-core";
const OPERATION_NOW = "2026-08-05T12:00:00.000Z";
const TOKEN = "secret-token-must-not-leak";
const ACCOUNT_ID = "provider-account-must-not-leak";
const CHECKPOINT = "checkpoint-must-not-leak";
const OWNER_PREFIX = "test.worker";

function pool() {
  return {
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    async query() {
      return { rows: [] };
    },
  };
}

function registry() {
  return {
    get(provider) {
      return { provider, poll: async () => ({}) };
    },
    list() {
      return [{ provider: "tiktok", poll: async () => ({}) }];
    },
  };
}

function source(id, extra = {}) {
  return {
    id: String(id),
    provider: extra.provider || "tiktok",
    environment: extra.environment || "sandbox",
    providerAccountId: ACCOUNT_ID,
    checkpoint: { value: CHECKPOINT },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadWorkerCore({
  listDue = async () => ({ items: [] }),
  pollSource = async (input) => ({
    ok: true,
    classification: "empty",
    detectionCount: 0,
    createdCount: 0,
    existingCount: 0,
    pageComplete: true,
    nextPollAt: "2026-08-05T12:05:00.000Z",
    sourceId: input.sourceId,
  }),
  createRegistry = () => registry(),
  createRefreshRegistry = () => ({ get: () => null, list: () => [] }),
} = {}) {
  const workerPath = require.resolve(MODULE_PATH);
  const pollSourcesPath = require.resolve("./verticals/codeclip/provider-poll-sources");
  const servicePath = require.resolve("./verticals/codeclip/provider-polling/service");
  const registryPath = require.resolve("./verticals/codeclip/provider-polling/production-adapter-registry");
  const refreshRegistryPath = require.resolve(
    "./verticals/codeclip/provider-polling/production-credential-refresh-registry"
  );

  const originals = new Map(
    [workerPath, pollSourcesPath, servicePath, registryPath, refreshRegistryPath].map((key) => [
      key,
      require.cache[key],
    ])
  );

  delete require.cache[workerPath];
  require.cache[pollSourcesPath] = {
    id: pollSourcesPath,
    filename: pollSourcesPath,
    loaded: true,
    exports: { listDueCodeClipProviderPollSources: listDue },
  };
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { pollCodeClipProviderSource: pollSource },
  };
  require.cache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: { createCodeClipProductionPollAdapterRegistry: createRegistry },
  };
  require.cache[refreshRegistryPath] = {
    id: refreshRegistryPath,
    filename: refreshRegistryPath,
    loaded: true,
    exports: {
      createCodeClipProductionCredentialRefreshRegistry: createRefreshRegistry,
    },
  };

  const mod = require(MODULE_PATH);
  function restore() {
    delete require.cache[workerPath];
    for (const [key, value] of originals) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  }
  return { mod, restore };
}

async function withWorker(mocks, fn) {
  const loaded = loadWorkerCore(mocks);
  try {
    return await fn(loaded.mod);
  } finally {
    loaded.restore();
  }
}

function assertWorkerError(error, code) {
  assert.equal(error.name, "CodeClipProviderPollingWorkerCoreError");
  assert.equal(error.code, code);
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(ACCOUNT_ID), false);
  assert.equal(serialized.includes(CHECKPOINT), false);
  assert.equal(serialized.includes("SELECT "), false);
}

test("public API is exact and module has no console logging", async () => {
  await withWorker({}, async (worker) => {
    assert.deepEqual(Object.keys(worker).sort(), [
      "CodeClipProviderPollingWorkerCoreError",
      "runCodeClipProviderPollingWorkerCycle",
    ].sort());
  });

  const sourceText = fs.readFileSync(require.resolve(MODULE_PATH), "utf8");
  assert.equal(/console\./.test(sourceText), false);
  for (const key of [
    "buildOwner",
    "summarizeServiceResult",
    "normalizeOwnerPrefix",
    "DEFAULT_LIMIT",
  ]) {
    assert.equal(sourceText.includes(`module.exports.${key}`), false);
  }
});

test("valid defaults use production registry, scan once, and return zero-due summary", async () => {
  let createdRegistry = 0;
  const scans = [];
  await withWorker(
    {
      createRegistry: () => {
        createdRegistry += 1;
        return registry();
      },
      listDue: async (filters, deps) => {
        scans.push({ filters, deps });
        return { items: [] };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { now: OPERATION_NOW },
        { queryClient: pool() }
      );
      assert.equal(createdRegistry, 1);
      assert.equal(scans.length, 1);
      assert.equal(scans[0].filters.limit, 25);
      assert.equal(scans[0].filters.provider, undefined);
      assert.equal(scans[0].filters.environment, undefined);
      assert.equal(scans[0].filters.now, OPERATION_NOW);
      assert.equal(scans[0].deps.queryClient.connect instanceof Function, true);
      assert.deepEqual(result, {
        ok: true,
        status: "completed",
        provider: null,
        environment: null,
        scanned: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        startedAt: OPERATION_NOW,
        completedAt: OPERATION_NOW,
        durationMs: 0,
        items: [],
      });
    }
  );
});

test("input validation rejects invalid dependencies and public options", async () => {
  await withWorker({}, async ({ runCodeClipProviderPollingWorkerCycle }) => {
    const valid = { queryClient: pool(), adapterRegistry: registry() };
    for (const [input, deps, code] of [
      [{}, {}, "DATABASE_UNAVAILABLE"],
      [{}, { queryClient: { query: async () => ({ rows: [] }) }, adapterRegistry: registry() }, "DATABASE_UNAVAILABLE"],
      [{ limit: 0 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ limit: 101 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ limit: "1" }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ concurrency: 0 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ concurrency: 17 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ environment: "dev" }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ environment: 1 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ provider: "bad provider" }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ provider: 1 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ ownerPrefix: "Bad Owner" }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ leaseMs: 4_999 }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ leaseMs: "60000" }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{ signal: { aborted: "false" } }, valid, "INVALID_WORKER_CYCLE_INPUT"],
      [{}, { queryClient: pool(), adapterRegistry: {} }, "ADAPTER_REGISTRY_NOT_AVAILABLE"],
      [{}, { queryClient: pool(), adapterRegistry: { provider: "tiktok", poll: async () => ({}) } }, "ADAPTER_REGISTRY_NOT_AVAILABLE"],
      [{}, { queryClient: pool(), adapterRegistry: registry(), credentialRefreshRegistry: {} }, "CREDENTIAL_REFRESH_REGISTRY_NOT_AVAILABLE"],
    ]) {
      await assert.rejects(
        () => runCodeClipProviderPollingWorkerCycle(input, deps),
        (error) => {
          assertWorkerError(error, code);
          return true;
        }
      );
    }
  });
});

test("due scan forwards filters and maps scan failure to typed global error", async () => {
  const scans = [];
  await withWorker(
    {
      listDue: async (filters) => {
        scans.push(filters);
        return { items: [] };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      await runCodeClipProviderPollingWorkerCycle(
        {
          provider: "tiktok",
          environment: "sandbox",
          limit: 7,
          now: OPERATION_NOW,
        },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.deepEqual(scans[0], {
        limit: 7,
        provider: "tiktok",
        environment: "sandbox",
        now: OPERATION_NOW,
      });
    }
  );

  await withWorker(
    {
      listDue: async () => {
        throw new Error(`database exploded ${ACCOUNT_ID}`);
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      await assert.rejects(
        () =>
          runCodeClipProviderPollingWorkerCycle(
            { now: OPERATION_NOW },
            { queryClient: pool(), adapterRegistry: registry() }
          ),
        (error) => {
          assertWorkerError(error, "DUE_SOURCE_SCAN_FAILED");
          assert.equal(error.underlyingCode, undefined);
          const serialized = JSON.stringify(error);
          assert.equal(serialized.includes("database exploded"), false);
          assert.equal(serialized.includes(ACCOUNT_ID), false);
          return true;
        }
      );
    }
  );
});

test("due-source scan maps network system codes to DATABASE_UNAVAILABLE with safe underlyingCode", async () => {
  for (const systemCode of [
    "ENOTFOUND",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ]) {
    await withWorker(
      {
        listDue: async () => {
          const error = new Error(
            `connect ${systemCode} secret-host DATABASE_URL=postgresql://user:pass@host/db SELECT * FROM secrets`
          );
          error.code = systemCode;
          error.stack = `Error: leaked stack ${TOKEN}\n    at listDue`;
          throw error;
        },
      },
      async ({ runCodeClipProviderPollingWorkerCycle }) => {
        await assert.rejects(
          () =>
            runCodeClipProviderPollingWorkerCycle(
              { now: OPERATION_NOW },
              { queryClient: pool(), adapterRegistry: registry() }
            ),
          (error) => {
            assertWorkerError(error, "DATABASE_UNAVAILABLE");
            assert.equal(error.underlyingCode, systemCode);
            const serialized = JSON.stringify(error);
            assert.equal(serialized.includes(TOKEN), false);
            assert.equal(serialized.includes("postgresql://"), false);
            assert.equal(serialized.includes("DATABASE_URL"), false);
            assert.equal(serialized.includes("SELECT "), false);
            assert.equal(serialized.includes("leaked stack"), false);
            assert.equal(serialized.includes("secret-host"), false);
            return true;
          }
        );
      }
    );
  }
});

test("due-source scan preserves DATABASE_UNAVAILABLE and PG-style codes safely", async () => {
  await withWorker(
    {
      listDue: async () => {
        const error = new Error("pool missing");
        error.code = "DATABASE_UNAVAILABLE";
        throw error;
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      await assert.rejects(
        () =>
          runCodeClipProviderPollingWorkerCycle(
            { now: OPERATION_NOW },
            { queryClient: pool(), adapterRegistry: registry() }
          ),
        (error) => {
          assertWorkerError(error, "DATABASE_UNAVAILABLE");
          assert.equal(error.underlyingCode, "DATABASE_UNAVAILABLE");
          return true;
        }
      );
    }
  );

  await withWorker(
    {
      listDue: async () => {
        const error = new Error(
          'relation "codeclip_provider_poll_sources" does not exist'
        );
        error.code = "42P01";
        error.detail = "leaked detail with " + ACCOUNT_ID;
        error.hint = "leaked hint";
        throw error;
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      await assert.rejects(
        () =>
          runCodeClipProviderPollingWorkerCycle(
            { now: OPERATION_NOW },
            { queryClient: pool(), adapterRegistry: registry() }
          ),
        (error) => {
          assertWorkerError(error, "DUE_SOURCE_SCAN_FAILED");
          assert.equal(error.underlyingCode, "42P01");
          const serialized = JSON.stringify(error);
          assert.equal(serialized.includes("relation"), false);
          assert.equal(serialized.includes("does not exist"), false);
          assert.equal(serialized.includes("leaked detail"), false);
          assert.equal(serialized.includes("leaked hint"), false);
          assert.equal(serialized.includes(ACCOUNT_ID), false);
          return true;
        }
      );
    }
  );
});

test("source success invokes service once per source with unique safe owners", async () => {
  const calls = [];
  await withWorker(
    {
      listDue: async () => ({ items: [source(1), source(2)] }),
      pollSource: async (input) => {
        calls.push(input);
        return {
          ok: true,
          classification: input.sourceId === "1" ? "empty" : "success",
          detectionCount: input.sourceId === "1" ? 0 : 2,
          createdCount: 1,
          existingCount: 1,
          pageComplete: true,
          nextPollAt: "2026-08-05T12:05:00.000Z",
          deliveryIds: ["delivery-id-not-returned"],
          accessToken: TOKEN,
          checkpoint: CHECKPOINT,
        };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        {
          ownerPrefix: OWNER_PREFIX,
          limit: 10,
          leaseMs: 60_000,
          now: OPERATION_NOW,
        },
        { queryClient: pool(), adapterRegistry: registry() }
      );

      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.sourceId), ["1", "2"]);
      assert.equal(new Set(calls.map((call) => call.owner)).size, 2);
      for (const call of calls) {
        assert.match(call.owner, /^[a-z0-9][a-z0-9._:-]{0,127}$/);
        assert.equal(call.owner.includes(ACCOUNT_ID), false);
        assert.equal(call.leaseMs, 60_000);
        assert.equal(call.limit, 10);
        assert.equal(call.now, OPERATION_NOW);
        assert.equal(call.adapterRegistry.get instanceof Function, true);
        assert.equal(call.credentialRefreshRegistry.get instanceof Function, true);
      }

      assert.equal(result.scanned, 2);
      assert.equal(result.attempted, 2);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.items.map((item) => item.sourceId), ["1", "2"]);
      assert.deepEqual(result.items.map((item) => item.deliveriesCount), [2, 2]);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(serialized.includes(CHECKPOINT), false);
      assert.equal(serialized.includes("delivery-id-not-returned"), false);
      assert.equal(serialized.includes("owner"), false);
    }
  );
});

test("bounded concurrency is enforced and summary order follows due scan order", async () => {
  let active = 0;
  let maxActive = 0;
  const completionDelays = { 1: 30, 2: 5, 3: 10, 4: 1 };
  await withWorker(
    {
      listDue: async () => ({ items: [source(1), source(2), source(3), source(4)] }),
      pollSource: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(completionDelays[input.sourceId]);
        active -= 1;
        return {
          ok: true,
          classification: "success",
          detectionCount: Number(input.sourceId),
          createdCount: 1,
          pageComplete: true,
          nextPollAt: OPERATION_NOW,
        };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { concurrency: 2, now: OPERATION_NOW },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.equal(maxActive, 2);
      assert.equal(active, 0);
      assert.deepEqual(result.items.map((item) => item.sourceId), ["1", "2", "3", "4"]);
      assert.deepEqual(result.items.map((item) => item.detectionsCount), [1, 2, 3, 4]);
    }
  );
});

test("concurrency one and concurrency above source count both complete deterministically", async () => {
  for (const concurrency of [1, 5]) {
    const calls = [];
    await withWorker(
      {
        listDue: async () => ({ items: [source("a"), source("b")] }),
        pollSource: async (input) => {
          calls.push(input.sourceId);
          return { ok: true, classification: "empty", pageComplete: true };
        },
      },
      async ({ runCodeClipProviderPollingWorkerCycle }) => {
        const result = await runCodeClipProviderPollingWorkerCycle(
          { concurrency, now: OPERATION_NOW },
          { queryClient: pool(), adapterRegistry: registry() }
        );
        assert.deepEqual(result.items.map((item) => item.sourceId), ["a", "b"]);
        assert.deepEqual(calls.sort(), ["a", "b"]);
      }
    );
  }
});

test("expected source failures are isolated and summarized safely", async () => {
  const outcomes = {
    1: { ok: false, classification: "claim_contention", nextPollAt: null },
    2: { ok: false, classification: "rate_limited", nextPollAt: "2026-08-05T12:01:00.000Z" },
    3: { ok: false, classification: "reauthorization_required", nextPollAt: null },
    4: { ok: false, classification: "terminal_configuration", nextPollAt: null },
    5: { ok: false, classification: "provider_malformed_response", nextPollAt: null },
    6: { ok: false, classification: "retryable", nextPollAt: "2026-08-05T12:02:00.000Z" },
  };
  await withWorker(
    {
      listDue: async () => ({ items: Object.keys(outcomes).map(source) }),
      pollSource: async (input) => outcomes[input.sourceId],
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { concurrency: 3, now: OPERATION_NOW },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.equal(result.scanned, 6);
      assert.equal(result.succeeded, 0);
      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 5);
      assert.equal(result.items[0].status, "skipped");
      assert.deepEqual(
        result.items.slice(1).map((item) => item.classification),
        [
          "rate_limited",
          "reauthorization_required",
          "terminal_configuration",
          "provider_malformed_response",
          "retryable",
        ]
      );
    }
  );
});

test("unexpected source throw maps to safe failure and later sources still run", async () => {
  const calls = [];
  await withWorker(
    {
      listDue: async () => ({ items: [source(1), source(2), source(3)] }),
      pollSource: async (input) => {
        calls.push(input.sourceId);
        if (input.sourceId === "2") throw new Error(`boom ${TOKEN}`);
        return { ok: true, classification: "empty", pageComplete: true };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { concurrency: 1, now: OPERATION_NOW },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.deepEqual(calls, ["1", "2", "3"]);
      assert.deepEqual(result.items.map((item) => item.status), [
        "succeeded",
        "failed",
        "succeeded",
      ]);
      assert.equal(result.items[1].classification, "WORKER_SOURCE_FAILED");
      assert.equal(JSON.stringify(result).includes("boom"), false);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    }
  );
});

test("already aborted signal returns aborted summary without DB scan", async () => {
  let scanned = false;
  await withWorker(
    {
      listDue: async () => {
        scanned = true;
        return { items: [source(1)] };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { now: OPERATION_NOW, signal: { aborted: true } },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.equal(scanned, false);
      assert.equal(result.status, "aborted");
      assert.equal(result.scanned, 0);
    }
  );
});

test("abort during cycle starts no new jobs and marks remaining skipped", async () => {
  const signal = { aborted: false };
  const calls = [];
  await withWorker(
    {
      listDue: async () => ({ items: [source(1), source(2), source(3), source(4), source(5)] }),
      pollSource: async (input) => {
        calls.push(input.sourceId);
        if (calls.length === 1) signal.aborted = true;
        await delay(10);
        return { ok: true, classification: "empty", pageComplete: true };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { concurrency: 2, signal, now: OPERATION_NOW },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      assert.equal(result.status, "aborted");
      assert.ok(calls.length <= 2);
      assert.equal(result.scanned, 5);
      assert.equal(result.attempted, calls.length);
      assert.equal(result.skipped, 5 - calls.length);
      assert.equal(result.items.length, 5);
      assert.equal(result.items.filter((item) => item.status === "skipped").length, 5 - calls.length);
    }
  );
});

test("injected registry is used and no arbitrary service function DI is accepted", async () => {
  let registrySeen = null;
  let fakeOverrideCalled = false;
  const injected = registry();
  await withWorker(
    {
      listDue: async () => ({ items: [source(1)] }),
      pollSource: async (input) => {
        registrySeen = input.adapterRegistry;
        return { ok: true, classification: "empty", pageComplete: true };
      },
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      await runCodeClipProviderPollingWorkerCycle(
        {
          now: OPERATION_NOW,
          listDueFn: async () => {
            fakeOverrideCalled = true;
          },
          pollSourceFn: async () => {
            fakeOverrideCalled = true;
          },
        },
        {
          queryClient: pool(),
          adapterRegistry: injected,
        }
      );
      assert.equal(registrySeen, injected);
      assert.equal(fakeOverrideCalled, false);
    }
  );
});

test("summary and serialized errors never leak sensitive service/source fields", async () => {
  await withWorker(
    {
      listDue: async () => ({ items: [source(1)] }),
      pollSource: async () => ({
        ok: false,
        classification: "retryable",
        providerAccountId: ACCOUNT_ID,
        checkpoint: CHECKPOINT,
        accessToken: TOKEN,
        owner: "owner-must-not-leak",
        claimVersion: 123,
        detections: [{ raw: "provider-payload" }],
      }),
    },
    async ({ runCodeClipProviderPollingWorkerCycle }) => {
      const result = await runCodeClipProviderPollingWorkerCycle(
        { now: OPERATION_NOW },
        { queryClient: pool(), adapterRegistry: registry() }
      );
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        ACCOUNT_ID,
        CHECKPOINT,
        TOKEN,
        "owner-must-not-leak",
        "claimVersion",
        "provider-payload",
      ]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    }
  );
});
