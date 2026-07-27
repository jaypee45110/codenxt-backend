#!/usr/bin/env node

const database = require("../db");
const {
  createCodeClipYouTubeReconciliationWorkerState,
  loadCodeClipYouTubeReconciliationWorkerConfig,
  runCodeClipYouTubeReconciliationWorkerOnce,
  sanitizeWorkerLogEvent,
} = require("../verticals/codeclip/youtube-reconciliation-worker");

function parseArgs(argv = process.argv.slice(2)) {
  const args = { once: false, dryRun: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--once") args.once = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/codeclip-youtube-reconciliation-worker.js [--once] [--dry-run] [--json]",
    "",
    "Runs automatic codeClip YouTube Atom reconciliation.",
    "--dry-run never claims subscriptions and never calls the write pipeline.",
  ].join("\n");
}

function buildRuntimeConfig(env = process.env, args = {}) {
  const baseConfig = loadCodeClipYouTubeReconciliationWorkerConfig(env);
  return {
    ...baseConfig,
    dryRun: args.dryRun || baseConfig.dryRun,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitterMs(max) {
  if (!max) return 0;
  return Math.floor(Math.random() * (max + 1));
}

function createLogger() {
  return {
    info: (event) => console.log("codeClip YouTube reconciliation worker", sanitizeWorkerLogEvent(event)),
    warn: (event) => console.warn("codeClip YouTube reconciliation worker", sanitizeWorkerLogEvent(event)),
    error: (event) => console.error("codeClip YouTube reconciliation worker", sanitizeWorkerLogEvent(event)),
  };
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  queryClient = database.pool,
  logger = createLogger(),
  workerState = createCodeClipYouTubeReconciliationWorkerState(),
  runWorkerOnce = runCodeClipYouTubeReconciliationWorkerOnce,
  sleep: sleepFn = sleep,
  randomJitterMs: jitterFn = randomJitterMs,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { status: "help" };
  }
  const config = buildRuntimeConfig(env, args);
  const shutdown = () => {
    workerState.shuttingDown = true;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  async function runOnce() {
    const report = await runWorkerOnce({
      config,
      dryRun: config.dryRun,
      queryClient,
      logger,
      workerState,
    });
    if (args.json) stdout.write(`${JSON.stringify(report)}\n`);
    else console.log("codeClip YouTube reconciliation worker summary", report.summary || report);
    return report;
  }

  if (args.once) return runOnce();
  while (!workerState.shuttingDown) {
    await sleepFn(jitterFn(config.jitterMs));
    if (workerState.shuttingDown) break;
    await runOnce();
    await sleepFn(config.intervalMs);
  }
  return { status: "shutdown" };
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error("codeClip YouTube reconciliation worker failed", {
      code: error?.code || error?.name || "startup_failed",
    });
    process.exitCode = 1;
  }).finally(async () => {
    try {
      await database.pool?.end?.();
    } catch {
      // Shutdown must not leak internals.
    }
  });
}

module.exports = {
  buildRuntimeConfig,
  parseArgs,
  runCli,
  usage,
};
