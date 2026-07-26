const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRuntimeConfig,
  parseArgs,
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
