const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCodeClipRegisteredProviders,
  isCodeClipProviderRegistered,
  normalizeCodeClipProviderName,
} = require("./verticals/codeclip/provider-registry");

test("codeClip provider registry exposes registered providers", () => {
  assert.deepEqual(getCodeClipRegisteredProviders(), ["meta", "sms", "test"]);
});

test("codeClip provider registry returns a stable provider list", () => {
  assert.deepEqual(getCodeClipRegisteredProviders(), getCodeClipRegisteredProviders());
});

test("codeClip provider registry returns a defensive copy", () => {
  const providers = getCodeClipRegisteredProviders();
  providers.push("custom");

  assert.deepEqual(getCodeClipRegisteredProviders(), ["meta", "sms", "test"]);
});

test("codeClip provider registry normalizes provider names", () => {
  assert.equal(normalizeCodeClipProviderName(" SMS "), "sms");
  assert.equal(normalizeCodeClipProviderName("Meta"), "meta");
  assert.equal(normalizeCodeClipProviderName(" TEST "), "test");
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
  assert.equal(isCodeClipProviderRegistered("unknown"), false);
  assert.equal(isCodeClipProviderRegistered(""), false);
});
