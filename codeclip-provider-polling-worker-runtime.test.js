const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const RUNTIME_PATH = path.join(
  __dirname,
  "verticals/codeclip/provider-polling/worker-runtime.js"
);
const CORE_PATH = path.join(
  __dirname,
  "verticals/codeclip/provider-polling/worker-core.js"
);

function loadRuntime({ runCycle } = {}) {
  delete require.cache[require.resolve("./verticals/codeclip/provider-polling/worker-runtime")];
  if (runCycle) {
    require.cache[require.resolve("./verticals/codeclip/provider-polling/worker-core")] = {
      id: CORE_PATH,
      filename: CORE_PATH,
      loaded: true,
      exports: {
        runCodeClipProviderPollingWorkerCycle: runCycle,
      },
    };
  } else {
    delete require.cache[require.resolve("./verticals/codeclip/provider-polling/worker-core")];
  }
  return require("./verticals/codeclip/provider-polling/worker-runtime");
}

function pool() {
  return {
    connect: async () => ({ release() {}, query: async () => ({ rows: [] }) }),
    query: async () => ({ rows: [] }),
  };
}

function registry() {
  return { get: () => ({ provider: "tiktok", poll: async () => ({}) }) };
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

function clock(start = "2026-08-05T10:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    now() {
      const value = new Date(ms).toISOString();
      ms += 1000;
      return value;
    },
  };
}

function manualTimers() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    runNext() {
      const first = timers.entries().next();
      if (first.done) return false;
      const [timerId, timer] = first.value;
      timers.delete(timerId);
      timer.fn();
      return true;
    },
  };
}

function successSummary(overrides = {}) {
  return {
    ok: true,
    status: "completed",
    provider: "tiktok",
    environment: "production",
    scanned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    items: [],
    ...overrides,
  };
}

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-token|providerAccountId|checkpoint|owner-|sql|select/i);
  assert.doesNotMatch(serialized, /native boom|raw provider|stack/i);
}

test("runtime public API is exact and module has no direct console usage", () => {
  const mod = loadRuntime();
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipProviderPollingWorkerRuntimeError",
    "createCodeClipProviderPollingWorkerRuntime",
    "loadCodeClipProviderPollingWorkerConfig",
  ]);
  const source = fs.readFileSync(RUNTIME_PATH, "utf8");
  assert.doesNotMatch(source, /console\./);
});

test("config loads defaults and every valid override", () => {
  const { loadCodeClipProviderPollingWorkerConfig } = loadRuntime();
  assert.deepEqual(loadCodeClipProviderPollingWorkerConfig({}), {
    enabled: true,
    provider: "tiktok",
    environment: "production",
    intervalMs: 30000,
    limit: 25,
    concurrency: 4,
    leaseMs: 60000,
    ownerPrefix: "codeclip.provider.poll.worker",
    failureBackoffMs: 30000,
    shutdownTimeoutMs: 30000,
    runOnStart: true,
    oneShot: false,
  });

  const config = loadCodeClipProviderPollingWorkerConfig({
    CODECLIP_PROVIDER_POLLING_WORKER_ENABLED: "0",
    CODECLIP_PROVIDER_POLLING_WORKER_PROVIDER: "TikTok",
    CODECLIP_PROVIDER_POLLING_WORKER_ENVIRONMENT: "sandbox",
    CODECLIP_PROVIDER_POLLING_WORKER_INTERVAL_MS: "60000",
    CODECLIP_PROVIDER_POLLING_WORKER_LIMIT: "10",
    CODECLIP_PROVIDER_POLLING_WORKER_CONCURRENCY: "2",
    CODECLIP_PROVIDER_POLLING_WORKER_LEASE_MS: "120000",
    CODECLIP_PROVIDER_POLLING_WORKER_OWNER_PREFIX: "custom.worker",
    CODECLIP_PROVIDER_POLLING_WORKER_FAILURE_BACKOFF_MS: "45000",
    CODECLIP_PROVIDER_POLLING_WORKER_SHUTDOWN_TIMEOUT_MS: "15000",
    CODECLIP_PROVIDER_POLLING_WORKER_RUN_ON_START: "false",
    CODECLIP_PROVIDER_POLLING_WORKER_ONE_SHOT: "true",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.provider, "tiktok");
  assert.equal(config.environment, "sandbox");
  assert.equal(config.intervalMs, 60000);
  assert.equal(config.limit, 10);
  assert.equal(config.concurrency, 2);
  assert.equal(config.leaseMs, 120000);
  assert.equal(config.ownerPrefix, "custom.worker");
  assert.equal(config.failureBackoffMs, 45000);
  assert.equal(config.shutdownTimeoutMs, 15000);
  assert.equal(config.runOnStart, false);
  assert.equal(config.oneShot, true);
  assertNoLeak(config);
});

test("config validation rejects malformed booleans, integers, provider and environment", () => {
  const { loadCodeClipProviderPollingWorkerConfig } = loadRuntime();
  const cases = [
    ["CODECLIP_PROVIDER_POLLING_WORKER_ENABLED", "yes"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_INTERVAL_MS", "1.5"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_LIMIT", "0"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_CONCURRENCY", "17"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_LEASE_MS", "4999"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_FAILURE_BACKOFF_MS", "999"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_SHUTDOWN_TIMEOUT_MS", "999"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_PROVIDER", "bad provider"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_PROVIDER", "meta"],
    ["CODECLIP_PROVIDER_POLLING_WORKER_ENVIRONMENT", "dev"],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => loadCodeClipProviderPollingWorkerConfig({ [key]: value }),
      /invalid|range|polling capable/
    );
  }
});

test("start supports immediate cycle, delayed first cycle, one-shot and defensive status", async () => {
  const calls = [];
  const log = logger();
  const timers = manualTimers();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async (input) => {
      calls.push(input);
      return successSummary({ scanned: 1, succeeded: 1 });
    },
  });

  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { runOnStart: true },
    { queryClient: pool(), adapterRegistry: registry(), logger: log, clock: clock(), timers }
  );
  assert.equal(runtime.getStatus().state, "idle");
  assert.deepEqual(await runtime.start(), { ok: true, status: "running" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const status = runtime.getStatus();
  assert.equal(status.state, "running");
  assert.equal(status.cyclesStarted, 1);
  assert.equal(Object.isFrozen(status), true);
  await runtime.stop();

  const delayed = createCodeClipProviderPollingWorkerRuntime(
    { runOnStart: false },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers: manualTimers() }
  );
  await delayed.start();
  assert.equal(delayed.getStatus().cyclesStarted, 0);
  await delayed.stop();

  const oneShot = createCodeClipProviderPollingWorkerRuntime(
    { oneShot: true },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers: manualTimers() }
  );
  const result = await oneShot.start();
  assert.equal(result.status, "stopped");
  assert.equal(oneShot.getStatus().state, "stopped");
  assertNoLeak(log.events);
});

test("start/stop are fail-closed or idempotent at lifecycle boundaries", async () => {
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => successSummary(),
  });
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({ enabled: "true" }, { queryClient: pool() }), /enabled/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({ runOnStart: "false" }, { queryClient: pool() }), /runOnStart/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({ oneShot: 1 }, { queryClient: pool() }), /oneShot/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({ provider: "meta" }, { queryClient: pool() }), /provider/);
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    {},
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers: manualTimers() }
  );
  assert.deepEqual(await runtime.stop(), { ok: true, status: "stopped" });
  assert.deepEqual(await runtime.stop(), { ok: true, status: "stopped" });

  const running = createCodeClipProviderPollingWorkerRuntime(
    { runOnStart: false },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers: manualTimers() }
  );
  await running.start();
  await assert.rejects(
    () => running.start(),
    (error) => error.code === "WORKER_ALREADY_RUNNING"
  );
  await running.stop();
});

test("runOnce is single-flight and forwards config without public worker-core DI", async () => {
  let release;
  const calls = [];
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async (input, deps) => {
      calls.push({ input, deps });
      await new Promise((resolve) => {
        release = resolve;
      });
      return successSummary({ scanned: 2 });
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    {
      provider: "tiktok",
      environment: "sandbox",
      limit: 3,
      concurrency: 2,
      leaseMs: 7000,
      ownerPrefix: "custom.owner",
      runOnStart: false,
    },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers: manualTimers(), runCycle: async () => {} }
  );
  await runtime.start();
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.provider, "tiktok");
  assert.equal(calls[0].input.environment, "sandbox");
  assert.equal(calls[0].input.limit, 3);
  assert.equal(calls[0].input.concurrency, 2);
  assert.equal(calls[0].input.leaseMs, 7000);
  assert.equal(calls[0].input.ownerPrefix, "custom.owner");
  assert.equal(typeof calls[0].input.signal.aborted, "boolean");
  assert.equal(calls[0].deps.queryClient.query instanceof Function, true);
  await runtime.stop();
});

test("cycle runs bounded delivery completion with the same provider and environment", async () => {
  const calls = [];
  const completionCalls = [];
  const log = logger();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async (input, deps) => {
      calls.push({ input, deps });
      return successSummary({ scanned: 1, attempted: 1, succeeded: 1 });
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    {
      provider: "tiktok",
      environment: "sandbox",
      limit: 7,
      runOnStart: false,
    },
    {
      queryClient: pool(),
      adapterRegistry: registry(),
      logger: log,
      clock: clock(),
      timers: manualTimers(),
      completionCycle: async (input, deps) => {
        completionCalls.push({ input, deps });
        return {
          ok: true,
          selected: 2,
          completed: 1,
          skipped: 1,
          retryableFailed: 0,
          terminalFailed: 0,
        };
      },
    }
  );

  await runtime.start();
  const summary = await runtime.runOnce();
  await runtime.stop();

  assert.equal(calls.length, 1);
  assert.equal(completionCalls.length, 1);
  assert.deepEqual(completionCalls[0].input, {
    provider: "tiktok",
    environment: "sandbox",
    limit: 7,
  });
  assert.equal(completionCalls[0].deps.queryClient.query instanceof Function, true);
  assert.equal(completionCalls[0].deps.logger, log);
  assert.deepEqual(summary.completion, {
    selected: 2,
    completed: 1,
    skipped: 1,
    retryableFailed: 0,
    terminalFailed: 0,
  });
  assert.equal(
    log.events.some((entry) => entry.event === "provider_polling_completion_completed"),
    true
  );
  assertNoLeak(log.events);
});

test("completion-based scheduling prevents overlap and uses failure backoff", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const timers = manualTimers();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (calls === 1) throw Object.assign(new Error("native boom"), { code: "DUE_SOURCE_SCAN_FAILED" });
      return successSummary();
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { intervalMs: 1000, failureBackoffMs: 2000 },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers }
  );
  await runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
  assert.equal([...timers.timers.values()][0].ms, 2000);
  timers.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assertNoLeak(runtime.getStatus());
  await runtime.stop();
});

test("shutdown aborts active cycle, clears pending timer, and handles timeout", async () => {
  let receivedSignal = null;
  let release;
  const timers = manualTimers();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async (input) => {
      receivedSignal = input.signal;
      await new Promise((resolve) => {
        release = resolve;
      });
      return successSummary({ status: input.signal.aborted ? "aborted" : "completed" });
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { shutdownTimeoutMs: 1000 },
    { queryClient: pool(), adapterRegistry: registry(), logger: logger(), clock: clock(), timers }
  );
  await runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.stop();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(timers.timers.size, 1);
  release();
  await stopping;
  assert.equal(runtime.getStatus().state, "stopped");
  assert.equal(timers.timers.size, 0);

  const timeoutTimers = manualTimers();
  const slow = createCodeClipProviderPollingWorkerRuntime(
    { shutdownTimeoutMs: 1000 },
    {
      queryClient: pool(),
      adapterRegistry: registry(),
      logger: logger(),
      clock: clock(),
      timers: timeoutTimers,
    }
  );
  await slow.start();
  await new Promise((resolve) => setImmediate(resolve));
  const timeoutStop = slow.stop();
  timeoutTimers.runNext();
  release();
  assert.deepEqual(await timeoutStop, { ok: false, status: "timeout" });
});

test("dependency validation rejects invalid pool, registry, logger, clock and timers", () => {
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => successSummary(),
  });
  assert.throws(
    () => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: { query() {} } }),
    (error) => error.code === "DATABASE_UNAVAILABLE"
  );
  assert.throws(
    () => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: pool(), adapterRegistry: { poll() {} } }),
    (error) => error.code === "ADAPTER_REGISTRY_NOT_AVAILABLE"
  );
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: pool(), logger: { info() {} } }), /logger/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: pool(), clock: {} }), /clock/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: pool(), timers: {} }), /timers/);
  assert.throws(() => createCodeClipProviderPollingWorkerRuntime({}, { queryClient: pool(), completionCycle: {} }), /completionCycle/);
});

test("logs are aggregate safe events only and provider failures in summary are not runtime crashes", async () => {
  const log = logger();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => successSummary({
      failed: 1,
      items: [{ sourceId: "source-secret", checkpoint: { accessToken: "secret-token" } }],
    }),
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { oneShot: true },
    { queryClient: pool(), adapterRegistry: registry(), logger: log, clock: clock(), timers: manualTimers() }
  );
  const result = await runtime.start();
  assert.equal(result.ok, true);
  assert.equal(log.events.some((entry) => entry.event === "provider_polling_cycle_completed"), true);
  assertNoLeak(log.events);
});

test("cycle_failed logs safe underlyingCode name and scanStage without message SQL params stack or credentials", async () => {
  const log = logger();
  const DATABASE_URL =
    "postgresql://user:super-secret-pass@postgres.internal:5432/railway";
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => {
      const error = new Error(
        `due source scan failed SELECT * FROM codeclip_provider_poll_sources WHERE id=$1 ${DATABASE_URL}`
      );
      error.name = "CodeClipProviderPollingWorkerCoreError";
      error.code = "DATABASE_UNAVAILABLE";
      error.underlyingCode = "ENOTFOUND";
      error.underlyingName = "Error";
      error.scanStage = "due_source_query_failed";
      error.stack = `Error: leaked stack with ${DATABASE_URL}\n    at runCycle`;
      throw error;
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { oneShot: true, provider: "tiktok", environment: "sandbox" },
    {
      queryClient: pool(),
      adapterRegistry: registry(),
      logger: log,
      clock: clock(),
      timers: manualTimers(),
    }
  );
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.equal(result.status, "stopped");
  assert.equal(result.summary?.errorCode, "DATABASE_UNAVAILABLE");
  assert.equal(result.summary?.underlyingCode, "ENOTFOUND");
  assert.equal(result.summary?.underlyingName, "Error");
  assert.equal(result.summary?.scanStage, "due_source_query_failed");
  const cycleFailed = log.events.find(
    (entry) => entry.event === "provider_polling_cycle_failed"
  );
  assert.ok(cycleFailed);
  assert.equal(cycleFailed.level, "error");
  assert.equal(cycleFailed.fields.provider, "tiktok");
  assert.equal(cycleFailed.fields.environment, "sandbox");
  assert.equal(cycleFailed.fields.cycleNumber, 1);
  assert.equal(cycleFailed.fields.errorCode, "DATABASE_UNAVAILABLE");
  assert.equal(cycleFailed.fields.underlyingCode, "ENOTFOUND");
  assert.equal(cycleFailed.fields.underlyingName, "Error");
  assert.equal(cycleFailed.fields.scanStage, "due_source_query_failed");
  assert.equal(Object.prototype.hasOwnProperty.call(cycleFailed.fields, "message"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cycleFailed.fields, "stack"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cycleFailed.fields, "sql"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cycleFailed.fields, "params"), false);
  assert.deepEqual(
    Object.keys(cycleFailed.fields).sort(),
    [
      "cycleNumber",
      "environment",
      "errorCode",
      "provider",
      "scanStage",
      "underlyingCode",
      "underlyingName",
    ].sort()
  );

  const serialized = JSON.stringify(log.events);
  assert.equal(serialized.includes("super-secret-pass"), false);
  assert.equal(serialized.includes("DATABASE_URL"), false);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.equal(serialized.includes("SELECT "), false);
  assert.equal(serialized.includes("leaked stack"), false);
  assert.equal(serialized.includes("due source scan failed SELECT"), false);
  assert.equal(serialized.includes("postgres.internal"), false);
  assertNoLeak(log.events);
});

test("cycle_failed omits underlyingCode when absent and never logs raw boom message", async () => {
  const log = logger();
  const { createCodeClipProviderPollingWorkerRuntime } = loadRuntime({
    runCycle: async () => {
      throw Object.assign(new Error("native boom with secret-token"), {
        code: "DUE_SOURCE_SCAN_FAILED",
      });
    },
  });
  const runtime = createCodeClipProviderPollingWorkerRuntime(
    { oneShot: true },
    {
      queryClient: pool(),
      adapterRegistry: registry(),
      logger: log,
      clock: clock(),
      timers: manualTimers(),
    }
  );
  await runtime.start();
  const cycleFailed = log.events.find(
    (entry) => entry.event === "provider_polling_cycle_failed"
  );
  assert.ok(cycleFailed);
  assert.equal(cycleFailed.fields.errorCode, "DUE_SOURCE_SCAN_FAILED");
  assert.equal(cycleFailed.fields.underlyingCode, undefined);
  assert.equal(JSON.stringify(log.events).includes("native boom"), false);
  assert.equal(JSON.stringify(log.events).includes("secret-token"), false);
  assertNoLeak(log.events);
});
