const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("./verticals/codeclip/provider-registry");

test("codeClip provider registry exposes registered providers", () => {
  assert.deepEqual(getCodeClipRegisteredProviders(), ["meta", "sms", "test", "youtube"]);
});

test("codeClip provider registry returns a stable provider list", () => {
  assert.deepEqual(getCodeClipRegisteredProviders(), getCodeClipRegisteredProviders());
});

test("codeClip provider registry returns a defensive copy", () => {
  const providers = getCodeClipRegisteredProviders();
  providers.push("custom");

  assert.deepEqual(getCodeClipRegisteredProviders(), ["meta", "sms", "test", "youtube"]);
});

test("codeClip provider registry normalizes provider names", () => {
  assert.equal(normalizeCodeClipProviderName(" SMS "), "sms");
  assert.equal(normalizeCodeClipProviderName("Meta"), "meta");
  assert.equal(normalizeCodeClipProviderName(" TEST "), "test");
  assert.equal(normalizeCodeClipProviderName(" YouTube "), "youtube");
});

test("codeClip provider registry normalizes missing provider to empty string", () => {
  assert.equal(normalizeCodeClipProviderName(), "");
  assert.equal(normalizeCodeClipProviderName(null), "");
  assert.equal(normalizeCodeClipProviderName("   "), "");
});

test("codeClip provider registry checks registered providers", () => {
  assert.equal(isCodeClipProviderRegistered(" SMS "), true);
  assert.equal(isCodeClipProviderRegistered("meta"), true);
  assert.equal(isCodeClipProviderRegistered("test"), true);
  assert.equal(isCodeClipProviderRegistered("youtube"), true);
  assert.equal(isCodeClipProviderRegistered("unknown"), false);
  assert.equal(isCodeClipProviderRegistered(""), false);
});

test("codeClip provider registry declares providerClass for every registered provider", () => {
  for (const name of getCodeClipRegisteredProviders()) {
    const definition = getCodeClipProviderDefinition(name);
    assert.ok(definition, `missing definition for ${name}`);
    assert.equal(definition.name, name);
    assert.equal(typeof definition.providerClass, "string");
    assert.equal(isCodeClipProviderClass(definition.providerClass), true);
  }
});

test("codeClip provider registry declares capabilities for every registered provider", () => {
  for (const name of getCodeClipRegisteredProviders()) {
    const definition = getCodeClipProviderDefinition(name);
    assert.ok(definition?.capabilities);
    for (const key of CODECLIP_PROVIDER_CAPABILITY_KEYS) {
      assert.equal(
        typeof definition.capabilities[key],
        "boolean",
        `${name}.capabilities.${key} must be boolean`
      );
    }
  }
});

test("codeClip provider registry exports explicit class metadata", () => {
  assert.deepEqual(CODECLIP_PROVIDER_CLASSES, ["push", "push_poll", "poll_only"]);

  const meta = getCodeClipProviderDefinition("meta");
  assert.equal(meta.providerClass, "push");
  assert.deepEqual(meta.capabilities, {
    webhook: true,
    polling: false,
    credentials: true,
  });

  const youtube = getCodeClipProviderDefinition("youtube");
  assert.equal(youtube.providerClass, "push_poll");
  assert.deepEqual(youtube.capabilities, {
    webhook: true,
    polling: true,
    credentials: true,
  });

  const sms = getCodeClipProviderDefinition("sms");
  assert.equal(sms.providerClass, "push");
  assert.deepEqual(sms.capabilities, {
    webhook: true,
    polling: false,
    credentials: false,
  });

  const testProvider = getCodeClipProviderDefinition("test");
  assert.equal(testProvider.providerClass, "push");
  assert.deepEqual(testProvider.capabilities, {
    webhook: true,
    polling: false,
    credentials: false,
  });
});

test("codeClip provider registry definitions list is a defensive copy", () => {
  const definitions = getCodeClipProviderDefinitions();
  assert.equal(definitions.length, 4);
  definitions[0].providerClass = "poll_only";
  definitions[0].capabilities.webhook = false;

  const meta = getCodeClipProviderDefinition("meta");
  assert.equal(meta.providerClass, "push");
  assert.equal(meta.capabilities.webhook, true);
});

test("codeClip provider class validation accepts known classes", () => {
  assert.deepEqual(validateCodeClipProviderClass("push"), {
    ok: true,
    providerClass: "push",
  });
  assert.deepEqual(validateCodeClipProviderClass(" PUSH_POLL "), {
    ok: true,
    providerClass: "push_poll",
  });
  assert.deepEqual(validateCodeClipProviderClass("poll_only"), {
    ok: true,
    providerClass: "poll_only",
  });
  assert.equal(isCodeClipProviderClass("push"), true);
  assert.equal(normalizeCodeClipProviderClass(" Push "), "push");
});

test("codeClip provider class validation rejects unknown and missing classes", () => {
  assert.deepEqual(validateCodeClipProviderClass(""), {
    ok: false,
    reason: "PROVIDER_CLASS_REQUIRED",
  });
  assert.deepEqual(validateCodeClipProviderClass(null), {
    ok: false,
    reason: "PROVIDER_CLASS_REQUIRED",
  });
  assert.deepEqual(validateCodeClipProviderClass("streaming"), {
    ok: false,
    reason: "UNSUPPORTED_PROVIDER_CLASS",
  });
  assert.equal(isCodeClipProviderClass("streaming"), false);
  assert.equal(isCodeClipProviderClass(""), false);
});

test("codeClip provider registry returns null for unknown provider definition", () => {
  assert.equal(getCodeClipProviderDefinition("unknown"), null);
  assert.equal(getCodeClipProviderDefinition(""), null);
});
