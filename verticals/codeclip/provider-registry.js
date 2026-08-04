/**
 * codeClip provider registry — authoritative definitions for registered providers.
 * providerClass and provider capabilities (webhook/polling/credentials) are declared
 * explicitly per provider. No name-based defaults; fail closed on invalid metadata.
 */

const CODECLIP_PROVIDER_CLASSES = Object.freeze(["push", "push_poll", "poll_only"]);

const CODECLIP_PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "webhook",
  "polling",
  "credentials",
]);

function normalizeCodeClipProviderName(provider) {
  return String(provider || "").trim().toLowerCase();
}

function normalizeCodeClipProviderClass(providerClass) {
  return String(providerClass || "").trim().toLowerCase();
}

function isCodeClipProviderClass(providerClass) {
  return CODECLIP_PROVIDER_CLASSES.includes(normalizeCodeClipProviderClass(providerClass));
}

/**
 * Fail-closed validation of providerClass.
 * @returns {{ ok: true, providerClass: string } | { ok: false, reason: string }}
 */
function validateCodeClipProviderClass(providerClass) {
  const normalized = normalizeCodeClipProviderClass(providerClass);
  if (!normalized) {
    return { ok: false, reason: "PROVIDER_CLASS_REQUIRED" };
  }
  if (!CODECLIP_PROVIDER_CLASSES.includes(normalized)) {
    return { ok: false, reason: "UNSUPPORTED_PROVIDER_CLASS" };
  }
  return { ok: true, providerClass: normalized };
}

function freezeProviderCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("codeClip provider capabilities must be an object");
  }
  const frozen = {};
  for (const key of CODECLIP_PROVIDER_CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== "boolean") {
      throw new Error(`codeClip provider capability "${key}" must be a boolean`);
    }
    frozen[key] = capabilities[key];
  }
  for (const key of Object.keys(capabilities)) {
    if (!CODECLIP_PROVIDER_CAPABILITY_KEYS.includes(key)) {
      throw new Error(`codeClip provider capability "${key}" is not supported`);
    }
  }
  return Object.freeze(frozen);
}

function freezeProviderDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("codeClip provider definition must be an object");
  }
  const name = normalizeCodeClipProviderName(definition.name);
  if (!name) {
    throw new Error("codeClip provider definition name is required");
  }
  const classResult = validateCodeClipProviderClass(definition.providerClass);
  if (!classResult.ok) {
    throw new Error(
      `codeClip provider "${name}" has invalid providerClass: ${classResult.reason}`
    );
  }
  return Object.freeze({
    name,
    providerClass: classResult.providerClass,
    capabilities: freezeProviderCapabilities(definition.capabilities),
  });
}

/**
 * Authoritative provider definitions. Every registered provider must declare
 * providerClass and capabilities explicitly.
 */
const CODECLIP_PROVIDER_DEFINITIONS = Object.freeze({
  meta: freezeProviderDefinition({
    name: "meta",
    providerClass: "push",
    capabilities: {
      webhook: true,
      polling: false,
      credentials: true,
    },
  }),
  sms: freezeProviderDefinition({
    name: "sms",
    providerClass: "push",
    capabilities: {
      webhook: true,
      polling: false,
      credentials: false,
    },
  }),
  test: freezeProviderDefinition({
    name: "test",
    providerClass: "push",
    capabilities: {
      webhook: true,
      polling: false,
      credentials: false,
    },
  }),
  youtube: freezeProviderDefinition({
    name: "youtube",
    providerClass: "push_poll",
    capabilities: {
      webhook: true,
      polling: true,
      credentials: true,
    },
  }),
});

const CODECLIP_PROVIDER_NAMES = Object.freeze(Object.keys(CODECLIP_PROVIDER_DEFINITIONS));

function getCodeClipRegisteredProviders() {
  return [...CODECLIP_PROVIDER_NAMES];
}

function isCodeClipProviderRegistered(provider) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);
  return Object.prototype.hasOwnProperty.call(
    CODECLIP_PROVIDER_DEFINITIONS,
    normalizedProvider
  );
}

/**
 * Returns a frozen definition for a registered provider, or null if unregistered.
 */
function getCodeClipProviderDefinition(provider) {
  const normalizedProvider = normalizeCodeClipProviderName(provider);
  if (!normalizedProvider) return null;
  return CODECLIP_PROVIDER_DEFINITIONS[normalizedProvider] || null;
}

/**
 * Defensive copy of all registered definitions (name, providerClass, capabilities).
 */
function getCodeClipProviderDefinitions() {
  return CODECLIP_PROVIDER_NAMES.map((name) => {
    const definition = CODECLIP_PROVIDER_DEFINITIONS[name];
    return {
      name: definition.name,
      providerClass: definition.providerClass,
      capabilities: { ...definition.capabilities },
    };
  });
}

module.exports = {
  CODECLIP_PROVIDER_CLASSES,
  CODECLIP_PROVIDER_CAPABILITY_KEYS,
  getCodeClipProviderDefinition,
  getCodeClipProviderDefinitions,
  getCodeClipRegisteredProviders,
  isCodeClipProviderClass,
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderClass,
  normalizeCodeClipProviderName,
  validateCodeClipProviderClass,
};
