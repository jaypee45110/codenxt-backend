function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountId(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function firstAccountId(values = []) {
  for (const value of values) {
    const normalized = normalizeAccountId(value);
    if (normalized) return normalized;
  }
  return "";
}

function headerValue(headers = {}, name) {
  const normalizedName = normalizeProvider(name);

  for (const [key, value] of Object.entries(headers || {})) {
    if (normalizeProvider(key) === normalizedName) return value;
  }

  return "";
}

function resolveGenericProviderAccount({ body = {}, metadata = {} } = {}) {
  return firstAccountId([
    body.providerAccountId,
    body.providerAccount,
    metadata.providerAccountId,
    metadata.providerAccount,
  ]);
}

function resolveSmsProviderAccount({ body = {}, headers = {}, metadata = {} } = {}) {
  return firstAccountId([
    resolveGenericProviderAccount({ body, metadata }),
    body.to,
    body.To,
    body.messagingServiceSid,
    body.MessagingServiceSid,
    headerValue(headers, "x-provider-account-id"),
  ]);
}

function resolveMetaProviderAccount({ body = {}, headers = {}, metadata = {} } = {}) {
  return firstAccountId([
    resolveGenericProviderAccount({ body, metadata }),
    body.recipient?.id,
    body.entry?.[0]?.id,
    body.entry?.[0]?.messaging?.[0]?.recipient?.id,
    body.objectId,
    headerValue(headers, "x-provider-account-id"),
  ]);
}

function resolveTestProviderAccount({ body = {}, metadata = {} } = {}) {
  return resolveGenericProviderAccount({ body, metadata }) || "test";
}

function resolveCodeClipProviderAccount({
  provider,
  body = {},
  headers = {},
  metadata = {},
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };

  const providerAccountId = (() => {
    if (normalizedProvider === "sms") {
      return resolveSmsProviderAccount({ body, headers, metadata });
    }
    if (normalizedProvider === "meta") {
      return resolveMetaProviderAccount({ body, headers, metadata });
    }
    if (normalizedProvider === "test") {
      return resolveTestProviderAccount({ body, metadata });
    }
    return resolveGenericProviderAccount({ body, metadata });
  })();

  if (!providerAccountId) return { ok: false, reason: "NO_PROVIDER_ACCOUNT" };

  return {
    ok: true,
    provider: normalizedProvider,
    providerAccountId,
  };
}

module.exports = {
  resolveCodeClipProviderAccount,
};
