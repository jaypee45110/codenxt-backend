const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCodeClipProviderVerificationRequest,
  listCodeClipProviderDetectionSources,
  mapCodeClipProviderDetectionSourceToDeliverySource,
  resolveCodeClipProviderDetectionSource,
  resolveCodeClipProviderGrace,
  resolveCodeClipProviderPolicy,
} = require("./verticals/codeclip/provider-policy");
const {
  isCodeClipProviderDeliveryInitialSource,
} = require("./verticals/codeclip/provider-delivery-sources");

function assertDefaultIdempotency(policy) {
  assert.deepEqual(policy.idempotency, {
    enabled: true,
    claimTtlSeconds: 300,
    responseTtlSeconds: 86400,
  });
}

function assertLiveIdempotency(policy) {
  assert.deepEqual(policy.idempotency, {
    enabled: true,
    claimTtlSeconds: 300,
    responseTtlSeconds: 86400,
    requireStoreForLiveProvider: true,
  });
}

function assertDefaultCapabilities(policy, {
  runtimeVerification,
  hmacVerification = false,
  rawBodyRequired = false,
  liveProvider = false,
  providerAccountIdRequired = false,
  durableDeliveryRequired = false,
  webhook = false,
  polling = false,
  credentials = false,
}) {
  assert.deepEqual(policy.capabilities, {
    route: true,
    envelope: true,
    adapter: true,
    keywordActivation: true,
    accountResolution: true,
    activationLookup: true,
    idempotency: true,
    webhookVerification: true,
    runtimeVerification,
    hmacVerification,
    rawBodyRequired,
    liveProvider,
    providerAccountIdRequired,
    durableDeliveryRequired,
    webhook,
    polling,
    credentials,
  });
}

function assertRuntimeVerificationInvariant(policy) {
  assert.equal(
    policy.capabilities.runtimeVerification,
    policy.verificationMode !== "disabled"
  );
}

function buildHmacPolicy(overrides = {}) {
  return {
    verificationMode: "hmac-sha256",
    secretEnvName: "CODECLIP_TEST_SECRET",
    capabilities: {
      hmacVerification: true,
    },
    ...overrides,
  };
}

test("codeClip provider policy returns test provider policy", () => {
  const result = resolveCodeClipProviderPolicy("test");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "test");
  assert.equal(result.policy.providerClass, "push");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "test");
  assert.equal(result.policy.envelopeType, "test");
  assert.equal(result.policy.verificationMode, "test");
  assert.equal(result.policy.secretEnvName, "");
  assertDefaultCapabilities(result.policy, {
    runtimeVerification: true,
    webhook: true,
    polling: false,
    credentials: false,
  });
  assertRuntimeVerificationInvariant(result.policy);
  assertDefaultIdempotency(result.policy);
});

test("codeClip provider policy returns sms provider policy", () => {
  const result = resolveCodeClipProviderPolicy("sms");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "sms");
  assert.equal(result.policy.providerClass, "push");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "sms");
  assert.equal(result.policy.envelopeType, "sms");
  assert.equal(result.policy.verificationMode, "hmac-sha256");
  assert.equal(result.policy.secretEnvName, "CODECLIP_SMS_WEBHOOK_SECRET");
  assertDefaultCapabilities(result.policy, {
    runtimeVerification: true,
    hmacVerification: true,
    rawBodyRequired: true,
    webhook: true,
    polling: false,
    credentials: false,
  });
  assertRuntimeVerificationInvariant(result.policy);
  assertDefaultIdempotency(result.policy);
});

test("codeClip provider policy returns meta provider policy", () => {
  const result = resolveCodeClipProviderPolicy("meta");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "meta");
  assert.equal(result.policy.providerClass, "push");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "meta");
  assert.equal(result.policy.envelopeType, "meta");
  assert.equal(result.policy.verificationMode, "hmac-sha256");
  assert.equal(result.policy.secretEnvName, "CODECLIP_META_WEBHOOK_SECRET");
  assertDefaultCapabilities(result.policy, {
    runtimeVerification: true,
    hmacVerification: true,
    rawBodyRequired: true,
    liveProvider: true,
    webhook: true,
    polling: false,
    credentials: true,
  });
  assertRuntimeVerificationInvariant(result.policy);
  assertLiveIdempotency(result.policy);
});

test("codeClip provider policy returns youtube WebSub policy", () => {
  const result = resolveCodeClipProviderPolicy("youtube");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "youtube");
  assert.equal(result.policy.providerClass, "push_poll");
  assert.equal(result.policy.routeEnabled, true);
  assert.equal(result.policy.adapter, "youtube");
  assert.equal(result.policy.envelopeType, "youtube-websub");
  assert.equal(result.policy.verificationMode, "websub-hmac");
  assert.equal(result.policy.secretEnvName, "CODECLIP_YOUTUBE_WEBSUB_SECRET");
  assert.equal(result.policy.signatureHeader, "X-Hub-Signature");
  assertDefaultCapabilities(result.policy, {
    runtimeVerification: true,
    hmacVerification: true,
    rawBodyRequired: true,
    liveProvider: true,
    providerAccountIdRequired: true,
    durableDeliveryRequired: true,
    webhook: true,
    polling: true,
    credentials: true,
  });
  assertRuntimeVerificationInvariant(result.policy);
  assertLiveIdempotency(result.policy);
});

test("codeClip provider policy normalizes provider names", () => {
  const result = resolveCodeClipProviderPolicy(" SMS ");

  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "sms");
});

test("codeClip provider policy rejects missing and unsupported providers", () => {
  assert.deepEqual(
    resolveCodeClipProviderPolicy(""),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );

  assert.deepEqual(
    resolveCodeClipProviderPolicy("unknown"),
    { ok: false, reason: "UNSUPPORTED_PROVIDER" }
  );
});

test("codeClip provider policy returns a defensive copy", () => {
  const first = resolveCodeClipProviderPolicy("test");
  first.policy.capabilities.runtimeVerification = false;
  first.policy.capabilities.webhook = false;
  first.policy.providerClass = "poll_only";
  first.policy.idempotency.claimTtlSeconds = 1;

  const second = resolveCodeClipProviderPolicy("test");
  assert.equal(second.policy.providerClass, "push");
  assertDefaultCapabilities(second.policy, {
    runtimeVerification: true,
    webhook: true,
    polling: false,
    credentials: false,
  });
  assertDefaultIdempotency(second.policy);
});

test("codeClip provider policy exposes providerClass and registry capabilities from registry", () => {
  const meta = resolveCodeClipProviderPolicy("meta");
  assert.equal(meta.policy.providerClass, "push");
  assert.equal(meta.policy.capabilities.webhook, true);
  assert.equal(meta.policy.capabilities.polling, false);
  assert.equal(meta.policy.capabilities.credentials, true);

  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.policy.providerClass, "push_poll");
  assert.equal(youtube.policy.capabilities.webhook, true);
  assert.equal(youtube.policy.capabilities.polling, true);
  assert.equal(youtube.policy.capabilities.credentials, true);
});

test("codeClip provider policy builds verifier request for test provider", () => {
  const { policy } = resolveCodeClipProviderPolicy("test");
  const headers = { "x-codeclip-test-signature": "valid" };
  const rawBody = "";

  assert.deepEqual(
    buildCodeClipProviderVerificationRequest({
      policy,
      provider: "test",
      headers,
      rawBody,
    }),
    {
      provider: "test",
      headers,
      rawBody,
      mode: "test",
    }
  );
});

test("codeClip provider policy builds hmac verifier request for meta with configured secret", () => {
  const headers = { "x-hub-signature-256": "sha256=unused" };
  const rawBody = "{\"text\":\"CLIP\"}";

  const { policy } = resolveCodeClipProviderPolicy("meta");
  const request = buildCodeClipProviderVerificationRequest({
    policy,
    provider: "meta",
    headers,
    rawBody,
    env: {
      CODECLIP_META_WEBHOOK_SECRET: " meta-secret ",
    },
  });

  assert.deepEqual(request, {
    provider: "meta",
    headers,
    rawBody,
    mode: "hmac-sha256",
    secret: "meta-secret",
  });
});

test("codeClip provider policy builds missing-secret signal for meta without configured secret", () => {
  const headers = { "x-hub-signature-256": "sha256=unused" };
  const rawBody = "{\"text\":\"CLIP\"}";

  const { policy } = resolveCodeClipProviderPolicy("meta");
  const request = buildCodeClipProviderVerificationRequest({
    policy,
    provider: "meta",
    headers,
    rawBody,
    env: {},
  });

  assert.equal(request.provider, "meta");
  assert.equal(request.headers, headers);
  assert.equal(request.rawBody, rawBody);
  assert.equal(request.mode, "hmac-sha256");
  assert.equal(Object.hasOwn(request, "secret"), false);
  assert.equal(Object.hasOwn(request, "secretResolution"), true);
  assert.deepEqual(request.secretResolution, {
    ok: false,
    reason: "SECRET_NOT_CONFIGURED",
    required: true,
  });
  assert.equal(Object.hasOwn(request, "signatureHeader"), false);
  assert.equal(Object.hasOwn(request, "signatureHeaders"), false);
  assert.equal(Object.hasOwn(request, "verificationMethod"), false);
  assert.equal(Object.hasOwn(request, "rawBodyRequired"), false);
  assert.equal(policy.capabilities.hmacVerification, true);
  assert.equal(policy.capabilities.rawBodyRequired, true);
  assert.equal(policy.capabilities.liveProvider, true);
});

test("codeClip provider policy builds hmac verifier request for sms with configured secret", () => {
  const { policy } = resolveCodeClipProviderPolicy("sms");
  const headers = { "x-provider-signature": "unused" };
  const rawBody = "Body=OPEN";

  assert.deepEqual(
    buildCodeClipProviderVerificationRequest({
      policy,
      provider: "sms",
      headers,
      rawBody,
      env: {
        CODECLIP_SMS_WEBHOOK_SECRET: " sms-secret ",
      },
    }),
    {
      provider: "sms",
      headers,
      rawBody,
      mode: "hmac-sha256",
      secret: "sms-secret",
    }
  );
});

test("codeClip provider policy builds missing-secret signal for sms without configured secret", () => {
  const { policy } = resolveCodeClipProviderPolicy("sms");
  const request = buildCodeClipProviderVerificationRequest({
    policy,
    provider: "sms",
    headers: { "x-provider-signature": "unused" },
    rawBody: "Body=OPEN",
    env: {},
  });

  assert.equal(request.provider, "sms");
  assert.equal(request.mode, "hmac-sha256");
  assert.equal(Object.hasOwn(request, "secret"), false);
  assert.deepEqual(request.secretResolution, {
    ok: false,
    reason: "SECRET_NOT_CONFIGURED",
    required: true,
  });
});

test("codeClip provider policy builds verifier request with secret when required and configured", () => {
  const headers = { "x-provider-signature": "unused" };
  const rawBody = "Body=CLIP";

  assert.deepEqual(
    buildCodeClipProviderVerificationRequest({
      policy: buildHmacPolicy(),
      provider: "sms",
      headers,
      rawBody,
      env: {
        CODECLIP_TEST_SECRET: " test-secret ",
      },
    }),
    {
      provider: "sms",
      headers,
      rawBody,
      mode: "hmac-sha256",
      secret: "test-secret",
    }
  );
});

test("codeClip provider policy builds safe missing-secret signal when required secret is not configured", () => {
  const request = buildCodeClipProviderVerificationRequest({
    policy: buildHmacPolicy(),
    provider: "meta",
    headers: { "x-hub-signature-256": "sha256=unused" },
    rawBody: "{\"text\":\"CLIP\"}",
    env: {
      OTHER_SECRET: "must-not-leak",
    },
  });

  assert.equal(request.provider, "meta");
  assert.equal(request.mode, "hmac-sha256");
  assert.equal(Object.hasOwn(request, "secret"), false);
  assert.deepEqual(request.secretResolution, {
    ok: false,
    reason: "SECRET_NOT_CONFIGURED",
    required: true,
  });
  assert.equal(Object.values(request.secretResolution).includes("must-not-leak"), false);
});

// ---------------------------------------------------------------------------
// F1B: detection source policy, delivery mapping, grace policy
// ---------------------------------------------------------------------------

const YOUTUBE_DETECTION = {
  defaultSource: "atom",
  sources: {
    atom: { deliverySource: "atom_reconciliation" },
    data_api: { deliverySource: "data_api_polling" },
  },
};

const YOUTUBE_GRACE = {
  defaultMs: 180000,
  minMs: 60000,
  maxMs: 3600000,
  sourceOverrides: {},
};

test("codeClip provider policy resolves default youtube detection source", () => {
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube"), {
    ok: true,
    detectionSource: "atom",
  });
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", null), {
    ok: true,
    detectionSource: "atom",
  });
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", "  "), {
    ok: true,
    detectionSource: "atom",
  });
});

test("codeClip provider policy normalizes known detection source casing and trim", () => {
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", " Atom "), {
    ok: true,
    detectionSource: "atom",
  });
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", "DATA_API"), {
    ok: true,
    detectionSource: "data_api",
  });
});

test("codeClip provider policy rejects unknown detection sources fail-closed", () => {
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", "manual"), {
    ok: false,
    reason: "UNSUPPORTED_DETECTION_SOURCE",
  });
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", "websub"), {
    ok: false,
    reason: "UNSUPPORTED_DETECTION_SOURCE",
  });
});

test("codeClip provider policy maps detection sources to canonical delivery sources", () => {
  assert.deepEqual(
    mapCodeClipProviderDetectionSourceToDeliverySource("youtube", "atom"),
    { ok: true, deliverySource: "atom_reconciliation" }
  );
  assert.deepEqual(
    mapCodeClipProviderDetectionSourceToDeliverySource("youtube", " DATA_API "),
    { ok: true, deliverySource: "data_api_polling" }
  );
});

test("codeClip provider policy mapping targets are members of delivery source allowlist", () => {
  const atom = mapCodeClipProviderDetectionSourceToDeliverySource("youtube", "atom");
  const dataApi = mapCodeClipProviderDetectionSourceToDeliverySource("youtube", "data_api");
  assert.equal(atom.ok, true);
  assert.equal(dataApi.ok, true);
  assert.equal(isCodeClipProviderDeliveryInitialSource(atom.deliverySource), true);
  assert.equal(isCodeClipProviderDeliveryInitialSource(dataApi.deliverySource), true);
});

test("codeClip provider policy push-only providers return detection and grace not-supported", () => {
  for (const provider of ["meta", "sms", "test"]) {
    assert.deepEqual(resolveCodeClipProviderDetectionSource(provider), {
      ok: false,
      reason: "DETECTION_NOT_SUPPORTED",
    });
    assert.deepEqual(mapCodeClipProviderDetectionSourceToDeliverySource(provider, "atom"), {
      ok: false,
      reason: "DETECTION_NOT_SUPPORTED",
    });
    assert.deepEqual(listCodeClipProviderDetectionSources(provider), {
      ok: false,
      reason: "DETECTION_NOT_SUPPORTED",
    });
    assert.deepEqual(resolveCodeClipProviderGrace({ provider }), {
      ok: false,
      reason: "GRACE_NOT_SUPPORTED",
    });
  }
});

test("codeClip provider policy resolves youtube grace default", () => {
  assert.deepEqual(resolveCodeClipProviderGrace({ provider: "youtube" }), {
    ok: true,
    graceMs: 180000,
  });
  assert.deepEqual(
    resolveCodeClipProviderGrace({ provider: "youtube", detectionSource: "atom" }),
    { ok: true, graceMs: 180000 }
  );
});

test("codeClip provider policy grace selection respects configured overrides surface", () => {
  // Live youtube policy has empty sourceOverrides; public API still accepts
  // detectionSource and returns defaultMs when no override key is configured.
  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.ok, true);
  assert.deepEqual(youtube.policy.grace.sourceOverrides, {});
  assert.deepEqual(
    resolveCodeClipProviderGrace({ provider: "youtube", detectionSource: "data_api" }),
    { ok: true, graceMs: youtube.policy.grace.defaultMs }
  );
  assert.deepEqual(
    resolveCodeClipProviderGrace({ provider: "youtube", detectionSource: "atom" }),
    { ok: true, graceMs: youtube.policy.grace.defaultMs }
  );
});

test("codeClip provider policy grace bounds on resolved policy are positive and ordered", () => {
  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.ok, true);
  const { defaultMs, minMs, maxMs, sourceOverrides } = youtube.policy.grace;
  assert.equal(Number.isSafeInteger(minMs) && minMs > 0, true);
  assert.equal(Number.isSafeInteger(maxMs) && maxMs >= minMs, true);
  assert.equal(Number.isSafeInteger(defaultMs), true);
  assert.equal(defaultMs >= minMs && defaultMs <= maxMs, true);
  assert.equal(defaultMs, 180000);
  assert.equal(minMs, 60000);
  assert.equal(maxMs, 3600000);
  for (const overrideMs of Object.values(sourceOverrides)) {
    assert.equal(Number.isSafeInteger(overrideMs), true);
    assert.equal(overrideMs >= minMs && overrideMs <= maxMs, true);
  }
  const resolved = resolveCodeClipProviderGrace({ provider: "youtube" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.graceMs >= minMs && resolved.graceMs <= maxMs, true);
});

test("codeClip provider policy default detection source is in allowlist and maps cleanly", () => {
  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.ok, true);
  const { defaultSource, sources } = youtube.policy.detection;
  assert.equal(Object.prototype.hasOwnProperty.call(sources, defaultSource), true);
  const resolved = resolveCodeClipProviderDetectionSource("youtube");
  assert.deepEqual(resolved, { ok: true, detectionSource: defaultSource });
  for (const [key, entry] of Object.entries(sources)) {
    assert.equal(isCodeClipProviderDeliveryInitialSource(entry.deliverySource), true);
    const mapped = mapCodeClipProviderDetectionSourceToDeliverySource("youtube", key);
    assert.deepEqual(mapped, { ok: true, deliverySource: entry.deliverySource });
  }
  assert.deepEqual(resolveCodeClipProviderDetectionSource("youtube", "not_in_allowlist"), {
    ok: false,
    reason: "UNSUPPORTED_DETECTION_SOURCE",
  });
});

test("codeClip provider policy detection only appears with polling capability", () => {
  for (const name of ["meta", "sms", "test", "youtube"]) {
    const result = resolveCodeClipProviderPolicy(name);
    assert.equal(result.ok, true);
    if (result.policy.capabilities.polling === true) {
      assert.ok(result.policy.detection);
      assert.ok(result.policy.grace);
      assert.equal(resolveCodeClipProviderDetectionSource(name).ok, true);
    } else {
      assert.equal(result.policy.detection, null);
      assert.equal(result.policy.grace, null);
      assert.deepEqual(resolveCodeClipProviderDetectionSource(name), {
        ok: false,
        reason: "DETECTION_NOT_SUPPORTED",
      });
    }
  }
});

test("codeClip provider policy grace rejects unknown detection source for override path", () => {
  assert.deepEqual(
    resolveCodeClipProviderGrace({ provider: "youtube", detectionSource: "unknown_feed" }),
    { ok: false, reason: "UNSUPPORTED_DETECTION_SOURCE" }
  );
});

test("codeClip provider policy detection and grace surfaces use defensive copies", () => {
  const first = resolveCodeClipProviderPolicy("youtube");
  assert.equal(first.ok, true);
  first.policy.detection.defaultSource = "mutated";
  first.policy.detection.sources.atom.deliverySource = "mutated";
  first.policy.detection.sources.extra = { deliverySource: "websub" };
  first.policy.grace.defaultMs = 1;
  first.policy.grace.sourceOverrides.atom = 1;
  const listed = listCodeClipProviderDetectionSources("youtube");
  listed.sources.push("injected");

  const second = resolveCodeClipProviderPolicy("youtube");
  assert.equal(second.policy.detection.defaultSource, "atom");
  assert.equal(second.policy.detection.sources.atom.deliverySource, "atom_reconciliation");
  assert.equal(Object.hasOwn(second.policy.detection.sources, "extra"), false);
  assert.equal(second.policy.grace.defaultMs, 180000);
  assert.deepEqual(second.policy.grace.sourceOverrides, {});
  assert.deepEqual(listCodeClipProviderDetectionSources("youtube"), {
    ok: true,
    sources: ["atom", "data_api"],
  });
});

test("codeClip provider source policy rejects unsupported provider", () => {
  assert.deepEqual(resolveCodeClipProviderDetectionSource("unknown"), {
    ok: false,
    reason: "UNSUPPORTED_PROVIDER",
  });
  assert.deepEqual(mapCodeClipProviderDetectionSourceToDeliverySource("", "atom"), {
    ok: false,
    reason: "UNSUPPORTED_PROVIDER",
  });
  assert.deepEqual(listCodeClipProviderDetectionSources("nope"), {
    ok: false,
    reason: "UNSUPPORTED_PROVIDER",
  });
  assert.deepEqual(resolveCodeClipProviderGrace({ provider: "unknown" }), {
    ok: false,
    reason: "UNSUPPORTED_PROVIDER",
  });
});

test("codeClip provider policy F1B keeps F1A providerClass and capabilities unchanged", () => {
  const meta = resolveCodeClipProviderPolicy("meta");
  assert.equal(meta.policy.providerClass, "push");
  assert.equal(meta.policy.capabilities.webhook, true);
  assert.equal(meta.policy.capabilities.polling, false);
  assert.equal(meta.policy.capabilities.credentials, true);
  assert.equal(meta.policy.detection, null);
  assert.equal(meta.policy.grace, null);

  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.policy.providerClass, "push_poll");
  assert.equal(youtube.policy.capabilities.webhook, true);
  assert.equal(youtube.policy.capabilities.polling, true);
  assert.equal(youtube.policy.capabilities.credentials, true);
  assert.deepEqual(youtube.policy.detection, YOUTUBE_DETECTION);
  assert.deepEqual(youtube.policy.grace, YOUTUBE_GRACE);
});

test("codeClip provider policy existing resolve API remains backward compatible", () => {
  const result = resolveCodeClipProviderPolicy("sms");
  assert.equal(result.ok, true);
  assert.equal(result.policy.provider, "sms");
  assert.equal(result.policy.verificationMode, "hmac-sha256");
  assert.equal(result.policy.secretEnvName, "CODECLIP_SMS_WEBHOOK_SECRET");
  assert.equal(typeof result.policy.capabilities.runtimeVerification, "boolean");
  assert.equal(typeof result.policy.providerClass, "string");
  assert.equal(Object.hasOwn(result.policy, "detection"), true);
  assert.equal(Object.hasOwn(result.policy, "grace"), true);
  assert.equal(result.policy.detection, null);
  assert.equal(result.policy.grace, null);
});

test("codeClip provider policy youtube exposes detection source list", () => {
  assert.deepEqual(listCodeClipProviderDetectionSources("youtube"), {
    ok: true,
    sources: ["atom", "data_api"],
  });
});

test("codeClip provider policy mapping rejects empty detection source", () => {
  assert.deepEqual(mapCodeClipProviderDetectionSourceToDeliverySource("youtube", ""), {
    ok: false,
    reason: "INVALID_DETECTION_SOURCE",
  });
  assert.deepEqual(mapCodeClipProviderDetectionSourceToDeliverySource("youtube", null), {
    ok: false,
    reason: "INVALID_DETECTION_SOURCE",
  });
});
