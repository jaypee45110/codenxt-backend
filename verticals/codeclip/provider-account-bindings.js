const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");
const { getCampaignByCode } = require("../../db");

const CODECLIP_VERTICAL = "codeclip";
const ACTIVE_STATUS = "active";
const DISABLED_STATUS = "disabled";
const PROVIDER_ACCOUNT_ID_MAX_LENGTH = 256;
const CREATED_BY_MAX_LENGTH = 80;

const PROVIDER_CHANNELS = Object.freeze({
  meta: new Set(["instagram", "messenger", "whatsapp"]),
  sms: new Set(["sms"]),
});

const VALID_STATUSES = new Set([ACTIVE_STATUS, DISABLED_STATUS]);

/**
 * Durable repository for codeClip Provider Account Bindings. Live Meta routing
 * uses this store as the authoritative mapping from vertical + provider +
 * providerAccountId to one active eventCode. Schema initialization is owned by
 * backend startup/bootstrap; repository functions do not create schema.
 * displayName is optional presentation data only and never affects identity,
 * uniqueness, or routing.
 */

class CodeClipProviderAccountBindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderAccountBindingError";
    this.code = code;
    this.details = details;
  }
}

function invalidBinding(message, details = {}) {
  return new CodeClipProviderAccountBindingError(
    "INVALID_PROVIDER_BINDING",
    message,
    details
  );
}

function bindingConflict(message, details = {}) {
  return new CodeClipProviderAccountBindingError(
    "PROVIDER_ACCOUNT_BINDING_CONFLICT",
    message,
    details
  );
}

function eventNotFound(message, details = {}) {
  return new CodeClipProviderAccountBindingError(
    "CODECLIP_EVENT_NOT_FOUND",
    message,
    details
  );
}

function bindingAmbiguous(message, details = {}) {
  return new CodeClipProviderAccountBindingError(
    "PROVIDER_ACCOUNT_BINDING_AMBIGUOUS",
    message,
    details
  );
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw new CodeClipProviderAccountBindingError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider account binding repository requires an explicit query client"
    );
  }
  return queryClient;
}

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBinding(`${fieldName} must be an object`, { fieldName });
  }
  return value;
}

function normalizeOptionalString(value, fieldName, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw invalidBinding(`${fieldName} must be a string`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw invalidBinding(`${fieldName} is too long`, { fieldName, maxLength });
  }
  return normalized;
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw invalidBinding(`${fieldName} must be a non-empty string`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw invalidBinding(`${fieldName} must be a non-empty string`, { fieldName });
  }
  if (normalized.length > maxLength) {
    throw invalidBinding(`${fieldName} is too long`, { fieldName, maxLength });
  }
  return normalized;
}

function normalizeCodeClipBindingProvider(provider) {
  const normalized = normalizeCodeClipProviderName(provider);
  if (!normalized || !isCodeClipProviderRegistered(normalized)) {
    throw invalidBinding("provider is not supported by codeClip", { fieldName: "provider" });
  }
  if (!Object.hasOwn(PROVIDER_CHANNELS, normalized)) {
    throw invalidBinding("provider is not supported for account bindings", {
      fieldName: "provider",
    });
  }
  return normalized;
}

function normalizeCodeClipBindingChannel(provider, channel) {
  const normalized = normalizeRequiredString(channel, "channel", 64).toLowerCase();
  const allowedChannels = PROVIDER_CHANNELS[provider];
  if (!allowedChannels || !allowedChannels.has(normalized)) {
    throw invalidBinding("channel is not valid for provider", {
      fieldName: "channel",
      provider,
      channel: normalized,
    });
  }
  return normalized;
}

function normalizeCodeClipBindingStatus(status = ACTIVE_STATUS) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!VALID_STATUSES.has(normalized)) {
    throw invalidBinding("status is not valid", { fieldName: "status" });
  }
  return normalized;
}

function normalizeCodeClipProviderAccountBindingInput(input = {}) {
  const value = requirePlainObject(input, "binding");
  const vertical = String(value.vertical || CODECLIP_VERTICAL).trim().toLowerCase();
  if (vertical !== CODECLIP_VERTICAL) {
    throw invalidBinding("vertical must be codeclip", { fieldName: "vertical" });
  }

  const provider = normalizeCodeClipBindingProvider(value.provider);
  const channel = normalizeCodeClipBindingChannel(provider, value.channel);
  const metadata =
    value.metadata === undefined || value.metadata === null
      ? {}
      : requirePlainObject(value.metadata, "metadata");

  return {
    vertical: CODECLIP_VERTICAL,
    eventCode: normalizeRequiredString(value.eventCode || value.event_code, "eventCode", 120),
    provider,
    providerAccountId: normalizeRequiredString(
      value.providerAccountId || value.provider_account_id,
      "providerAccountId",
      PROVIDER_ACCOUNT_ID_MAX_LENGTH
    ),
    channel,
    status: normalizeCodeClipBindingStatus(value.status || ACTIVE_STATUS),
    displayName: normalizeOptionalString(value.displayName || value.display_name, "displayName", 160),
    createdBy:
      normalizeOptionalString(
        value.createdBy || value.created_by,
        "createdBy",
        CREATED_BY_MAX_LENGTH
      ) || "operator",
    metadata,
  };
}

function mapCodeClipProviderAccountBindingRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    vertical: row.vertical,
    eventCode: row.event_code,
    provider: row.provider,
    channel: row.channel,
    providerAccountId: row.provider_account_id,
    status: row.status,
    displayName: row.display_name || null,
    createdBy: row.created_by,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at || null,
  };
}

function maskCodeClipProviderAccountId(providerAccountId) {
  const value = String(providerAccountId || "").trim();
  if (!value) return "";
  if (value.length <= 2) return "••";
  if (value.length <= 4) return `${"•".repeat(value.length - 1)}${value.slice(-1)}`;
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function toPublicCodeClipProviderBinding(binding = null) {
  const mapped = binding?.event_code
    ? mapCodeClipProviderAccountBindingRow(binding)
    : binding;
  if (!mapped) return null;

  return {
    id: mapped.id,
    eventCode: mapped.eventCode,
    provider: mapped.provider,
    channel: mapped.channel,
    status: mapped.status,
    displayName: mapped.displayName || null,
    maskedAccountId: maskCodeClipProviderAccountId(mapped.providerAccountId),
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
    disabledAt: mapped.disabledAt || null,
  };
}

async function assertCodeClipEventExists(eventCode, { getEventByCode = getCampaignByCode } = {}) {
  if (typeof getEventByCode !== "function") {
    throw eventNotFound("codeClip event lookup is unavailable", { eventCode });
  }
  const event = await getEventByCode(eventCode);
  const vertical = String(event?.vertical || event?.raw_event?.vertical || "").trim().toLowerCase();
  if (!event || vertical !== CODECLIP_VERTICAL) {
    throw eventNotFound("codeClip event was not found", { eventCode });
  }
  return event;
}

async function getActiveBindingByIdentity(normalized, queryClient) {
  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE vertical = $1
        AND provider = $2
        AND provider_account_id = $3
        AND status = 'active'
      LIMIT 2
    `,
    [CODECLIP_VERTICAL, normalized.provider, normalized.providerAccountId]
  );
  const rows = result.rows || [];
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw bindingAmbiguous("multiple active provider account bindings found", {
      provider: normalized.provider,
    });
  }
  return mapCodeClipProviderAccountBindingRow(rows[0]);
}

async function createCodeClipProviderAccountBinding(
  binding = {},
  { queryClient, getEventByCode = getCampaignByCode } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalized = normalizeCodeClipProviderAccountBindingInput(binding);
  if (normalized.status !== ACTIVE_STATUS) {
    throw invalidBinding("new provider account bindings must be active", {
      fieldName: "status",
    });
  }

  await assertCodeClipEventExists(normalized.eventCode, { getEventByCode });

  const existing = await getActiveBindingByIdentity(normalized, client);
  if (existing) {
    if (existing.eventCode === normalized.eventCode) {
      return {
        status: "existing",
        created: false,
        existing: true,
        row: existing,
      };
    }
    throw bindingConflict("provider account is already bound to another episode", {
      provider: normalized.provider,
      eventCode: existing.eventCode,
    });
  }

  try {
    const result = await client.query(
      `
        INSERT INTO codeclip_provider_account_bindings (
          vertical,
          event_code,
          provider,
          channel,
          provider_account_id,
          status,
          display_name,
          created_by,
          metadata,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb,NOW())
        RETURNING *
      `,
      [
        normalized.vertical,
        normalized.eventCode,
        normalized.provider,
        normalized.channel,
        normalized.providerAccountId,
        normalized.displayName,
        normalized.createdBy,
        JSON.stringify(normalized.metadata),
      ]
    );

    return {
      status: "created",
      created: true,
      existing: false,
      row: mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null),
    };
  } catch (error) {
    if (error?.code === "23505") {
      const conflict = await getActiveBindingByIdentity(normalized, client);
      throw bindingConflict("provider account is already bound to another episode", {
        provider: normalized.provider,
        eventCode: conflict?.eventCode,
      });
    }
    throw error;
  }
}

async function getCodeClipProviderAccountBindingById(id, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  if (!id) return null;
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE id = $1
        AND vertical = 'codeclip'
      LIMIT 1
    `,
    [id]
  );
  return mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null);
}

async function findActiveCodeClipProviderAccountBinding(
  { provider, providerAccountId } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalized = {
    provider: normalizeCodeClipBindingProvider(provider),
    providerAccountId: normalizeRequiredString(
      providerAccountId,
      "providerAccountId",
      PROVIDER_ACCOUNT_ID_MAX_LENGTH
    ),
  };
  return getActiveBindingByIdentity(normalized, client);
}

async function listCodeClipProviderAccountBindingsForEvent(
  eventCode,
  { includeDisabled = false, queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedEventCode = normalizeRequiredString(eventCode, "eventCode", 120);
  const statusPredicate = includeDisabled ? "" : "AND status = 'active'";
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE vertical = 'codeclip'
        AND event_code = $1
        ${statusPredicate}
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedEventCode]
  );
  return (result.rows || []).map(mapCodeClipProviderAccountBindingRow);
}

async function disableCodeClipProviderAccountBinding(id, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  if (!id) return null;

  const existing = await getCodeClipProviderAccountBindingById(id, { queryClient: client });
  if (!existing) return null;
  if (existing.status === DISABLED_STATUS) return existing;

  const result = await client.query(
    `
      UPDATE codeclip_provider_account_bindings
      SET
        status = 'disabled',
        disabled_at = COALESCE(disabled_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
        AND vertical = 'codeclip'
      RETURNING *
    `,
    [id]
  );
  return mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null);
}

module.exports = {
  CODECLIP_VERTICAL,
  CodeClipProviderAccountBindingError,
  normalizeCodeClipProviderAccountBindingInput,
  createCodeClipProviderAccountBinding,
  getCodeClipProviderAccountBindingById,
  findActiveCodeClipProviderAccountBinding,
  listCodeClipProviderAccountBindingsForEvent,
  disableCodeClipProviderAccountBinding,
  maskCodeClipProviderAccountId,
  toPublicCodeClipProviderBinding,
};
