const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH = path.join(
  __dirname,
  "verticals/codeclip/meta-messenger-page-credentials.js"
);

function loadModule() {
  delete require.cache[require.resolve("./verticals/codeclip/meta-messenger-page-credentials")];
  return require("./verticals/codeclip/meta-messenger-page-credentials");
}

function validConfigJson(overrides = {}) {
  const base = {
    pages: {
      "page-123": {
        pageAccessToken: "secret-token-page-123",
        graphApiVersion: "v19.0",
        status: "active",
      },
      "page-456": {
        pageAccessToken: "secret-token-page-456",
        graphApiVersion: "v22.0",
      },
      "page-disabled": {
        pageAccessToken: "secret-token-disabled",
        graphApiVersion: "v19.0",
        status: "disabled",
      },
    },
  };
  return JSON.stringify({ ...base, ...overrides, pages: { ...base.pages, ...(overrides.pages || {}) } });
}

function assertNoSecretLeak(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-token/i);
  assert.doesNotMatch(serialized, /pageAccessToken":"[^"]+"/);
}

test("module exports pure parse/resolve and optional async binding resolver factory", () => {
  const mod = loadModule();
  assert.equal(typeof mod.parseMetaMessengerPageCredentialConfig, "function");
  assert.equal(typeof mod.resolveMetaMessengerPageCredentials, "function");
  assert.equal(typeof mod.toPublicMetaMessengerPageCredentialView, "function");
  assert.equal(typeof mod.createMetaMessengerPageCredentialResolver, "function");

  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /fetch\(|http\.|https\.|graph\.facebook/i);
  assert.doesNotMatch(source, /claimCodeClip|recordCodeClip|listEligible|dispatchCodeClip/);
  assert.doesNotMatch(source, /require\(["'].*redis["']\)/i);
});

test("parse accepts multi-page config and freezes map entries", () => {
  const { parseMetaMessengerPageCredentialConfig } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.pages["page-123"].pageAccessToken, "secret-token-page-123");
  assert.equal(parsed.config.pages["page-123"].graphApiVersion, "v19.0");
  assert.equal(parsed.config.pages["page-123"].status, "active");
  assert.equal(parsed.config.pages["page-456"].status, "active");
  assert.equal(parsed.config.pages["page-disabled"].status, "disabled");
  assert.equal(Object.isFrozen(parsed.config), true);
  assert.equal(Object.isFrozen(parsed.config.pages), true);
  assert.equal(Object.isFrozen(parsed.config.pages["page-123"]), true);
});

test("parse fails closed on invalid JSON structure and field values", () => {
  const { parseMetaMessengerPageCredentialConfig } = loadModule();

  assert.equal(parseMetaMessengerPageCredentialConfig("").ok, false);
  assert.equal(parseMetaMessengerPageCredentialConfig("{").reason, "CREDENTIAL_CONFIG_INVALID");
  assert.equal(parseMetaMessengerPageCredentialConfig("[]").reason, "CREDENTIAL_CONFIG_INVALID");
  assert.equal(parseMetaMessengerPageCredentialConfig(JSON.stringify({})).reason, "CREDENTIAL_CONFIG_INVALID");
  assert.equal(
    parseMetaMessengerPageCredentialConfig(JSON.stringify({ pages: [] })).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );
  assert.equal(
    parseMetaMessengerPageCredentialConfig(
      JSON.stringify({ pages: { "page-x": { pageAccessToken: "", graphApiVersion: "v19.0" } } })
    ).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );
  assert.equal(
    parseMetaMessengerPageCredentialConfig(
      JSON.stringify({ pages: { "page-x": { pageAccessToken: "tok", graphApiVersion: "21.0" } } })
    ).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );
  assert.equal(
    parseMetaMessengerPageCredentialConfig(
      JSON.stringify({ pages: { "page-x": { pageAccessToken: "tok", graphApiVersion: "v21" } } })
    ).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );
  assert.equal(
    parseMetaMessengerPageCredentialConfig(
      JSON.stringify({ pages: { "page-x": { pageAccessToken: "tok", graphApiVersion: "latest" } } })
    ).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );
  assert.equal(
    parseMetaMessengerPageCredentialConfig(
      JSON.stringify({
        pages: { "page-x": { pageAccessToken: "tok", graphApiVersion: "v19.0", status: "maybe" } },
      })
    ).reason,
    "CREDENTIAL_CONFIG_INVALID"
  );

  const invalid = parseMetaMessengerPageCredentialConfig(
    JSON.stringify({ pages: { "page-x": { pageAccessToken: "secret-token-leak", graphApiVersion: "bad" } } })
  );
  assertNoSecretLeak(invalid);
});

test("resolve by providerAccountId is deterministic and fail-closed", () => {
  const {
    parseMetaMessengerPageCredentialConfig,
    resolveMetaMessengerPageCredentials,
  } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  assert.equal(parsed.ok, true);

  const hit = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    credentialConfig: parsed.config,
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.pageAccessToken, "secret-token-page-123");
  assert.equal(hit.graphApiVersion, "v19.0");
  assert.equal(Object.hasOwn(hit, "retryable"), false);

  const again = resolveMetaMessengerPageCredentials({
    providerAccountId: " page-123 ",
    credentialConfig: parsed.config,
  });
  assert.deepEqual(
    { ok: again.ok, pageAccessToken: again.pageAccessToken, graphApiVersion: again.graphApiVersion },
    { ok: hit.ok, pageAccessToken: hit.pageAccessToken, graphApiVersion: hit.graphApiVersion }
  );

  const missing = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-unknown",
    credentialConfig: parsed.config,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "CREDENTIALS_UNAVAILABLE");
  assert.equal(missing.retryable, false);
  assertNoSecretLeak(missing);

  const disabled = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-disabled",
    credentialConfig: parsed.config,
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, "CREDENTIAL_DISABLED");
  assert.equal(disabled.retryable, false);

  const noAccount = resolveMetaMessengerPageCredentials({
    providerAccountId: "",
    credentialConfig: parsed.config,
  });
  assert.equal(noAccount.ok, false);
  assert.equal(noAccount.reason, "CREDENTIAL_PROVIDER_ACCOUNT_REQUIRED");
});

test("resolve with binding enforces meta messenger active account consistency", () => {
  const {
    parseMetaMessengerPageCredentialConfig,
    resolveMetaMessengerPageCredentials,
  } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  assert.equal(parsed.ok, true);

  const ok = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    bindingId: "binding-1",
    credentialConfig: parsed.config,
    binding: {
      id: "binding-1",
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-123",
      status: "active",
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.pageAccessToken, "secret-token-page-123");

  const disabledBinding = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    bindingId: "binding-1",
    credentialConfig: parsed.config,
    binding: {
      id: "binding-1",
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-123",
      status: "disabled",
    },
  });
  assert.equal(disabledBinding.ok, false);
  assert.equal(disabledBinding.reason, "CREDENTIAL_BINDING_DISABLED");

  const wrongChannel = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    bindingId: "binding-1",
    credentialConfig: parsed.config,
    binding: {
      id: "binding-1",
      provider: "meta",
      channel: "instagram",
      providerAccountId: "page-123",
      status: "active",
    },
  });
  assert.equal(wrongChannel.ok, false);
  assert.equal(wrongChannel.reason, "CREDENTIAL_BINDING_CHANNEL_INVALID");

  const mismatch = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    bindingId: "binding-1",
    credentialConfig: parsed.config,
    binding: {
      id: "binding-1",
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-456",
      status: "active",
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "CREDENTIAL_BINDING_ACCOUNT_MISMATCH");

  const missingBinding = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    bindingId: "binding-1",
    credentialConfig: parsed.config,
    binding: null,
  });
  assert.equal(missingBinding.ok, false);
  assert.equal(missingBinding.reason, "CREDENTIAL_BINDING_UNAVAILABLE");
});

test("createMetaMessengerPageCredentialResolver supports sync and async getBinding only", async () => {
  const {
    parseMetaMessengerPageCredentialConfig,
    createMetaMessengerPageCredentialResolver,
  } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  assert.equal(parsed.ok, true);

  const syncResolver = createMetaMessengerPageCredentialResolver({
    credentialConfig: parsed.config,
    getBinding: (bindingId) => ({
      id: bindingId,
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-123",
      status: "active",
    }),
  });
  const syncResult = syncResolver({
    providerAccountId: "page-123",
    bindingId: "binding-1",
  });
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.pageAccessToken, "secret-token-page-123");

  const asyncResolver = createMetaMessengerPageCredentialResolver({
    credentialConfig: parsed.config,
    getBinding: async (bindingId) => ({
      id: bindingId,
      provider: "meta",
      channel: "messenger",
      providerAccountId: "page-456",
      status: "active",
    }),
  });
  const asyncResult = await asyncResolver({
    providerAccountId: "page-456",
    bindingId: "binding-2",
  });
  assert.equal(asyncResult.ok, true);
  assert.equal(asyncResult.pageAccessToken, "secret-token-page-456");

  const throwResolver = createMetaMessengerPageCredentialResolver({
    credentialConfig: parsed.config,
    getBinding: async () => {
      throw new Error("db down");
    },
  });
  await assert.rejects(
    async () =>
      throwResolver({
        providerAccountId: "page-123",
        bindingId: "binding-1",
      }),
    /db down/
  );
});

test("createMetaMessengerPageCredentialResolver parses env once via pure parse", () => {
  const { createMetaMessengerPageCredentialResolverFromEnv } = loadModule();
  const resolver = createMetaMessengerPageCredentialResolverFromEnv({
    CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON: validConfigJson(),
  });
  assert.equal(typeof resolver, "function");
  const result = resolver({ providerAccountId: "page-123" });
  assert.equal(result.ok, true);
  assert.equal(result.graphApiVersion, "v19.0");

  const bad = createMetaMessengerPageCredentialResolverFromEnv({
    CODECLIP_META_MESSENGER_PAGE_CREDENTIALS_JSON: "{",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "CREDENTIAL_CONFIG_INVALID");
  assertNoSecretLeak(bad);
});

test("public view never exposes token and reports hasToken", () => {
  const {
    parseMetaMessengerPageCredentialConfig,
    resolveMetaMessengerPageCredentials,
    toPublicMetaMessengerPageCredentialView,
  } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  const resolved = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-123",
    credentialConfig: parsed.config,
  });
  const publicView = toPublicMetaMessengerPageCredentialView({
    providerAccountId: "page-123",
    resolution: resolved,
  });
  assert.equal(publicView.ok, true);
  assert.equal(publicView.hasToken, true);
  assert.equal(publicView.graphApiVersion, "v19.0");
  assert.equal(publicView.status, "active");
  assert.equal(Object.hasOwn(publicView, "pageAccessToken"), false);
  assert.match(publicView.providerAccountIdMasked, /123$/);
  assertNoSecretLeak(publicView);

  const missing = resolveMetaMessengerPageCredentials({
    providerAccountId: "missing",
    credentialConfig: parsed.config,
  });
  const publicFail = toPublicMetaMessengerPageCredentialView({
    providerAccountId: "missing",
    resolution: missing,
  });
  assert.equal(publicFail.ok, false);
  assert.equal(publicFail.hasToken, false);
  assert.equal(Object.hasOwn(publicFail, "pageAccessToken"), false);
  assertNoSecretLeak(publicFail);
});

test("no fallback across pages and no partial credential without token", () => {
  const {
    parseMetaMessengerPageCredentialConfig,
    resolveMetaMessengerPageCredentials,
  } = loadModule();
  const parsed = parseMetaMessengerPageCredentialConfig(validConfigJson());
  const miss = resolveMetaMessengerPageCredentials({
    providerAccountId: "page-unknown",
    credentialConfig: parsed.config,
  });
  assert.equal(miss.ok, false);
  assert.equal(Object.hasOwn(miss, "pageAccessToken"), false);
  assert.equal(Object.hasOwn(miss, "graphApiVersion"), false);
});
