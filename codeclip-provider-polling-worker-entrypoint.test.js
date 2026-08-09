const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const SCRIPT_PATH = path.join(__dirname, "scripts/codeclip-provider-polling-worker.js");

function loadEntrypoint() {
  delete require.cache[require.resolve("./scripts/codeclip-provider-polling-worker")];
  return require("./scripts/codeclip-provider-polling-worker");
}

function pool() {
  return {
    connect: async () => ({ release() {}, query: async () => ({ rows: [] }) }),
    query: async () => ({ rows: [] }),
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };
}

function logger() {
  const events = [];
  return {
    events,
    info: (event, fields) => events.push({ level: "info", event, fields }),
    warn: (event, fields) => events.push({ level: "warn", event, fields }),
    error: (event, fields) => events.push({ level: "error", event, fields }),
  };
}

function processLike() {
  const handlers = new Map();
  return {
    exitCode: 0,
    handlers,
    once(name, fn) {
      handlers.set(name, fn);
    },
    removeListener(name, fn) {
      if (handlers.get(name) === fn) handlers.delete(name);
    },
  };
}

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-token|providerAccountId|checkpoint|native boom|stack|sql/i);
}

test("entrypoint import has no side effects and public API is narrow", () => {
  const mod = loadEntrypoint();
  assert.deepEqual(Object.keys(mod).sort(), [
    "runCodeClipProviderPollingWorkerEntrypoint",
  ]);
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /require\.main === module/);
  assert.doesNotMatch(source, /youtube/i);
});

test("argument parsing is private and observable through entrypoint behavior", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  await assert.rejects(() =>
    runCodeClipProviderPollingWorkerEntrypoint({
      argv: ["--dry-run"],
      processLike: processLike(),
      createRuntime: () => {
        throw new Error("runtime should not be created");
      },
    })
  );
});

test("help writes usage and does not create runtime", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  let created = false;
  let output = "";
  const result = await runCodeClipProviderPollingWorkerEntrypoint({
    argv: ["--help"],
    stdout: { write: (chunk) => { output += chunk; } },
    createRuntime: () => {
      created = true;
    },
    processLike: processLike(),
  });
  assert.equal(result.status, "help");
  assert.match(output, /Usage:/);
  assert.equal(created, false);
});

test("valid one-shot applies CLI override, starts runtime, stops, and closes owned pool", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const log = logger();
  const db = pool();
  const proc = processLike();
  const calls = [];
  const runtime = {
    start: async () => {
      calls.push("start");
      return { ok: true, status: "stopped" };
    },
    stop: async () => {
      calls.push("stop");
      return { ok: true, status: "stopped" };
    },
  };
  const result = await runCodeClipProviderPollingWorkerEntrypoint({
    argv: ["--once"],
    env: {},
    queryClient: db,
    logger: log,
    processLike: proc,
    closeOwnedPool: true,
    loadConfig: () => ({ enabled: true, oneShot: false }),
    createRuntime: (config, deps) => {
      calls.push({ config, deps });
      return runtime;
    },
  });
  assert.equal(result.status, "stopped");
  assert.equal(calls[0].config.oneShot, true);
  assert.equal(calls[0].deps.queryClient, db);
  assert.deepEqual(calls.slice(1), ["start", "stop"]);
  assert.equal(db.endCalls, 1);
  assert.equal(proc.handlers.size, 0);
  assertNoLeak(log.events);
});

test("disabled config exits safely without database, runtime, signals, or timers", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const log = logger();
  const proc = processLike();
  let created = false;
  const result = await runCodeClipProviderPollingWorkerEntrypoint({
    argv: [],
    queryClient: null,
    logger: log,
    processLike: proc,
    loadConfig: () => ({
      enabled: false,
      provider: "tiktok",
      environment: "production",
      oneShot: false,
    }),
    createRuntime: () => {
      created = true;
    },
  });
  assert.deepEqual(result, { ok: true, status: "disabled" });
  assert.equal(created, false);
  assert.equal(proc.handlers.size, 0);
  assert.equal(log.events.some((entry) => entry.event === "provider_polling_worker_disabled"), true);
  assertNoLeak(log.events);
});

test("valid recurring startup registers signals without closing shared pool", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const db = pool();
  const proc = processLike();
  let stopped = false;
  const resultPromise = runCodeClipProviderPollingWorkerEntrypoint({
    argv: [],
    env: {},
    queryClient: db,
    logger: logger(),
    processLike: proc,
    loadConfig: () => ({ enabled: true, oneShot: false }),
    createRuntime: () => ({
      start: async () => ({ ok: true, status: "running" }),
      stop: async () => {
        stopped = true;
        return { ok: true, status: "stopped" };
      },
    }),
  });
  assert.equal(proc.handlers.has("SIGTERM"), true);
  await proc.handlers.get("SIGTERM")();
  const result = await resultPromise;
  assert.equal(result.status, "stopped");
  assert.equal(stopped, true);
  assert.equal(db.endCalls, 0);
  assert.equal(proc.handlers.size, 0);
});

test("recurring owned pool is not ended while running and ends only after stop", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const db = pool();
  const proc = processLike();
  let stopCalls = 0;
  const resultPromise = runCodeClipProviderPollingWorkerEntrypoint({
    argv: [],
    env: {},
    queryClient: db,
    logger: logger(),
    processLike: proc,
    closeOwnedPool: true,
    loadConfig: () => ({ enabled: true, oneShot: false }),
    createRuntime: () => ({
      start: async () => ({ ok: true, status: "running" }),
      stop: async () => {
        stopCalls += 1;
        // Pool must still be open while runtime is stopping/running work.
        assert.equal(db.endCalls, 0);
        return { ok: true, status: "stopped" };
      },
    }),
  });

  // Allow start path to register handlers and park on signalStopPromise.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(proc.handlers.has("SIGTERM"), true);
  assert.equal(db.endCalls, 0, "pool must not end while status is running");

  await proc.handlers.get("SIGTERM")();
  const result = await resultPromise;
  assert.equal(result.status, "stopped");
  assert.equal(stopCalls, 1);
  assert.equal(db.endCalls, 1, "pool ends only after runtime has stopped");
  assert.equal(proc.handlers.size, 0);
});

test("signal handler path asks runtime to stop safely", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const proc = processLike();
  let signalHandler;
  let stopped = false;
  await runCodeClipProviderPollingWorkerEntrypoint({
    argv: [],
    env: {},
    queryClient: pool(),
    logger: logger(),
    processLike: {
      ...proc,
      once(name, fn) {
        proc.once(name, fn);
        if (name === "SIGTERM") signalHandler = fn;
      },
      removeListener: proc.removeListener.bind(proc),
    },
    loadConfig: () => ({ enabled: true, oneShot: false }),
    createRuntime: () => ({
      start: async () => {
        void signalHandler();
        return { ok: true, status: "running" };
      },
      stop: async () => {
        stopped = true;
        return { ok: true, status: "stopped" };
      },
    }),
  });
  assert.equal(stopped, true);
});

test("config, startup and database failures are logged safely with exitCode 1", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  for (const scenario of [
    {
      loadConfig: () => {
        const error = new Error("secret-token native boom");
        error.code = "INVALID_WORKER_RUNTIME_CONFIG";
        throw error;
      },
      queryClient: pool(),
    },
    {
      loadConfig: () => ({ enabled: true, oneShot: true }),
      queryClient: null,
    },
    {
      loadConfig: () => ({ enabled: true, oneShot: true }),
      queryClient: pool(),
      createRuntime: () => {
        const error = new Error("native boom");
        error.code = "WORKER_STARTUP_FAILED";
        throw error;
      },
    },
  ]) {
    const log = logger();
    const proc = processLike();
    await assert.rejects(() =>
      runCodeClipProviderPollingWorkerEntrypoint({
        argv: [],
        logger: log,
        processLike: proc,
        createRuntime: () => ({
          start: async () => ({ ok: true, status: "stopped" }),
          stop: async () => ({ ok: true, status: "stopped" }),
        }),
        ...scenario,
      })
    );
    assert.equal(proc.exitCode, 1);
    assert.equal(log.events.some((entry) => entry.event === "provider_polling_worker_startup_failed"), true);
    assertNoLeak(log.events);
  }
});

test("pool close failure is sanitized and does not mask one-shot success", async () => {
  const { runCodeClipProviderPollingWorkerEntrypoint } = loadEntrypoint();
  const log = logger();
  const db = {
    connect: async () => ({}),
    query: async () => ({}),
    end: async () => {
      throw new Error("native boom secret-token");
    },
  };
  const result = await runCodeClipProviderPollingWorkerEntrypoint({
    argv: ["--once"],
    queryClient: db,
    logger: log,
    processLike: processLike(),
    closeOwnedPool: true,
    loadConfig: () => ({ enabled: true, oneShot: false }),
    createRuntime: () => ({
      start: async () => ({ ok: true, status: "stopped" }),
      stop: async () => ({ ok: true, status: "stopped" }),
    }),
  });
  assert.equal(result.status, "stopped");
  assert.equal(log.events.some((entry) => entry.event === "provider_polling_worker_pool_close_failed"), true);
  assertNoLeak(log.events);
});
