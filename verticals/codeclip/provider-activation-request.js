const {
  resolveCodeClipProviderActivationEvent,
} = require("./provider-activation");
const {
  resolveCodeClipProviderAccount,
} = require("./provider-account-resolver");

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeErrorCodes(result = {}) {
  return Array.isArray(result.errors)
    ? result.errors.map((error) => error.code).filter(Boolean)
    : [];
}

function findCodeClipEventByCode(events, eventCode) {
  return Object.values(events || {}).find(
    (item) =>
      item?.code === eventCode &&
      String(item?.vertical || "").trim().toLowerCase() === "codeclip"
  ) || null;
}

function buildInvalidProviderRequest(reason = "INVALID_PROVIDER_KEYWORD_PAYLOAD") {
  return {
    ok: false,
    reason,
  };
}

function buildCodeClipProviderActivationRequest({
  provider,
  normalizedProviderInput,
  body,
  headers,
  metadata,
  events,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const providerAccount = resolveCodeClipProviderAccount({
    provider: normalizedProvider,
    body,
    headers,
    metadata,
  });
  const providerAccountId = providerAccount.ok ? providerAccount.providerAccountId : undefined;
  const errorCodes = normalizeErrorCodes(normalizedProviderInput);
  const canUseActivationLookup =
    !normalizedProviderInput?.ok &&
    errorCodes.length === 1 &&
    errorCodes[0] === "EVENT_CODE_REQUIRED" &&
    normalizedProviderInput.keyword &&
    normalizedProviderInput.messageId;

  if (!normalizedProviderInput?.ok && !canUseActivationLookup) {
    const firstError = errorCodes[0];
    if (firstError === "PROVIDER_REQUIRED") return buildInvalidProviderRequest("PROVIDER_REQUIRED");
    if (firstError === "KEYWORD_REQUIRED") return buildInvalidProviderRequest("KEYWORD_REQUIRED");
    return buildInvalidProviderRequest();
  }

  const keyword = normalizedProviderInput.keyword;
  const messageId = normalizedProviderInput.messageId;
  let eventCode = normalizedProviderInput.eventCode;
  let event = null;

  if (eventCode) {
    event = findCodeClipEventByCode(events, eventCode);
  } else {
    const activationLookup = resolveCodeClipProviderActivationEvent({
      provider: normalizedProvider,
      keyword,
      providerAccountId,
      events,
    });

    if (!activationLookup.ok) {
      return buildInvalidProviderRequest(activationLookup.reason);
    }

    event = activationLookup.event;
    eventCode = String(event?.code || "").trim();
  }

  return {
    ok: true,
    provider: normalizedProvider,
    eventCode,
    keyword,
    messageId,
    providerAccountId,
    event,
    idempotency: {
      provider: normalizedProvider,
      eventCode,
      messageId,
    },
  };
}

module.exports = {
  buildCodeClipProviderActivationRequest,
};
