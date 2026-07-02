function normalizeTestProviderKeyword(input = {}) {
  const eventCode = String(input.eventCode || "").trim();
  const keyword = String(input.text || "").trim();
  const messageId = String(input.messageId || input.providerEventId || "").trim();
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
  const messageId = String(input.messageId || input.MessageSid || input.providerEventId || "").trim();
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

const KEYWORD_PROVIDER_ADAPTERS = {
  sms: normalizeSmsKeywordProvider,
  test: normalizeTestProviderKeyword,
};

function emptyProviderKeywordResult(errors = []) {
  return {
    ok: false,
    eventCode: "",
    keyword: "",
    messageId: "",
    warnings: [],
    errors,
  };
}

function normalizeProviderKeywordIngress(provider, input = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();

  if (!normalizedProvider) {
    return emptyProviderKeywordResult([{ code: "PROVIDER_REQUIRED" }]);
  }

  const adapter = KEYWORD_PROVIDER_ADAPTERS[normalizedProvider];
  if (!adapter) {
    return emptyProviderKeywordResult([{ code: "PROVIDER_ADAPTER_NOT_FOUND" }]);
  }

  return adapter(input);
}

module.exports = {
  normalizeProviderKeywordIngress,
  normalizeSmsKeywordProvider,
  normalizeTestProviderKeyword,
};
