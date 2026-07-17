const CODECLIP_PROVIDER_NAMES = ["meta", "sms", "test", "youtube"];

function normalizeCodeClipProviderName(provider) {
  return String(provider || "").trim().toLowerCase();
}

function getCodeClipRegisteredProviders() {
  return [...CODECLIP_PROVIDER_NAMES];
}

function isCodeClipProviderRegistered(provider) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);
  return CODECLIP_PROVIDER_NAMES.includes(normalizedProvider);
}

module.exports = {
  getCodeClipRegisteredProviders,
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
};
