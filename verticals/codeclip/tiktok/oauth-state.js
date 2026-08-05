/**
 * TikTok OAuth durable state (F2A1).
 *
 * Stores hashed CSRF state + episode/env/redirect/scope binding.
 * Raw state is never persisted. No tokens, secrets, or TikTok HTTP.
 */

const crypto = require("node:crypto");
const database = require("../../../db");

const CODECLIP_VERTICAL = "codeclip";
const MAX_BIGINT_ID = 9223372036854775807n;

const DEFAULT_STATE_TTL_SECONDS = 600;
const MIN_STATE_TTL_SECONDS = 60;
const MAX_STATE_TTL_SECONDS = 3600;

const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 300_000;

const OWNER_MAX = 128;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EVENT_CODE_MAX = 120;
const REDIRECT_URI_MAX = 512;
const RETURN_URL_MAX = 2048;
const CREATED_BY_MAX = 128;
const SCOPE_MAX = 128;
const SCOPES_MAX_COUNT = 16;

const STATUSES = Object.freeze(["pending", "claimed", "completed"]);
const ENVIRONMENTS = Object.freeze(["sandbox", "production"]);

const SAFE_SELECT = `
  id,
  state_hash,
  event_code,
  environment,
  redirect_uri,
  requested_scopes,
  return_url,
  created_by,
  status,
  claim_owner,
  claimed_at,
  claim_expires_at,
  claim_version,
  created_at,
  expires_at,
  completed_at,
  consumed_at
`.replace(/\s+/g, " ").trim();

class CodeClipTikTokOAuthError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokOAuthError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function oauthError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "status"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipTikTokOAuthError(code, message, safe);
}

function requireQueryClient(queryClient) {
  if (!queryClient) {
    throw oauthError(
      "DATABASE_UNAVAILABLE",
      "TikTok OAuth state requires an explicit query client"
    );
  }
  const hasQuery = typeof queryClient.query === "function";
  const hasConnect = typeof queryClient.connect === "function";
  if (!hasQuery && !hasConnect) {
    throw oauthError(
      "DATABASE_UNAVAILABLE",
      "TikTok OAuth state requires an explicit query client"
    );
  }
  return queryClient;
}

async function withStateTransaction(queryClient, work) {
  if (typeof queryClient.connect === "function") {
    let client = null;
    try {
      client = await queryClient.connect();
    } catch {
      throw oauthError("DATABASE_UNAVAILABLE", "failed to open database client");
    }
    if (!client || typeof client.query !== "function") {
      throw oauthError("DATABASE_UNAVAILABLE", "database pool returned invalid client");
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
        // preserve original
      }
      throw error;
    } finally {
      try {
        if (typeof client.release === "function") client.release();
      } catch {
        // ignore
      }
    }
  }
  if (typeof queryClient.query !== "function") {
    throw oauthError("DATABASE_UNAVAILABLE", "TikTok OAuth state requires query client");
  }
  return work(queryClient);
}

function hashState(rawState) {
  return crypto.createHash("sha256").update(String(rawState), "utf8").digest("hex");
}

function generateRawState() {
  return crypto.randomBytes(32).toString("base64url");
}

function toIso(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeInjectedNow(now) {
  if (now === undefined) return null;
  if (now === null || now === "") {
    throw oauthError("INVALID_OAUTH_REQUEST", "now is invalid", { fieldName: "now" });
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw oauthError("INVALID_OAUTH_REQUEST", "now is invalid", { fieldName: "now" });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw oauthError("INVALID_OAUTH_REQUEST", "now is invalid", { fieldName: "now" });
    }
    return new Date(ms).toISOString();
  }
  throw oauthError("INVALID_OAUTH_REQUEST", "now is invalid", { fieldName: "now" });
}

async function resolveOperationNow(tx, injectedNow) {
  const clockResult = await tx.query(
    `SELECT COALESCE($1::timestamptz, NOW()) AS operation_now`,
    [injectedNow]
  );
  const operationNowIso = toIso(clockResult.rows?.[0]?.operation_now);
  if (!operationNowIso) {
    throw oauthError("DATABASE_ERROR", "failed to resolve operation clock");
  }
  return {
    operationNowIso,
    operationNowMs: parseMs(operationNowIso),
  };
}

function normalizePositiveBigIntId(value, fieldName = "id") {
  let normalized;
  if (typeof value === "string") normalized = value.trim();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw oauthError("INVALID_OAUTH_REQUEST", `${fieldName} is invalid`, { fieldName });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") normalized = value.toString();
  else {
    throw oauthError("INVALID_OAUTH_REQUEST", `${fieldName} is invalid`, { fieldName });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw oauthError("INVALID_OAUTH_REQUEST", `${fieldName} is invalid`, { fieldName });
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_BIGINT_ID) {
    throw oauthError("INVALID_OAUTH_REQUEST", `${fieldName} is invalid`, { fieldName });
  }
  return normalized;
}

function normalizeClaimOwner(owner) {
  if (typeof owner !== "string") {
    throw oauthError("INVALID_OAUTH_REQUEST", "owner is invalid", { fieldName: "owner" });
  }
  const normalized = owner.trim().toLowerCase();
  if (!normalized || normalized.length > OWNER_MAX || !OWNER_PATTERN.test(normalized)) {
    throw oauthError("INVALID_OAUTH_REQUEST", "owner is invalid", { fieldName: "owner" });
  }
  return normalized;
}

function normalizeLeaseMs(leaseMs) {
  if (leaseMs === undefined) return DEFAULT_LEASE_MS;
  if (typeof leaseMs !== "number" || !Number.isInteger(leaseMs)) {
    throw oauthError("INVALID_OAUTH_REQUEST", "leaseMs is invalid", { fieldName: "leaseMs" });
  }
  if (leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw oauthError("INVALID_OAUTH_REQUEST", "leaseMs is invalid", { fieldName: "leaseMs" });
  }
  return leaseMs;
}

function normalizeExpectedVersion(value) {
  if (value === undefined || value === null || value === "") {
    throw oauthError("INVALID_OAUTH_REQUEST", "expectedClaimVersion is required", {
      fieldName: "expectedClaimVersion",
    });
  }
  let normalized;
  if (typeof value === "string") normalized = value.trim();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw oauthError("INVALID_OAUTH_REQUEST", "expectedClaimVersion is invalid", {
        fieldName: "expectedClaimVersion",
      });
    }
    normalized = String(value);
  } else if (typeof value === "bigint") normalized = value.toString();
  else {
    throw oauthError("INVALID_OAUTH_REQUEST", "expectedClaimVersion is invalid", {
      fieldName: "expectedClaimVersion",
    });
  }
  if (!/^[0-9]+$/.test(normalized)) {
    throw oauthError("INVALID_OAUTH_REQUEST", "expectedClaimVersion is invalid", {
      fieldName: "expectedClaimVersion",
    });
  }
  const parsed = BigInt(normalized);
  if (parsed < 1n || parsed > MAX_BIGINT_ID) {
    throw oauthError("INVALID_OAUTH_REQUEST", "expectedClaimVersion is invalid", {
      fieldName: "expectedClaimVersion",
    });
  }
  return normalized;
}

function normalizeEventCode(value) {
  if (typeof value !== "string") {
    throw oauthError("INVALID_OAUTH_REQUEST", "eventCode is invalid", {
      fieldName: "eventCode",
    });
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > EVENT_CODE_MAX ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw oauthError("INVALID_OAUTH_REQUEST", "eventCode is invalid", {
      fieldName: "eventCode",
    });
  }
  return normalized;
}

function normalizeEnvironment(value) {
  if (typeof value !== "string") {
    throw oauthError("INVALID_ENVIRONMENT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!ENVIRONMENTS.includes(normalized)) {
    throw oauthError("INVALID_ENVIRONMENT", "environment is invalid", {
      fieldName: "environment",
    });
  }
  return normalized;
}

function normalizeRedirectUri(value) {
  if (typeof value !== "string") {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri is invalid", {
      fieldName: "redirectUri",
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > REDIRECT_URI_MAX) {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri is invalid", {
      fieldName: "redirectUri",
    });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri is invalid", {
      fieldName: "redirectUri",
    });
  }
  if (parsed.protocol !== "https:") {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri must be HTTPS", {
      fieldName: "redirectUri",
    });
  }
  if (parsed.search || parsed.hash) {
    throw oauthError("INVALID_REDIRECT_URI", "redirectUri must be static", {
      fieldName: "redirectUri",
    });
  }
  return trimmed;
}

function normalizeReturnUrl(value) {
  if (typeof value !== "string") {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > RETURN_URL_MAX) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw oauthError("INVALID_RETURN_URL", "returnUrl is invalid", {
      fieldName: "returnUrl",
    });
  }
  if (parsed.protocol !== "https:") {
    throw oauthError("INVALID_RETURN_URL", "returnUrl must be HTTPS", {
      fieldName: "returnUrl",
    });
  }
  if (parsed.hash) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl must not include fragment", {
      fieldName: "returnUrl",
    });
  }
  if (parsed.username || parsed.password) {
    throw oauthError("INVALID_RETURN_URL", "returnUrl must not include credentials", {
      fieldName: "returnUrl",
    });
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeScopes(value) {
  let list;
  if (value === undefined || value === null) {
    list = ["user.info.basic"];
  } else if (Array.isArray(value)) {
    list = value;
  } else {
    throw oauthError("INVALID_SCOPES", "requestedScopes is invalid", {
      fieldName: "requestedScopes",
    });
  }
  if (list.length === 0 || list.length > SCOPES_MAX_COUNT) {
    throw oauthError("INVALID_SCOPES", "requestedScopes is invalid", {
      fieldName: "requestedScopes",
    });
  }
  const allowed = new Set(["user.info.basic"]);
  const seen = new Set();
  const scopes = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw oauthError("INVALID_SCOPES", "requestedScopes is invalid", {
        fieldName: "requestedScopes",
      });
    }
    const s = entry.trim();
    if (!s || s.length > SCOPE_MAX || !allowed.has(s)) {
      throw oauthError("INVALID_SCOPES", "requestedScopes is invalid", {
        fieldName: "requestedScopes",
      });
    }
    if (!seen.has(s)) {
      seen.add(s);
      scopes.push(s);
    }
  }
  scopes.sort();
  if (scopes.length === 0) {
    throw oauthError("INVALID_SCOPES", "requestedScopes is invalid", {
      fieldName: "requestedScopes",
    });
  }
  return scopes;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw oauthError("INVALID_OAUTH_REQUEST", "actor is required", {
      fieldName: "actor",
    });
  }
  const type = String(actor.type || "").trim().toLowerCase();
  if (!["operator", "operator_key", "system"].includes(type)) {
    throw oauthError("INVALID_OAUTH_REQUEST", "actor is invalid", {
      fieldName: "actor",
    });
  }
  let id = null;
  if (actor.id !== undefined && actor.id !== null && actor.id !== "") {
    if (typeof actor.id !== "string") {
      throw oauthError("INVALID_OAUTH_REQUEST", "actor is invalid", {
        fieldName: "actor",
      });
    }
    id = actor.id.trim().slice(0, CREATED_BY_MAX);
    if (!id) id = null;
  }
  if (type !== "system" && !id) {
    throw oauthError("INVALID_OAUTH_REQUEST", "actor is invalid", {
      fieldName: "actor",
    });
  }
  return { type, id: id || "system" };
}

function toPublicState(row) {
  if (!row) return null;
  let claimVersion = row.claim_version ?? 0;
  if (typeof claimVersion === "bigint") claimVersion = Number(claimVersion);
  else claimVersion = Number(claimVersion);
  if (!Number.isFinite(claimVersion)) claimVersion = 0;

  return {
    id: String(row.id),
    eventCode: row.event_code,
    environment: row.environment,
    redirectUri: row.redirect_uri,
    requestedScopes: Array.isArray(row.requested_scopes)
      ? row.requested_scopes.map((s) => String(s))
      : [],
    returnUrl: row.return_url,
    createdBy: row.created_by || null,
    status: row.status,
    claimOwner: row.claim_owner || null,
    claimedAt: toIso(row.claimed_at),
    claimExpiresAt: toIso(row.claim_expires_at),
    claimVersion,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    completedAt: toIso(row.completed_at),
    consumedAt: toIso(row.consumed_at),
  };
}

/**
 * Create a pending OAuth state. Returns rawState only for immediate URL build.
 */
async function createCodeClipTikTokOAuthState(
  {
    eventCode,
    environment,
    redirectUri,
    returnUrl,
    requestedScopes,
    actor,
    now,
    ttlSeconds,
  } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedEventCode = normalizeEventCode(eventCode);
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedRedirect = normalizeRedirectUri(redirectUri);
  const normalizedReturn = normalizeReturnUrl(returnUrl);
  const scopes = normalizeScopes(requestedScopes);
  const mutationActor = normalizeActor(actor);
  const injectedNow = normalizeInjectedNow(now);

  let ttl = DEFAULT_STATE_TTL_SECONDS;
  if (ttlSeconds !== undefined) {
    if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds)) {
      throw oauthError("INVALID_OAUTH_REQUEST", "ttlSeconds is invalid", {
        fieldName: "ttlSeconds",
      });
    }
    if (ttlSeconds < MIN_STATE_TTL_SECONDS || ttlSeconds > MAX_STATE_TTL_SECONDS) {
      throw oauthError("INVALID_OAUTH_REQUEST", "ttlSeconds is invalid", {
        fieldName: "ttlSeconds",
      });
    }
    ttl = ttlSeconds;
  }

  const rawState = generateRawState();
  const stateHash = hashState(rawState);

  return withStateTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );
    const expiresAt = new Date(operationNowMs + ttl * 1000).toISOString();

    const result = await tx.query(
      `
        INSERT INTO codeclip_tiktok_oauth_states (
          state_hash,
          event_code,
          environment,
          redirect_uri,
          requested_scopes,
          return_url,
          created_by,
          status,
          claim_owner,
          claimed_at,
          claim_expires_at,
          claim_version,
          created_at,
          expires_at,
          completed_at,
          consumed_at
        )
        VALUES (
          $1, $2, $3, $4, $5::text[], $6, $7,
          'pending',
          NULL, NULL, NULL,
          0,
          $8::timestamptz,
          $9::timestamptz,
          NULL, NULL
        )
        RETURNING ${SAFE_SELECT}
      `,
      [
        stateHash,
        normalizedEventCode,
        normalizedEnvironment,
        normalizedRedirect,
        scopes,
        normalizedReturn,
        `${mutationActor.type}:${mutationActor.id}`.slice(0, CREATED_BY_MAX),
        operationNowIso,
        expiresAt,
      ]
    );

    const row = result.rows?.[0];
    if (!row) {
      throw oauthError("DATABASE_ERROR", "OAuth state insert returned no row");
    }

    return {
      rawState,
      expiresAt,
      oauthState: toPublicState(row),
    };
  });
}

/**
 * Claim a pending (or stale claimed) OAuth state by raw state string.
 */
async function claimCodeClipTikTokOAuthState(
  { state, owner, leaseMs, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  if (typeof state !== "string" || !state.trim()) {
    throw oauthError("INVALID_OAUTH_REQUEST", "state is invalid", {
      fieldName: "state",
    });
  }
  const stateHash = hashState(state.trim());
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
  const injectedNow = normalizeInjectedNow(now);

  return withStateTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT}
        FROM codeclip_tiktok_oauth_states
        WHERE state_hash = $1
        FOR UPDATE
      `,
      [stateHash]
    );
    const row = locked.rows?.[0] || null;
    if (!row) {
      throw oauthError("OAUTH_STATE_NOT_FOUND", "OAuth state was not found");
    }

    const expiresMs = parseMs(row.expires_at);
    if (expiresMs === null || expiresMs <= operationNowMs) {
      throw oauthError("OAUTH_STATE_EXPIRED", "OAuth state has expired");
    }

    if (row.status === "completed") {
      return {
        ok: true,
        status: "completed",
        oauthState: toPublicState(row),
        alreadyCompleted: true,
      };
    }

    const claimExpiresMs = parseMs(row.claim_expires_at);
    const hasActiveClaim =
      row.status === "claimed" &&
      row.claim_owner &&
      claimExpiresMs !== null &&
      claimExpiresMs > operationNowMs;

    if (hasActiveClaim) {
      return {
        ok: false,
        reason: "OAUTH_STATE_CONTENTION",
        oauthState: toPublicState(row),
      };
    }

    const updated = await tx.query(
      `
        UPDATE codeclip_tiktok_oauth_states
        SET
          status = 'claimed',
          claim_owner = $2,
          claimed_at = $3::timestamptz,
          claim_expires_at =
            $3::timestamptz + ($4::bigint * INTERVAL '1 millisecond'),
          claim_version = claim_version + 1
        WHERE id = $1
          AND status IN ('pending', 'claimed')
          AND expires_at > $3::timestamptz
          AND (
            claim_expires_at IS NULL
            OR claim_expires_at <= $3::timestamptz
          )
        RETURNING ${SAFE_SELECT}
      `,
      [row.id, normalizedOwner, operationNowIso, normalizedLeaseMs]
    );

    const claimed = updated.rows?.[0] || null;
    if (!claimed) {
      return {
        ok: false,
        reason: "OAUTH_STATE_CONTENTION",
        oauthState: toPublicState(row),
      };
    }

    let claimVersion = claimed.claim_version;
    if (typeof claimVersion === "bigint") claimVersion = Number(claimVersion);
    else claimVersion = Number(claimVersion);

    return {
      ok: true,
      status: "claimed",
      claimVersion,
      claimedAt: toIso(claimed.claimed_at) || operationNowIso,
      claimExpiresAt: toIso(claimed.claim_expires_at),
      oauthState: toPublicState(claimed),
      alreadyCompleted: false,
    };
  });
}

/**
 * Complete a claimed OAuth state (fenced). Used by F2A2 after credential persistence.
 */
async function completeCodeClipTikTokOAuthState(
  { stateId, id, owner, expectedClaimVersion, now } = {},
  { queryClient } = {}
) {
  const client = requireQueryClient(queryClient);
  const normalizedId = normalizePositiveBigIntId(stateId ?? id, "stateId");
  const normalizedOwner = normalizeClaimOwner(owner);
  const normalizedVersion = normalizeExpectedVersion(expectedClaimVersion);
  const injectedNow = normalizeInjectedNow(now);

  return withStateTransaction(client, async (tx) => {
    const { operationNowIso, operationNowMs } = await resolveOperationNow(
      tx,
      injectedNow
    );

    const locked = await tx.query(
      `
        SELECT ${SAFE_SELECT}
        FROM codeclip_tiktok_oauth_states
        WHERE id = $1
        FOR UPDATE
      `,
      [normalizedId]
    );
    const current = locked.rows?.[0] || null;
    if (!current) {
      throw oauthError("OAUTH_STATE_NOT_FOUND", "OAuth state was not found");
    }

    if (current.status === "completed") {
      return {
        status: "completed",
        alreadyCompleted: true,
        oauthState: toPublicState(current),
      };
    }

    if (current.status !== "claimed") {
      throw oauthError("OAUTH_STATE_RACE", "OAuth state is not claimable for completion");
    }

    const ownerMatches =
      current.claim_owner != null &&
      String(current.claim_owner).trim().toLowerCase() === normalizedOwner;
    const versionMatches =
      String(current.claim_version ?? "") === normalizedVersion;
    const claimExpiresMs = parseMs(current.claim_expires_at);
    const notStale =
      claimExpiresMs !== null &&
      operationNowMs !== null &&
      claimExpiresMs > operationNowMs;

    if (!ownerMatches) {
      throw oauthError("OAUTH_STATE_OWNER_MISMATCH", "OAuth claim owner mismatch");
    }
    if (!versionMatches || !notStale) {
      throw oauthError("OAUTH_STATE_STALE", "OAuth claim fence did not match");
    }

    const updated = await tx.query(
      `
        UPDATE codeclip_tiktok_oauth_states
        SET
          status = 'completed',
          completed_at = $2::timestamptz,
          consumed_at = $2::timestamptz,
          claim_owner = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL
        WHERE id = $1
          AND status = 'claimed'
          AND claim_owner = $3
          AND claim_version = $4::bigint
          AND claim_expires_at > $2::timestamptz
        RETURNING ${SAFE_SELECT}
      `,
      [normalizedId, operationNowIso, normalizedOwner, normalizedVersion]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      throw oauthError("OAUTH_STATE_RACE", "OAuth state changed during complete");
    }

    return {
      status: "completed",
      alreadyCompleted: false,
      oauthState: toPublicState(row),
    };
  });
}

module.exports = {
  CodeClipTikTokOAuthError,
  createCodeClipTikTokOAuthState,
  claimCodeClipTikTokOAuthState,
  completeCodeClipTikTokOAuthState,
  // Test-only: re-export hash for verifying SQL params never contain raw state
  // is NOT exported - tests check via create return + mock SQL
};
