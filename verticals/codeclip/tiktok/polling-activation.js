/**
 * Explicit codeClip TikTok polling activation.
 *
 * Operator/domain activation only: validates event, binding, credential,
 * video.list scope, adapter availability, and creates/reactivates the generic
 * poll source. It does not call TikTok, read secrets, refresh credentials,
 * invoke polling, create workers, or wire routes.
 */

const {
  findCodeClipProviderCredential,
  inspectCodeClipProviderCredentialUsability,
} = require("../provider-credentials");
const {
  createCodeClipProviderPollSource,
  findCodeClipProviderPollSource,
  reactivateCodeClipProviderPollSource,
  CodeClipProviderPollSourceError,
} = require("../provider-poll-sources");
const {
  createCodeClipProductionPollAdapterRegistry,
} = require("../provider-polling/production-adapter-registry");

const PROVIDER = "tiktok";
const CHANNEL = "tiktok";
const VERTICAL = "codeclip";
const REQUIRED_SCOPE = "video.list";
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 86_400_000;

class CodeClipTikTokPollingActivationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokPollingActivationError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function activationError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "status"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 120);
      }
    }
  }
  return new CodeClipTikTokPollingActivationError(code, message, safe);
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw activationError(
      "INVALID_POLLING_ACTIVATION",
      `${fieldName} is required`,
      { fieldName }
    );
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw activationError(
      "INVALID_POLLING_ACTIVATION",
      `${fieldName} is invalid`,
      { fieldName }
    );
  }
  return normalized;
}

function normalizeEnvironment(value) {
  const normalized = normalizeRequiredString(value, "environment", 32).toLowerCase();
  if (normalized !== "sandbox" && normalized !== "production") {
    throw activationError(
      "INVALID_POLLING_ACTIVATION",
      "environment is invalid",
      { fieldName: "environment" }
    );
  }
  return normalized;
}

function normalizePollIntervalMs(value) {
  const candidate =
    value === undefined ? DEFAULT_POLL_INTERVAL_MS : value;
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw activationError(
      "INVALID_POLLING_ACTIVATION",
      "pollIntervalMs is invalid",
      { fieldName: "pollIntervalMs" }
    );
  }
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < MIN_POLL_INTERVAL_MS ||
    candidate > MAX_POLL_INTERVAL_MS
  ) {
    throw activationError(
      "INVALID_POLLING_ACTIVATION",
      "pollIntervalMs is out of range",
      { fieldName: "pollIntervalMs" }
    );
  }
  return candidate;
}

function normalizeNow(value) {
  if (value === undefined) return null;
  if (value === null || value === "") {
    throw activationError("INVALID_POLLING_ACTIVATION", "now is invalid", {
      fieldName: "now",
    });
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw activationError("INVALID_POLLING_ACTIVATION", "now is invalid", {
      fieldName: "now",
    });
  }
  return new Date(ms).toISOString();
}

function requirePool(queryClient) {
  if (!queryClient || typeof queryClient.connect !== "function") {
    throw activationError(
      "DATABASE_UNAVAILABLE",
      "TikTok polling activation requires a database pool"
    );
  }
  return queryClient;
}

function verifyAdapterRegistry(adapterRegistry) {
  const registry =
    adapterRegistry === undefined
      ? createCodeClipProductionPollAdapterRegistry()
      : adapterRegistry;
  if (!registry || typeof registry.get !== "function") {
    throw activationError(
      "TIKTOK_POLL_ADAPTER_NOT_AVAILABLE",
      "TikTok poll adapter is not available"
    );
  }
  let descriptor;
  try {
    descriptor = registry.get(PROVIDER);
  } catch {
    throw activationError(
      "TIKTOK_POLL_ADAPTER_NOT_AVAILABLE",
      "TikTok poll adapter is not available"
    );
  }
  if (
    !descriptor ||
    descriptor.provider !== PROVIDER ||
    typeof descriptor.poll !== "function"
  ) {
    throw activationError(
      "TIKTOK_POLL_ADAPTER_NOT_AVAILABLE",
      "TikTok poll adapter is not available"
    );
  }
  return registry;
}

async function resolveOperationNow(tx, injectedNow) {
  const result = await tx.query(
    `
      SELECT COALESCE($1::timestamptz, NOW()) AS operation_now
    `,
    [injectedNow]
  );
  const value = result.rows?.[0]?.operation_now;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw activationError("DATABASE_ERROR", "failed to resolve operation clock");
  }
  return new Date(ms).toISOString();
}

async function withActivationTransaction(pool, work) {
  let client = null;
  try {
    client = await pool.connect();
  } catch {
    throw activationError("DATABASE_UNAVAILABLE", "failed to open database client");
  }
  if (!client || typeof client.query !== "function") {
    throw activationError("DATABASE_UNAVAILABLE", "database pool returned an invalid client");
  }

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // preserve original failure
    }
    if (error instanceof CodeClipTikTokPollingActivationError) throw error;
    if (error instanceof CodeClipProviderPollSourceError) {
      if (error.code === "POLL_SOURCE_RACE") {
        throw activationError("POLL_SOURCE_RACE", "poll source changed during activation");
      }
      throw activationError("DATABASE_ERROR", "poll source mutation failed");
    }
    throw activationError("DATABASE_ERROR", "TikTok polling activation failed");
  } finally {
    try {
      if (typeof client.release === "function") client.release();
    } catch {
      // ignore release failures
    }
  }
}

async function loadCodeClipEvent(tx, eventCode) {
  const result = await tx.query(
    `
      SELECT event_code, vertical
      FROM campaigns
      WHERE event_code = $1
      LIMIT 2
    `,
    [eventCode]
  );
  const rows = result.rows || [];
  if (!rows.length) {
    throw activationError("EVENT_NOT_FOUND", "codeClip event was not found");
  }
  const event = rows.find(
    (row) => String(row.vertical || "").trim().toLowerCase() === VERTICAL
  );
  if (!event) {
    throw activationError("INVALID_EVENT", "event is not a codeClip episode");
  }
  return event;
}

async function loadTikTokBinding(tx, { eventCode, providerAccountId }) {
  const result = await tx.query(
    `
      SELECT id, event_code, provider, channel, provider_account_id, status, updated_at
      FROM codeclip_provider_account_bindings
      WHERE vertical = $1
        AND provider = $2
        AND provider_account_id = $3
      ORDER BY status = 'active' DESC, updated_at DESC, id DESC
      LIMIT 3
    `,
    [VERTICAL, PROVIDER, providerAccountId]
  );
  const bindings = result.rows || [];
  const active = bindings.filter((row) => row.status === "active");
  if (active.length > 1) {
    throw activationError(
      "TIKTOK_BINDING_CONFLICT",
      "multiple active TikTok bindings found"
    );
  }
  if (active.length === 1) {
    const binding = active[0];
    if (
      String(binding.event_code || "") !== eventCode ||
      String(binding.channel || "").trim().toLowerCase() !== CHANNEL
    ) {
      throw activationError(
        "TIKTOK_BINDING_CONFLICT",
        "TikTok account is bound to another episode or channel"
      );
    }
    return binding;
  }
  const disabledForEvent = bindings.find(
    (row) =>
      row.status === "disabled" &&
      String(row.event_code || "") === eventCode &&
      String(row.channel || "").trim().toLowerCase() === CHANNEL
  );
  if (disabledForEvent) {
    throw activationError(
      "TIKTOK_BINDING_DISABLED",
      "TikTok binding is disabled"
    );
  }
  throw activationError(
    "TIKTOK_BINDING_NOT_FOUND",
    "active TikTok binding was not found"
  );
}

function assertCredentialUsable(credential, usability) {
  if (!credential) {
    throw activationError(
      "TIKTOK_CREDENTIAL_NOT_FOUND",
      "TikTok credential was not found"
    );
  }
  const status = String(credential.status || usability?.status || "").trim();
  if (status === "disabled") {
    throw activationError(
      "TIKTOK_CREDENTIAL_DISABLED",
      "TikTok credential is disabled"
    );
  }
  if (status === "revoked") {
    throw activationError(
      "TIKTOK_CREDENTIAL_REVOKED",
      "TikTok credential is revoked"
    );
  }
  if (status === "reauthorization_required" || usability?.reauthorizationRequired === true) {
    throw activationError(
      "TIKTOK_REAUTHORIZATION_REQUIRED",
      "TikTok credential requires reauthorization"
    );
  }
  if (!usability || usability.usableForProviderApi !== true) {
    throw activationError(
      "TIKTOK_CREDENTIAL_UNUSABLE",
      "TikTok credential is not usable for provider API"
    );
  }
  const scopes = Array.isArray(credential.scopes) ? credential.scopes : [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw activationError(
      "TIKTOK_VIDEO_LIST_SCOPE_REQUIRED",
      "TikTok video.list scope is required"
    );
  }
}

function safeSummary(status, source, { eventCode, environment, pollIntervalMs, nextPollAt }) {
  return {
    ok: true,
    status,
    sourceId: source?.id != null ? String(source.id) : null,
    provider: PROVIDER,
    environment,
    eventCode,
    pollIntervalMs: source?.pollIntervalMs || pollIntervalMs,
    nextPollAt: source?.nextPollAt || nextPollAt || null,
  };
}

async function activateCodeClipTikTokPolling(
  {
    eventCode,
    environment,
    providerAccountId,
    pollIntervalMs,
    now,
  } = {},
  {
    queryClient,
    adapterRegistry,
  } = {}
) {
  const normalized = {
    eventCode: normalizeRequiredString(eventCode, "eventCode", 120),
    environment: normalizeEnvironment(environment),
    providerAccountId: normalizeRequiredString(
      providerAccountId,
      "providerAccountId",
      256
    ),
    pollIntervalMs: normalizePollIntervalMs(pollIntervalMs),
    now: normalizeNow(now),
  };

  const pool = requirePool(queryClient);
  verifyAdapterRegistry(adapterRegistry);

  return withActivationTransaction(pool, async (tx) => {
    const operationNow = await resolveOperationNow(tx, normalized.now);
    await loadCodeClipEvent(tx, normalized.eventCode);
    await loadTikTokBinding(tx, normalized);

    const credential = await findCodeClipProviderCredential(
      {
        provider: PROVIDER,
        environment: normalized.environment,
        providerAccountId: normalized.providerAccountId,
      },
      { queryClient: tx, now: operationNow }
    );
    const usability = credential
      ? await inspectCodeClipProviderCredentialUsability(
          { id: credential.id, now: operationNow },
          { queryClient: tx }
        )
      : null;
    assertCredentialUsable(credential, usability);

    const existing = await findCodeClipProviderPollSource(
      {
        provider: PROVIDER,
        environment: normalized.environment,
        providerAccountId: normalized.providerAccountId,
      },
      { queryClient: tx }
    );

    if (existing) {
      if (existing.status === "active") {
        return safeSummary("already_active", existing, {
          ...normalized,
          nextPollAt: existing.nextPollAt,
        });
      }
      if (existing.status === "disabled") {
        throw activationError(
          "TIKTOK_POLL_SOURCE_DISABLED",
          "TikTok poll source is disabled"
        );
      }
      if (existing.status !== "paused") {
        throw activationError(
          "POLL_SOURCE_RACE",
          "TikTok poll source has invalid status"
        );
      }
      const reactivated = await reactivateCodeClipProviderPollSource(
        {
          pollSourceId: existing.id,
          nextPollAt: operationNow,
          now: operationNow,
        },
        { queryClient: tx }
      );
      return safeSummary("reactivated", reactivated.pollSource, {
        ...normalized,
        nextPollAt: operationNow,
      });
    }

    const created = await createCodeClipProviderPollSource(
      {
        provider: PROVIDER,
        environment: normalized.environment,
        providerAccountId: normalized.providerAccountId,
        pollIntervalMs: normalized.pollIntervalMs,
        nextPollAt: operationNow,
        checkpoint: {},
      },
      { queryClient: tx, now: operationNow }
    );
    return safeSummary("activated", created.pollSource, {
      ...normalized,
      nextPollAt: operationNow,
    });
  });
}

module.exports = {
  CodeClipTikTokPollingActivationError,
  activateCodeClipTikTokPolling,
};
