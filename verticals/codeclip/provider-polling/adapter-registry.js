/**
 * codeClip provider poll adapter registry (F1D2A).
 *
 * Instance-based only — no module-level mutable singleton.
 * Providers must be registry-registered with capabilities.polling === true.
 * No auto-scan, no provider HTTP, no YouTube/TikTok hardcoding.
 */

const {
  getCodeClipProviderDefinition,
  normalizeCodeClipProviderName,
} = require("../provider-registry");

class CodeClipProviderPollAdapterRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipProviderPollAdapterRegistryError";
    this.code = code;
    this.details =
      details && typeof details === "object" ? { ...details } : {};
  }
}

function registryError(code, message, details = {}) {
  const safe = {};
  if (details && typeof details === "object") {
    for (const key of ["fieldName", "reason", "provider"]) {
      if (details[key] !== undefined && details[key] !== null) {
        safe[key] = String(details[key]).slice(0, 80);
      }
    }
  }
  return new CodeClipProviderPollAdapterRegistryError(code, message, safe);
}

function freezeAdapterDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw registryError(
      "INVALID_ADAPTER",
      "adapter descriptor must be an object",
      { fieldName: "adapter" }
    );
  }

  const keys = Object.keys(descriptor);
  for (const key of keys) {
    if (key !== "provider" && key !== "poll") {
      throw registryError(
        "INVALID_ADAPTER",
        "adapter descriptor contains unsupported field",
        { fieldName: key, reason: "UNKNOWN_FIELD" }
      );
    }
  }

  const normalizedProvider = normalizeCodeClipProviderName(descriptor.provider);
  if (!normalizedProvider) {
    throw registryError("INVALID_ADAPTER", "adapter provider is required", {
      fieldName: "provider",
    });
  }

  const definition = getCodeClipProviderDefinition(normalizedProvider);
  if (!definition) {
    throw registryError(
      "INVALID_ADAPTER",
      "adapter provider is not registered",
      { fieldName: "provider", reason: "INVALID_PROVIDER", provider: normalizedProvider }
    );
  }
  if (definition.capabilities.polling !== true) {
    throw registryError(
      "POLLING_NOT_SUPPORTED",
      "adapter provider does not support polling",
      { fieldName: "provider", reason: "POLLING_FALSE", provider: definition.name }
    );
  }

  if (typeof descriptor.poll !== "function") {
    throw registryError(
      "INVALID_ADAPTER",
      "adapter.poll must be a function",
      { fieldName: "poll" }
    );
  }

  return Object.freeze({
    provider: definition.name,
    poll: descriptor.poll,
  });
}

/**
 * Create an isolated poll adapter registry instance.
 */
function createCodeClipProviderPollAdapterRegistry() {
  /** @type {Map<string, { provider: string, poll: Function }>} */
  const adapters = new Map();

  function register(adapter) {
    const frozen = freezeAdapterDescriptor(adapter);
    if (adapters.has(frozen.provider)) {
      throw registryError(
        "ADAPTER_ALREADY_REGISTERED",
        "adapter is already registered for provider",
        { fieldName: "provider", provider: frozen.provider }
      );
    }
    adapters.set(frozen.provider, frozen);
    return frozen;
  }

  function get(provider) {
    const normalized = normalizeCodeClipProviderName(provider);
    if (!normalized) {
      throw registryError(
        "ADAPTER_NOT_FOUND",
        "adapter provider is required",
        { fieldName: "provider" }
      );
    }
    const definition = getCodeClipProviderDefinition(normalized);
    if (!definition || definition.capabilities.polling !== true) {
      throw registryError(
        "ADAPTER_NOT_FOUND",
        "no poll adapter registered for provider",
        { fieldName: "provider", provider: normalized || "" }
      );
    }
    const found = adapters.get(definition.name);
    if (!found) {
      throw registryError(
        "ADAPTER_NOT_FOUND",
        "no poll adapter registered for provider",
        { fieldName: "provider", provider: definition.name }
      );
    }
    return found;
  }

  function list() {
    return Array.from(adapters.values()).map((entry) =>
      Object.freeze({
        provider: entry.provider,
        poll: entry.poll,
      })
    );
  }

  return Object.freeze({
    register,
    get,
    list,
  });
}

module.exports = {
  CodeClipProviderPollAdapterRegistryError,
  createCodeClipProviderPollAdapterRegistry,
};
