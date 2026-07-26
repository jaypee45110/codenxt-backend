const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const monitorPath =
  process.env.CODECLIP_MONITOR_MODULE_PATH ||
  path.resolve(
    "/Users/jan/event-platform/codenxt-backend",
    "scripts/codeclip-provider-delivery-monitor.js"
  );

const {
  DEFAULTS,
  loadConfig,
  validateOperatorSummary,
  pollOperatorSummary,
  classifySummary,
  createAlertMessage,
  sendWebhookAlert,
  sendNotification,
  createMonitorState,
  processMeasurement,
  createCodeClipProviderDeliveryMonitor,
} = require(monitorPath);

const SAFE_ADMIN_KEY = "test-admin-key-not-secret";
const SAFE_SUMMARY_URL = "https://monitor.example.test/summary";
const SAFE_WEBHOOK_URL = "https://alerts.example.test/hook";
const SAFE_EMAIL_TO = "monitor-recipient@example.test";
const SAFE_RESEND_KEY = "test-resend-key-not-secret";
const SAFE_FROM_EMAIL = "codeClip Monitor <monitor@example.test>";

function validEnv(overrides = {}) {
  return {
    CODECLIP_OPERATOR_SUMMARY_URL: SAFE_SUMMARY_URL,
    CODECLIP_ADMIN_KEY: SAFE_ADMIN_KEY,
    CODECLIP_MONITOR_ALERT_WEBHOOK_URL: SAFE_WEBHOOK_URL,
    CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: "slack",
    ...overrides,
  };
}

function validSummary(overrides = {}) {
  return {
    total: 0,
    completed: 0,
    committedIncomplete: 0,
    processing: 0,
    failedPrecommit: 0,
    unknown: 0,
    oldestCommittedIncompleteAt: null,
    oldestProcessingAt: null,
    latestCompletedAt: null,
    attentionRequired: false,
    attentionReasons: [],
    ...overrides,
  };
}

function validBody(summaryOverrides = {}, bodyOverrides = {}) {
  return {
    ok: true,
    vertical: "codeclip",
    generatedAt: "2026-07-12T12:00:00.000Z",
    providerDeliveries: validSummary(summaryOverrides),
    ...bodyOverrides,
  };
}

function createJsonResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function createInvalidJsonResponse(status = 200) {
  return {
    status,
    async json() {
      throw new SyntaxError("invalid json");
    },
  };
}

function createLogger() {
  const lines = {
    log: [],
    warn: [],
    error: [],
  };

  return {
    lines,
    logger: {
      log(line) {
        lines.log.push(String(line));
      },
      warn(line) {
        lines.warn.push(String(line));
      },
      error(line) {
        lines.error.push(String(line));
      },
    },
    text() {
      return [...lines.log, ...lines.warn, ...lines.error].join("\n");
    },
  };
}

function createClock(start = "2026-07-12T12:00:00.000Z") {
  let current = new Date(start);
  return {
    now() {
      return new Date(current.getTime());
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    set(value) {
      current = new Date(value);
    },
  };
}

function createTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false };
      timeouts.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cleared = true;
    },
    setInterval(fn, ms) {
      const entry = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(entry) {
      if (entry) entry.cleared = true;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    summaryUrl: SAFE_SUMMARY_URL,
    adminKey: SAFE_ADMIN_KEY,
    alertWebhookUrl: SAFE_WEBHOOK_URL,
    notificationKind: "slack",
    pollIntervalMs: 60000,
    timeoutMs: 5000,
    alertCooldownMs: 900000,
    httpFailureThreshold: 2,
    ...overrides,
  };
}

function createFetchSequence(results) {
  const calls = [];
  const queue = [...results];
  const fetchFn = async (...args) => {
    calls.push(args);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(...args);
    return next;
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function createEmailSender(results = [true]) {
  const calls = [];
  const queue = [...results];
  const sendEmailFn = async (payload) => {
    calls.push(payload);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  sendEmailFn.calls = calls;
  return sendEmailFn;
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function measurement(summaryOverrides = {}, overrides = {}) {
  const summary = validSummary(summaryOverrides);
  return {
    ok: true,
    httpStatus: 200,
    ...classifySummary(summary),
    summary,
    ...overrides,
  };
}

function webhookResponse(status = 204, body = "webhook-body-not-read") {
  return {
    status,
    async text() {
      throw new Error(body);
    },
    async json() {
      throw new Error(body);
    },
  };
}

function parseLogLines(lines) {
  return lines.map((line) => JSON.parse(line));
}

async function processWithFetch(measure, state, config, fetchResults, options = {}) {
  const fetchFn = createFetchSequence(fetchResults);
  const logger = options.logger || createLogger();
  const clock = options.clock || createClock();
  await processMeasurement(measure, state, config, {
    fetchFn,
    sendEmailFn: options.sendEmailFn,
    logger: logger.logger,
    clock,
    timers: options.timers || createTimers(),
  });
  return { fetchFn, logger, clock };
}

test("loadConfig rejects every missing core environment variable and whitespace core values", () => {
  for (const key of [
    "CODECLIP_OPERATOR_SUMMARY_URL",
    "CODECLIP_ADMIN_KEY",
  ]) {
    assert.throws(() => loadConfig(validEnv({ [key]: undefined })), /required/);
    assert.throws(() => loadConfig(validEnv({ [key]: "   " })), /required/);
  }
});

test("loadConfig accepts legacy Slack and Discord configuration and normalizes notification kind", () => {
  const slack = loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: " slack " }));
  const discord = loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: "DISCORD" }));

  assert.equal(slack.notificationKind, "slack");
  assert.equal(discord.notificationKind, "discord");
  assert.equal(slack.summaryUrl, SAFE_SUMMARY_URL);
  assert.equal(slack.alertWebhookUrl, SAFE_WEBHOOK_URL);
});

test("loadConfig accepts explicit Slack, Discord, and email notification configuration", () => {
  const slack = loadConfig(
    validEnv({ CODECLIP_MONITOR_NOTIFICATION_KIND: " slack " })
  );
  const discord = loadConfig(
    validEnv({ CODECLIP_MONITOR_NOTIFICATION_KIND: "DISCORD" })
  );
  const email = loadConfig(
    validEnv({
      CODECLIP_MONITOR_NOTIFICATION_KIND: "email",
      CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: undefined,
      CODECLIP_MONITOR_ALERT_WEBHOOK_URL: undefined,
      CODECLIP_MONITOR_ALERT_EMAIL_TO: ` ${SAFE_EMAIL_TO} `,
      RESEND_API_KEY: SAFE_RESEND_KEY,
      RESEND_FROM_EMAIL: SAFE_FROM_EMAIL,
    })
  );

  assert.equal(slack.notificationKind, "slack");
  assert.equal(discord.notificationKind, "discord");
  assert.equal(email.notificationKind, "email");
  assert.equal(email.alertEmailTo, SAFE_EMAIL_TO);
  assert.equal(email.alertWebhookUrl, undefined);
});

test("loadConfig rejects invalid notification kind, URLs, and URL credentials", () => {
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_MONITOR_NOTIFICATION_KIND: "pager" })),
    /email, slack, or discord/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: "email" })),
    /slack or discord/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_OPERATOR_SUMMARY_URL: "http://example.test" })),
    /https URL/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_URL: "http://example.test" })),
    /https URL/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_OPERATOR_SUMMARY_URL: "not a url" })),
    /https URL/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_URL: "not a url" })),
    /https URL/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_OPERATOR_SUMMARY_URL: "https://user@example.test" })),
    /credentials/
  );
  assert.throws(
    () => loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_WEBHOOK_URL: "https://user@example.test" })),
    /credentials/
  );
});

test("loadConfig validates email-only requirements without requiring webhook configuration", () => {
  const baseEmailEnv = {
    CODECLIP_MONITOR_NOTIFICATION_KIND: "email",
    CODECLIP_MONITOR_ALERT_WEBHOOK_KIND: undefined,
    CODECLIP_MONITOR_ALERT_WEBHOOK_URL: undefined,
    CODECLIP_MONITOR_ALERT_EMAIL_TO: SAFE_EMAIL_TO,
    RESEND_API_KEY: SAFE_RESEND_KEY,
    RESEND_FROM_EMAIL: SAFE_FROM_EMAIL,
  };

  assert.doesNotThrow(() => loadConfig(validEnv(baseEmailEnv)));
  assert.throws(
    () => loadConfig(validEnv({ ...baseEmailEnv, CODECLIP_MONITOR_ALERT_EMAIL_TO: undefined })),
    /CODECLIP_MONITOR_ALERT_EMAIL_TO/
  );
  assert.throws(
    () => loadConfig(validEnv({ ...baseEmailEnv, CODECLIP_MONITOR_ALERT_EMAIL_TO: "not-an-email" })),
    /valid email/
  );
  assert.throws(
    () => loadConfig(validEnv({ ...baseEmailEnv, CODECLIP_MONITOR_ALERT_EMAIL_TO: "a@example.test,b@example.test" })),
    /valid email/
  );
  assert.throws(
    () => loadConfig(validEnv({ ...baseEmailEnv, RESEND_API_KEY: undefined })),
    /RESEND_API_KEY/
  );
  assert.throws(
    () => loadConfig(validEnv({ ...baseEmailEnv, RESEND_FROM_EMAIL: "   " })),
    /RESEND_FROM_EMAIL/
  );
});

test("loadConfig applies defaults, accepts numeric overrides, and treats empty optional overrides as defaults", () => {
  const defaults = loadConfig(validEnv());
  assert.equal(defaults.pollIntervalMs, DEFAULTS.pollIntervalMs);
  assert.equal(defaults.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(defaults.alertCooldownMs, DEFAULTS.alertCooldownMs);
  assert.equal(defaults.httpFailureThreshold, DEFAULTS.httpFailureThreshold);

  const overridden = loadConfig(
    validEnv({
      CODECLIP_MONITOR_POLL_INTERVAL_MS: "1000",
      CODECLIP_MONITOR_TIMEOUT_MS: "2000",
      CODECLIP_MONITOR_ALERT_COOLDOWN_MS: "3000",
      CODECLIP_MONITOR_HTTP_FAILURE_THRESHOLD: "4",
    })
  );
  assert.equal(overridden.pollIntervalMs, 1000);
  assert.equal(overridden.timeoutMs, 2000);
  assert.equal(overridden.alertCooldownMs, 3000);
  assert.equal(overridden.httpFailureThreshold, 4);

  const empty = loadConfig(
    validEnv({
      CODECLIP_MONITOR_POLL_INTERVAL_MS: "",
      CODECLIP_MONITOR_TIMEOUT_MS: "",
      CODECLIP_MONITOR_ALERT_COOLDOWN_MS: "",
      CODECLIP_MONITOR_HTTP_FAILURE_THRESHOLD: "",
    })
  );
  assert.equal(empty.pollIntervalMs, DEFAULTS.pollIntervalMs);
  assert.equal(empty.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(empty.alertCooldownMs, DEFAULTS.alertCooldownMs);
  assert.equal(empty.httpFailureThreshold, DEFAULTS.httpFailureThreshold);
});

test("loadConfig rejects invalid numeric overrides", () => {
  const invalids = ["0", "-1", "1.5", "NaN", "abc"];
  const keys = [
    "CODECLIP_MONITOR_POLL_INTERVAL_MS",
    "CODECLIP_MONITOR_TIMEOUT_MS",
    "CODECLIP_MONITOR_ALERT_COOLDOWN_MS",
    "CODECLIP_MONITOR_ALERT_REMINDER_MS",
    "CODECLIP_MONITOR_HTTP_FAILURE_THRESHOLD",
  ];

  for (const key of keys) {
    for (const value of invalids) {
      assert.throws(() => loadConfig(validEnv({ [key]: value })), /positive integer/);
    }
  }
});

test("loadConfig applies conservative alert reminder default and override", () => {
  const defaults = loadConfig(validEnv());
  assert.equal(defaults.alertReminderMs, 21600000);

  const overridden = loadConfig(
    validEnv({ CODECLIP_MONITOR_ALERT_REMINDER_MS: "7200000" })
  );
  assert.equal(overridden.alertReminderMs, 7200000);

  const empty = loadConfig(validEnv({ CODECLIP_MONITOR_ALERT_REMINDER_MS: "" }));
  assert.equal(empty.alertReminderMs, 21600000);
});

test("validateOperatorSummary accepts valid empty and fully populated summaries", () => {
  assert.deepEqual(validateOperatorSummary(validBody()), validSummary());

  const full = validBody({
    total: 5,
    completed: 2,
    committedIncomplete: 1,
    processing: 1,
    failedPrecommit: 1,
    unknown: 0,
    oldestCommittedIncompleteAt: "2026-07-12T10:00:00.000Z",
    oldestProcessingAt: "2026-07-12T11:00:00.000Z",
    latestCompletedAt: "2026-07-12T12:00:00.000Z",
    attentionRequired: true,
    attentionReasons: ["committed_incomplete"],
  });

  assert.equal(validateOperatorSummary(full).total, 5);
});

test("validateOperatorSummary rejects unexpected fields and invalid response containers", () => {
  assert.throws(() => validateOperatorSummary(null), /Invalid response contract/);
  assert.throws(() => validateOperatorSummary([]), /Invalid response contract/);
  assert.throws(() => validateOperatorSummary(validBody({}, { extra: true })), /Unexpected top-level/);
  assert.throws(
    () => validateOperatorSummary(validBody({ extra: true })),
    /Unexpected providerDeliveries/
  );
  assert.throws(() => validateOperatorSummary(validBody({}, { ok: false })), /Invalid/);
  assert.throws(() => validateOperatorSummary(validBody({}, { vertical: "codepod" })), /Invalid/);
  assert.throws(
    () => validateOperatorSummary(validBody({}, { generatedAt: "not-a-date" })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({}, { providerDeliveries: null })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({}, { providerDeliveries: [] })),
    /Invalid/
  );
});

test("validateOperatorSummary rejects invalid count fields", () => {
  for (const field of [
    "total",
    "completed",
    "committedIncomplete",
    "processing",
    "failedPrecommit",
    "unknown",
  ]) {
    const bodyWithMissingCount = validBody();
    delete bodyWithMissingCount.providerDeliveries[field];
    assert.throws(() => validateOperatorSummary(bodyWithMissingCount), /Invalid/);

    assert.throws(() => validateOperatorSummary(validBody({ [field]: -1 })), /Invalid/);
    assert.throws(() => validateOperatorSummary(validBody({ [field]: 1.5 })), /Invalid/);
    assert.throws(() => validateOperatorSummary(validBody({ [field]: "1" })), /Invalid/);
  }
});

test("validateOperatorSummary validates aggregate timestamps and attention fields", () => {
  for (const field of [
    "oldestCommittedIncompleteAt",
    "oldestProcessingAt",
    "latestCompletedAt",
  ]) {
    assert.doesNotThrow(() => validateOperatorSummary(validBody({ [field]: null })));
    assert.throws(() => validateOperatorSummary(validBody({ [field]: "bad-date" })), /Invalid/);
  }

  assert.throws(
    () => validateOperatorSummary(validBody({ attentionRequired: "true" })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({ attentionReasons: "reason" })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({ attentionReasons: [""] })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({ attentionReasons: ["   "] })),
    /Invalid/
  );
  assert.throws(
    () => validateOperatorSummary(validBody({ attentionReasons: [1] })),
    /Invalid/
  );
  assert.doesNotThrow(() => validateOperatorSummary(validBody({ attentionReasons: [] })));
});

test("pollOperatorSummary sends safe GET request and classifies normal, critical, and warning summaries", async () => {
  const timers = createTimers();
  const fetchFn = createFetchSequence([
    createJsonResponse(200, validBody()),
    createJsonResponse(200, validBody({ committedIncomplete: 1 })),
    createJsonResponse(200, validBody({ unknown: 1 })),
  ]);
  const config = baseConfig();

  const normal = await pollOperatorSummary(config, { fetchFn, timers });
  const critical = await pollOperatorSummary(config, { fetchFn, timers });
  const warning = await pollOperatorSummary(config, { fetchFn, timers });

  assert.equal(normal.ok, true);
  assert.equal(normal.classification, "ok");
  assert.equal(critical.classification, "critical");
  assert.equal(critical.reason, "committed_incomplete");
  assert.equal(warning.classification, "warning");
  assert.equal(warning.reason, "unknown");

  const [url, options] = fetchFn.calls[0];
  assert.equal(url, SAFE_SUMMARY_URL);
  assert.equal(options.method, "GET");
  assert.deepEqual(Object.keys(options.headers), ["x-admin-key"]);
  assert.equal(options.headers["x-admin-key"], SAFE_ADMIN_KEY);
  assert.ok(timers.timeouts.every((entry) => entry.cleared));
});

test("pollOperatorSummary classifies HTTP and malformed response failures", async () => {
  for (const status of [401, 403, 404, 503]) {
    const result = await pollOperatorSummary(baseConfig(), {
      fetchFn: createFetchSequence([createJsonResponse(status, { ok: false })]),
      timers: createTimers(),
    });
    assert.equal(result.classification, "transport_error");
    assert.equal(result.reason, `http_${status}`);
    assert.equal(result.httpStatus, status);
  }

  const missing = await pollOperatorSummary(baseConfig(), {
    fetchFn: createFetchSequence([null]),
    timers: createTimers(),
  });
  assert.equal(missing.classification, "transport_error");
  assert.equal(missing.reason, "network");
});

test("pollOperatorSummary classifies invalid JSON, invalid contract, timeout, and network exceptions", async () => {
  const invalidJson = await pollOperatorSummary(baseConfig(), {
    fetchFn: createFetchSequence([createInvalidJsonResponse()]),
    timers: createTimers(),
  });
  assert.equal(invalidJson.reason, "invalid_json");

  const invalidContract = await pollOperatorSummary(baseConfig(), {
    fetchFn: createFetchSequence([createJsonResponse(200, validBody({}, { extra: true }))]),
    timers: createTimers(),
  });
  assert.equal(invalidContract.reason, "invalid_contract");

  const timeout = await pollOperatorSummary(baseConfig(), {
    fetchFn: createFetchSequence([abortError()]),
    timers: createTimers(),
  });
  assert.equal(timeout.reason, "timeout");

  const network = await pollOperatorSummary(baseConfig(), {
    fetchFn: createFetchSequence([new Error("network down")]),
    timers: createTimers(),
  });
  assert.equal(network.reason, "network");
});

test("processMeasurement sends immediate committedIncomplete and unknown alerts but ignores non-alerting aggregates", async () => {
  const config = baseConfig();
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();

  const committed = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(committed.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), true);

  const unknownState = createMonitorState();
  const unknown = await processWithFetch(
    measurement({ unknown: 1 }),
    unknownState,
    config,
    [webhookResponse()],
    { clock: createClock(), logger: createLogger() }
  );
  assert.equal(unknown.fetchFn.calls.length, 1);
  assert.equal(unknownState.alerts.has("unknown"), true);

  for (const summary of [
    { processing: 1 },
    { failedPrecommit: 1 },
    { attentionRequired: true, attentionReasons: ["committed_incomplete"] },
  ]) {
    const localState = createMonitorState();
    const result = await processWithFetch(
      measurement(summary),
      localState,
      config,
      [],
      { clock: createClock(), logger: createLogger() }
    );
    assert.equal(result.fetchFn.calls.length, 0);
    assert.equal(localState.alerts.size, 0);
  }
});

test("processMeasurement applies transport threshold and resets counter on a valid measurement", async () => {
  const config = baseConfig();
  const state = createMonitorState();
  const logger = createLogger();
  const clock = createClock();

  const first = await processWithFetch(
    { ok: false, httpStatus: null, classification: "transport_error", reason: "timeout", summary: null },
    state,
    config,
    [],
    { clock, logger }
  );
  assert.equal(first.fetchFn.calls.length, 0);
  assert.equal(state.consecutiveTransportFailures, 1);

  const second = await processWithFetch(
    { ok: false, httpStatus: null, classification: "transport_error", reason: "timeout", summary: null },
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(second.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("codeclip:transport_error:timeout:none"), true);
  assert.equal(state.alerts.get("codeclip:transport_error:timeout:none").reason, "timeout");

  await processWithFetch(measurement(), state, config, [webhookResponse()], { clock, logger });
  assert.equal(state.consecutiveTransportFailures, 0);
  assert.equal(state.consecutiveTransportFailureId, null);
  assert.equal(state.alerts.has("codeclip:transport_error:timeout:none"), false);
});

test("processMeasurement sends first http_401 alert when threshold is reached", async () => {
  const config = baseConfig({ httpFailureThreshold: 2 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };

  const first = await processWithFetch(http401, state, config, [], { clock, logger });
  assert.equal(first.fetchFn.calls.length, 0);
  assert.equal(state.alerts.size, 0);

  const second = await processWithFetch(http401, state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(second.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("codeclip:transport_error:http_401:401"), true);
  assert.equal(state.alerts.get("codeclip:transport_error:http_401:401").severity, "critical");
});

test("processMeasurement suppresses identical http_401 until explicit reminder period", async () => {
  const config = baseConfig({
    alertCooldownMs: 900000,
    alertReminderMs: 21600000,
    httpFailureThreshold: 2,
  });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };

  await processWithFetch(http401, state, config, [], { clock, logger });
  const firstAlert = await processWithFetch(http401, state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(firstAlert.fetchFn.calls.length, 1);
  const firstSentAt = state.alerts.get("codeclip:transport_error:http_401:401").lastSentAt;

  clock.advance(900000);
  const afterCooldown = await processWithFetch(http401, state, config, [], { clock, logger });
  assert.equal(afterCooldown.fetchFn.calls.length, 0);
  assert.equal(state.alerts.get("codeclip:transport_error:http_401:401").lastSentAt, firstSentAt);

  clock.advance(21600000 - 900000 - 1);
  const beforeReminder = await processWithFetch(http401, state, config, [], { clock, logger });
  assert.equal(beforeReminder.fetchFn.calls.length, 0);
  assert.equal(state.alerts.get("codeclip:transport_error:http_401:401").lastSentAt, firstSentAt);

  clock.advance(1);
  const reminder = await processWithFetch(http401, state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(reminder.fetchFn.calls.length, 1);
  assert.ok(state.alerts.get("codeclip:transport_error:http_401:401").lastSentAt > firstSentAt);
});

test("processMeasurement requires threshold for changed transport identity before replacing active alarm", async () => {
  const config = baseConfig({
    alertCooldownMs: 900000,
    alertReminderMs: 21600000,
    httpFailureThreshold: 2,
  });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };
  const http500 = {
    ok: false,
    httpStatus: 500,
    classification: "transport_error",
    reason: "http_500",
    summary: null,
  };

  await processWithFetch(http401, state, config, [], { clock, logger });
  await processWithFetch(http401, state, config, [webhookResponse()], { clock, logger });
  assert.equal(state.alerts.has("codeclip:transport_error:http_401:401"), true);
  assert.equal(state.consecutiveTransportFailures, 2);
  assert.equal(state.consecutiveTransportFailureId, "codeclip:transport_error:http_401:401");

  clock.advance(60000);
  const firstChanged = await processWithFetch(http500, state, config, [], {
    clock,
    logger,
  });
  assert.equal(firstChanged.fetchFn.calls.length, 0);
  assert.equal(state.consecutiveTransportFailures, 1);
  assert.equal(state.consecutiveTransportFailureId, "codeclip:transport_error:http_500:500");
  assert.equal(state.alerts.has("codeclip:transport_error:http_401:401"), true);
  assert.equal(state.alerts.has("codeclip:transport_error:http_500:500"), false);

  clock.advance(60000);
  const secondChanged = await processWithFetch(http500, state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(secondChanged.fetchFn.calls.length, 1);
  assert.equal(state.consecutiveTransportFailures, 2);
  assert.equal(state.consecutiveTransportFailureId, "codeclip:transport_error:http_500:500");
  assert.equal(state.alerts.has("codeclip:transport_error:http_500:500"), true);
  assert.equal(state.alerts.has("codeclip:transport_error:http_401:401"), false);
});

test("processMeasurement does not share threshold across alternating transport identities", async () => {
  const config = baseConfig({ httpFailureThreshold: 2, alertReminderMs: 21600000 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };
  const http500 = {
    ok: false,
    httpStatus: 500,
    classification: "transport_error",
    reason: "http_500",
    summary: null,
  };

  for (const item of [http401, http500, http401, http500]) {
    const result = await processWithFetch(item, state, config, [], { clock, logger });
    assert.equal(result.fetchFn.calls.length, 0);
    assert.equal(state.consecutiveTransportFailures, 1);
  }

  assert.equal(state.alerts.size, 0);
  assert.equal(state.consecutiveTransportFailureId, "codeclip:transport_error:http_500:500");
});

test("processMeasurement resets transport counter identity on healthy measurement", async () => {
  const config = baseConfig({ httpFailureThreshold: 2, alertReminderMs: 21600000 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };

  await processWithFetch(http401, state, config, [], { clock, logger });
  assert.equal(state.consecutiveTransportFailures, 1);
  assert.equal(state.consecutiveTransportFailureId, "codeclip:transport_error:http_401:401");

  await processWithFetch(measurement(), state, config, [], { clock, logger });
  assert.equal(state.consecutiveTransportFailures, 0);
  assert.equal(state.consecutiveTransportFailureId, null);
});

test("processMeasurement sends one transport recovery, then allows same failure after recovery", async () => {
  const config = baseConfig({ httpFailureThreshold: 2, alertReminderMs: 21600000 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };

  await processWithFetch(http401, state, config, [], { clock, logger });
  await processWithFetch(http401, state, config, [webhookResponse()], { clock, logger });

  const recovered = await processWithFetch(measurement(), state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(recovered.fetchFn.calls.length, 1);
  assert.match(JSON.parse(recovered.fetchFn.calls[0][1].body).text, /reason=transport_http_401_recovered/);
  assert.equal(state.alerts.size, 0);

  const stillOk = await processWithFetch(measurement(), state, config, [], { clock, logger });
  assert.equal(stillOk.fetchFn.calls.length, 0);

  await processWithFetch(http401, state, config, [], { clock, logger });
  const newFailure = await processWithFetch(http401, state, config, [webhookResponse()], {
    clock,
    logger,
  });
  assert.equal(newFailure.fetchFn.calls.length, 1);
});

test("createMonitorState documents restart limitation by starting with empty in-memory alerts", async () => {
  const config = baseConfig({ httpFailureThreshold: 2, alertReminderMs: 21600000 });
  const http401 = {
    ok: false,
    httpStatus: 401,
    classification: "transport_error",
    reason: "http_401",
    summary: null,
  };

  const beforeRestart = createMonitorState();
  await processWithFetch(http401, beforeRestart, config, [], { clock: createClock(), logger: createLogger() });
  await processWithFetch(http401, beforeRestart, config, [webhookResponse()], {
    clock: createClock(),
    logger: createLogger(),
  });
  assert.equal(beforeRestart.alerts.size, 1);

  const afterRestart = createMonitorState();
  assert.equal(afterRestart.alerts.size, 0);
  assert.equal(afterRestart.consecutiveTransportFailures, 0);
  assert.equal(afterRestart.consecutiveTransportFailureId, null);
});

test("processMeasurement sends invalid_json and invalid_contract alerts immediately", async () => {
  for (const reason of ["invalid_json", "invalid_contract"]) {
    const state = createMonitorState();
    const result = await processWithFetch(
      { ok: false, httpStatus: 200, classification: "critical", reason, summary: null },
      state,
      baseConfig(),
      [webhookResponse()],
      { clock: createClock(), logger: createLogger() }
    );
    assert.equal(result.fetchFn.calls.length, 1);
    assert.equal(state.alerts.has(reason), true);
  }
});

test("processMeasurement suppresses alarms inside cooldown and sends reminder after cooldown", async () => {
  const config = baseConfig({ alertCooldownMs: 1000 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();

  const first = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(first.fetchFn.calls.length, 1);
  const firstSentAt = state.alerts.get("committed_incomplete").lastSentAt;

  clock.advance(500);
  const suppressed = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [],
    { clock, logger }
  );
  assert.equal(suppressed.fetchFn.calls.length, 0);
  assert.equal(state.alerts.get("committed_incomplete").lastSentAt, firstSentAt);

  clock.advance(600);
  const reminder = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(reminder.fetchFn.calls.length, 1);
  assert.ok(state.alerts.get("committed_incomplete").lastSentAt > firstSentAt);
});

test("processMeasurement retries failed first alert and failed reminder without moving cooldown", async () => {
  const config = baseConfig({ alertCooldownMs: 1000 });
  const clock = createClock();
  const logger = createLogger();
  const state = createMonitorState();

  const failedFirst = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse(500)],
    { clock, logger }
  );
  assert.equal(failedFirst.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), false);

  const retried = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(retried.fetchFn.calls.length, 1);
  const lastSentAt = state.alerts.get("committed_incomplete").lastSentAt;

  clock.advance(1100);
  const failedReminder = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse(500)],
    { clock, logger }
  );
  assert.equal(failedReminder.fetchFn.calls.length, 1);
  assert.equal(state.alerts.get("committed_incomplete").lastSentAt, lastSentAt);

  const retryReminder = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse()],
    { clock, logger }
  );
  assert.equal(retryReminder.fetchFn.calls.length, 1);
  assert.ok(state.alerts.get("committed_incomplete").lastSentAt > lastSentAt);
});

test("processMeasurement uses email provider for alert, reminder, and recovery", async () => {
  const config = baseConfig({
    notificationKind: "email",
    alertEmailTo: SAFE_EMAIL_TO,
    alertCooldownMs: 1000,
  });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();
  const sendEmailFn = createEmailSender([true, true, true]);

  await processMeasurement(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    {
      sendEmailFn,
      fetchFn: createFetchSequence([webhookResponse()]),
      logger: logger.logger,
      clock,
      timers: createTimers(),
    }
  );

  assert.equal(sendEmailFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), true);

  await processMeasurement(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    {
      sendEmailFn,
      fetchFn: createFetchSequence([webhookResponse()]),
      logger: logger.logger,
      clock,
      timers: createTimers(),
    }
  );

  assert.equal(sendEmailFn.calls.length, 1);

  clock.advance(1001);
  await processMeasurement(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    {
      sendEmailFn,
      fetchFn: createFetchSequence([webhookResponse()]),
      logger: logger.logger,
      clock,
      timers: createTimers(),
    }
  );

  assert.equal(sendEmailFn.calls.length, 2);
  assert.match(sendEmailFn.calls[1].text, /reason=committed_incomplete/);

  await processMeasurement(measurement(), state, config, {
    sendEmailFn,
    fetchFn: createFetchSequence([webhookResponse()]),
    logger: logger.logger,
    clock,
    timers: createTimers(),
  });

  assert.equal(sendEmailFn.calls.length, 3);
  assert.match(sendEmailFn.calls[2].text, /reason=committed_incomplete_recovered/);
  assert.equal(state.alerts.has("committed_incomplete"), false);
  assert.doesNotMatch(logger.text(), /monitor-recipient|test-resend-key|CodeClip Monitor <monitor@example.test>/i);
});

test("processMeasurement treats email delivery failure as notification failure", async () => {
  const config = baseConfig({
    notificationKind: "email",
    alertEmailTo: SAFE_EMAIL_TO,
  });
  const state = createMonitorState();
  const sendEmailFn = createEmailSender([new Error("email provider response should not leak")]);
  const logger = createLogger();

  await processMeasurement(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    {
      sendEmailFn,
      fetchFn: createFetchSequence([webhookResponse()]),
      logger: logger.logger,
      clock: createClock(),
      timers: createTimers(),
    }
  );

  assert.equal(sendEmailFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), false);
  assert.doesNotMatch(logger.text(), /email provider response|monitor-recipient|test-resend-key/);
});

test("processMeasurement normal email measurement sends no notification", async () => {
  const sendEmailFn = createEmailSender();
  await processMeasurement(
    measurement(),
    createMonitorState(),
    baseConfig({ notificationKind: "email", alertEmailTo: SAFE_EMAIL_TO }),
    {
      sendEmailFn,
      fetchFn: createFetchSequence([webhookResponse()]),
      logger: createLogger().logger,
      clock: createClock(),
      timers: createTimers(),
    }
  );

  assert.equal(sendEmailFn.calls.length, 0);
});

test("processMeasurement sends stable recovery messages once and clears state after delivery", async () => {
  const recoveries = [
    ["committed_incomplete", "committed_incomplete_recovered"],
    ["unknown", "unknown_recovered"],
    ["invalid_json", "invalid_json_recovered"],
    ["invalid_contract", "invalid_contract_recovered"],
    ["transport_failure", "transport_recovered"],
  ];

  for (const [alarmId, recoveryReason] of recoveries) {
    const state = createMonitorState();
    state.alerts.set(alarmId, {
      notified: true,
      lastSentAt: 1,
      severity: alarmId === "unknown" ? "warning" : "critical",
      reason: alarmId,
    });
    const result = await processWithFetch(
      measurement(),
      state,
      baseConfig(),
      [webhookResponse()],
      { clock: createClock(), logger: createLogger() }
    );
    assert.equal(result.fetchFn.calls.length, 1);
    const payload = JSON.parse(result.fetchFn.calls[0][1].body);
    assert.match(payload.text, new RegExp(`reason=${recoveryReason}`));
    assert.equal(state.alerts.has(alarmId), false);

    const second = await processWithFetch(
      measurement(),
      state,
      baseConfig(),
      [],
      { clock: createClock(), logger: createLogger() }
    );
    assert.equal(second.fetchFn.calls.length, 0);
  }
});

test("processMeasurement does not recover alarms that were never delivered and retries failed recovery", async () => {
  const config = baseConfig();
  const state = createMonitorState();
  state.alerts.set("committed_incomplete", {
    notified: false,
    lastSentAt: 1,
    severity: "critical",
    reason: "committed_incomplete",
  });

  const neverDelivered = await processWithFetch(
    measurement(),
    state,
    config,
    [],
    { clock: createClock(), logger: createLogger() }
  );
  assert.equal(neverDelivered.fetchFn.calls.length, 0);
  assert.equal(state.alerts.has("committed_incomplete"), true);

  state.alerts.set("committed_incomplete", {
    notified: true,
    lastSentAt: 1,
    severity: "critical",
    reason: "committed_incomplete",
  });

  const failed = await processWithFetch(
    measurement(),
    state,
    config,
    [webhookResponse(500)],
    { clock: createClock(), logger: createLogger() }
  );
  assert.equal(failed.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), true);

  const retried = await processWithFetch(
    measurement(),
    state,
    config,
    [webhookResponse()],
    { clock: createClock(), logger: createLogger() }
  );
  assert.equal(retried.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("committed_incomplete"), false);
});

test("processMeasurement only recovers transport alarms on valid ok measurements", async () => {
  const state = createMonitorState();
  state.alerts.set("transport_failure", {
    notified: true,
    lastSentAt: 1,
    severity: "critical",
    reason: "timeout",
  });

  const invalidJson = await processWithFetch(
    { ok: false, httpStatus: 200, classification: "critical", reason: "invalid_json", summary: null },
    state,
    baseConfig(),
    [webhookResponse()],
    { clock: createClock(), logger: createLogger() }
  );
  assert.equal(invalidJson.fetchFn.calls.length, 1);
  assert.equal(state.alerts.has("transport_failure"), true);
  assert.equal(state.alerts.has("invalid_json"), true);
});

test("sendNotification selects email provider and sends safe email content", async () => {
  const config = baseConfig({
    notificationKind: "email",
    alertEmailTo: SAFE_EMAIL_TO,
  });
  const sendEmailFn = createEmailSender();
  const fetchFn = createFetchSequence([webhookResponse()]);
  const message = createAlertMessage({
    severity: "critical",
    reason: "committed_incomplete",
    timestamp: "2026-07-12T12:00:00.000Z",
    httpStatus: 200,
    summary: validSummary({ committedIncomplete: 1 }),
  });

  const ok = await sendNotification(config, message, {
    sendEmailFn,
    fetchFn,
    timers: createTimers(),
    logger: createLogger().logger,
  });

  assert.equal(ok, true);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(sendEmailFn.calls.length, 1);
  assert.deepEqual(sendEmailFn.calls[0], {
    to: SAFE_EMAIL_TO,
    subject: "codeClip provider delivery monitor alert",
    text: message,
    html: `<pre>${message}</pre>`,
    fromName: "codeClip Provider Monitor",
  });

  const serialized = JSON.stringify(sendEmailFn.calls[0]);
  assert.doesNotMatch(serialized, /test-admin-key|https:\/\/monitor|test-resend-key/);
});

test("sendNotification treats email provider failure as delivery failure", async () => {
  const config = baseConfig({
    notificationKind: "email",
    alertEmailTo: SAFE_EMAIL_TO,
  });
  const logger = createLogger();
  const ok = await sendNotification(config, "safe message", {
    sendEmailFn: createEmailSender([new Error("provider response should not leak")]),
    timers: createTimers(),
    logger: logger.logger,
  });

  assert.equal(ok, false);
  assert.doesNotMatch(logger.text(), /provider response should not leak|monitor-recipient|test-resend-key/);
});

test("sendNotification keeps Slack and Discord on webhook transport", async () => {
  for (const kind of ["slack", "discord"]) {
    const fetchFn = createFetchSequence([webhookResponse(204)]);
    const sendEmailFn = createEmailSender();
    const ok = await sendNotification(baseConfig({ notificationKind: kind }), "safe message", {
      fetchFn,
      sendEmailFn,
      timers: createTimers(),
      logger: createLogger().logger,
    });

    assert.equal(ok, true);
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(sendEmailFn.calls.length, 0);
  }
});

test("sendWebhookAlert sends Slack and Discord payloads without reading response body", async () => {
  for (const [kind, field] of [["slack", "text"], ["discord", "content"]]) {
    const fetchFn = createFetchSequence([webhookResponse(204)]);
    const ok = await sendWebhookAlert(
      baseConfig({ notificationKind: kind }),
      "safe message",
      { fetchFn, timers: createTimers(), logger: createLogger().logger }
    );
    assert.equal(ok, true);
    const [url, options] = fetchFn.calls[0];
    assert.equal(url, SAFE_WEBHOOK_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["content-type"], "application/json");
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload), [field]);
    assert.equal(payload[field], "safe message");
  }
});

test("sendWebhookAlert returns false for non-2xx, network, and timeout failures without leaking response body", async () => {
  const logger = createLogger();
  const non2xx = await sendWebhookAlert(baseConfig(), "safe message", {
    fetchFn: createFetchSequence([webhookResponse(500, "do-not-read")]),
    timers: createTimers(),
    logger: logger.logger,
    clock: createClock(),
  });
  const network = await sendWebhookAlert(baseConfig(), "safe message", {
    fetchFn: createFetchSequence([new Error("network contains sensitive detail")]),
    timers: createTimers(),
    logger: logger.logger,
    clock: createClock(),
  });
  const timeout = await sendWebhookAlert(baseConfig(), "safe message", {
    fetchFn: createFetchSequence([abortError()]),
    timers: createTimers(),
    logger: logger.logger,
    clock: createClock(),
  });

  assert.equal(non2xx, false);
  assert.equal(network, false);
  assert.equal(timeout, false);
  const text = logger.text();
  assert.doesNotMatch(text, /do-not-read|sensitive detail|https:\/\/alerts|x-admin-key|test-admin-key/);
});

test("webhook failure logging is damped but delivery attempts continue", async () => {
  const config = baseConfig({ alertCooldownMs: 1000 });
  const state = createMonitorState();
  const clock = createClock();
  const logger = createLogger();

  const first = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse(500)],
    { clock, logger }
  );
  const second = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse(500)],
    { clock, logger }
  );
  clock.advance(1100);
  const third = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    state,
    config,
    [webhookResponse(500)],
    { clock, logger }
  );

  assert.equal(first.fetchFn.calls.length, 1);
  assert.equal(second.fetchFn.calls.length, 1);
  assert.equal(third.fetchFn.calls.length, 1);
  assert.equal(logger.lines.warn.length, 2);

  const successLogger = createLogger();
  const success = await processWithFetch(
    measurement({ committedIncomplete: 1 }),
    createMonitorState(),
    config,
    [webhookResponse()],
    { clock: createClock(), logger: successLogger }
  );
  assert.equal(success.fetchFn.calls.length, 1);
  assert.equal(successLogger.lines.warn.length, 0);
});

test("safe measurement, transport, startup, shutdown, and internal-error logs exclude sensitive data", async () => {
  const logger = createLogger();
  const clock = createClock();
  const config = baseConfig();
  const monitor = createCodeClipProviderDeliveryMonitor(config, {
    fetchFn: async () => createJsonResponse(200, validBody()),
    logger: logger.logger,
    clock,
    timers: createTimers(),
  });

  monitor.start();
  monitor.stop();
  await processMeasurement(
    { ok: false, httpStatus: null, classification: "transport_error", reason: "network", summary: null },
    createMonitorState(),
    config,
    { logger: logger.logger, clock, fetchFn: createFetchSequence([]), timers: createTimers() }
  );

  const throwingLogger = createLogger();
  const brokenMonitor = createCodeClipProviderDeliveryMonitor(config, {
    fetchFn: async () => createJsonResponse(200, validBody()),
    logger: {
      log() {
        throw new Error("stack should not leak");
      },
      warn: throwingLogger.logger.warn,
      error: throwingLogger.logger.error,
    },
    clock,
    timers: createTimers(),
  });
  await brokenMonitor.tick();

  const combined = `${logger.text()}\n${throwingLogger.text()}`;
  assert.doesNotMatch(
    combined,
    /test-admin-key|https:\/\/monitor|https:\/\/alerts|x-admin-key|providerAccount|messageId|eventCode|deliveryId|stack should not leak|providerDeliveries/
  );

  const parsed = parseLogLines([...logger.lines.log, ...logger.lines.warn, ...logger.lines.error]);
  assert.ok(parsed.some((entry) => entry.event === "started"));
  assert.ok(parsed.some((entry) => entry.event === "stopped"));
  assert.ok(parsed.some((entry) => entry.event === "measurement" && entry.total === null));
});

test("createCodeClipProviderDeliveryMonitor starts immediately, registers interval, avoids overlap, stops cleanly, and continues after internal errors", async () => {
  const config = baseConfig({ pollIntervalMs: 1234 });
  const timers = createTimers();
  const clock = createClock();
  const logger = createLogger();
  let releaseFetch;
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
    }
    return createJsonResponse(200, validBody());
  };

  const monitor = createCodeClipProviderDeliveryMonitor(config, {
    fetchFn,
    logger: logger.logger,
    timers,
    clock,
  });

  monitor.start();
  assert.equal(fetchCalls, 1);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 1234);

  const overlapped = await monitor.tick();
  assert.equal(overlapped, false);
  assert.equal(fetchCalls, 1);

  releaseFetch();
  await new Promise((resolve) => setImmediate(resolve));
  const afterFirst = await monitor.tick();
  assert.equal(afterFirst, true);
  assert.equal(fetchCalls, 2);

  monitor.stop();
  assert.equal(timers.intervals[0].cleared, true);
  const afterStop = await monitor.tick();
  assert.equal(afterStop, false);

  const errorLogger = createLogger();
  const errorMonitor = createCodeClipProviderDeliveryMonitor(config, {
    fetchFn: async () => createJsonResponse(200, validBody()),
    logger: {
      log() {
        throw new Error("boom");
      },
      warn: errorLogger.logger.warn,
      error: errorLogger.logger.error,
    },
    timers: createTimers(),
    clock,
  });
  const first = await errorMonitor.tick();
  const second = await errorMonitor.tick();
  assert.equal(first, false);
  assert.equal(second, false);
  assert.match(errorLogger.text(), /monitor_internal_error/);
});
