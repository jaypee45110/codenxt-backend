#!/usr/bin/env node

/**
 * B11.2F2 Meta Messenger Dispatch Worker CLI
 *
 * Separate process entrypoint (Railway-friendly). Does not start on import.
 * Usage:
 *   node scripts/codeclip-meta-messenger-dispatch-worker.js [--once]
 */

const database = require("../db");
const {
  createCodeClipMetaMessengerDispatchWorkerState,
  loadCodeClipMetaMessengerDispatchWorkerConfig,
  runCodeClipMetaMessengerDispatchCycle,
  sanitizeMetaMessengerDispatchWorkerLogEvent,
} = require("../verticals/codeclip/meta-messenger-dispatch-worker");
const {
  getCodeClipProviderAccountBindingById,
} = require("../verticals/codeclip/provider-account-bindings");
const {
  createMetaMessengerPageCredentialResolverFromEnv,
} = require("../verticals/codeclip/meta-messenger-page-credentials");

function parseArgs(argv = process.argv.slice(2)) {
  const args = { once: false, help: false };
  for (const arg of argv) {
    if (arg === "--once") args.once = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/codeclip-meta-messenger-dispatch-worker.js [--once]",
    "",
    "Runs codeClip Meta Messenger outbound dispatch cycles.",
    "Requires CODECLIP_META_MESSENGER_DISPATCH_WORKER_ENABLED=1 and valid",
    "CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON when enabled.",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLogger() {
  return {
    info: (event) =>
      console.log(
        "codeClip Meta Messenger dispatch worker",
        sanitizeMetaMessengerDispatchWorkerLogEvent(event)
      ),
    warn: (event) =>
      console.warn(
        "codeClip Meta Messenger dispatch worker",
        sanitizeMetaMessengerDispatchWorkerLogEvent(event)
      ),
    error: (event) =>
      console.error(
        "codeClip Meta Messenger dispatch worker",
        sanitizeMetaMessengerDispatchWorkerLogEvent(event)
      ),
  };
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  queryClient = database.pool,
  logger = createLogger(),
  workerState = createCodeClipMetaMessengerDispatchWorkerState(),
  runCycle = runCodeClipMetaMessengerDispatchCycle,
  sleep: sleepFn = sleep,
  loadConfig = loadCodeClipMetaMessengerDispatchWorkerConfig,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { status: "help" };
  }

  const loaded = loadConfig(env);
  if (!loaded.ok) {
    logger.error({
      event: "startup_failed",
      reason: loaded.reason,
    });
    const error = new Error(loaded.reason || "startup_failed");
    error.code = loaded.reason || "startup_failed";
    throw error;
  }

  if (!loaded.config.enabled) {
    logger.info({ event: "disabled" });
    return { status: "disabled" };
  }

  if (!queryClient) {
    logger.error({ event: "startup_failed", reason: "DATABASE_UNAVAILABLE" });
    const error = new Error("DATABASE_UNAVAILABLE");
    error.code = "DATABASE_UNAVAILABLE";
    throw error;
  }

  // Re-bind getBinding with live queryClient for binding consistency checks.
  const resolverOrError = createMetaMessengerPageCredentialResolverFromEnv(env, {
    getBinding: async (bindingId) =>
      getCodeClipProviderAccountBindingById(bindingId, { queryClient }),
  });
  if (resolverOrError && resolverOrError.ok === false) {
    logger.error({ event: "startup_failed", reason: resolverOrError.reason });
    const error = new Error(resolverOrError.reason || "CREDENTIAL_CONFIG_INVALID");
    error.code = resolverOrError.reason || "CREDENTIAL_CONFIG_INVALID";
    throw error;
  }

  const config = {
    ...loaded.config,
    resolvePageAccessCredentials: resolverOrError,
  };

  const shutdown = () => {
    workerState.shuttingDown = true;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  async function runOnce() {
    if (workerState.cycleRunning) {
      logger.warn({ event: "cycle_overlap_skipped" });
      return { ok: false, failureCode: "cycle_overlap" };
    }
    workerState.cycleRunning = true;
    try {
      const report = await runCycle({
        limit: config.limit,
        concurrency: config.concurrency,
        staleAfterSeconds: config.staleAfterSeconds,
        timeoutMs: config.timeoutMs,
        queryClient,
        resolvePageAccessCredentials: config.resolvePageAccessCredentials,
      });
      logger.info({
        event: "cycle_completed",
        ok: report.ok,
        summary: report.summary,
        cycleId: report.cycleId,
      });
      return report;
    } finally {
      workerState.cycleRunning = false;
    }
  }

  if (args.once) {
    return runOnce();
  }

  logger.info({
    event: "started",
    limit: config.limit,
    concurrency: config.concurrency,
    intervalMs: config.intervalMs,
    staleAfterSeconds: config.staleAfterSeconds,
  });

  while (!workerState.shuttingDown) {
    await runOnce();
    if (workerState.shuttingDown) break;
    await sleepFn(config.intervalMs);
  }

  logger.info({ event: "shutdown" });
  return { status: "shutdown" };
}

if (require.main === module) {
  runCli()
    .catch((error) => {
      console.error("codeClip Meta Messenger dispatch worker failed", {
        code: error?.code || error?.name || "startup_failed",
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await database.pool?.end?.();
      } catch {
        // Shutdown must not leak internals.
      }
    });
}

module.exports = {
  createLogger,
  parseArgs,
  runCli,
  usage,
};
