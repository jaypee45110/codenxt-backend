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

function normalizeMetaEnvelope(input) {
  const { provider, rawProvider, body = {}, headers, query, metadata, receivedAt } = input;
  const messageId = firstValue([
    body.messageId,
    body.providerEventId,
    body.entry?.[0]?.messaging?.[0]?.message?.mid,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id,
  ]);
  const text = firstValue([
    body.text,
    body.keyword,
    body.entry?.[0]?.messaging?.[0]?.message?.text,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body,
  ]);
  const providerAccountId = firstValue([
    body.recipient?.id,
    body.entry?.[0]?.id,
    body.entry?.[0]?.messaging?.[0]?.recipient?.id,
  ]);
  const senderId = firstValue([
    body.sender?.id,
    body.entry?.[0]?.messaging?.[0]?.sender?.id,
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from,
  ]);

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
    channel: "meta",
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
};
