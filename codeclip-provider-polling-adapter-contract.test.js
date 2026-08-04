const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderPollAdapterContractError,
  normalizeCodeClipProviderPollAdapterInput,
  normalizeCodeClipProviderPollAdapterResult,
  buildCodeClipProviderPollingExternalMessageId,
} = require("./verticals/codeclip/provider-polling/adapter-contract");

const NOW = "2026-08-04T12:00:00.000Z";
const TOKEN = "secret-access-token-value-do-not-leak";

function assertNoTokenLeak(value) {
  const blob =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, v) =>
          typeof v === "function" ? "[Function]" : v
        );
  assert.equal(blob.includes(TOKEN), false, "token must not appear in serialized diagnostics");
}

function assertContractError(error, code) {
  assert.ok(error instanceof CodeClipProviderPollAdapterContractError);
  assert.equal(error.code, code);
  assertNoTokenLeak(error.message);
  assertNoTokenLeak(error.details || {});
  assertNoTokenLeak({
    name: error.name,
    code: error.code,
    message: error.message,
    details: error.details,
  });
}

function validInput(overrides = {}) {
  return {
    provider: "youtube",
    environment: "sandbox",
    providerAccountId: "UC_poll_contract_channel_01",
    accessToken: TOKEN,
    checkpoint: { cursor: "0" },
    now: NOW,
    limit: 25,
    ...overrides,
  };
}

function validDetection(overrides = {}) {
  return {
    providerObjectId: "video-1",
    publishedAt: "2026-08-01T10:00:00.000Z",
    detectedAt: NOW,
    source: "data_api",
    ...overrides,
  };
}

function validSuccess(overrides = {}) {
  return {
    ok: true,
    detections: [validDetection()],
    nextCheckpoint: { cursor: "1" },
    page: { complete: true },
    ...overrides,
  };
}

test("adapter contract exports only public surface", () => {
  const mod = require("./verticals/codeclip/provider-polling/adapter-contract");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipProviderPollAdapterContractError",
    "buildCodeClipProviderPollingExternalMessageId",
    "normalizeCodeClipProviderPollAdapterInput",
    "normalizeCodeClipProviderPollAdapterResult",
  ]);
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test("normalize adapter input accepts valid polling-capable input with accessToken", () => {
  const normalized = normalizeCodeClipProviderPollAdapterInput(validInput());
  assert.equal(normalized.provider, "youtube");
  assert.equal(normalized.environment, "sandbox");
  assert.equal(normalized.providerAccountId, "UC_poll_contract_channel_01");
  // F1D2B must be able to pass this object directly to adapter.poll(...)
  assert.equal(normalized.accessToken, TOKEN);
  assert.equal(Object.hasOwn(normalized, "hasAccessToken"), false);
  assert.deepEqual(normalized.checkpoint, { cursor: "0" });
  assert.equal(normalized.now, NOW);
  assert.equal(normalized.limit, 25);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "accessToken",
    "checkpoint",
    "environment",
    "limit",
    "now",
    "provider",
    "providerAccountId",
  ]);

  // Defensive checkpoint copy
  normalized.checkpoint.cursor = "mutated";
  const again = normalizeCodeClipProviderPollAdapterInput(validInput());
  assert.equal(again.checkpoint.cursor, "0");
});

test("normalized accessToken is for in-memory adapter use only and errors never leak it", () => {
  const normalized = normalizeCodeClipProviderPollAdapterInput(validInput());
  assert.equal(normalized.accessToken, TOKEN);

  // Simulated adapter receives the same token from normalized input (F1D2B path).
  let seen = null;
  function fakePoll(input) {
    seen = input.accessToken;
    return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
  }
  fakePoll(normalized);
  assert.equal(seen, TOKEN);

  // Errors from other fields must not embed the token.
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ checkpoint: { access_token: "nested" }, accessToken: TOKEN })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      return true;
    }
  );
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ limit: 999, accessToken: TOKEN })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      return true;
    }
  );
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ provider: "meta", accessToken: TOKEN })
      ),
    (error) => {
      assertContractError(error, "POLLING_NOT_SUPPORTED");
      return true;
    }
  );
});

test("normalize adapter input defaults limit to 25", () => {
  const { limit, ...rest } = validInput();
  const normalized = normalizeCodeClipProviderPollAdapterInput(rest);
  assert.equal(normalized.limit, 25);
});

test("normalize adapter input rejects non-polling and unknown providers", () => {
  for (const provider of ["meta", "sms", "test"]) {
    assert.throws(
      () => normalizeCodeClipProviderPollAdapterInput(validInput({ provider })),
      (error) => {
        assertContractError(error, "POLLING_NOT_SUPPORTED");
        return true;
      }
    );
  }
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ provider: "not-real" })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      return true;
    }
  );
});

test("normalize adapter input rejects invalid environment and account", () => {
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ environment: "staging" })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      assert.equal(error.details.fieldName, "environment");
      return true;
    }
  );
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ providerAccountId: "" })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      return true;
    }
  );
});

test("normalize adapter input rejects missing token without leaking it", () => {
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ accessToken: "" })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      assert.equal(error.details.fieldName, "accessToken");
      return true;
    }
  );
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterInput(
        validInput({ accessToken: null })
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_INPUT");
      return true;
    }
  );
});

test("normalize adapter input rejects invalid checkpoints and sensitive keys", () => {
  for (const checkpoint of [
    [],
    "x",
    1,
    { access_token: "nope" },
    { token: "x" },
    { refresh_token: "x" },
    { blob: "x".repeat(5000) },
    { n: NaN },
  ]) {
    assert.throws(
      () =>
        normalizeCodeClipProviderPollAdapterInput(
          validInput({ checkpoint })
        ),
      (error) => {
        assertContractError(error, "INVALID_ADAPTER_INPUT");
        assert.equal(error.details.fieldName, "checkpoint");
        return true;
      }
    );
  }

  // null checkpoint becomes {}
  const empty = normalizeCodeClipProviderPollAdapterInput(
    validInput({ checkpoint: null })
  );
  assert.deepEqual(empty.checkpoint, {});
});

test("normalize adapter input limit is fail-closed without clamp", () => {
  for (const limit of [
    0,
    51,
    1.5,
    "25",
    null,
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    25n,
  ]) {
    assert.throws(
      () => normalizeCodeClipProviderPollAdapterInput(validInput({ limit })),
      (error) => {
        assertContractError(error, "INVALID_ADAPTER_INPUT");
        return true;
      }
    );
  }

  assert.equal(
    normalizeCodeClipProviderPollAdapterInput(validInput({ limit: 1 })).limit,
    1
  );
  assert.equal(
    normalizeCodeClipProviderPollAdapterInput(validInput({ limit: 50 })).limit,
    50
  );

  const { limit: _omit, ...withoutLimit } = validInput();
  assert.equal(
    normalizeCodeClipProviderPollAdapterInput(withoutLimit).limit,
    25
  );
});

// ---------------------------------------------------------------------------
// Success result
// ---------------------------------------------------------------------------

test("normalize success result accepts empty page and detections", () => {
  const empty = normalizeCodeClipProviderPollAdapterResult(
    {
      ok: true,
      detections: [],
      nextCheckpoint: {},
      page: { complete: true },
    },
    { provider: "youtube" }
  );
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.detections, []);
  assert.equal(empty.duplicateCount, 0);
  assert.equal(empty.page.complete, true);

  const one = normalizeCodeClipProviderPollAdapterResult(validSuccess(), {
    provider: "youtube",
  });
  assert.equal(one.detections.length, 1);
  assert.equal(one.detections[0].source, "data_api");
  assert.equal(one.detections[0].deliverySource, "data_api_polling");
  assert.equal(one.detections[0].providerObjectId, "video-1");
  assert.deepEqual(one.nextCheckpoint, { cursor: "1" });
});

test("normalize success result maps atom detection source", () => {
  const result = normalizeCodeClipProviderPollAdapterResult(
    validSuccess({
      detections: [validDetection({ source: "atom" })],
    }),
    { provider: "youtube" }
  );
  assert.equal(result.detections[0].source, "atom");
  assert.equal(result.detections[0].deliverySource, "atom_reconciliation");
});

test("normalize success result accepts optional fields and signals", () => {
  const result = normalizeCodeClipProviderPollAdapterResult(
    validSuccess({
      detections: [
        validDetection({
          canonicalUrl: "https://example.com/v/1",
          rawType: "video",
        }),
      ],
      signals: { classification: "success", retryAfterMs: 5_000 },
      page: { complete: false },
    }),
    { provider: "youtube" }
  );
  assert.equal(result.detections[0].canonicalUrl, "https://example.com/v/1");
  assert.equal(result.detections[0].rawType, "video");
  assert.deepEqual(result.signals, {
    classification: "success",
    retryAfterMs: 5_000,
  });
  assert.equal(result.page.complete, false);
});

test("normalize success result rejects malformed shapes and forbidden fields", () => {
  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: true,
          detections: [],
          nextCheckpoint: {},
          page: { complete: true },
          rawResponse: {},
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: true,
          detections: "nope",
          nextCheckpoint: {},
          page: { complete: true },
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: true,
          detections: [],
          nextCheckpoint: {},
          page: {},
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      assert.equal(error.details.fieldName, "page.complete");
      return true;
    }
  );

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: true,
          detections: Array.from({ length: 51 }, (_, i) =>
            validDetection({ providerObjectId: `id-${i}` })
          ),
          nextCheckpoint: {},
          page: { complete: true },
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );
});

test("normalize success result rejects invalid detection fields", () => {
  for (const bad of [
    { source: "manual" },
    { source: "websub" },
    { publishedAt: "not-a-date" },
    { detectedAt: null },
    { providerObjectId: "" },
    { canonicalUrl: "http://insecure.example" },
    { rawType: "BAD TYPE" },
    { headers: {} },
  ]) {
    assert.throws(
      () =>
        normalizeCodeClipProviderPollAdapterResult(
          validSuccess({
            detections: [validDetection(bad)],
          }),
          { provider: "youtube" }
        ),
      (error) => {
        assertContractError(error, "INVALID_ADAPTER_RESULT");
        return true;
      }
    );
  }
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

test("identical duplicate detections are deduped; conflicts rejected", () => {
  const deduped = normalizeCodeClipProviderPollAdapterResult(
    validSuccess({
      detections: [
        validDetection({ providerObjectId: "same" }),
        validDetection({ providerObjectId: "same" }),
        validDetection({ providerObjectId: "other" }),
      ],
    }),
    { provider: "youtube" }
  );
  assert.equal(deduped.detections.length, 2);
  assert.equal(deduped.duplicateCount, 1);
  assert.equal(deduped.detections[0].providerObjectId, "same");
  assert.equal(deduped.detections[1].providerObjectId, "other");

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        validSuccess({
          detections: [
            validDetection({
              providerObjectId: "same",
              publishedAt: "2026-08-01T10:00:00.000Z",
            }),
            validDetection({
              providerObjectId: "same",
              publishedAt: "2026-08-02T10:00:00.000Z",
            }),
          ],
        }),
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      assert.equal(error.details.reason, "CONFLICTING_DUPLICATE");
      return true;
    }
  );

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        validSuccess({
          detections: [
            validDetection({ providerObjectId: "same", source: "data_api" }),
            validDetection({ providerObjectId: "same", source: "atom" }),
          ],
        }),
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      assert.equal(error.details.reason, "CONFLICTING_DUPLICATE");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Failure result
// ---------------------------------------------------------------------------

test("normalize failure result accepts allowlisted classifications", () => {
  for (const classification of [
    "retryable",
    "rate_limited",
    "reauthorization_required",
    "credential_unusable",
    "terminal_configuration",
    "provider_malformed_response",
  ]) {
    const result = normalizeCodeClipProviderPollAdapterResult(
      {
        ok: false,
        classification,
        retryAfterMs: 60_000,
        code: "provider_timeout",
      },
      { provider: "youtube" }
    );
    assert.equal(result.ok, false);
    assert.equal(result.classification, classification);
    assert.equal(result.retryAfterMs, 60_000);
    assert.equal(result.code, "provider_timeout");
  }
});

test("normalize failure result rejects success classifications and bad shapes", () => {
  for (const classification of ["success", "empty", "nope"]) {
    assert.throws(
      () =>
        normalizeCodeClipProviderPollAdapterResult(
          { ok: false, classification },
          { provider: "youtube" }
        ),
      (error) => {
        assertContractError(error, "INVALID_ADAPTER_RESULT");
        return true;
      }
    );
  }

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: false,
          classification: "retryable",
          retryAfterMs: 100,
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );

  assert.throws(
    () =>
      normalizeCodeClipProviderPollAdapterResult(
        {
          ok: false,
          classification: "retryable",
          message: "raw body",
        },
        { provider: "youtube" }
      ),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("build polling external message id is stable and framework-owned", () => {
  const id = buildCodeClipProviderPollingExternalMessageId({
    provider: "youtube",
    providerObjectId: " video-abc ",
  });
  assert.equal(id, "poll:youtube:video-abc");

  const again = buildCodeClipProviderPollingExternalMessageId({
    provider: " YouTube ",
    providerObjectId: "video-abc",
  });
  assert.equal(again, id);

  assert.equal(id.includes("UC_"), false);
  assert.match(id, /^poll:youtube:/);
  // Fits ledger TEXT identity (no truncation)
  assert.ok(id.length <= 326);

  // Exact object-id max (256) is accepted for youtube
  const maxId = "a".repeat(256);
  const maxIdentity = buildCodeClipProviderPollingExternalMessageId({
    provider: "youtube",
    providerObjectId: maxId,
  });
  assert.equal(maxIdentity, `poll:youtube:${maxId}`);
  assert.equal(maxIdentity.length, "poll:youtube:".length + 256);

  // One over object-id max fails closed
  assert.throws(
    () =>
      buildCodeClipProviderPollingExternalMessageId({
        provider: "youtube",
        providerObjectId: "a".repeat(257),
      }),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollAdapterContractError);
      return true;
    }
  );

  assert.throws(
    () =>
      buildCodeClipProviderPollingExternalMessageId({
        provider: "meta",
        providerObjectId: "x",
      }),
    (error) => {
      assertContractError(error, "POLLING_NOT_SUPPORTED");
      return true;
    }
  );

  assert.throws(
    () =>
      buildCodeClipProviderPollingExternalMessageId({
        provider: "youtube",
        providerObjectId: "",
      }),
    (error) => {
      assertContractError(error, "INVALID_ADAPTER_RESULT");
      return true;
    }
  );
});

test("normalized success/failure results never include tokens or envelopes", () => {
  const success = normalizeCodeClipProviderPollAdapterResult(
    {
      ok: true,
      detections: [
        {
          providerObjectId: "v1",
          publishedAt: "2026-08-01T10:00:00.000Z",
          detectedAt: NOW,
          source: "data_api",
        },
      ],
      nextCheckpoint: {},
      page: { complete: true },
    },
    { provider: "youtube" }
  );
  assertNoTokenLeak(success);
  assert.equal(Object.hasOwn(success, "accessToken"), false);
  assert.equal(Object.hasOwn(success, "refreshToken"), false);
  assert.equal(JSON.stringify(success).includes("envelope"), false);

  const failure = normalizeCodeClipProviderPollAdapterResult(
    { ok: false, classification: "retryable", code: "timeout" },
    { provider: "youtube" }
  );
  assertNoTokenLeak(failure);
  assert.equal(Object.hasOwn(failure, "accessToken"), false);
});

test("provider_polling is available as delivery source but not mapped by existing policies", () => {
  const {
    isCodeClipProviderDeliveryInitialSource,
  } = require("./verticals/codeclip/provider-delivery-sources");
  const {
    mapCodeClipProviderDetectionSourceToDeliverySource,
    resolveCodeClipProviderPolicy,
  } = require("./verticals/codeclip/provider-policy");

  assert.equal(isCodeClipProviderDeliveryInitialSource("provider_polling"), true);

  const youtube = resolveCodeClipProviderPolicy("youtube");
  assert.equal(youtube.ok, true);
  const mapped = Object.values(youtube.policy.detection.sources).map(
    (entry) => entry.deliverySource
  );
  assert.deepEqual(mapped.sort(), ["atom_reconciliation", "data_api_polling"]);
  assert.equal(mapped.includes("provider_polling"), false);

  assert.deepEqual(
    mapCodeClipProviderDetectionSourceToDeliverySource("youtube", "data_api"),
    { ok: true, deliverySource: "data_api_polling" }
  );
  assert.deepEqual(
    mapCodeClipProviderDetectionSourceToDeliverySource("youtube", "atom"),
    { ok: true, deliverySource: "atom_reconciliation" }
  );

  for (const provider of ["meta", "sms", "test"]) {
    const resolved = resolveCodeClipProviderPolicy(provider);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.policy.detection, null);
  }
});
