/**
 * TikTok credential refresh orchestrator (F2B2).
 *
 * claim → secret-read → verify provider=tiktok → TikTok HTTP (no TX) → complete/release.
 *
 * Rotation risk: TikTok may issue a new refresh_token before durable complete.
 * If complete fails after HTTP success, plaintext dies with the process; the
 * encrypted store retains the prior token-set. Subsequent invalid_grant must
 * go through reauthorization. No intermediate token staging table.
 *
 * Production dependencies are locked module imports. Callers may only inject:
 * queryClient (pool), env, fetchImpl, timeoutMs.
 *
 * No routes, scheduler, worker, polling, or Display API.
 */

const {
  CodeClipProviderCredentialRefreshError,
  claimCodeClipProviderCredentialRefresh,
  completeCodeClipProviderCredentialRefresh,
  releaseCodeClipProviderCredentialRefresh,
} = require("../provider-credential-refresh");
const {
  getCodeClipProviderCredentialSecretsForUse,
} = require("../provider-credentials");
const {
  CodeClipTikTokOAuthClientError,
  refreshCodeClipTikTokAccessToken,
} = require("./oauth-client");

const PROVIDER = "tiktok";
const SYSTEM_ACTOR = Object.freeze({
  type: "system",
  id: "tiktok_token_refresh",
});

const SAFE_DETAIL_KEYS = new Set(["fieldName", "reason", "status"]);

class CodeClipTikTokCredentialRefreshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokCredentialRefreshError";
    this.code = code;
    this.details = sanitizeDetails(details);
  }
}

function sanitizeDetails(details) {
  const safe = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return safe;
  }
  for (const key of SAFE_DETAIL_KEYS) {
    if (details[key] !== undefined && details[key] !== null) {
      safe[key] = String(details[key]).slice(0, 80);
    }
  }
  return safe;
}

function orchestratorError(code, message, details = {}) {
  return new CodeClipTikTokCredentialRefreshError(code, message, details);
}

function requirePool(queryClient) {
  if (!queryClient || typeof queryClient.connect !== "function") {
    throw orchestratorError(
      "DATABASE_UNAVAILABLE",
      "TikTok credential refresh requires a pool with connect()"
    );
  }
  return queryClient;
}

function normalizeCredentialId(credentialId) {
  if (credentialId === undefined || credentialId === null || credentialId === "") {
    throw orchestratorError("INVALID_REFRESH_REQUEST", "credentialId is required", {
      fieldName: "credentialId",
    });
  }
  if (typeof credentialId === "number") {
    if (!Number.isSafeInteger(credentialId) || credentialId <= 0) {
      throw orchestratorError("INVALID_REFRESH_REQUEST", "credentialId is invalid", {
        fieldName: "credentialId",
      });
    }
    return String(credentialId);
  }
  if (typeof credentialId === "string" && /^[0-9]+$/.test(credentialId.trim())) {
    return credentialId.trim();
  }
  if (typeof credentialId === "bigint" && credentialId > 0n) {
    return credentialId.toString();
  }
  throw orchestratorError("INVALID_REFRESH_REQUEST", "credentialId is invalid", {
    fieldName: "credentialId",
  });
}

function mapRefreshClientError(error) {
  if (!(error instanceof CodeClipTikTokOAuthClientError)) return null;
  const code = error.code;
  if (code === "TIKTOK_CONFIG_NOT_AVAILABLE") {
    return { kind: "config", code, reason: "tiktok_refresh_config_unavailable" };
  }
  if (
    code === "TIKTOK_REAUTHORIZATION_REQUIRED" ||
    code === "REFRESH_TOKEN_REQUIRED"
  ) {
    return {
      kind: "reauthorization",
      code: "TIKTOK_REAUTHORIZATION_REQUIRED",
      reason: "tiktok_refresh_authorization_invalid",
    };
  }
  if (code === "TIKTOK_RATE_LIMITED") {
    return { kind: "retryable", code, reason: "tiktok_rate_limited" };
  }
  if (code === "TIKTOK_SERVICE_UNAVAILABLE") {
    return { kind: "retryable", code, reason: "tiktok_service_unavailable" };
  }
  if (code === "INVALID_TIKTOK_REFRESH_RESPONSE") {
    // Provider response malformed — credential may still be valid; retryable.
    return {
      kind: "retryable",
      code: "TIKTOK_REFRESH_FAILED",
      reason: "tiktok_refresh_invalid_response",
    };
  }
  if (code === "TIKTOK_REFRESH_FAILED") {
    return { kind: "retryable", code, reason: "tiktok_refresh_failed" };
  }
  return {
    kind: "retryable",
    code: "TIKTOK_REFRESH_FAILED",
    reason: "tiktok_refresh_failed",
  };
}

function mapGenericRefreshError(error) {
  if (!(error instanceof CodeClipProviderCredentialRefreshError)) return null;
  const code = error.code;
  if (code === "CREDENTIAL_NOT_FOUND") {
    return orchestratorError("CREDENTIAL_NOT_FOUND", "credential was not found");
  }
  if (
    code === "REFRESH_CLAIM_OWNER_MISMATCH" ||
    code === "REFRESH_CLAIM_STALE" ||
    code === "REFRESH_CLAIM_MISSING" ||
    code === "REFRESH_STATUS_RACE" ||
    code === "REFRESH_NOT_COMPLETABLE"
  ) {
    return orchestratorError(
      "CREDENTIAL_REFRESH_RACE",
      "credential refresh claim race"
    );
  }
  if (code === "DATABASE_UNAVAILABLE" || code === "DATABASE_ERROR") {
    return orchestratorError(code, "database error");
  }
  if (code === "INVALID_CREDENTIAL_INPUT") {
    return orchestratorError("INVALID_REFRESH_REQUEST", "refresh request is invalid");
  }
  return orchestratorError("PERSISTENCE_FAILED", "credential refresh persistence failed");
}

async function safeRelease({ queryClient, credentialId, owner, outcome, reason, now }) {
  try {
    await releaseCodeClipProviderCredentialRefresh(
      {
        credentialId,
        owner,
        outcome,
        reason,
        actor: SYSTEM_ACTOR,
        now,
      },
      { queryClient }
    );
  } catch (error) {
    // Never report soft failure as if claim was cleared when release itself fails.
    const mapped = mapGenericRefreshError(error);
    if (mapped) throw mapped;
    throw orchestratorError("PERSISTENCE_FAILED", "failed to release refresh claim");
  }
}

/**
 * Refresh a TikTok provider credential using generic claim/complete fencing.
 *
 * @param {{ credentialId, owner, leaseMs?, now? }} input
 * @param {{ queryClient, env?, fetchImpl?, timeoutMs? }} options
 *   queryClient must be a pool with connect() (Alternativ B ownership).
 *   fetchImpl/env/timeoutMs are the only injectable I/O dependencies.
 */
async function refreshCodeClipTikTokCredential(
  { credentialId, owner, leaseMs, now } = {},
  { queryClient, env = process.env, fetchImpl, timeoutMs } = {}
) {
  const pool = requirePool(queryClient);
  const normalizedId = normalizeCredentialId(credentialId);

  if (typeof owner !== "string" || !owner.trim()) {
    throw orchestratorError("INVALID_REFRESH_REQUEST", "owner is required", {
      fieldName: "owner",
    });
  }

  let claim;
  try {
    claim = await claimCodeClipProviderCredentialRefresh(
      {
        credentialId: normalizedId,
        owner,
        leaseMs,
        now,
      },
      { queryClient: pool }
    );
  } catch (error) {
    const mapped = mapGenericRefreshError(error);
    if (mapped) throw mapped;
    throw orchestratorError("PERSISTENCE_FAILED", "failed to claim refresh");
  }

  if (!claim || claim.ok === false) {
    const reason = claim?.reason || "REFRESH_NOT_CLAIMABLE";
    if (reason === "REFRESH_CLAIM_CONTENTION") {
      return {
        ok: false,
        status: "retryable",
        credentialId: normalizedId,
        classification: "REFRESH_CLAIM_CONTENTION",
      };
    }
    if (reason === "REFRESH_NOT_CLAIMABLE") {
      return {
        ok: false,
        status: "retryable",
        credentialId: normalizedId,
        classification: "REFRESH_NOT_CLAIMABLE",
      };
    }
    throw orchestratorError("REFRESH_NOT_CLAIMABLE", "credential is not claimable");
  }

  const claimedCredentialId = String(claim.credentialId || normalizedId);

  // Secret-read after claim (no open TX held across HTTP).
  let secrets;
  try {
    secrets = await getCodeClipProviderCredentialSecretsForUse(
      { id: claimedCredentialId, purpose: "refresh", now },
      { queryClient: pool, env }
    );
  } catch {
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_retryable",
      reason: "tiktok_refresh_secret_read_failed",
      now,
    });
    throw orchestratorError("PERSISTENCE_FAILED", "secret-read failed");
  }

  if (!secrets || secrets.ok !== true) {
    const secretReason = secrets?.reason || "REFRESH_TOKEN_UNAVAILABLE";
    if (
      secretReason === "REAUTHORIZATION_REQUIRED" ||
      secretReason === "TOKEN_NOT_PRESENT"
    ) {
      await safeRelease({
        queryClient: pool,
        credentialId: claimedCredentialId,
        owner,
        outcome: "failed_reauthorization",
        reason: "tiktok_refresh_token_unavailable",
        now,
      });
      return {
        ok: false,
        status: "reauthorization_required",
        credentialId: claimedCredentialId,
        classification: "REFRESH_TOKEN_UNAVAILABLE",
      };
    }
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_retryable",
      reason: "tiktok_refresh_secret_read_failed",
      now,
    });
    return {
      ok: false,
      status: "retryable",
      credentialId: claimedCredentialId,
      classification: "REFRESH_TOKEN_UNAVAILABLE",
    };
  }

  // Provider gate immediately after secret-read (authoritative identity source).
  const provider = String(secrets.credential?.provider || "")
    .trim()
    .toLowerCase();
  if (provider !== PROVIDER) {
    // Clear fenced claim; do not mark reauthorization for wrong provider.
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_retryable",
      reason: "unsupported_credential_provider",
      now,
    });
    throw orchestratorError(
      "UNSUPPORTED_CREDENTIAL_PROVIDER",
      "credential provider is not tiktok"
    );
  }

  const providerAccountId = secrets.credential?.providerAccountId;
  const refreshToken = secrets.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) {
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_reauthorization",
      reason: "tiktok_refresh_token_unavailable",
      now,
    });
    return {
      ok: false,
      status: "reauthorization_required",
      credentialId: claimedCredentialId,
      classification: "REFRESH_TOKEN_UNAVAILABLE",
    };
  }
  if (typeof providerAccountId !== "string" || !providerAccountId) {
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_retryable",
      reason: "tiktok_refresh_identity_unavailable",
      now,
    });
    throw orchestratorError("PERSISTENCE_FAILED", "credential identity unavailable");
  }

  // HTTP refresh — no DB transaction open.
  let tokenResult;
  try {
    tokenResult = await refreshCodeClipTikTokAccessToken(
      { refreshToken, now },
      { env, fetchImpl, timeoutMs }
    );
  } catch (error) {
    const classified = mapRefreshClientError(error);
    if (!classified) {
      await safeRelease({
        queryClient: pool,
        credentialId: claimedCredentialId,
        owner,
        outcome: "failed_retryable",
        reason: "tiktok_refresh_failed",
        now,
      });
      throw orchestratorError("TIKTOK_REFRESH_FAILED", "TikTok token refresh failed");
    }

    if (classified.kind === "config") {
      await safeRelease({
        queryClient: pool,
        credentialId: claimedCredentialId,
        owner,
        outcome: "failed_retryable",
        reason: classified.reason,
        now,
      });
      throw orchestratorError(
        "TIKTOK_CONFIG_NOT_AVAILABLE",
        "TikTok OAuth is not configured"
      );
    }

    if (classified.kind === "reauthorization") {
      await safeRelease({
        queryClient: pool,
        credentialId: claimedCredentialId,
        owner,
        outcome: "failed_reauthorization",
        reason: classified.reason,
        now,
      });
      return {
        ok: false,
        status: "reauthorization_required",
        credentialId: claimedCredentialId,
        classification: classified.code,
      };
    }

    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_retryable",
      reason: classified.reason,
      now,
    });
    return {
      ok: false,
      status: "retryable",
      credentialId: claimedCredentialId,
      classification: classified.code,
    };
  }

  // Exact identity match (case-sensitive).
  if (String(tokenResult.openId) !== String(providerAccountId)) {
    await safeRelease({
      queryClient: pool,
      credentialId: claimedCredentialId,
      owner,
      outcome: "failed_reauthorization",
      reason: "tiktok_refresh_identity_mismatch",
      now,
    });
    return {
      ok: false,
      status: "reauthorization_required",
      credentialId: claimedCredentialId,
      classification: "TIKTOK_ACCOUNT_IDENTITY_MISMATCH",
    };
  }

  try {
    const completed = await completeCodeClipProviderCredentialRefresh(
      {
        credentialId: claimedCredentialId,
        owner,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        accessTokenExpiresAt: tokenResult.accessTokenExpiresAt,
        tokenType: tokenResult.tokenType,
        scopes: tokenResult.scopes,
        metadata: {
          refreshTokenExpiresAt: tokenResult.refreshTokenExpiresAt,
        },
        actor: SYSTEM_ACTOR,
        reason: "tiktok_refresh_succeeded",
        now,
      },
      { queryClient: pool, env }
    );

    const credential = completed?.credential || null;
    const refreshTokenExpiresAt =
      credential?.metadata &&
      typeof credential.metadata === "object" &&
      credential.metadata.refreshTokenExpiresAt
        ? String(credential.metadata.refreshTokenExpiresAt)
        : tokenResult.refreshTokenExpiresAt || null;

    return {
      ok: true,
      status: "refreshed",
      credentialId: claimedCredentialId,
      accessTokenExpiresAt:
        credential?.accessTokenExpiresAt || tokenResult.accessTokenExpiresAt || null,
      refreshTokenExpiresAt,
    };
  } catch (error) {
    // HTTP succeeded but durable complete failed — tokens only in memory (lost).
    // Prior encrypted set remains if TX rolled back. No automatic re-HTTP.
    const mapped = mapGenericRefreshError(error);
    if (mapped) throw mapped;
    throw orchestratorError(
      "CREDENTIAL_REFRESH_RACE",
      "credential refresh completion failed"
    );
  }
}

module.exports = {
  CodeClipTikTokCredentialRefreshError,
  refreshCodeClipTikTokCredential,
};
