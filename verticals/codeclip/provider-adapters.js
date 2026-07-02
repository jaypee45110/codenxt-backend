function normalizeTestProviderKeyword(input = {}) {
  const eventCode = String(input.eventCode || "").trim();
  const keyword = String(input.text || "").trim();
  const messageId = String(input.messageId || "").trim();
  const errors = [];

  if (!eventCode) errors.push({ code: "EVENT_CODE_REQUIRED" });
  if (!keyword) errors.push({ code: "KEYWORD_REQUIRED" });
  if (!messageId) errors.push({ code: "MESSAGE_ID_REQUIRED" });

  if (errors.length) {
    return {
      ok: false,
      eventCode,
      keyword,
      messageId,
      warnings: [],
      errors,
    };
  }

  return {
    ok: true,
    eventCode,
    keyword,
    messageId,
    warnings: [],
    errors: [],
  };
}

function normalizeSmsKeywordProvider(input = {}) {
  const eventCode = String(input.eventCode || "").trim();
  const keyword = String(input.Body || input.body || input.text || "").trim();
  const messageId = String(input.MessageSid || input.messageId || "").trim();
  const errors = [];

  if (!eventCode) errors.push({ code: "EVENT_CODE_REQUIRED" });
  if (!keyword) errors.push({ code: "KEYWORD_REQUIRED" });
  if (!messageId) errors.push({ code: "MESSAGE_ID_REQUIRED" });

  if (errors.length) {
    return {
      ok: false,
      eventCode,
      keyword,
      messageId,
      warnings: [],
      errors,
    };
  }

  return {
    ok: true,
    eventCode,
    keyword,
    messageId,
    warnings: [],
    errors: [],
  };
}

module.exports = {
  normalizeSmsKeywordProvider,
  normalizeTestProviderKeyword,
};
