const {
  eventMatchesBoundProviderActivation,
} = require("./provider-activation");
const {
  CodeClipProviderAccountBindingError,
  findActiveCodeClipProviderAccountBinding,
} = require("./provider-account-bindings");

function normalizeToken(value) {
  return String(value || "").trim();
}

function buildResolution({
  provider,
  providerAccountId,
  eventCode,
  eventId,
  lookupMethod = "providerAccountBinding",
  matchedBy,
} = {}) {
  const resolution = {
    provider,
    lookupMethod,
  };

  if (providerAccountId) resolution.providerAccountId = providerAccountId;
  if (eventCode) resolution.eventCode = eventCode;
  if (eventId) resolution.eventId = eventId;
  if (matchedBy) resolution.matchedBy = matchedBy;

  return resolution;
}

function isCodeClipEvent(event) {
  return String(event?.vertical || event?.raw_event?.vertical || "").trim().toLowerCase() === "codeclip";
}

async function resolveCodeClipProviderAccountBindingRoute({
  provider,
  providerAccountId,
  channel,
  keyword,
  queryClient,
  getEventByCode,
} = {}) {
  const normalizedProvider = normalizeToken(provider).toLowerCase();
  const normalizedProviderAccountId = normalizeToken(providerAccountId);
  const normalizedKeyword = normalizeToken(keyword);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };
  if (!normalizedKeyword) return { ok: false, reason: "KEYWORD_REQUIRED" };
  if (!normalizedProviderAccountId) return { ok: false, reason: "NO_MATCH" };
  if (typeof getEventByCode !== "function") {
    return { ok: false, reason: "BINDING_EVENT_LOOKUP_UNAVAILABLE" };
  }

  let binding = null;
  try {
    binding = await findActiveCodeClipProviderAccountBinding(
      {
        provider: normalizedProvider,
        providerAccountId: normalizedProviderAccountId,
      },
      { queryClient }
    );
  } catch (error) {
    if (
      error instanceof CodeClipProviderAccountBindingError &&
      error.code === "PROVIDER_ACCOUNT_BINDING_AMBIGUOUS"
    ) {
      return { ok: false, reason: "PROVIDER_ACCOUNT_BINDING_AMBIGUOUS" };
    }
    return { ok: false, reason: "PROVIDER_ACCOUNT_BINDING_UNAVAILABLE" };
  }

  if (!binding) {
    return {
      ok: false,
      reason: "NO_MATCH",
      resolution: buildResolution({
        provider: normalizedProvider,
        providerAccountId: normalizedProviderAccountId,
      }),
    };
  }

  // Product-channel integrity for Meta surfaces: envelope channel must match
  // durable binding channel. Lookup remains provider+providerAccountId unique;
  // this check prevents Instagram traffic from consuming a Messenger binding
  // (and the reverse) before activation, delivery processing, or outbound.
  const PRODUCT_CHANNELS = new Set(["messenger", "instagram", "whatsapp"]);
  const envelopeChannel = normalizeToken(channel).toLowerCase();
  const bindingChannel = normalizeToken(binding.channel).toLowerCase();
  if (
    PRODUCT_CHANNELS.has(envelopeChannel) ||
    PRODUCT_CHANNELS.has(bindingChannel)
  ) {
    if (!envelopeChannel || envelopeChannel !== bindingChannel) {
      return {
        ok: false,
        reason: "PROVIDER_BINDING_CHANNEL_MISMATCH",
        resolution: buildResolution({
          provider: normalizedProvider,
          providerAccountId: normalizedProviderAccountId,
          eventCode: normalizeToken(binding.eventCode),
        }),
      };
    }
  }

  const eventCode = normalizeToken(binding.eventCode);
  let event = null;
  try {
    event = await getEventByCode(eventCode);
  } catch {
    return {
      ok: false,
      reason: "BINDING_EVENT_LOOKUP_UNAVAILABLE",
      resolution: buildResolution({
        provider: normalizedProvider,
        providerAccountId: normalizedProviderAccountId,
        eventCode,
      }),
    };
  }

  if (!event || !isCodeClipEvent(event)) {
    return {
      ok: false,
      reason: "PROVIDER_ACCOUNT_BINDING_EVENT_INVALID",
      resolution: buildResolution({
        provider: normalizedProvider,
        providerAccountId: normalizedProviderAccountId,
        eventCode,
      }),
    };
  }

  const rawEvent = event.raw_event || event;
  if (
    !eventMatchesBoundProviderActivation(rawEvent, {
      provider: normalizedProvider,
      channel,
      keyword: normalizedKeyword,
    })
  ) {
    return {
      ok: false,
      reason: "NO_MATCH",
      resolution: buildResolution({
        provider: normalizedProvider,
        providerAccountId: normalizedProviderAccountId,
        eventCode,
        eventId: rawEvent.id || event.id,
      }),
    };
  }

  return {
    ok: true,
    provider: normalizedProvider,
    eventCode,
    keyword: normalizedKeyword,
    providerAccountId: normalizedProviderAccountId,
    event: rawEvent,
    binding,
    resolution: buildResolution({
      provider: normalizedProvider,
      providerAccountId: normalizedProviderAccountId,
      eventCode,
      eventId: rawEvent.id || event.id,
      matchedBy: "providerAccountBinding",
    }),
  };
}

module.exports = {
  resolveCodeClipProviderAccountBindingRoute,
};
