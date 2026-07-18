const PROVIDER_CHANNEL_ALIASES = {
  meta: ["meta", "facebook", "instagram", "messenger", "whatsapp"],
  sms: ["sms"],
  test: ["test"],
  youtube: ["youtube"],
};

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function readActivationValue(event, key) {
  for (const value of [event?.[key], event?.metadata?.[key], event?.config?.[key]]) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function normalizeActivationChannels(value) {
  if (value === undefined || value === null) return null;

  if (Array.isArray(value)) {
    return value.map(normalizeToken).filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeToken).filter(Boolean);
      }
    } catch {
      // Fall through to comma-separated normalization.
    }

    return trimmed.split(",").map(normalizeToken).filter(Boolean);
  }

  return [];
}

function providerChannelTokens(provider) {
  const normalizedProvider = normalizeToken(provider);
  return new Set(PROVIDER_CHANNEL_ALIASES[normalizedProvider] || [normalizedProvider]);
}

function providerMatchesActivationChannels(provider, event) {
  const channels = normalizeActivationChannels(readActivationValue(event, "activationChannels"));
  if (channels === null) return true;
  if (!channels.length) return false;

  const providerTokens = providerChannelTokens(provider);
  return channels.some((channel) => providerTokens.has(channel));
}

function normalizeProviderAccountIds(value) {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return value.map(normalizeToken).filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(normalizeProviderAccountIds);
  }

  return [normalizeToken(value)].filter(Boolean);
}

function eventProviderAccountIds(event, provider) {
  const normalizedProvider = normalizeToken(provider);
  const containers = [event, event?.metadata, event?.config].filter(Boolean);
  const ids = [];

  for (const container of containers) {
    ids.push(...normalizeProviderAccountIds(container.providerAccountId));
    ids.push(...normalizeProviderAccountIds(container.providerAccountIds));
    if (container.providerAccounts && typeof container.providerAccounts === "object") {
      ids.push(...normalizeProviderAccountIds(container.providerAccounts[normalizedProvider]));
    }
  }

  return [...new Set(ids)];
}

function providerAccountMatches(event, provider, providerAccountId) {
  const eventAccountIds = eventProviderAccountIds(event, provider);
  if (!eventAccountIds.length) return true;

  const normalizedProviderAccountId = normalizeToken(providerAccountId);
  if (!normalizedProviderAccountId) return false;

  return eventAccountIds.includes(normalizedProviderAccountId);
}

function eventMatchesProviderActivation(event, { provider, keyword, providerAccountId }) {
  if (normalizeToken(event?.vertical) !== "codeclip") return false;
  if (!providerMatchesActivationChannels(provider, event)) return false;
  if (!providerAccountMatches(event, provider, providerAccountId)) return false;

  const eventKeyword = normalizeToken(readActivationValue(event, "activationKeyword"));
  return !!eventKeyword && eventKeyword === normalizeToken(keyword);
}

function eventMatchesBoundProviderActivation(event, { provider, channel, keyword } = {}) {
  if (normalizeToken(event?.vertical) !== "codeclip") return false;

  const status = normalizeToken(event?.status || event?.metadata?.status || event?.config?.status);
  if (status && status !== "active") return false;

  const activationMethod = normalizeToken(readActivationValue(event, "activationMethod"));
  if (activationMethod && !["keyword", "both"].includes(activationMethod)) return false;

  if (!providerMatchesActivationChannels(channel || provider, event)) return false;

  const eventKeyword = normalizeToken(readActivationValue(event, "activationKeyword"));
  return !!eventKeyword && eventKeyword === normalizeToken(keyword);
}

function eventMatchesBoundProviderEventActivation(event, {
  provider,
  channel,
  activationEvent,
} = {}) {
  if (normalizeToken(event?.vertical) !== "codeclip") return false;

  const status = normalizeToken(event?.status || event?.metadata?.status || event?.config?.status);
  if (status && status !== "active") return false;

  const activationMethod = normalizeToken(readActivationValue(event, "activationMethod"));
  if (activationMethod && !["provider", "both"].includes(activationMethod)) return false;

  if (!providerMatchesActivationChannels(channel || provider, event)) return false;

  const eventActivation = normalizeToken(readActivationValue(event, "activationEvent"));
  return !!eventActivation && eventActivation === normalizeToken(activationEvent);
}

function resolveCodeClipProviderActivationEvent({
  provider,
  keyword,
  providerAccountId,
  events,
} = {}) {
  const normalizedProvider = normalizeToken(provider);
  const normalizedKeyword = normalizeToken(keyword);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };
  if (!normalizedKeyword) return { ok: false, reason: "KEYWORD_REQUIRED" };

  const eventList = Array.isArray(events) ? events : Object.values(events || {});
  const matches = eventList.filter((event) =>
    eventMatchesProviderActivation(event, {
      provider: normalizedProvider,
      keyword: normalizedKeyword,
      providerAccountId,
    })
  );

  if (!matches.length) return { ok: false, reason: "NO_MATCH" };
  if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS_MATCH" };

  return {
    ok: true,
    event: matches[0],
  };
}

module.exports = {
  eventMatchesBoundProviderActivation,
  eventMatchesBoundProviderEventActivation,
  normalizeActivationChannels,
  readActivationValue,
  resolveCodeClipProviderActivationEvent,
};
