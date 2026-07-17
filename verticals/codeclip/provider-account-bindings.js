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
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const LIST_CURSOR_VERSION = 1;
const MAX_BIGINT_ID = 9223372036854775807n;

const PROVIDER_CHANNELS = Object.freeze({
  meta: new Set(["instagram", "messenger", "whatsapp"]),
  sms: new Set(["sms"]),
  youtube: new Set(["youtube"]),
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

function providerBindingError(code, message, details = {}) {
  return new CodeClipProviderAccountBindingError(code, message, details);
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

function normalizeCodeClipProviderBindingDisplayName(value) {
  if (value === undefined) {
    throw invalidBinding("displayName is required", { fieldName: "displayName" });
  }
  return normalizeOptionalString(value, "displayName", 160);
}

function assertNoControlCharacters(value, fieldName) {
  if (/[\u0000-\u001f\u007f]/.test(String(value || ""))) {
    throw invalidBinding(`${fieldName} contains invalid characters`, { fieldName });
  }
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw invalidBinding(`${fieldName} must be a non-empty string`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw invalidBinding(`${fieldName} must be a non-empty string`, { fieldName });
  }
  assertNoControlCharacters(normalized, fieldName);
  if (normalized.length > maxLength) {
    throw invalidBinding(`${fieldName} is too long`, { fieldName, maxLength });
  }
  return normalized;
}

function normalizeCodeClipProviderBindingEventCode(value) {
  return normalizeRequiredString(value, "eventCode", 120);
}

function normalizeOptionalFilterString(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw invalidBinding(`${fieldName} must be a string`, { fieldName });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  assertNoControlCharacters(normalized, fieldName);
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

function normalizeCodeClipProviderAccountId(provider, providerAccountId) {
  const normalized = normalizeRequiredString(
    providerAccountId,
    "providerAccountId",
    PROVIDER_ACCOUNT_ID_MAX_LENGTH
  );

  if (provider === "youtube") {
    if (/^https?:\/\//i.test(normalized) || normalized.startsWith("@")) {
      throw invalidBinding("YouTube providerAccountId must be a channel ID", {
        fieldName: "providerAccountId",
      });
    }
    if (!/^UC[A-Za-z0-9_-]{20,32}$/.test(normalized)) {
      throw invalidBinding("YouTube providerAccountId must be a channel ID", {
        fieldName: "providerAccountId",
      });
    }
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

function normalizeCodeClipProviderBindingListLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return DEFAULT_LIST_LIMIT;
  let parsed;
  if (typeof limit === "number") {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw invalidBinding("limit must be a positive integer", { fieldName: "limit" });
    }
    parsed = limit;
  } else if (typeof limit === "string") {
    const value = limit.trim();
    if (!/^[0-9]+$/.test(value) || value.length > 6) {
      throw invalidBinding("limit must be a positive integer", { fieldName: "limit" });
    }
    parsed = Number.parseInt(value, 10);
    if (!parsed) {
      throw invalidBinding("limit must be a positive integer", { fieldName: "limit" });
    }
  } else {
    throw invalidBinding("limit must be a positive integer", { fieldName: "limit" });
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function normalizePositiveBigIntId(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw invalidBinding(`${fieldName} is invalid`, { fieldName, reason: "INVALID_CURSOR" });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw invalidBinding(`${fieldName} is invalid`, { fieldName, reason: "INVALID_CURSOR" });
  }
  return normalized;
}

function normalizeCodeClipProviderBindingId(value) {
  let normalized;
  if (typeof value === "string") {
    normalized = value.trim();
    assertNoControlCharacters(normalized, "bindingId");
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw invalidBinding("bindingId is invalid", { fieldName: "bindingId" });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    normalized = value.toString();
  } else {
    throw invalidBinding("bindingId is invalid", { fieldName: "bindingId" });
  }

  if (!/^[0-9]+$/.test(normalized)) {
    throw invalidBinding("bindingId is invalid", { fieldName: "bindingId" });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw invalidBinding("bindingId is invalid", { fieldName: "bindingId" });
  }
  return normalized;
}

function normalizeCursorTimestamp(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName, 80);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw invalidBinding(`${fieldName} is invalid`, { fieldName, reason: "INVALID_CURSOR" });
  }
  return normalized;
}

function encodeCodeClipProviderBindingCursor(binding) {
  if (!binding) return null;
  return Buffer.from(
    JSON.stringify({
      v: LIST_CURSOR_VERSION,
      updatedAt: binding.updatedAt,
      id: String(binding.id),
    })
  ).toString("base64url");
}

function decodeCodeClipProviderBindingCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > 512) {
    throw invalidBinding("cursor is invalid", { fieldName: "cursor", reason: "INVALID_CURSOR" });
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const keys = Object.keys(decoded || {}).sort().join(",");
    if (!decoded || decoded.v !== LIST_CURSOR_VERSION || keys !== "id,updatedAt,v") {
      throw new Error("invalid cursor shape");
    }
    return {
      updatedAt: normalizeCursorTimestamp(decoded.updatedAt, "cursor.updatedAt"),
      id: normalizePositiveBigIntId(decoded.id, "cursor.id"),
    };
  } catch {
    throw invalidBinding("cursor is invalid", { fieldName: "cursor", reason: "INVALID_CURSOR" });
  }
}

function escapeLikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, (match) => `\\${match}`);
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
    eventCode: normalizeCodeClipProviderBindingEventCode(value.eventCode || value.event_code),
    provider,
    providerAccountId: normalizeCodeClipProviderAccountId(
      provider,
      value.providerAccountId || value.provider_account_id
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

function normalizeCodeClipProviderAccountBindingListFilters(filters = {}) {
  const vertical = normalizeOptionalFilterString(filters.vertical, "vertical", 64) || CODECLIP_VERTICAL;
  if (vertical.toLowerCase() !== CODECLIP_VERTICAL) {
    throw invalidBinding("vertical must be codeclip", { fieldName: "vertical" });
  }
  const status = normalizeOptionalFilterString(filters.status, "status", 32);
  if (status && !VALID_STATUSES.has(status.toLowerCase())) {
    throw invalidBinding("status is not valid", { fieldName: "status" });
  }
  return {
    vertical: CODECLIP_VERTICAL,
    eventCode: normalizeOptionalFilterString(filters.eventCode || filters.event_code, "eventCode", 120),
    provider: normalizeOptionalFilterString(filters.provider, "provider", 64)?.toLowerCase() || null,
    channel: normalizeOptionalFilterString(filters.channel, "channel", 64)?.toLowerCase() || null,
    status: status?.toLowerCase() || null,
    search: normalizeOptionalFilterString(filters.search, "search", 120),
    limit: normalizeCodeClipProviderBindingListLimit(filters.limit),
    cursor: decodeCodeClipProviderBindingCursor(filters.cursor),
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
    vertical: mapped.vertical,
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

async function listBindingsByIdentity(normalized, queryClient) {
  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE vertical = $1
        AND provider = $2
        AND provider_account_id = $3
      ORDER BY status = 'active' DESC, updated_at DESC, id DESC
      LIMIT 3
    `,
    [CODECLIP_VERTICAL, normalized.provider, normalized.providerAccountId]
  );
  return (result.rows || []).map(mapCodeClipProviderAccountBindingRow);
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
    if (existing.eventCode === normalized.eventCode && existing.channel === normalized.channel) {
      return {
        status: "existing",
        created: false,
        existing: true,
        row: existing,
      };
    }
    throw bindingConflict("provider account is already bound to another episode or channel", {
      bindingId: existing.id,
      provider: existing.provider,
      eventCode: existing.eventCode,
      channel: existing.channel,
      status: existing.status,
    });
  }

  const disabledMatches = (await listBindingsByIdentity(normalized, client)).filter(
    (binding) => binding.status === DISABLED_STATUS
  );
  if (disabledMatches.length) {
    throw bindingConflict("provider account has a disabled binding that must be reactivated", {
      provider: normalized.provider,
      eventCode: disabledMatches[0].eventCode,
      bindingId: disabledMatches[0].id,
      status: disabledMatches[0].status,
      reactivationRequired: true,
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
        bindingId: conflict?.id,
        channel: conflict?.channel,
        status: conflict?.status,
      });
    }
    throw error;
  }
}

async function listCodeClipProviderAccountBindings(
  filters = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalized = normalizeCodeClipProviderAccountBindingListFilters(filters);
  const predicates = ["vertical = $1"];
  const params = [normalized.vertical];

  if (normalized.eventCode) {
    params.push(normalized.eventCode);
    predicates.push(`event_code = $${params.length}`);
  }
  if (normalized.provider) {
    params.push(normalized.provider);
    predicates.push(`provider = $${params.length}`);
  }
  if (normalized.channel) {
    params.push(normalized.channel);
    predicates.push(`channel = $${params.length}`);
  }
  if (normalized.status) {
    params.push(normalized.status);
    predicates.push(`status = $${params.length}`);
  }
  if (normalized.search) {
    params.push(`%${escapeLikePattern(normalized.search.toLowerCase())}%`);
    predicates.push(`(
      LOWER(event_code) LIKE $${params.length} ESCAPE '\\'
      OR LOWER(provider) LIKE $${params.length} ESCAPE '\\'
      OR LOWER(channel) LIKE $${params.length} ESCAPE '\\'
      OR LOWER(COALESCE(display_name, '')) LIKE $${params.length} ESCAPE '\\'
    )`);
  }
  if (normalized.cursor) {
    params.push(normalized.cursor.updatedAt);
    const updatedAtParam = params.length;
    params.push(normalized.cursor.id);
    const idParam = params.length;
    predicates.push(`(
      updated_at < $${updatedAtParam}::timestamptz
      OR (updated_at = $${updatedAtParam}::timestamptz AND id < $${idParam}::bigint)
    )`);
  }

  params.push(normalized.limit + 1);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE ${predicates.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );

  const rows = (result.rows || []).map(mapCodeClipProviderAccountBindingRow);
  const hasMore = rows.length > normalized.limit;
  const items = hasMore ? rows.slice(0, normalized.limit) : rows;

  return {
    items,
    page: {
      limit: normalized.limit,
      nextCursor: hasMore ? encodeCodeClipProviderBindingCursor(items[items.length - 1]) : null,
      hasMore,
    },
    filters: {
      vertical: normalized.vertical,
      eventCode: normalized.eventCode,
      provider: normalized.provider,
      channel: normalized.channel,
      status: normalized.status,
      search: normalized.search,
    },
  };
}

async function getCodeClipProviderAccountBindingById(id, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizeCodeClipProviderBindingId(id);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_bindings
      WHERE id = $1
        AND vertical = 'codeclip'
      LIMIT 1
    `,
    [normalizedId]
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
  };
  normalized.providerAccountId = normalizeCodeClipProviderAccountId(
    normalized.provider,
    providerAccountId
  );
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
  const normalizedId = normalizeCodeClipProviderBindingId(id);

  const existing = await getCodeClipProviderAccountBindingById(normalizedId, { queryClient: client });
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
    [normalizedId]
  );
  return mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null);
}

async function updateCodeClipProviderAccountBinding(
  id,
  input = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizeCodeClipProviderBindingId(id);
  const value = requirePlainObject(input, "binding update");
  if (!Object.hasOwn(value, "displayName")) {
    throw invalidBinding("displayName is required", { fieldName: "displayName" });
  }
  if (value.displayName === undefined) {
    throw invalidBinding("displayName is required", { fieldName: "displayName" });
  }

  const normalizedDisplayName = normalizeCodeClipProviderBindingDisplayName(value.displayName);
  const result = await client.query(
    `
      UPDATE codeclip_provider_account_bindings
      SET
        display_name = $2,
        updated_at = NOW()
      WHERE id = $1
        AND vertical = 'codeclip'
      RETURNING *
    `,
    [normalizedId, normalizedDisplayName]
  );
  return mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null);
}

async function reactivateCodeClipProviderAccountBinding(id, { queryClient } = {}) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizeCodeClipProviderBindingId(id);

  const existing = await getCodeClipProviderAccountBindingById(normalizedId, { queryClient: client });
  if (!existing) return { reactivated: false, row: null };
  if (existing.status === ACTIVE_STATUS) {
    return { reactivated: false, row: existing };
  }

  const active = await getActiveBindingByIdentity(
    {
      provider: existing.provider,
      providerAccountId: existing.providerAccountId,
    },
    client
  );
  if (active && String(active.id) !== String(existing.id)) {
    throw bindingConflict("provider account is already bound to another active binding", {
      bindingId: active.id,
      provider: active.provider,
      eventCode: active.eventCode,
      channel: active.channel,
      status: active.status,
    });
  }

  await client.query("SAVEPOINT codeclip_provider_binding_reactivate");
  try {
    const result = await client.query(
      `
        UPDATE codeclip_provider_account_bindings
        SET
          status = 'active',
          disabled_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND vertical = 'codeclip'
        RETURNING *
      `,
      [normalizedId]
    );
    const row = mapCodeClipProviderAccountBindingRow(result.rows?.[0] || null);
    await client.query("RELEASE SAVEPOINT codeclip_provider_binding_reactivate");
    if (!row) return { reactivated: false, row: null };

    return {
      reactivated: true,
      row,
    };
  } catch (error) {
    if (error?.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT codeclip_provider_binding_reactivate");
      const conflict = await getActiveBindingByIdentity(
        {
          provider: existing.provider,
          providerAccountId: existing.providerAccountId,
        },
        client
      );
      await client.query("RELEASE SAVEPOINT codeclip_provider_binding_reactivate");
      if (!conflict) {
        throw providerBindingError(
          "PROVIDER_BINDING_CONFLICT_LOOKUP_FAILED",
          "Unable to resolve the active provider binding after a uniqueness conflict."
        );
      }
      throw bindingConflict("provider account is already bound to another active binding", {
        bindingId: conflict.id,
        provider: conflict.provider,
        eventCode: conflict.eventCode,
        channel: conflict.channel,
        status: conflict.status,
      });
    }
    await client.query("ROLLBACK TO SAVEPOINT codeclip_provider_binding_reactivate");
    await client.query("RELEASE SAVEPOINT codeclip_provider_binding_reactivate");
    throw error;
  }
}

module.exports = {
  CODECLIP_VERTICAL,
  CodeClipProviderAccountBindingError,
  normalizeCodeClipProviderAccountBindingInput,
  normalizeCodeClipProviderBindingDisplayName,
  normalizeCodeClipProviderBindingEventCode,
  normalizeCodeClipProviderBindingId,
  normalizeCodeClipProviderAccountId,
  normalizeCodeClipProviderAccountBindingListFilters,
  normalizeCodeClipProviderBindingListLimit,
  createCodeClipProviderAccountBinding,
  getCodeClipProviderAccountBindingById,
  findActiveCodeClipProviderAccountBinding,
  listCodeClipProviderAccountBindings,
  listCodeClipProviderAccountBindingsForEvent,
  disableCodeClipProviderAccountBinding,
  updateCodeClipProviderAccountBinding,
  reactivateCodeClipProviderAccountBinding,
  maskCodeClipProviderAccountId,
  toPublicCodeClipProviderBinding,
};
