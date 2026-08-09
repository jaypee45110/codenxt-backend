const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyCodeClipProviderPollingSourceHealth,
  classifyCodeClipProviderPollingDeliveryHealth,
} = require("./verticals/codeclip/provider-polling/health-classification");

const NOW = "2026-08-09T12:00:00.000Z";

test("healthy active source with recent success", () => {
  const result = classifyCodeClipProviderPollingSourceHealth({
    now: NOW,
    source: {
      status: "active",
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastSuccessAt: "2026-08-09T11:55:00.000Z",
      pollIntervalMs: 300000,
    },
  });
  assert.equal(result.classification, "healthy");
});

test("consecutive failures classify as degraded", () => {
  const result = classifyCodeClipProviderPollingSourceHealth({
    now: NOW,
    source: {
      status: "active",
      consecutiveFailures: 3,
      lastErrorCode: "retryable",
      lastSuccessAt: "2026-08-09T11:55:00.000Z",
      pollIntervalMs: 300000,
    },
  });
  assert.equal(result.classification, "degraded");
});

test("reauthorization_required classifies reauthorization", () => {
  const result = classifyCodeClipProviderPollingSourceHealth({
    now: NOW,
    source: {
      status: "paused",
      consecutiveFailures: 1,
      lastErrorCode: "reauthorization_required",
      lastSuccessAt: "2026-08-09T11:00:00.000Z",
      pollIntervalMs: 300000,
    },
  });
  assert.equal(result.classification, "reauthorization");
});

test("stale last success classifies stale", () => {
  const result = classifyCodeClipProviderPollingSourceHealth({
    now: NOW,
    source: {
      status: "active",
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastSuccessAt: "2026-08-09T08:00:00.000Z",
      pollIntervalMs: 300000,
    },
  });
  assert.equal(result.classification, "stale");
});

test("missing source is not_configured", () => {
  const result = classifyCodeClipProviderPollingSourceHealth({ source: null });
  assert.equal(result.classification, "not_configured");
});

test("terminal completion failures classify terminal_delivery", () => {
  const result = classifyCodeClipProviderPollingDeliveryHealth({
    terminalCompletionFailures: 2,
  });
  assert.equal(result.classification, "terminal_delivery");
});
