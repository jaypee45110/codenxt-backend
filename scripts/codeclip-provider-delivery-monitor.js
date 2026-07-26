#!/usr/bin/env node

const MONITOR_NAME = "codeclip_provider_deliveries";

/*
 * Alarm state is intentionally in-memory for this first monitor version.
 * A service restart clears active alarms, cooldown state, and transport counters.
 * The monitor never writes Redis, PostgreSQL, files, or delivery state.
 *
 * This monitor intentionally validates the exact public operator contract.
 * Unknown response fields are treated as a breaking change.
 */

const DEFAULTS = Object.freeze({
  pollIntervalMs: 60000,
  timeoutMs: 5000,
  alertCooldownMs: 900000,
  alertReminderMs: 21600000,
  httpFailureThreshold: 2,
});

const REQUIRED_ENV = Object.freeze([
  "CODECLIP_OPERATOR_SUMMARY_URL",
  "CODECLIP_ADMIN_KEY",
]);

const ALLOWED_NOTIFICATION_KINDS = new Set(["email", "slack", "discord"]);
const WEBHOOK_NOTIFICATION_KINDS = new Set(["slack", "discord"]);
const EMAIL_SUBJECT = "codeClip provider delivery monitor alert";
const EMAIL_FROM_NAME = "codeClip Provider Monitor";

const TOP_LEVEL_FIELDS = new Set([
  "ok",
  "vertical",
  "generatedAt",
  "providerDeliveries",
]);

const SUMMARY_FIELDS = new Set([
  "total",
  "completed",
  "committedIncomplete",
  "processing",
  "failedPrecommit",
  "unknown",
  "oldestCommittedIncompleteAt",
  "oldestProcessingAt",
  "latestCompletedAt",
  "attentionRequired",
  "attentionReasons",
]);

const COUNT_FIELDS = Object.freeze([
  "total",
  "completed",
  "committedIncomplete",
  "processing",
  "failedPrecommit",
  "unknown",
]);

const TIMESTAMP_FIELDS = Object.freeze([
  "oldestCommittedIncompleteAt",
  "oldestProcessingAt",
  "latestCompletedAt",
]);

function parsePositiveInteger(value, name, defaultValue) {
  const raw =
    value === undefined || value === null || value === ""
      ? defaultValue
      : value;
  const parsed = typeof raw === "number" ? raw : Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseHttpsUrl(value, name) {
  let parsed;

  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${name} must be a valid https URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid https URL`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not include credentials`);
  }

  return parsed.toString();
}

function normalizeNotificationKind(env = process.env) {
  const explicitKind = String(env.CODECLIP_MONITOR_NOTIFICATION_KIND || "")
    .trim()
    .toLowerCase();

  if (explicitKind) return { notificationKind: explicitKind, explicit: true };

  const legacyKind = String(env.CODECLIP_MONITOR_ALERT_WEBHOOK_KIND || "")
    .trim()
    .toLowerCase();

  return { notificationKind: legacyKind, explicit: false };
}

function parseEmailAddress(value, name) {
  const email = String(value || "").trim();

  if (!email) {
    throw new Error(`${name} is required`);
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[<>,;]/.test(email)
  ) {
    throw new Error(`${name} must be a valid email address`);
  }

  return email;
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function loadConfig(env = process.env) {
  for (const name of REQUIRED_ENV) {
    if (typeof env[name] !== "string" || env[name].trim().length === 0) {
      throw new Error(`${name} is required`);
    }
  }

  const { notificationKind, explicit } = normalizeNotificationKind(env);

  if (!ALLOWED_NOTIFICATION_KINDS.has(notificationKind)) {
    throw new Error(
      "CODECLIP_MONITOR_NOTIFICATION_KIND must be email, slack, or discord"
    );
  }

  if (!explicit && notificationKind === "email") {
    throw new Error(
      "CODECLIP_MONITOR_ALERT_WEBHOOK_KIND must be slack or discord"
    );
  }

  const config = {
    summaryUrl: parseHttpsUrl(
      env.CODECLIP_OPERATOR_SUMMARY_URL,
      "CODECLIP_OPERATOR_SUMMARY_URL"
    ),
    adminKey: env.CODECLIP_ADMIN_KEY,
    notificationKind,
    pollIntervalMs: parsePositiveInteger(
      env.CODECLIP_MONITOR_POLL_INTERVAL_MS,
      "CODECLIP_MONITOR_POLL_INTERVAL_MS",
      DEFAULTS.pollIntervalMs
    ),
    timeoutMs: parsePositiveInteger(
      env.CODECLIP_MONITOR_TIMEOUT_MS,
      "CODECLIP_MONITOR_TIMEOUT_MS",
      DEFAULTS.timeoutMs
    ),
    alertCooldownMs: parsePositiveInteger(
      env.CODECLIP_MONITOR_ALERT_COOLDOWN_MS,
      "CODECLIP_MONITOR_ALERT_COOLDOWN_MS",
      DEFAULTS.alertCooldownMs
    ),
    alertReminderMs: parsePositiveInteger(
      env.CODECLIP_MONITOR_ALERT_REMINDER_MS,
      "CODECLIP_MONITOR_ALERT_REMINDER_MS",
      DEFAULTS.alertReminderMs
    ),
    httpFailureThreshold: parsePositiveInteger(
      env.CODECLIP_MONITOR_HTTP_FAILURE_THRESHOLD,
      "CODECLIP_MONITOR_HTTP_FAILURE_THRESHOLD",
      DEFAULTS.httpFailureThreshold
    ),
  };

  if (WEBHOOK_NOTIFICATION_KINDS.has(notificationKind)) {
    config.alertWebhookUrl = parseHttpsUrl(
      env.CODECLIP_MONITOR_ALERT_WEBHOOK_URL,
      "CODECLIP_MONITOR_ALERT_WEBHOOK_URL"
    );
  }

  if (notificationKind === "email") {
    config.alertEmailTo = parseEmailAddress(
      env.CODECLIP_MONITOR_ALERT_EMAIL_TO,
      "CODECLIP_MONITOR_ALERT_EMAIL_TO"
    );
    requireNonEmpty(env.RESEND_API_KEY, "RESEND_API_KEY");
    requireNonEmpty(env.RESEND_FROM_EMAIL, "RESEND_FROM_EMAIL");
  }

  return config;
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertOnlyFields(object, allowedFields, label) {
  for (const field of Object.keys(object)) {
    if (!allowedFields.has(field)) {
      throw new Error(`Unexpected ${label} field`);
    }
  }
}

function validateOperatorSummary(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid response contract");
  }

  assertOnlyFields(body, TOP_LEVEL_FIELDS, "top-level");

  if (body.ok !== true) throw new Error("Invalid response contract");
  if (body.vertical !== "codeclip") throw new Error("Invalid response contract");
  if (!isIsoTimestamp(body.generatedAt)) {
    throw new Error("Invalid response contract");
  }

  const summary = body.providerDeliveries;

  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Invalid response contract");
  }

  assertOnlyFields(summary, SUMMARY_FIELDS, "providerDeliveries");

  for (const field of COUNT_FIELDS) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      throw new Error("Invalid response contract");
    }
  }

  for (const field of TIMESTAMP_FIELDS) {
    if (summary[field] !== null && !isIsoTimestamp(summary[field])) {
      throw new Error("Invalid response contract");
    }
  }

  if (typeof summary.attentionRequired !== "boolean") {
    throw new Error("Invalid response contract");
  }

  if (
    !Array.isArray(summary.attentionReasons) ||
    summary.attentionReasons.some(
      (reason) => typeof reason !== "string" || reason.trim().length === 0
    )
  ) {
    throw new Error("Invalid response contract");
  }

  return summary;
}

function createTimeoutController(timeoutMs, timers = globalThis) {
  const controller = new AbortController();
  const timeout = timers.setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

function clearTimeoutController(timeout, timers = globalThis) {
  if (timeout) timers.clearTimeout(timeout);
}

function createSystemClock() {
  return {
    now() {
      return new Date();
    },
  };
}

function logEvent(logger, clock, event) {
  const payload = {
    timestamp: clock.now().toISOString(),
    monitor: MONITOR_NAME,
    ...event,
  };

  const line = JSON.stringify(payload);

  if (event.level === "warn" && typeof logger.warn === "function") {
    logger.warn(line);
    return;
  }

  if (event.level === "error" && typeof logger.error === "function") {
    logger.error(line);
    return;
  }

  logger.log(line);
}

function safeCounts(summary = null) {
  if (!summary) {
    return {
      total: null,
      completed: null,
      committedIncomplete: null,
      processing: null,
      failedPrecommit: null,
      unknown: null,
    };
  }

  return {
    total: summary.total,
    completed: summary.completed,
    committedIncomplete: summary.committedIncomplete,
    processing: summary.processing,
    failedPrecommit: summary.failedPrecommit,
    unknown: summary.unknown,
  };
}

function classifySummary(summary) {
  if (summary.committedIncomplete > 0) {
    return { classification: "critical", reason: "committed_incomplete" };
  }

  if (summary.unknown > 0) {
    return { classification: "warning", reason: "unknown" };
  }

  return { classification: "ok", reason: "normal" };
}

function getTransportReason(error, response = null) {
  if (response && Number.isInteger(response.status)) {
    return `http_${response.status}`;
  }

  if (error?.name === "AbortError") {
    return "timeout";
  }

  return "network";
}

async function pollOperatorSummary(config, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const timers = options.timers || globalThis;
  const { controller, timeout } = createTimeoutController(
    config.timeoutMs,
    timers
  );

  try {
    const response = await fetchFn(config.summaryUrl, {
      method: "GET",
      headers: {
        "x-admin-key": config.adminKey,
      },
      signal: controller.signal,
    });

    if (!response || response.status !== 200) {
      return {
        ok: false,
        httpStatus: response?.status || null,
        classification: "transport_error",
        reason: getTransportReason(null, response),
        summary: null,
      };
    }

    let body;

    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        httpStatus: 200,
        classification: "critical",
        reason: "invalid_json",
        summary: null,
      };
    }

    try {
      const summary = validateOperatorSummary(body);
      return {
        ok: true,
        httpStatus: 200,
        ...classifySummary(summary),
        summary,
      };
    } catch {
      return {
        ok: false,
        httpStatus: 200,
        classification: "critical",
        reason: "invalid_contract",
        summary: null,
      };
    }
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      classification: "transport_error",
      reason: getTransportReason(error),
      summary: null,
    };
  } finally {
    clearTimeoutController(timeout, timers);
  }
}

function createAlertMessage({
  severity,
  reason,
  timestamp,
  httpStatus,
  summary,
}) {
  const counts = safeCounts(summary);

  return [
    "codeClip provider delivery monitor",
    "vertical=codeclip",
    `severity=${severity}`,
    `reason=${reason}`,
    `timestamp=${timestamp}`,
    `httpStatus=${httpStatus === null || httpStatus === undefined ? "null" : httpStatus}`,
    `total=${counts.total}`,
    `completed=${counts.completed}`,
    `committedIncomplete=${counts.committedIncomplete}`,
    `processing=${counts.processing}`,
    `failedPrecommit=${counts.failedPrecommit}`,
    `unknown=${counts.unknown}`,
  ].join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendWebhookAlert(config, message, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const timers = options.timers || globalThis;
  const logger = options.logger || console;
  const clock = options.clock || createSystemClock();
  const webhookKind = config.notificationKind || config.webhookKind;
  const webhookUrl = config.alertWebhookUrl || config.webhookUrl;
  const payload =
    webhookKind === "slack" ? { text: message } : { content: message };

  const { controller, timeout } = createTimeoutController(
    config.timeoutMs,
    timers
  );

  try {
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response || response.status < 200 || response.status > 299) {
      logEvent(logger, clock, {
        level: "warn",
        event: "webhook_delivery_failed",
        classification: "warning",
        reason: getTransportReason(null, response),
        httpStatus: response?.status || null,
      });
      return false;
    }

    return true;
  } catch (error) {
    logEvent(logger, clock, {
      level: "warn",
      event: "webhook_delivery_failed",
      classification: "warning",
      reason: getTransportReason(error),
      httpStatus: null,
    });
    return false;
  } finally {
    clearTimeoutController(timeout, timers);
  }
}

async function sendEmailAlert(config, message, options = {}) {
  const sendEmailFn =
    options.sendEmailFn || require("../mailer").sendEmail;

  try {
    await sendEmailFn({
      to: config.alertEmailTo,
      subject: EMAIL_SUBJECT,
      text: message,
      html: `<pre>${escapeHtml(message)}</pre>`,
      fromName: EMAIL_FROM_NAME,
    });
    return true;
  } catch {
    return false;
  }
}

async function sendNotification(config, message, options = {}) {
  if (config.notificationKind === "email") {
    return sendEmailAlert(config, message, options);
  }

  return sendWebhookAlert(config, message, options);
}

function normalizeAlarmIdentityPart(value) {
  return (
    String(value || "none")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_:-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "none"
  );
}

function createTransportAlarmId(measurement) {
  const httpStatus = Number.isInteger(measurement.httpStatus)
    ? measurement.httpStatus
    : "none";

  return [
    "codeclip",
    normalizeAlarmIdentityPart(measurement.classification),
    normalizeAlarmIdentityPart(measurement.reason || "transport_failure"),
    normalizeAlarmIdentityPart(httpStatus),
  ].join(":");
}

function isTransportAlarmId(id) {
  return (
    id === "transport_failure" ||
    String(id || "").startsWith("codeclip:transport_error:")
  );
}

function shouldLogNotificationDeliveryFailure(state, nowMs, config) {
  if (
    state.lastNotificationFailureLoggedAt !== null &&
    nowMs - state.lastNotificationFailureLoggedAt < config.alertCooldownMs
  ) {
    return false;
  }

  state.lastNotificationFailureLoggedAt = nowMs;
  return true;
}

async function sendNotificationDamped(config, message, state, options = {}) {
  const clock = options.clock || createSystemClock();
  const logger = options.logger || console;
  const nowMs = clock.now().getTime();

  const delivered = await sendNotification(config, message, {
    ...options,
    clock,
    logger: {
      log: logger.log?.bind(logger) || (() => {}),
      error: logger.error?.bind(logger) || (() => {}),
      warn: (...args) => {
        if (shouldLogNotificationDeliveryFailure(state, nowMs, config)) {
          logger.warn(...args);
        }
      },
    },
  });

  if (
    !delivered &&
    config.notificationKind === "email" &&
    shouldLogNotificationDeliveryFailure(state, nowMs, config)
  ) {
    logEvent(logger, clock, {
      level: "warn",
      event: "notification_delivery_failed",
      classification: "warning",
      reason: "email_delivery_failed",
      httpStatus: null,
    });
  }

  return delivered;
}

function getActiveReasons(measurement, state, config) {
  if (measurement.reason === "invalid_json") {
    return [{ id: "invalid_json", severity: "critical", reason: "invalid_json" }];
  }

  if (measurement.reason === "invalid_contract") {
    return [
      {
        id: "invalid_contract",
        severity: "critical",
        reason: "invalid_contract",
      },
    ];
  }

  if (measurement.reason === "committed_incomplete") {
    return [
      {
        id: "committed_incomplete",
        severity: "critical",
        reason: "committed_incomplete",
      },
    ];
  }

  if (measurement.reason === "unknown") {
    return [{ id: "unknown", severity: "warning", reason: "unknown" }];
  }

  if (
    measurement.classification === "transport_error" &&
    state.consecutiveTransportFailures >= config.httpFailureThreshold
  ) {
    return [
      {
        id: createTransportAlarmId(measurement),
        severity: "critical",
        reason: measurement.reason || "transport_failure",
        reminderMs: config.alertReminderMs,
      },
    ];
  }

  return [];
}

function getRecoveryReason(alarmId, previous = {}) {
  switch (alarmId) {
    case "committed_incomplete":
      return "committed_incomplete_recovered";
    case "unknown":
      return "unknown_recovered";
    case "invalid_json":
      return "invalid_json_recovered";
    case "invalid_contract":
      return "invalid_contract_recovered";
    case "transport_failure":
      return "transport_recovered";
    default:
      if (isTransportAlarmId(alarmId)) {
        return `transport_${normalizeAlarmIdentityPart(previous.reason || "failure")}_recovered`;
      }
      throw new Error("Unknown recovery alarm id");
  }
}

async function processMeasurement(measurement, state, config, options = {}) {
  const clock = options.clock || createSystemClock();
  const now = options.now || clock.now();
  const timestamp = now.toISOString();
  const logger = options.logger || console;
  const fetchFn = options.fetchFn || fetch;
  const timers = options.timers || globalThis;

  if (measurement.classification === "transport_error") {
    const transportAlarmId = createTransportAlarmId(measurement);
    if (state.consecutiveTransportFailureId === transportAlarmId) {
      state.consecutiveTransportFailures += 1;
    } else {
      state.consecutiveTransportFailureId = transportAlarmId;
      state.consecutiveTransportFailures = 1;
    }
  } else if (measurement.ok) {
    state.consecutiveTransportFailures = 0;
    state.consecutiveTransportFailureId = null;
  } else {
    state.consecutiveTransportFailures = 0;
    state.consecutiveTransportFailureId = null;
  }

  const activeReasons = getActiveReasons(measurement, state, config);
  const activeIds = new Set(activeReasons.map((entry) => entry.id));

  logEvent(logger, { now: () => now }, {
    event: "measurement",
    httpStatus: measurement.httpStatus,
    ...safeCounts(measurement.summary),
    classification: measurement.classification,
    reason: measurement.reason,
  });

  for (const active of activeReasons) {
    const previous = state.alerts.get(active.id);
    const reminderMs = active.reminderMs || config.alertCooldownMs;
    const shouldSend =
      !previous || now.getTime() - previous.lastSentAt >= reminderMs;

    if (!shouldSend) continue;

    const message = createAlertMessage({
      severity: active.severity,
      reason: active.reason,
      timestamp,
      httpStatus: measurement.httpStatus,
      summary: measurement.summary,
    });

    const delivered = await sendNotificationDamped(config, message, state, {
      fetchFn,
      logger,
      timers,
      clock: { now: () => now },
      sendEmailFn: options.sendEmailFn,
    });

    if (!delivered) continue;

    state.alerts.set(active.id, {
      notified: true,
      lastSentAt: now.getTime(),
      severity: active.severity,
      reason: active.reason,
    });

    if (isTransportAlarmId(active.id)) {
      for (const id of Array.from(state.alerts.keys())) {
        if (id !== active.id && isTransportAlarmId(id)) {
          state.alerts.delete(id);
        }
      }
    }
  }

  if (!measurement.ok) return;

  for (const [id, previous] of Array.from(state.alerts.entries())) {
    if (activeIds.has(id) || !previous.notified) continue;

    const message = createAlertMessage({
      severity: "recovery",
      reason: getRecoveryReason(id, previous),
      timestamp,
      httpStatus: measurement.httpStatus,
      summary: measurement.summary,
    });

    const delivered = await sendNotificationDamped(config, message, state, {
      fetchFn,
      logger,
      timers,
      clock: { now: () => now },
      sendEmailFn: options.sendEmailFn,
    });

    if (delivered) {
      state.alerts.delete(id);
    }
  }
}

function createMonitorState() {
  return {
    consecutiveTransportFailures: 0,
    consecutiveTransportFailureId: null,
    lastNotificationFailureLoggedAt: null,
    alerts: new Map(),
  };
}

function createCodeClipProviderDeliveryMonitor(config, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const logger = options.logger || console;
  const timers = options.timers || globalThis;
  const clock = options.clock || createSystemClock();
  const state = options.state || createMonitorState();

  let interval = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return false;

    running = true;

    try {
      const measurement = await pollOperatorSummary(config, {
        fetchFn,
        timers,
      });

      await processMeasurement(measurement, state, config, {
        clock,
        logger,
        fetchFn,
        timers,
        sendEmailFn: options.sendEmailFn,
      });

      return true;
    } catch {
      logEvent(logger, clock, {
        level: "error",
        event: "monitor_internal_error",
        classification: "error",
        reason: "internal_error",
        httpStatus: null,
        total: null,
        completed: null,
        committedIncomplete: null,
        processing: null,
        failedPrecommit: null,
        unknown: null,
      });

      return false;
    } finally {
      running = false;
    }
  }

  function start() {
    stopped = false;

    logEvent(logger, clock, {
      event: "started",
      notificationKind: config.notificationKind,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
      alertCooldownMs: config.alertCooldownMs,
      alertReminderMs: config.alertReminderMs,
      httpFailureThreshold: config.httpFailureThreshold,
    });

    // The first poll starts immediately; tick() catches internal errors.
    void tick();

    interval = timers.setInterval(() => {
      void tick();
    }, config.pollIntervalMs);
  }

  function stop() {
    stopped = true;

    if (interval) {
      timers.clearInterval(interval);
    }

    interval = null;

    logEvent(logger, clock, {
      event: "stopped",
    });
  }

  return {
    start,
    stop,
    tick,
    state,
  };
}

function main() {
  let config;

  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        monitor: MONITOR_NAME,
        level: "error",
        event: "configuration_error",
        reason: error.message,
      })
    );
    process.exitCode = 1;
    return;
  }

  const monitor = createCodeClipProviderDeliveryMonitor(config);

  process.once("SIGTERM", () => monitor.stop());
  process.once("SIGINT", () => monitor.stop());

  monitor.start();
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULTS,
  MONITOR_NAME,
  loadConfig,
  validateOperatorSummary,
  pollOperatorSummary,
  classifySummary,
  createAlertMessage,
  sendWebhookAlert,
  sendEmailAlert,
  sendNotification,
  createMonitorState,
  processMeasurement,
  createCodeClipProviderDeliveryMonitor,
};
