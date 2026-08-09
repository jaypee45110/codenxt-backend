#!/usr/bin/env node

/**
 * codeClip generic provider polling worker entrypoint.
 *
 * Railway-compatible process wrapper. Does not start on import.
 */

const database = require("../db");
const {
  createCodeClipProviderPollingWorkerRuntime,
  loadCodeClipProviderPollingWorkerConfig,
} = require("../verticals/codeclip/provider-polling/worker-runtime");
const {
  createCodeClipProviderPollingStructuredLogger,
} = require("../verticals/codeclip/provider-polling/structured-logger");

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
    "Usage: node scripts/codeclip-provider-polling-worker.js [--once]",
    "",
    "Runs generic codeClip provider polling cycles.",
    "Configuration uses CODECLIP_PROVIDER_POLLING_WORKER_* environment variables.",
  ].join("\n");
}

function createLogger() {
  return createCodeClipProviderPollingStructuredLogger();
}

function applyCliOverrides(config, args) {
  if (!args.once) return config;
  return { ...config, oneShot: true };
}

async function closePool(pool, logger) {
  if (!pool || typeof pool.end !== "function") return;
  try {
    await pool.end();
  } catch {
    logger.warn("provider_polling_worker_pool_close_failed", {});
  }
}

async function runCodeClipProviderPollingWorkerEntrypoint({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  queryClient = database.pool,
  logger = createLogger(),
  createRuntime = createCodeClipProviderPollingWorkerRuntime,
  loadConfig = loadCodeClipProviderPollingWorkerConfig,
  processLike = process,
  closeOwnedPool = false,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { status: "help" };
  }

  let runtime = null;
  let stopping = false;
  let signalStopResolve = null;
  const signalStopPromise = new Promise((resolve) => {
    signalStopResolve = resolve;
  });
  const stopRuntime = async () => {
    if (stopping) return;
    stopping = true;
    const result = runtime
      ? await runtime.stop()
      : { ok: true, status: "stopped" };
    signalStopResolve(result);
    return result;
  };

  const onSignal = () => {
    void stopRuntime();
  };

  try {
    const config = applyCliOverrides(loadConfig(env), args);
    if (!config.enabled) {
      logger.info("provider_polling_worker_disabled", {
        provider: config.provider || null,
        environment: config.environment || null,
      });
      return { ok: true, status: "disabled" };
    }
    if (!queryClient) {
      const error = new Error("DATABASE_UNAVAILABLE");
      error.code = "DATABASE_UNAVAILABLE";
      throw error;
    }

    runtime = createRuntime(config, { queryClient, logger });

    if (processLike && typeof processLike.once === "function") {
      processLike.once("SIGTERM", onSignal);
      processLike.once("SIGINT", onSignal);
    }

    const result = await runtime.start();
    if (result?.status === "disabled" || config.oneShot) {
      await stopRuntime();
    } else if (result?.status === "running") {
      // Await stop so finally/closeOwnedPool cannot end the shared pool while
      // the recurring runtime is still running (async finally runs before a
      // non-awaited returned Promise settles).
      return await signalStopPromise;
    }
    return result;
  } catch (error) {
    logger.error("provider_polling_worker_startup_failed", {
      errorCode: String(error?.code || error?.name || "startup_failed").slice(
        0,
        80
      ),
    });
    if (processLike) processLike.exitCode = 1;
    throw error;
  } finally {
    if (processLike && typeof processLike.removeListener === "function") {
      processLike.removeListener("SIGTERM", onSignal);
      processLike.removeListener("SIGINT", onSignal);
    }
    if (closeOwnedPool) {
      await closePool(queryClient, logger);
    }
  }
}

if (require.main === module) {
  runCodeClipProviderPollingWorkerEntrypoint({
    closeOwnedPool: true,
  }).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  runCodeClipProviderPollingWorkerEntrypoint,
};
