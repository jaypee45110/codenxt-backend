const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodeClipProviderPollingLogPayload,
  createCodeClipProviderPollingStructuredLogger,
} = require("./verticals/codeclip/provider-polling/structured-logger");

test("structured logger builds single-line JSON with allowlisted fields only", () => {
  const lines = [];
  const logger = createCodeClipProviderPollingStructuredLogger({
    info: (line) => lines.push(line),
  });
  logger.info("provider_polling_cycle_completed", {
    provider: "tiktok",
    environment: "sandbox",
    cycleNumber: 3,
    status: "completed",
    scanned: 1,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    accessToken: "secret-token",
    providerAccountId: "open-id-leak",
    message: "should-not-appear",
    stack: "Error stack",
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^codeClip provider polling worker \{/);
  const jsonPart = lines[0].slice(lines[0].indexOf("{"));
  const payload = JSON.parse(jsonPart);
  assert.equal(payload.operationalEvent, "provider_polling_cycle_completed");
  assert.equal(payload.provider, "tiktok");
  assert.equal(payload.scanned, 1);
  assert.equal(payload.attempted, 1);
  assert.equal(payload.succeeded, 1);
  assert.equal(payload.accessToken, undefined);
  assert.equal(payload.providerAccountId, undefined);
  assert.equal(payload.message, undefined);
  assert.equal(payload.stack, undefined);
  assert.equal(lines[0].includes("\n"), false);
});

test("completion event uses distinct selected/completed fields not poll aliases", () => {
  const payload = buildCodeClipProviderPollingLogPayload(
    "provider_polling_completion_completed",
    {
      provider: "tiktok",
      environment: "sandbox",
      cycleNumber: 3,
      status: "completed",
      selected: 0,
      completed: 0,
      terminalFailed: 0,
      retryableFailed: 0,
      skipped: 0,
      // poll-like fields must not be required/confused
      scanned: 1,
      attempted: 1,
    }
  );
  assert.equal(payload.operationalEvent, "provider_polling_completion_completed");
  assert.equal(payload.selected, 0);
  assert.equal(payload.completed, 0);
  assert.equal(payload.terminalFailed, 0);
  assert.equal(payload.retryableFailed, 0);
  // scanned can still be present if caller passes it, but worker does not
  assert.equal(payload.scanned, 1);
});

test("structured logger preserves safe diagnostics and drops secrets", () => {
  const lines = [];
  const logger = createCodeClipProviderPollingStructuredLogger({
    error: (line) => lines.push(line),
  });
  logger.error("provider_polling_cycle_failed", {
    provider: "tiktok",
    environment: "sandbox",
    cycleNumber: 1,
    errorCode: "DUE_SOURCE_SCAN_FAILED",
    underlyingCode: "ENOTFOUND",
    scanStage: "due_source_query_failed",
    DATABASE_URL: "postgresql://u:p@host/db",
    sql: "SELECT * FROM secrets",
  });
  const payload = JSON.parse(lines[0].slice(lines[0].indexOf("{")));
  assert.equal(payload.errorCode, "DUE_SOURCE_SCAN_FAILED");
  assert.equal(payload.underlyingCode, "ENOTFOUND");
  assert.equal(payload.scanStage, "due_source_query_failed");
  assert.equal(payload.DATABASE_URL, undefined);
  assert.equal(payload.sql, undefined);
  assert.equal(JSON.stringify(payload).includes("postgresql://"), false);
});
