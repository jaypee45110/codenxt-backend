#!/usr/bin/env node

const {
  formatHumanReport,
  sanitizeOperationalError,
  scanCodeClipYouTubeReconciliation,
} = require("../verticals/codeclip/youtube-reconciliation-scanner");
const database = require("../db");

function parseArgs(argv) {
  const args = {
    json: false,
    source: "atom",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        const error = new Error("argument requires a value");
        error.code = "invalid_argument";
        error.details = { fieldName: name.replace(/^--/, "") };
        throw error;
      }
      index += 1;
      return value;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--event-code") args.eventCode = readValue(arg);
    else if (arg === "--provider-account-id") args.providerAccountId = readValue(arg);
    else if (arg === "--channel-id") args.channelId = readValue(arg);
    else if (arg === "--limit") args.limit = readValue(arg);
    else if (arg === "--lookback-hours") args.lookbackHours = readValue(arg);
    else if (arg === "--source") args.source = readValue(arg);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      const error = new Error("unknown argument");
      error.code = "invalid_argument";
      error.details = { fieldName: "argument" };
      throw error;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/codeclip-youtube-reconciliation-scanner.js [options]",
    "",
    "READ-ONLY scanner for codeClip YouTube missing provider-event candidates.",
    "",
    "Options:",
    "  --event-code <code>",
    "  --provider-account-id <UC channel id>",
    "  --channel-id <UC channel id>",
    "  --limit <count>",
    "  --lookback-hours <hours>",
    "  --source <atom|data_api>",
    "  --json",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const report = await scanCodeClipYouTubeReconciliation({
    ...args,
    queryClient: database.pool,
  });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatHumanReport(report));
  return report.errors.length ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const safe = sanitizeOperationalError(error, "source_failed");
      process.stderr.write(`codeClip YouTube reconciliation scanner failed: ${safe.code}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  usage,
};
