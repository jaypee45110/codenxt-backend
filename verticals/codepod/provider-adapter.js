const {
  normalizeCodePodProviderEnvelope,
} = require("./provider-envelope");

function adaptCodePodProviderKeyword(input = {}) {
  const normalized = normalizeCodePodProviderEnvelope(input);

  if (!normalized.ok) {
    return {
      ok: false,
      reason: normalized.reason,
      envelope: null,
      keywordEntry: null,
    };
  }

  const envelope = normalized.envelope;

  return {
    ok: true,
    provider: normalized.provider,
    envelope,
    keywordEntry: {
      eventCode: envelope.eventCode,
      keyword: envelope.keyword,
      messageId: envelope.messageId,
      provider: envelope.provider,
      providerAccountId: envelope.providerAccountId,
      receivedAt: envelope.receivedAt,
    },
    providerMetadata: {
      senderId: envelope.senderId,
      recipientId: envelope.recipientId,
      channel: envelope.channel,
      metadata: envelope.metadata,
    },
  };
}

module.exports = {
  adaptCodePodProviderKeyword,
};
