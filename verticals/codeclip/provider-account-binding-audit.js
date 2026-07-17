const {
  CODECLIP_VERTICAL,
  CodeClipProviderAccountBindingError,
  toPublicCodeClipProviderBinding,
} = require("./provider-account-bindings");

const AUDIT_ACTIONS = new Set([
  "created",
  "display_name_updated",
  "disabled",
  "reactivated",
]);

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
const AUDIT_CURSOR_VERSION = 1;
const MAX_BIGINT_ID = 9223372036854775807n;

const SENSITIVE_KEYS = new Set([
  "provideraccountid",
  "provider_account_id",
  "adminkey",
  "admin_key",
  "secret",
  "webhooksecret",
  "webhook_secret",
  "apikey",
  "api_key",
  "authorization",
  "password",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
]);

function auditError(code, message, details = {}) {
  return new CodeClipProviderAccountBindingError(code, message, details);
}

function requireQueryClient(queryClient) {
  if (!queryClient || typeof queryClient.query !== "function") {
    throw auditError(
      "DATABASE_UNAVAILABLE",
      "codeClip provider account binding audit repository requires an explicit query client"
    );
  }
  return queryClient;
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    throw auditError("INVALID_PROVIDER_BINDING_AUDIT_INPUT", `${fieldName} must be a string`, {
      fieldName,
    });
  }
  const normalized = value.trim();
  if (!normalized) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_INPUT",
      `${fieldName} must be a non-empty string`,
      { fieldName }
    );
  }
  if (normalized.length > maxLength) {
    throw auditError("INVALID_PROVIDER_BINDING_AUDIT_INPUT", `${fieldName} is too long`, {
      fieldName,
      maxLength,
    });
  }
  return normalized;
}

function normalizeAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  if (!AUDIT_ACTIONS.has(normalized)) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_ACTION",
      "provider binding audit action is not supported",
      { action: normalized || null }
    );
  }
  return normalized;
}

function normalizeActorType(actorType) {
  const normalized = String(actorType || "operator").trim().toLowerCase();
  if (!["operator", "operator_key"].includes(normalized)) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_ACTOR",
      "audit actor type is not supported"
    );
  }
  return normalized;
}

function normalizeActorId(actorId, actorType = "operator") {
  if (actorType === "operator_key") {
    if (actorId === undefined || actorId === null || String(actorId).trim() === "") {
      return null;
    }
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_ACTOR",
      "audit actor id is not supported"
    );
  }

  const normalized = String(actorId || "admin").trim().toLowerCase();
  if (normalized !== "admin") {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_ACTOR",
      "audit actor id is not supported"
    );
  }
  return normalized;
}

function normalizeCodeClipProviderBindingAuditLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_AUDIT_LIMIT;

  let parsed;
  if (typeof limit === "number") {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw auditError(
        "INVALID_PROVIDER_BINDING_AUDIT_LIMIT",
        "audit limit must be a positive integer"
      );
    }
    parsed = limit;
  } else if (typeof limit === "string") {
    if (!/^[0-9]+$/.test(limit)) {
      throw auditError(
        "INVALID_PROVIDER_BINDING_AUDIT_LIMIT",
        "audit limit must be a positive integer"
      );
    }
    parsed = Number.parseInt(limit, 10);
    if (!parsed) {
      throw auditError(
        "INVALID_PROVIDER_BINDING_AUDIT_LIMIT",
        "audit limit must be a positive integer"
      );
    }
  } else {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_LIMIT",
      "audit limit must be a positive integer"
    );
  }

  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function normalizePositiveBigIntId(value, fieldName, code) {
  const normalized = String(value || "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw auditError(code, `${fieldName} is invalid`, { fieldName });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw auditError(code, `${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeAuditBindingId(bindingId) {
  return normalizePositiveBigIntId(
    bindingId,
    "bindingId",
    "INVALID_PROVIDER_BINDING_AUDIT_INPUT"
  );
}

function normalizeCursorTimestamp(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName, 80);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw auditError("INVALID_PROVIDER_BINDING_AUDIT_CURSOR", `${fieldName} is invalid`, {
      fieldName,
    });
  }
  return normalized;
}

function encodeCodeClipProviderBindingAuditCursor(event) {
  if (!event) return null;
  return Buffer.from(
    JSON.stringify({
      v: AUDIT_CURSOR_VERSION,
      createdAt: event.createdAt,
      id: String(event.id),
    })
  ).toString("base64url");
}

function decodeCodeClipProviderBindingAuditCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > 512) {
    throw auditError("INVALID_PROVIDER_BINDING_AUDIT_CURSOR", "audit cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const keys = Object.keys(decoded || {}).sort().join(",");
    if (!decoded || decoded.v !== AUDIT_CURSOR_VERSION || keys !== "createdAt,id,v") {
      throw new Error("invalid cursor shape");
    }
    return {
      createdAt: normalizeCursorTimestamp(decoded.createdAt, "cursor.createdAt"),
      id: normalizePositiveBigIntId(
        decoded.id,
        "cursor.id",
        "INVALID_PROVIDER_BINDING_AUDIT_CURSOR"
      ),
    };
  } catch {
    throw auditError("INVALID_PROVIDER_BINDING_AUDIT_CURSOR", "audit cursor is invalid");
  }
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || "").trim().toLowerCase());
}

function sanitizeCodeClipProviderBindingAuditState(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodeClipProviderBindingAuditState(entry));
  }
  if (typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    sanitized[key] = sanitizeCodeClipProviderBindingAuditState(entry);
  }
  return sanitized;
}

function toAuditState(binding) {
  const publicBinding = toPublicCodeClipProviderBinding(binding);
  if (!publicBinding) return null;
  return sanitizeCodeClipProviderBindingAuditState(publicBinding);
}

function requireCodeClipBinding(binding) {
  if (!binding || String(binding.vertical || "").trim().toLowerCase() !== CODECLIP_VERTICAL) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_INPUT",
      "audit binding must be a codeClip provider account binding"
    );
  }
  return {
    id: normalizeRequiredString(String(binding.id || ""), "binding.id", 120),
    eventCode: normalizeRequiredString(
      binding.eventCode || binding.event_code,
      "binding.eventCode",
      120
    ),
    provider: normalizeRequiredString(binding.provider, "binding.provider", 64),
    channel: normalizeRequiredString(binding.channel, "binding.channel", 64),
  };
}

function mapAuditRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    vertical: row.vertical,
    bindingId: row.binding_id,
    eventCode: row.event_code,
    provider: row.provider,
    channel: row.channel,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    beforeState: sanitizeCodeClipProviderBindingAuditState(row.before_state),
    afterState: sanitizeCodeClipProviderBindingAuditState(row.after_state),
    metadata: sanitizeCodeClipProviderBindingAuditState(row.metadata) || {},
    createdAt: row.created_at,
  };
}

function toPublicCodeClipProviderBindingAuditEvent(event = null) {
  const mapped = event?.event_code ? mapAuditRow(event) : event;
  if (
    !mapped ||
    String(mapped.vertical || "").trim().toLowerCase() !== CODECLIP_VERTICAL
  ) {
    return null;
  }

  return {
    id: mapped.id,
    bindingId: mapped.bindingId,
    eventCode: mapped.eventCode,
    provider: mapped.provider,
    channel: mapped.channel,
    action: mapped.action,
    actorType: mapped.actorType,
    actorId: mapped.actorId,
    beforeState: sanitizeCodeClipProviderBindingAuditState(mapped.beforeState),
    afterState: sanitizeCodeClipProviderBindingAuditState(mapped.afterState),
    metadata: sanitizeCodeClipProviderBindingAuditState(mapped.metadata) || {},
    createdAt: mapped.createdAt,
  };
}

async function appendCodeClipProviderAccountBindingAuditEvent(
  {
    binding,
    action,
    actorType = "operator",
    actorId = "admin",
    beforeState = null,
    afterState = null,
    metadata = {},
  } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedBinding = requireCodeClipBinding(binding);
  const normalizedAction = normalizeAction(action);
  const normalizedActorType = normalizeActorType(actorType);
  const normalizedActorId = normalizeActorId(actorId, normalizedActorType);
  const sanitizedBeforeState = sanitizeCodeClipProviderBindingAuditState(beforeState);
  const sanitizedAfterState = sanitizeCodeClipProviderBindingAuditState(afterState);
  const sanitizedMetadata = sanitizeCodeClipProviderBindingAuditState(metadata) || {};

  const result = await client.query(
    `
      INSERT INTO codeclip_provider_account_binding_audit (
        vertical,
        binding_id,
        event_code,
        provider,
        channel,
        action,
        actor_type,
        actor_id,
        before_state,
        after_state,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)
      RETURNING *
    `,
    [
      CODECLIP_VERTICAL,
      normalizedBinding.id,
      normalizedBinding.eventCode,
      normalizedBinding.provider,
      normalizedBinding.channel,
      normalizedAction,
      normalizedActorType,
      normalizedActorId,
      JSON.stringify(sanitizedBeforeState),
      JSON.stringify(sanitizedAfterState),
      JSON.stringify(sanitizedMetadata),
    ]
  );

  return mapAuditRow(result.rows?.[0] || null);
}

async function listCodeClipProviderAccountBindingAuditEvents(
  { bindingId, eventCode, limit } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedLimit = normalizeCodeClipProviderBindingAuditLimit(limit);
  const predicates = ["vertical = $1"];
  const params = [CODECLIP_VERTICAL];

  if (bindingId !== undefined && bindingId !== null) {
    params.push(normalizeRequiredString(String(bindingId), "bindingId", 120));
    predicates.push(`binding_id = $${params.length}`);
  }
  if (eventCode !== undefined && eventCode !== null) {
    params.push(normalizeRequiredString(String(eventCode), "eventCode", 120));
    predicates.push(`event_code = $${params.length}`);
  }
  if (params.length === 1) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_INPUT",
      "audit list requires bindingId or eventCode"
    );
  }

  params.push(normalizedLimit);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_binding_audit
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );

  return (result.rows || []).map(mapAuditRow);
}

async function listCodeClipProviderAccountBindingAuditEventsPage(
  { bindingId, eventCode, limit, cursor } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedLimit = normalizeCodeClipProviderBindingAuditLimit(limit);
  const normalizedCursor = decodeCodeClipProviderBindingAuditCursor(cursor);
  const predicates = ["vertical = $1"];
  const params = [CODECLIP_VERTICAL];

  if (bindingId !== undefined && bindingId !== null) {
    params.push(normalizeAuditBindingId(bindingId));
    predicates.push(`binding_id = $${params.length}`);
  }
  if (eventCode !== undefined && eventCode !== null) {
    params.push(normalizeRequiredString(String(eventCode), "eventCode", 120));
    predicates.push(`event_code = $${params.length}`);
  }
  if (params.length === 1) {
    throw auditError(
      "INVALID_PROVIDER_BINDING_AUDIT_INPUT",
      "audit list requires bindingId or eventCode"
    );
  }
  if (normalizedCursor) {
    params.push(normalizedCursor.createdAt);
    const createdAtParam = params.length;
    params.push(normalizedCursor.id);
    const idParam = params.length;
    predicates.push(`(
      created_at < $${createdAtParam}::timestamptz
      OR (created_at = $${createdAtParam}::timestamptz AND id < $${idParam}::bigint)
    )`);
  }

  params.push(normalizedLimit + 1);
  const result = await client.query(
    `
      SELECT *
      FROM codeclip_provider_account_binding_audit
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );
  const rows = (result.rows || []).map(mapAuditRow);
  const hasMore = rows.length > normalizedLimit;
  const items = hasMore ? rows.slice(0, normalizedLimit) : rows;

  return {
    items,
    page: {
      limit: normalizedLimit,
      nextCursor: hasMore ? encodeCodeClipProviderBindingAuditCursor(items[items.length - 1]) : null,
      hasMore,
    },
  };
}

module.exports = {
  appendCodeClipProviderAccountBindingAuditEvent,
  listCodeClipProviderAccountBindingAuditEvents,
  listCodeClipProviderAccountBindingAuditEventsPage,
  normalizeCodeClipProviderBindingAuditLimit,
  sanitizeCodeClipProviderBindingAuditState,
  toAuditState,
  toPublicCodeClipProviderBindingAuditEvent,
};
