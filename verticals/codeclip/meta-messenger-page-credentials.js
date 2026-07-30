/**
 * B11.2F1 Meta Messenger Page Credential Wiring
 *
 * Pure, fail-closed configuration parse and credential resolve for Page access tokens.
 * No network, no dispatch, no claim/record, no Redis.
 *
 * B11.2E DI shape:
 *   resolve({ providerAccountId, bindingId?, outboundId? })
 *     → { ok: true, pageAccessToken, graphApiVersion }
 *     → { ok: false, reason, retryable: false }
 *
 * Only optional getBinding may be async (via createMetaMessengerPageCredentialResolver).
 */

const GRAPH_API_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;
const CREDENTIAL_STATUSES = new Set(["active", "disabled"]);
const ENV_CREDENTIALS_JSON = "CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON";

function normalizeString(value) {
  return String(value || "").trim();
}

function credentialError(reason, details = {}) {
  return {
    ok: false,
    reason,
    retryable: false,
    details,
  };
}

function maskProviderAccountId(providerAccountId) {
  const value = normalizeString(providerAccountId);
  if (!value) return "";
  if (value.length <= 2) return "••";
  if (value.length <= 4) return `${"•".repeat(value.length - 1)}${value.slice(-1)}`;
  return `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGraphApiVersion(value) {
  const normalized = normalizeString(value);
  if (!normalized || !GRAPH_API_VERSION_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeCredentialStatus(value) {
  if (value === undefined || value === null || value === "") return "active";
  const normalized = normalizeString(value).toLowerCase();
  if (!CREDENTIAL_STATUSES.has(normalized)) return null;
  return normalized;
}

/**
 * Pure parse of raw JSON credential configuration.
 * Never includes tokens in error details.
 */
function parseMetaMessengerPageCredentialConfig(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "raw" });
  }
  if (typeof rawValue !== "string") {
    return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "raw_type" });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "json" });
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.pages)) {
    return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "pages" });
  }

  const pages = Object.create(null);
  for (const [rawKey, rawEntry] of Object.entries(parsed.pages)) {
    const providerAccountId = normalizeString(rawKey);
    if (!providerAccountId) {
      return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "providerAccountId" });
    }
    if (!isPlainObject(rawEntry)) {
      return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "page_entry" });
    }

    const pageAccessToken =
      typeof rawEntry.pageAccessToken === "string" ? rawEntry.pageAccessToken.trim() : "";
    if (!pageAccessToken) {
      return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "pageAccessToken" });
    }

    const graphApiVersion = normalizeGraphApiVersion(rawEntry.graphApiVersion);
    if (!graphApiVersion) {
      return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "graphApiVersion" });
    }

    const status = normalizeCredentialStatus(rawEntry.status);
    if (!status) {
      return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "status" });
    }

    pages[providerAccountId] = Object.freeze({
      pageAccessToken,
      graphApiVersion,
      status,
    });
  }

  return {
    ok: true,
    config: Object.freeze({
      pages: Object.freeze(pages),
    }),
  };
}

function assertBindingConsistency(binding, providerAccountId, bindingId) {
  if (binding === undefined) {
    // Caller did not supply binding object; only bindingId without binding is invalid when required.
    if (bindingId) {
      return credentialError("CREDENTIAL_BINDING_UNAVAILABLE");
    }
    return { ok: true };
  }
  if (binding === null) {
    return credentialError("CREDENTIAL_BINDING_UNAVAILABLE");
  }
  if (!isPlainObject(binding)) {
    return credentialError("CREDENTIAL_BINDING_UNAVAILABLE");
  }

  const status = normalizeString(binding.status).toLowerCase();
  if (status && status !== "active") {
    return credentialError("CREDENTIAL_BINDING_DISABLED");
  }

  const provider = normalizeString(binding.provider).toLowerCase();
  const channel = normalizeString(binding.channel).toLowerCase();
  if (provider !== "meta" || channel !== "messenger") {
    return credentialError("CREDENTIAL_BINDING_CHANNEL_INVALID", {
      provider: provider || null,
      channel: channel || null,
    });
  }

  const bindingAccountId = normalizeString(binding.providerAccountId);
  if (!bindingAccountId) {
    return credentialError("CREDENTIAL_BINDING_UNAVAILABLE");
  }
  if (providerAccountId && bindingAccountId !== providerAccountId) {
    return credentialError("CREDENTIAL_BINDING_ACCOUNT_MISMATCH");
  }

  return { ok: true, providerAccountId: bindingAccountId };
}

/**
 * Pure resolve against an already-parsed credential config.
 * Optional `binding` is a plain object already loaded by the caller (sync).
 */
function resolveMetaMessengerPageCredentials({
  providerAccountId,
  bindingId,
  credentialConfig,
  binding,
} = {}) {
  if (!credentialConfig || !isPlainObject(credentialConfig.pages)) {
    return credentialError("CREDENTIAL_CONFIG_INVALID", { field: "credentialConfig" });
  }

  const normalizedBindingId = normalizeString(bindingId);
  let pageId = normalizeString(providerAccountId);

  if (normalizedBindingId || binding !== undefined) {
    if (normalizedBindingId && binding === undefined) {
      return credentialError("CREDENTIAL_BINDING_UNAVAILABLE");
    }
    const bindingCheck = assertBindingConsistency(binding, pageId, normalizedBindingId);
    if (!bindingCheck.ok) return bindingCheck;
    if (bindingCheck.providerAccountId) {
      pageId = bindingCheck.providerAccountId;
    }
  }

  if (!pageId) {
    return credentialError("CREDENTIAL_PROVIDER_ACCOUNT_REQUIRED");
  }

  const entry = credentialConfig.pages[pageId];
  if (!entry) {
    return credentialError("CREDENTIALS_UNAVAILABLE");
  }
  if (entry.status === "disabled") {
    return credentialError("CREDENTIAL_DISABLED");
  }

  const token = typeof entry.pageAccessToken === "string" ? entry.pageAccessToken.trim() : "";
  if (!token) {
    return credentialError("CREDENTIAL_INVALID");
  }
  const graphApiVersion = normalizeGraphApiVersion(entry.graphApiVersion);
  if (!graphApiVersion) {
    return credentialError("CREDENTIAL_GRAPH_VERSION_INVALID");
  }

  return {
    ok: true,
    pageAccessToken: token,
    graphApiVersion,
  };
}

function toPublicMetaMessengerPageCredentialView({
  providerAccountId,
  resolution,
} = {}) {
  const masked = maskProviderAccountId(providerAccountId);
  if (!resolution || resolution.ok !== true) {
    return {
      ok: false,
      reason: resolution?.reason || "CREDENTIALS_UNAVAILABLE",
      retryable: false,
      hasToken: false,
      providerAccountIdMasked: masked || null,
      graphApiVersion: null,
      status: null,
    };
  }
  return {
    ok: true,
    hasToken: Boolean(resolution.pageAccessToken),
    providerAccountIdMasked: masked || null,
    graphApiVersion: resolution.graphApiVersion || null,
    status: "active",
  };
}

/**
 * Builds a resolver closed over a frozen credential config.
 * getBinding may be sync or async; parse/map lookup remains pure and sync.
 */
function createMetaMessengerPageCredentialResolver({
  credentialConfig,
  getBinding = null,
} = {}) {
  if (!credentialConfig || !isPlainObject(credentialConfig.pages)) {
    throw new Error("credentialConfig is required");
  }

  function resolveSync(input = {}) {
    return resolveMetaMessengerPageCredentials({
      providerAccountId: input.providerAccountId,
      bindingId: input.bindingId,
      credentialConfig,
      binding: input.binding,
    });
  }

  if (typeof getBinding !== "function") {
    return resolveSync;
  }

  return function resolveWithOptionalBinding(input = {}) {
    const bindingId = normalizeString(input.bindingId);
    if (!bindingId) {
      return resolveSync(input);
    }

    const bindingOrPromise = getBinding(bindingId, input);
    if (bindingOrPromise && typeof bindingOrPromise.then === "function") {
      return bindingOrPromise.then((binding) =>
        resolveMetaMessengerPageCredentials({
          providerAccountId: input.providerAccountId,
          bindingId,
          credentialConfig,
          binding,
        })
      );
    }

    return resolveMetaMessengerPageCredentials({
      providerAccountId: input.providerAccountId,
      bindingId,
      credentialConfig,
      binding: bindingOrPromise,
    });
  };
}

/**
 * Parse env once. On invalid config returns a permanent fail object (not a function).
 * On success returns a sync resolver function (or async if getBinding is async).
 */
function createMetaMessengerPageCredentialResolverFromEnv(
  env = process.env,
  { getBinding = null, envName = ENV_CREDENTIALS_JSON } = {}
) {
  const raw = env?.[envName];
  const parsed = parseMetaMessengerPageCredentialConfig(
    raw === undefined || raw === null ? "" : String(raw)
  );
  if (!parsed.ok) {
    return parsed;
  }
  return createMetaMessengerPageCredentialResolver({
    credentialConfig: parsed.config,
    getBinding,
  });
}

module.exports = {
  ENV_CREDENTIALS_JSON,
  createMetaMessengerPageCredentialResolver,
  createMetaMessengerPageCredentialResolverFromEnv,
  maskMetaMessengerPageCredentialAccountId: maskProviderAccountId,
  parseMetaMessengerPageCredentialConfig,
  resolveMetaMessengerPageCredentials,
  toPublicMetaMessengerPageCredentialView,
};
