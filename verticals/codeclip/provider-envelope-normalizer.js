const {
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./provider-registry");

function normalizeValue(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function firstValue(values = []) {
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (normalized) return normalized;
  }
  return "";
}

function buildEnvelope({
  provider,
  rawProvider,
  body,
  headers,
  query,
  metadata,
  receivedAt,
  messageId,
  text,
  providerAccountId,
  senderId,
  recipientId,
  channel,
}) {
  return {
    ok: true,
    provider,
    envelope: {
      provider,
      rawProvider,
      rawBody: body || {},
      rawHeaders: headers || {},
      rawQuery: query || {},
      receivedAt: receivedAt || new Date().toISOString(),
      messageId,
      text,
      providerAccountId,
      senderId,
      recipientId,
      channel,
      metadata: metadata || {},
    },
  };
}

function normalizeTestEnvelope(input) {
  const { provider, rawProvider, body = {}, headers, query, metadata, receivedAt } = input;
  const messageId = firstValue([body.providerEventId, body.messageId]);
  const text = firstValue([body.text, body.keyword]);
  const providerAccountId = firstValue([body.providerAccountId]) || "test";
  const senderId = firstValue([body.senderId]);
  const recipientId = firstValue([body.recipientId]);
  const channel = firstValue([body.channel]);

  if (!messageId) return { ok: false, reason: "MESSAGE_ID_REQUIRED" };
  if (!text) return { ok: false, reason: "TEXT_REQUIRED" };

  return buildEnvelope({
    provider,
    rawProvider,
    body,
    headers,
    query,
    metadata,
    receivedAt,
    messageId,
    text,
    providerAccountId,
    senderId,
    recipientId,
    channel,
  });
}

function normalizeSmsEnvelope(input) {
  const { provider, rawProvider, body = {}, headers, query, metadata, receivedAt } = input;
  const messageId = firstValue([
    body.MessageSid,
    body.messageSid,
    body.messageId,
    body.providerEventId,
  ]);
  const text = firstValue([body.Body, body.body, body.text, body.keyword]);
  const providerAccountId = firstValue([
    body.To,
    body.to,
    body.MessagingServiceSid,
    body.messagingServiceSid,
  ]);
  const senderId = firstValue([body.From, body.from]);

  if (!messageId) return { ok: false, reason: "MESSAGE_ID_REQUIRED" };
  if (!text) return { ok: false, reason: "TEXT_REQUIRED" };

  return buildEnvelope({
    provider,
    rawProvider,
    body,
    headers,
    query,
    metadata,
    receivedAt,
    messageId,
    text,
    providerAccountId,
    senderId,
    recipientId: providerAccountId,
    channel: "sms",
  });
}

/**
 * Resolve Meta product channel from webhook body shape.
 * Shared Meta provider route (/codeclip/provider/meta/keyword) carries:
 *   messenger | instagram | whatsapp
 *
 * Returns:
 *   { ok: true, channel }
 *   { ok: false, reason }
 *
 * Fail closed for explicit unknown object values. Missing object is only
 * classified when the payload shape uniquely identifies a product.
 */
function resolveMetaProviderChannel(body = {}) {
  const objectName = normalizeValue(body.object).toLowerCase();
  const whatsappValue = body.entry?.[0]?.changes?.[0]?.value;
  const isWhatsAppMessageEnvelope =
    objectName === "whatsapp_business_account" ||
    String(whatsappValue?.messaging_product || "")
      .trim()
      .toLowerCase() === "whatsapp";

  if (isWhatsAppMessageEnvelope) {
    return { ok: true, channel: "whatsapp" };
  }
  if (objectName === "instagram") {
    return { ok: true, channel: "instagram" };
  }
  if (objectName === "page") {
    return { ok: true, channel: "messenger" };
  }

  // Explicit non-empty object that is not a known Meta product surface.
  if (objectName) {
    return { ok: false, reason: "UNSUPPORTED_META_OBJECT" };
  }

  // Missing/empty object: only accept unambiguous Messenger messaging shape.
  if (Array.isArray(body.entry?.[0]?.messaging)) {
    return { ok: true, channel: "messenger" };
  }

  // Ambiguous or empty Meta body without product identity.
  return { ok: false, reason: "UNSUPPORTED_META_OBJECT" };
}

/**
 * Resolve provider account id for Messenger/Instagram messaging payloads.
 * Fail closed when entry.id and messaging.recipient.id both exist and differ.
 * One missing source is allowed; equal values are valid.
 * Does not use sender.id (PSID/IGSID).
 */
function resolveMessagingProviderAccountId(body = {}, messaging = null) {
  const entryId = normalizeValue(body.entry?.[0]?.id);
  const messagingRecipientId = normalizeValue(messaging?.recipient?.id);
  const topLevelRecipientId = normalizeValue(body.recipient?.id);

  if (entryId && messagingRecipientId && entryId !== messagingRecipientId) {
    return { ok: false, reason: "PROVIDER_ACCOUNT_ID_CONFLICT" };
  }

  // Prefer entry.id, then messaging.recipient.id, then simplified top-level recipient.
  const providerAccountId = entryId || messagingRecipientId || topLevelRecipientId;
  return { ok: true, providerAccountId };
}

/**
 * Count processable messaging items across all entry[] arrays.
 * B13 policy (Alternative B): Messenger/Instagram keyword ingress does not
 * silently process only the first event when multiple messaging items exist.
 */
function countMetaMessagingEvents(body = {}) {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  let count = 0;
  for (const entry of entries) {
    if (Array.isArray(entry?.messaging)) {
      count += entry.messaging.length;
    }
  }
  return count;
}

/**
 * True when message.attachments has at least one object-like attachment
 * with a type and/or payload. Empty arrays and non-objects do not qualify.
 */
function hasValidMetaMessageAttachment(message = null) {
  if (!message || typeof message !== "object") return false;
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    return false;
  }
  return message.attachments.some(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (normalizeValue(item.type) ||
        (item.payload && typeof item.payload === "object"))
  );
}

/**
 * Classify non-keyword Messenger/Instagram messaging events.
 * Returns a reason when the event must not enter keyword activation.
 */
function classifyMetaMessagingEventType(messaging = null) {
  if (!messaging || typeof messaging !== "object") return null;

  if (messaging.message && messaging.message.is_echo === true) {
    return "MESSAGE_IS_ECHO";
  }
  if (messaging.delivery || messaging.read) {
    return "NON_KEYWORD_EVENT";
  }
  if (messaging.postback || messaging.referral || messaging.reaction) {
    return "NON_KEYWORD_EVENT";
  }
  if (messaging.message && messaging.message.is_deleted === true) {
    return "NON_KEYWORD_EVENT";
  }
  return null;
}

function normalizeMetaEnvelope(input) {
  const { provider, rawProvider, body = {}, headers, query, metadata, receivedAt } = input;
  const whatsappValue = body.entry?.[0]?.changes?.[0]?.value;
  const channelResult = resolveMetaProviderChannel(body);
  if (!channelResult.ok) {
    return { ok: false, reason: channelResult.reason || "UNSUPPORTED_META_OBJECT" };
  }
  const channel = channelResult.channel;
  const isWhatsAppMessageEnvelope = channel === "whatsapp";
  const isInstagramEnvelope = channel === "instagram";
  const isMessengerEnvelope = channel === "messenger";

  // Alternative B multi-event policy for Messenger/Instagram keyword ingress.
  if (isMessengerEnvelope || isInstagramEnvelope) {
    const messagingEventCount = countMetaMessagingEvents(body);
    if (messagingEventCount > 1) {
      return { ok: false, reason: "MULTI_EVENT_UNSUPPORTED" };
    }
  }

  const messaging = body.entry?.[0]?.messaging?.[0] || null;

  if (isMessengerEnvelope || isInstagramEnvelope) {
    const nonKeywordReason = classifyMetaMessagingEventType(messaging);
    if (nonKeywordReason) {
      return { ok: false, reason: nonKeywordReason };
    }
  }

  const messageId = firstValue([
    body.messageId,
    body.providerEventId,
    messaging?.message?.mid,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id,
  ]);
  // Instagram Messaging uses the same messaging[].message.text shape as Messenger.
  // Some IG edge payloads use message.text as an object — only accept string-like text.
  const messagingText = messaging?.message?.text;
  const text = firstValue([
    body.text,
    body.keyword,
    typeof messagingText === "string" || typeof messagingText === "number"
      ? messagingText
      : messagingText?.body,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body,
  ]);

  let providerAccountId = "";
  if (isWhatsAppMessageEnvelope) {
    providerAccountId = firstValue([whatsappValue?.metadata?.phone_number_id]);
  } else if (isMessengerEnvelope || isInstagramEnvelope) {
    const accountResult = resolveMessagingProviderAccountId(body, messaging);
    if (!accountResult.ok) {
      return { ok: false, reason: accountResult.reason || "PROVIDER_ACCOUNT_ID_CONFLICT" };
    }
    providerAccountId = accountResult.providerAccountId || "";
  }

  const senderId = firstValue([
    body.sender?.id,
    messaging?.sender?.id,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from,
  ]);

  if (!messageId) return { ok: false, reason: "MESSAGE_ID_REQUIRED" };
  // Legitimate non-keyword media: valid attachment(s) without text → ignore
  // (retry-safe). Empty attachments[] or invalid shapes fall through to
  // TEXT_REQUIRED / malformed handling and must not be treated as success.
  if (
    (isMessengerEnvelope || isInstagramEnvelope) &&
    !text &&
    hasValidMetaMessageAttachment(messaging?.message)
  ) {
    return { ok: false, reason: "NON_KEYWORD_EVENT" };
  }
  if (!text) return { ok: false, reason: "TEXT_REQUIRED" };
  if (isWhatsAppMessageEnvelope && !providerAccountId) {
    return { ok: false, reason: "PROVIDER_ACCOUNT_ID_REQUIRED" };
  }
  // Instagram requires a page/IG account identity for binding resolution.
  if (isInstagramEnvelope && !providerAccountId) {
    return { ok: false, reason: "PROVIDER_ACCOUNT_ID_REQUIRED" };
  }

  return buildEnvelope({
    provider,
    rawProvider,
    body,
    headers,
    query,
    metadata,
    receivedAt,
    messageId,
    text,
    providerAccountId,
    senderId,
    recipientId: providerAccountId,
    channel,
  });
}

function normalizeCodeClipProviderEnvelope({
  provider,
  body = {},
  headers = {},
  query = {},
  metadata = {},
  receivedAt,
} = {}) {
  const rawProvider = provider;
  const normalizedProvider = normalizeCodeClipProviderName(provider);

  if (!normalizedProvider) return { ok: false, reason: "PROVIDER_REQUIRED" };
  if (!isCodeClipProviderRegistered(normalizedProvider)) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER" };
  }

  const input = {
    provider: normalizedProvider,
    rawProvider,
    body,
    headers,
    query,
    metadata,
    receivedAt,
  };

  if (normalizedProvider === "test") return normalizeTestEnvelope(input);
  if (normalizedProvider === "sms") return normalizeSmsEnvelope(input);
  return normalizeMetaEnvelope(input);
}

module.exports = {
  normalizeCodeClipProviderEnvelope,
  resolveMetaProviderChannel,
  resolveMessagingProviderAccountId,
  countMetaMessagingEvents,
  classifyMetaMessagingEventType,
  hasValidMetaMessageAttachment,
};
