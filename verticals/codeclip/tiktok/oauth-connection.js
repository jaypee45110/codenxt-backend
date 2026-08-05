/**
 * TikTok OAuth connection orchestrator (F2A2B).
 *
 * Start authorization + callback complete flow:
 * claim state → HTTP token exchange (outside TX) → credential + binding +
 * state complete (one short TX).
 *
 * No refresh, revoke, Display API, polling, or workers.
 */

const crypto = require("node:crypto");

const {
  CodeClipTikTokOAuthError,
  claimCodeClipTikTokOAuthState,
  completeCodeClipTikTokOAuthState,
} = require("./oauth-state");
const {
  createCodeClipTikTokOAuthAuthorization,
} = require("./oauth-authorization");
const {
  CodeClipTikTokOAuthClientError,
  exchangeCodeClipTikTokAuthorizationCode,
} = require("./oauth-client");
const {
  CodeClipProviderCredentialError,
  createCodeClipProviderCredential,
  findCodeClipProviderCredential,
  updateCodeClipProviderCredentialTokens,
} = require("../provider-credentials");
const {
  CodeClipProviderAccountBindingError,
  createCodeClipProviderAccountBinding,
  reactivateCodeClipProviderAccountBinding,
} = require("../provider-account-bindings");
const {
  appendCodeClipProviderAccountBindingAuditEvent,
  toAuditState,
} = require("../provider-account-binding-audit");

const PROVIDER = "tiktok";
const CHANNEL = "tiktok";
const REDIRECT_STATUS_PARAM = "tiktok";

/** Success-path claim lease (exchange + short persistence). */
const CLAIM_LEASE_MS = 60_000;
/**
 * Cancellation burns the state for as long as F2A1 max claim lease allows.
 * After lease expiry, remaining state TTL may still reject via expires_at.
 * F2A2B model: claimed-until-lease (no cancelled status without schema change).
 */
const CANCEL_CLAIM_LEASE_MS = 300_000;

const START_SYSTEM_ACTOR_ID = "tiktok_oauth_start";
const CALLBACK_SYSTEM_ACTOR_ID = "tiktok_oauth_callback";
const ACTOR_ID_MAX = 80;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const SAFE_DETAIL_KEYS = new Set(["fieldName", "reason", "status"]);

class CodeClipTikTokOAuthConnectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipTikTokOAuthConnectionError";
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

function connectionError(code, message, details = {}) {
  return new CodeClipTikTokOAuthConnectionError(code, message, details);
}

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeInjectedNow(now) {
  if (now === undefined) return new Date().toISOString();
  if (now === null || now === "") {
    throw connectionError("INVALID_CALLBACK", "now is invalid", {
      fieldName: "now",
    });
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw connectionError("INVALID_CALLBACK", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  if (typeof now === "string" || typeof now === "number") {
    const ms = Date.parse(now);
    if (!Number.isFinite(ms)) {
      throw connectionError("INVALID_CALLBACK", "now is invalid", {
        fieldName: "now",
      });
    }
    return new Date(ms).toISOString();
  }
  throw connectionError("INVALID_CALLBACK", "now is invalid", {
    fieldName: "now",
  });
}

function buildClaimOwner(requestId) {
  const suffix =
    typeof requestId === "string" && requestId.trim()
      ? requestId.trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "").slice(0, 48)
      : crypto.randomBytes(8).toString("hex");
  const owner = `tiktok-oauth-callback:${suffix || crypto.randomBytes(8).toString("hex")}`;
  return owner.slice(0, 128);
}

/**
 * Start-route actor (Model C).
 *
 * Admin-key auth has no operator identity. Default is a stable system actor.
 * F2A1 oauth-state requires non-system actors to include an id, and credential
 * audit forbids operator_key with an id — so operator_key is rejected here.
 * Callback mutations always use the stable system credential actor below.
 */
function normalizeStartActor(actor) {
  if (actor === undefined || actor === null) {
    return { type: "system", id: START_SYSTEM_ACTOR_ID };
  }
  if (typeof actor !== "object" || Array.isArray(actor)) {
    throw connectionError("INVALID_CALLBACK", "actor is invalid", {
      fieldName: "actor",
    });
  }
  const type = String(actor.type || "")
    .trim()
    .toLowerCase();
  if (!["operator", "system"].includes(type)) {
    // operator_key is intentionally rejected: F2A1 requires an id while
    // credential audit forbids operator_key ids.
    throw connectionError("INVALID_CALLBACK", "actor is invalid", {
      fieldName: "actor",
    });
  }

  if (type === "system") {
    let id = START_SYSTEM_ACTOR_ID;
    if (actor.id !== undefined && actor.id !== null && actor.id !== "") {
      if (typeof actor.id !== "string") {
        throw connectionError("INVALID_CALLBACK", "actor is invalid", {
          fieldName: "actor",
        });
      }
      id = actor.id.trim().toLowerCase();
      if (!id || id.length > ACTOR_ID_MAX || !ACTOR_ID_PATTERN.test(id)) {
        throw connectionError("INVALID_CALLBACK", "actor is invalid", {
          fieldName: "actor",
        });
      }
    }
    return { type: "system", id };
  }

  // operator
  if (typeof actor.id !== "string") {
    throw connectionError("INVALID_CALLBACK", "actor is invalid", {
      fieldName: "actor",
    });
  }
  const operatorId = actor.id.trim().toLowerCase();
  if (
    !operatorId ||
    operatorId.length > ACTOR_ID_MAX ||
    !ACTOR_ID_PATTERN.test(operatorId)
  ) {
    throw connectionError("INVALID_CALLBACK", "actor is invalid", {
      fieldName: "actor",
    });
  }
  return { type: "operator", id: operatorId };
}

/**
 * Callback persistence actors (Model C).
 *
 * Credential mutations always use a stable system actor for OAuth completion.
 * Binding audit allowlist only supports operator | operator_key (not system),
 * so binding audit uses operator_key without id (same pattern as YouTube OAuth).
 * created_by is historical only; malformed values do not invent operators.
 */
function resolveCallbackMutationActors(_createdBy) {
  return {
    credentialActor: { type: "system", id: CALLBACK_SYSTEM_ACTOR_ID },
    bindingAuditActorType: "operator_key",
    bindingAuditActorId: null,
  };
}

function buildSafeRedirect(returnUrl, status) {
  if (typeof returnUrl !== "string" || !returnUrl.trim()) {
    throw connectionError("INVALID_CALLBACK", "return URL is unavailable");
  }
  let parsed;
  try {
    parsed = new URL(returnUrl.trim());
  } catch {
    throw connectionError("INVALID_CALLBACK", "return URL is unavailable");
  }
  if (parsed.protocol !== "https:") {
    throw connectionError("INVALID_CALLBACK", "return URL is unavailable");
  }
  parsed.searchParams.set(REDIRECT_STATUS_PARAM, status);
  return parsed.toString();
}

function mapStateError(error) {
  if (!(error instanceof CodeClipTikTokOAuthError)) return null;
  const code = error.code;
  if (code === "OAUTH_STATE_NOT_FOUND") {
    return connectionError("OAUTH_STATE_NOT_FOUND", "OAuth state was not found");
  }
  if (code === "OAUTH_STATE_EXPIRED") {
    return connectionError("OAUTH_STATE_EXPIRED", "OAuth state has expired");
  }
  if (code === "OAUTH_STATE_STALE" || code === "OAUTH_STATE_RACE") {
    return connectionError("OAUTH_STATE_STALE", "OAuth state claim is no longer valid");
  }
  if (code === "OAUTH_STATE_OWNER_MISMATCH") {
    return connectionError("OAUTH_STATE_STALE", "OAuth state claim is no longer valid");
  }
  if (code === "DATABASE_UNAVAILABLE") {
    return connectionError("DATABASE_UNAVAILABLE", "database is unavailable");
  }
  if (code === "DATABASE_ERROR") {
    return connectionError("DATABASE_ERROR", "database error");
  }
  if (code === "INVALID_OAUTH_REQUEST") {
    return connectionError("INVALID_CALLBACK", "callback request is invalid");
  }
  return connectionError("AUTHORIZATION_FAILED", "authorization failed");
}

function mapClientError(error) {
  if (!(error instanceof CodeClipTikTokOAuthClientError)) return null;
  const code = error.code;
  if (code === "TIKTOK_CONFIG_NOT_AVAILABLE") {
    return connectionError("TOKEN_EXCHANGE_FAILED", "TikTok OAuth is not configured");
  }
  if (
    code === "AUTHORIZATION_CODE_REQUIRED" ||
    code === "AUTHORIZATION_CODE_INVALID" ||
    code === "AUTHORIZATION_CODE_EXPIRED"
  ) {
    return connectionError("TOKEN_EXCHANGE_FAILED", "authorization code exchange failed");
  }
  if (code === "INVALID_REDIRECT_URI") {
    return connectionError("TOKEN_EXCHANGE_FAILED", "authorization code exchange failed");
  }
  if (code === "INVALID_TIKTOK_RESPONSE") {
    return connectionError("INVALID_TOKEN_RESPONSE", "TikTok token response is invalid");
  }
  if (
    code === "TIKTOK_RATE_LIMITED" ||
    code === "TIKTOK_SERVICE_UNAVAILABLE" ||
    code === "TOKEN_EXCHANGE_FAILED"
  ) {
    return connectionError("TOKEN_EXCHANGE_FAILED", "TikTok token exchange failed");
  }
  return connectionError("TOKEN_EXCHANGE_FAILED", "TikTok token exchange failed");
}

function mapCredentialError(error) {
  if (!(error instanceof CodeClipProviderCredentialError)) return null;
  if (error.code === "CREDENTIAL_CONFLICT") {
    return connectionError("CREDENTIAL_CONFLICT", "credential conflict");
  }
  if (error.code === "INVALID_STATUS_FOR_TOKEN_UPDATE") {
    const status = error.details?.status;
    if (status === "disabled") {
      return connectionError("CREDENTIAL_DISABLED", "credential is disabled");
    }
    if (status === "revoked") {
      return connectionError("CREDENTIAL_REVOKED", "credential is revoked");
    }
    return connectionError("CREDENTIAL_DISABLED", "credential cannot be updated");
  }
  if (error.code === "DATABASE_UNAVAILABLE") {
    return connectionError("DATABASE_UNAVAILABLE", "database is unavailable");
  }
  if (error.code === "DATABASE_ERROR") {
    return connectionError("DATABASE_ERROR", "database error");
  }
  return connectionError("PERSISTENCE_FAILED", "credential persistence failed");
}

function mapBindingError(error) {
  if (!(error instanceof CodeClipProviderAccountBindingError)) return null;
  if (error.code === "PROVIDER_ACCOUNT_BINDING_CONFLICT") {
    return connectionError("BINDING_CONFLICT", "provider account binding conflict", {
      reason: error.details?.reactivationRequired ? "reactivation_required" : "active_conflict",
    });
  }
  if (error.code === "CODECLIP_EVENT_NOT_FOUND") {
    return connectionError("PERSISTENCE_FAILED", "episode not found for binding");
  }
  return connectionError("PERSISTENCE_FAILED", "binding persistence failed");
}

function mapUnknownError(error) {
  if (error instanceof CodeClipTikTokOAuthConnectionError) return error;
  return (
    mapStateError(error) ||
    mapClientError(error) ||
    mapCredentialError(error) ||
    mapBindingError(error) ||
    connectionError("PERSISTENCE_FAILED", "connection failed")
  );
}

async function withCallerOwnedTransaction(pool, work) {
  if (!pool || typeof pool.connect !== "function") {
    throw connectionError("DATABASE_UNAVAILABLE", "database pool is unavailable");
  }
  let client = null;
  try {
    client = await pool.connect();
  } catch {
    throw connectionError("DATABASE_UNAVAILABLE", "failed to open database client");
  }
  if (!client || typeof client.query !== "function") {
    throw connectionError("DATABASE_UNAVAILABLE", "database client is invalid");
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

/**
 * Start TikTok OAuth authorization (no TikTok HTTP).
 */
async function startCodeClipTikTokOAuthConnection(
  {
    eventCode,
    environment,
    returnUrl,
    requestedScopes,
    actor,
    disableAutoAuth,
    now,
  } = {},
  { queryClient, env = process.env, getEventByCode } = {}
) {
  if (!queryClient) {
    throw connectionError("DATABASE_UNAVAILABLE", "query client is required");
  }

  const redirectUri = String(env.CODECLIP_TIKTOK_REDIRECT_URI || "").trim();
  const mutationActor = normalizeStartActor(actor);

  try {
    const result = await createCodeClipTikTokOAuthAuthorization(
      {
        eventCode,
        environment,
        redirectUri,
        returnUrl,
        requestedScopes,
        actor: mutationActor,
        disableAutoAuth,
        now,
      },
      { queryClient, env, getEventByCode }
    );
    return {
      ok: true,
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    if (error instanceof CodeClipTikTokOAuthError) {
      if (error.code === "TIKTOK_CONFIG_NOT_AVAILABLE") {
        throw connectionError(
          "TIKTOK_CONFIG_NOT_AVAILABLE",
          "TikTok OAuth is not configured"
        );
      }
      if (error.code === "EVENT_NOT_FOUND" || error.code === "INVALID_EVENT") {
        throw connectionError("INVALID_CALLBACK", "event is invalid", {
          fieldName: "eventCode",
        });
      }
      if (error.code === "INVALID_RETURN_URL") {
        throw connectionError("INVALID_CALLBACK", "returnUrl is invalid", {
          fieldName: "returnUrl",
        });
      }
      if (error.code === "INVALID_ENVIRONMENT") {
        throw connectionError("INVALID_CALLBACK", "environment is invalid", {
          fieldName: "environment",
        });
      }
      if (error.code === "DATABASE_UNAVAILABLE" || error.code === "DATABASE_ERROR") {
        throw connectionError(error.code, "database error");
      }
      throw connectionError("INVALID_CALLBACK", "start request is invalid");
    }
    throw mapUnknownError(error);
  }
}

async function ensureCredentialForTokenResult(
  {
    tokenResult,
    environment,
    actor,
    now,
    env,
  },
  {
    queryClient,
    findCredential = findCodeClipProviderCredential,
    createCredential = createCodeClipProviderCredential,
    updateCredentialTokens = updateCodeClipProviderCredentialTokens,
  }
) {
  const openId = tokenResult.openId;
  const existing = await findCredential(
    {
      provider: PROVIDER,
      providerAccountId: openId,
      environment,
    },
    { queryClient, now }
  );

  const metadata =
    tokenResult.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: tokenResult.refreshTokenExpiresAt }
      : {};

  if (!existing) {
    const created = await createCredential(
      {
        provider: PROVIDER,
        environment,
        providerAccountId: openId,
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        accessTokenExpiresAt: tokenResult.accessTokenExpiresAt,
        tokenType: tokenResult.tokenType,
        scopes: tokenResult.scopes,
        metadata,
      },
      {
        queryClient,
        env,
        now,
        actor,
        reason: "tiktok_oauth_connected",
      }
    );
    return {
      credential: created.credential,
      created: true,
      updated: false,
    };
  }

  if (existing.status === "disabled") {
    throw connectionError("CREDENTIAL_DISABLED", "credential is disabled", {
      status: "disabled",
    });
  }
  if (existing.status === "revoked") {
    throw connectionError("CREDENTIAL_REVOKED", "credential is revoked", {
      status: "revoked",
    });
  }

  const nextMetadata = {
    ...(existing.metadata && typeof existing.metadata === "object"
      ? existing.metadata
      : {}),
    ...metadata,
  };

  const updated = await updateCredentialTokens(
    existing.id,
    {
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      accessTokenExpiresAt: tokenResult.accessTokenExpiresAt,
      tokenType: tokenResult.tokenType,
      scopes: tokenResult.scopes,
      metadata: nextMetadata,
    },
    {
      queryClient,
      env,
      now,
      actor,
      reason: "tiktok_oauth_token_refresh",
    }
  );

  return {
    credential: updated.credential,
    created: false,
    updated: true,
  };
}

async function ensureBindingForConnection(
  {
    eventCode,
    openId,
    createdBy,
    bindingAuditActorType,
    bindingAuditActorId,
  },
  {
    queryClient,
    getEventByCode,
    createBinding = createCodeClipProviderAccountBinding,
    reactivateBinding = reactivateCodeClipProviderAccountBinding,
    appendBindingAudit = appendCodeClipProviderAccountBindingAuditEvent,
  }
) {
  const auditType = bindingAuditActorType || "operator_key";
  const auditId = bindingAuditActorId === undefined ? null : bindingAuditActorId;

  try {
    const result = await createBinding(
      {
        eventCode,
        provider: PROVIDER,
        channel: CHANNEL,
        providerAccountId: openId,
        displayName: null,
        createdBy: createdBy || CALLBACK_SYSTEM_ACTOR_ID,
        metadata: { source: "tiktok_oauth" },
      },
      { queryClient, getEventByCode }
    );

    if (result.created) {
      await appendBindingAudit(
        {
          binding: result.row,
          action: "created",
          actorType: auditType,
          actorId: auditId,
          beforeState: null,
          afterState: cloneJson(toAuditState(result.row)),
          metadata: { source: "tiktok_oauth" },
        },
        { queryClient }
      );
      return {
        binding: result.row,
        created: true,
        reactivated: false,
        alreadyConnected: false,
      };
    }

    return {
      binding: result.row,
      created: false,
      reactivated: false,
      alreadyConnected: true,
    };
  } catch (error) {
    if (!(error instanceof CodeClipProviderAccountBindingError)) throw error;
    if (error.code !== "PROVIDER_ACCOUNT_BINDING_CONFLICT") throw error;

    const details = error.details || {};
    if (
      details.reactivationRequired === true &&
      String(details.eventCode || "") === String(eventCode) &&
      details.bindingId
    ) {
      const reactivated = await reactivateBinding(details.bindingId, {
        queryClient,
      });
      if (!reactivated?.row) {
        throw connectionError("BINDING_CONFLICT", "binding reactivation failed");
      }
      if (reactivated.reactivated) {
        await appendBindingAudit(
          {
            binding: reactivated.row,
            action: "reactivated",
            actorType: auditType,
            actorId: auditId,
            beforeState: null,
            afterState: cloneJson(toAuditState(reactivated.row)),
            metadata: { source: "tiktok_oauth" },
          },
          { queryClient }
        );
      }
      return {
        binding: reactivated.row,
        created: false,
        reactivated: Boolean(reactivated.reactivated),
        alreadyConnected: !reactivated.reactivated,
      };
    }

    throw connectionError("BINDING_CONFLICT", "provider account binding conflict");
  }
}

/**
 * Complete TikTok OAuth callback: claim → exchange → persist atomically.
 */
async function completeCodeClipTikTokOAuthConnection(
  {
    code,
    state,
    error: providerError,
    error_description: _errorDescription,
    scopes: _callbackScopes,
    now,
    requestId,
  } = {},
  options = {}
) {
  const {
    queryClient,
    env = process.env,
    fetchImpl,
    timeoutMs,
    getEventByCode,
    exchangeCode = exchangeCodeClipTikTokAuthorizationCode,
    claimState = claimCodeClipTikTokOAuthState,
    completeState = completeCodeClipTikTokOAuthState,
    findCredential,
    createCredential,
    updateCredentialTokens,
    createBinding,
    reactivateBinding,
    appendBindingAudit,
    runPersistenceTransaction,
  } = options;

  if (!queryClient) {
    throw connectionError("DATABASE_UNAVAILABLE", "query client is required");
  }

  const operationNow = normalizeInjectedNow(now);
  const rawState = typeof state === "string" ? state.trim() : "";
  if (!rawState) {
    throw connectionError("INVALID_CALLBACK", "state is required", {
      fieldName: "state",
    });
  }

  const hasProviderError =
    providerError !== undefined &&
    providerError !== null &&
    String(providerError).trim() !== "";
  const providerErrorSlug = hasProviderError
    ? String(providerError).trim().toLowerCase()
    : "";
  // Never use providerErrorSlug (or description) outside cancel/fail status mapping.
  const cancelStatus =
    providerErrorSlug === "access_denied" ||
    providerErrorSlug === "user_cancelled" ||
    providerErrorSlug === "login_cancelled"
      ? "authorization_cancelled"
      : "authorization_failed";

  const claimOwner = buildClaimOwner(requestId);
  // Cancellation uses max claim lease to burn the state as long as F2A1 allows.
  const claimLeaseMs = hasProviderError ? CANCEL_CLAIM_LEASE_MS : CLAIM_LEASE_MS;

  let claimResult;
  try {
    claimResult = await claimState(
      {
        state: rawState,
        owner: claimOwner,
        leaseMs: claimLeaseMs,
        now: operationNow,
      },
      { queryClient }
    );
  } catch (error) {
    throw mapStateError(error) || mapUnknownError(error);
  }

  if (claimResult?.alreadyCompleted === true || claimResult?.status === "completed") {
    // Completed means a prior successful connection, not cancellation.
    const returnUrl = claimResult.oauthState?.returnUrl;
    return {
      ok: true,
      status: "already_connected",
      redirectUrl: buildSafeRedirect(returnUrl, "already_connected"),
      eventCode: claimResult.oauthState?.eventCode || null,
    };
  }

  if (!claimResult?.ok) {
    // Active claim (e.g. prior cancellation burn or in-flight callback).
    if (claimResult?.reason === "OAUTH_STATE_CONTENTION") {
      const contendedReturnUrl = claimResult.oauthState?.returnUrl;
      const contendedEventCode = claimResult.oauthState?.eventCode || null;
      if (hasProviderError && contendedReturnUrl) {
        // Duplicate cancellation: safe redirect, no exchange, not "connected".
        return {
          ok: false,
          status: cancelStatus,
          redirectUrl: buildSafeRedirect(contendedReturnUrl, cancelStatus),
          eventCode: contendedEventCode,
        };
      }
      if (contendedReturnUrl) {
        // Code (or empty) after an active claim — cannot establish connection.
        return {
          ok: false,
          status: "authorization_failed",
          redirectUrl: buildSafeRedirect(
            contendedReturnUrl,
            "authorization_failed"
          ),
          eventCode: contendedEventCode,
          errorCode: "OAUTH_STATE_CONTENTION",
        };
      }
      throw connectionError(
        "OAUTH_STATE_CONTENTION",
        "OAuth state is already claimed"
      );
    }
    throw connectionError("OAUTH_STATE_STALE", "OAuth state claim failed");
  }

  const oauthState = claimResult.oauthState;
  const claimVersion = claimResult.claimVersion;
  const returnUrl = oauthState.returnUrl;
  const eventCode = oauthState.eventCode;
  const environment = oauthState.environment;
  const redirectUri = oauthState.redirectUri;
  const stateId = oauthState.id;
  const createdBy = oauthState.createdBy;

  // Provider cancellation / error: no token exchange, no credential/binding.
  // State remains claimed for claimLeaseMs (cancel uses max lease) and is not
  // marked completed (would look like connected). F2A2B model: claimed-until-lease.
  if (hasProviderError) {
    return {
      ok: false,
      status: cancelStatus,
      redirectUrl: buildSafeRedirect(returnUrl, cancelStatus),
      eventCode,
    };
  }

  const authorizationCode = typeof code === "string" ? code.trim() : "";
  if (!authorizationCode) {
    return {
      ok: false,
      status: "authorization_failed",
      redirectUrl: buildSafeRedirect(returnUrl, "authorization_failed"),
      eventCode,
    };
  }

  let tokenResult;
  try {
    tokenResult = await exchangeCode(
      {
        code: authorizationCode,
        redirectUri,
        now: operationNow,
      },
      { env, fetchImpl, timeoutMs }
    );
  } catch (error) {
    const mapped = mapClientError(error) || mapUnknownError(error);
    // Exchange failed after claim: redirect safe failure (state stays claimed/expires).
    if (returnUrl) {
      return {
        ok: false,
        status: "authorization_failed",
        redirectUrl: buildSafeRedirect(returnUrl, "authorization_failed"),
        eventCode,
        errorCode: mapped.code,
      };
    }
    throw mapped;
  }

  if (!tokenResult || typeof tokenResult.openId !== "string" || !tokenResult.openId.trim()) {
    return {
      ok: false,
      status: "authorization_failed",
      redirectUrl: buildSafeRedirect(returnUrl, "authorization_failed"),
      eventCode,
      errorCode: "INVALID_TOKEN_RESPONSE",
    };
  }

  const {
    credentialActor,
    bindingAuditActorType,
    bindingAuditActorId,
  } = resolveCallbackMutationActors(createdBy);
  const persist = runPersistenceTransaction
    ? (work) => runPersistenceTransaction(work)
    : (work) => withCallerOwnedTransaction(queryClient, work);

  try {
    const persisted = await persist(async (tx) => {
      const credentialResult = await ensureCredentialForTokenResult(
        {
          tokenResult,
          environment,
          actor: credentialActor,
          now: operationNow,
          env,
        },
        {
          queryClient: tx,
          findCredential,
          createCredential,
          updateCredentialTokens,
        }
      );

      const bindingResult = await ensureBindingForConnection(
        {
          eventCode,
          openId: tokenResult.openId,
          createdBy: createdBy || CALLBACK_SYSTEM_ACTOR_ID,
          bindingAuditActorType,
          bindingAuditActorId,
        },
        {
          queryClient: tx,
          getEventByCode,
          createBinding,
          reactivateBinding,
          appendBindingAudit,
        }
      );

      await completeState(
        {
          stateId,
          owner: claimOwner,
          expectedClaimVersion: claimVersion,
          now: operationNow,
        },
        { queryClient: tx }
      );

      return { credentialResult, bindingResult };
    });

    const already =
      persisted.bindingResult.alreadyConnected &&
      !persisted.bindingResult.created &&
      !persisted.bindingResult.reactivated &&
      !persisted.credentialResult.created;

    const status = already ? "already_connected" : "connected";
    return {
      ok: true,
      status,
      redirectUrl: buildSafeRedirect(returnUrl, status),
      eventCode,
      bindingCreated: Boolean(persisted.bindingResult.created),
      credentialCreated: Boolean(persisted.credentialResult.created),
    };
  } catch (error) {
    const mapped = mapUnknownError(error);
    // Exchange succeeded but persistence failed: tokens stay in memory only.
    if (
      mapped.code === "BINDING_CONFLICT" ||
      mapped.code === "CREDENTIAL_DISABLED" ||
      mapped.code === "CREDENTIAL_REVOKED" ||
      mapped.code === "CREDENTIAL_CONFLICT"
    ) {
      const redirectStatus =
        mapped.code === "BINDING_CONFLICT"
          ? "binding_conflict"
          : mapped.code === "CREDENTIAL_DISABLED" ||
              mapped.code === "CREDENTIAL_REVOKED"
            ? "reauthorization_required"
            : "authorization_failed";
      return {
        ok: false,
        status: redirectStatus,
        redirectUrl: buildSafeRedirect(returnUrl, redirectStatus),
        eventCode,
        errorCode: mapped.code,
      };
    }
    return {
      ok: false,
      status: "authorization_failed",
      redirectUrl: buildSafeRedirect(returnUrl, "authorization_failed"),
      eventCode,
      errorCode: mapped.code,
    };
  }
}

module.exports = {
  CodeClipTikTokOAuthConnectionError,
  startCodeClipTikTokOAuthConnection,
  completeCodeClipTikTokOAuthConnection,
};
