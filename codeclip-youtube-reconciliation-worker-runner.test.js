const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRuntimeConfig,
  parseArgs,
  runCli,
} = require("./scripts/codeclip-youtube-reconciliation-worker");

test("YouTube reconciliation worker runner parses safe command arguments", () => {
  assert.deepEqual(parseArgs([]), { once: false, dryRun: false, json: false, help: false });
  assert.deepEqual(parseArgs(["--once", "--dry-run", "--json"]), {
    once: true,
    dryRun: true,
    json: true,
    help: false,
  });
  assert.deepEqual(parseArgs(["--help"]), { once: false, dryRun: false, json: false, help: true });
  assert.throws(() => parseArgs(["--execute"]), /Unknown argument/);
});

test("YouTube reconciliation worker runner preserves all supported dry-run env values", () => {
  for (const value of ["true", "1", "yes"]) {
    assert.equal(
      buildRuntimeConfig({ CODECLIP_YOUTUBE_RECONCILIATION_DRY_RUN: value }, {}).dryRun,
      true,
      value
    );
  }
  for (const value of ["false", "0", "no"]) {
    assert.equal(
      buildRuntimeConfig({ CODECLIP_YOUTUBE_RECONCILIATION_DRY_RUN: value }, {}).dryRun,
      false,
      value
    );
  }
  assert.equal(
    buildRuntimeConfig({ CODECLIP_YOUTUBE_RECONCILIATION_DRY_RUN: "0" }, { dryRun: true }).dryRun,
    true
  );
});

function createLoopHarness({ stopAfterRuns = 2 } = {}) {
  const calls = {
    runs: [],
    sleeps: [],
    stdout: "",
  };
  const workerState = { running: false, shuttingDown: false };
  return {
    calls,
    workerState,
    stdout: {
      write: (chunk) => {
        calls.stdout += chunk;
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    queryClient: { query: async () => ({ rows: [] }) },
    randomJitterMs: () => 0,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    runWorkerOnce: async ({ config, dryRun, workerState: activeWorkerState }) => {
      calls.runs.push({ dryRun, intervalMs: config.intervalMs });
      if (calls.runs.length >= stopAfterRuns) {
        activeWorkerState.shuttingDown = true;
      }
      return {
        mode: dryRun ? "dry_run" : "write_enabled",
        summary: {
          claimsAcquired: 0,
          processedCompleted: 0,
          eligibleForProcessing: dryRun ? 1 : 0,
          observabilityFailures: 0,
        },
      };
    },
  };
}

test("YouTube reconciliation worker dry-run loops until shutdown instead of exiting after one run", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 2 });
  const result = await runCli({
    argv: ["--dry-run"],
    env: {
      CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS: "60000",
      CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0",
    },
    ...harness,
  });
  assert.equal(result.status, "shutdown");
  assert.equal(harness.calls.runs.length, 2);
  assert.deepEqual(harness.calls.runs.map((run) => run.dryRun), [true, true]);
});

test("YouTube reconciliation worker dry-run once remains a one-shot run", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 5 });
  const result = await runCli({
    argv: ["--dry-run", "--once"],
    env: { CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0" },
    ...harness,
  });
  assert.equal(result.mode, "dry_run");
  assert.equal(harness.calls.runs.length, 1);
  assert.equal(harness.calls.runs[0].dryRun, true);
  assert.equal(harness.calls.sleeps.length, 0);
});

test("YouTube reconciliation worker write-enabled once remains a one-shot run", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 5 });
  const result = await runCli({
    argv: ["--once"],
    env: { CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0" },
    ...harness,
  });
  assert.equal(result.mode, "write_enabled");
  assert.equal(harness.calls.runs.length, 1);
  assert.equal(harness.calls.runs[0].dryRun, false);
  assert.equal(harness.calls.sleeps.length, 0);
});

test("YouTube reconciliation worker default write-enabled mode starts the ordinary loop", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 2 });
  const result = await runCli({
    argv: [],
    env: {
      CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS: "60000",
      CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0",
    },
    ...harness,
  });
  assert.equal(result.status, "shutdown");
  assert.equal(harness.calls.runs.length, 2);
  assert.deepEqual(harness.calls.runs.map((run) => run.dryRun), [false, false]);
});

test("YouTube reconciliation worker dry-run loop keeps write side effects disabled across cycles", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 3 });
  const result = await runCli({
    argv: ["--dry-run", "--json"],
    env: {
      CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS: "60000",
      CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0",
      CODECLIP_YOUTUBE_RECONCILIATION_GLOBAL_CONCURRENCY: "2",
    },
    ...harness,
  });
  assert.equal(result.status, "shutdown");
  assert.equal(harness.calls.runs.length, 3);
  assert.deepEqual(harness.calls.runs.map((run) => run.dryRun), [true, true, true]);
  assert.equal(harness.calls.runs.every((run) => run.intervalMs === 60000), true);
  assert.match(harness.calls.stdout, /"mode":"dry_run"/);
});

test("YouTube reconciliation worker dry-run loop honors shutdown before starting new work", async () => {
  const harness = createLoopHarness({ stopAfterRuns: 10 });
  harness.sleep = async (ms) => {
    harness.calls.sleeps.push(ms);
    harness.workerState.shuttingDown = true;
  };
  const result = await runCli({
    argv: ["--dry-run"],
    env: {
      CODECLIP_YOUTUBE_RECONCILIATION_INTERVAL_MS: "60000",
      CODECLIP_YOUTUBE_RECONCILIATION_JITTER_MS: "0",
    },
    ...harness,
  });
  assert.equal(result.status, "shutdown");
  assert.equal(harness.calls.runs.length, 0);
});
