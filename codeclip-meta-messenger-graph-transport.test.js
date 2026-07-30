const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const MODULE_PATH = path.join(__dirname, "verticals/codeclip/meta-messenger-graph-transport.js");

function loadTransport() {
  delete require.cache[require.resolve("./verticals/codeclip/meta-messenger-graph-transport")];
  return require("./verticals/codeclip/meta-messenger-graph-transport");
}

function validDeliverable(overrides = {}) {
  return {
    type: "reward_link",
    rewardTier: "clip",
    url: "https://rewards.example/clip-123",
    metadata: {
      displayTier: "Clip",
      title: "Backstage clip",
      rewardType: "video",
    },
    ...overrides,
  };
}

function validBuilderInput(overrides = {}) {
  return {
    providerAccountId: "page-123456789",
    recipientId: "psid-987654321",
    deliverable: validDeliverable(),
    graphApiVersion: "v19.0",
    ...overrides,
  };
}

function assertSecretFree(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /Authorization|Bearer|pageAccessToken|access_token|PAGE_ACCESS|secret-token/i);
}

test("module exports builder and executor for inbound-triggered Meta Messenger reward_link only", () => {
  const transport = loadTransport();
  assert.equal(typeof transport.buildMetaMessengerGraphSendRequest, "function");
  assert.equal(typeof transport.executeMetaMessengerGraphSend, "function");
  assert.doesNotMatch(
    fs.readFileSync(MODULE_PATH, "utf8"),
    /createOrGetCodeClipMetaMessengerOutbound|claimCodeClipMetaMessengerOutbound|recordCodeClipMetaMessengerOutbound|require\(["'].*redis|require\(["'].*\/db/
  );
});

test("builds valid inbound-triggered reward_link Graph request without secrets", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();
  const input = validBuilderInput();
  const frozen = JSON.parse(JSON.stringify(input));
  const result = buildMetaMessengerGraphSendRequest(input);

  assert.equal(result.ok, true);
  assert.equal(result.request.method, "POST");
  assert.equal(
    result.request.url,
    "https://graph.facebook.com/v19.0/page-123456789/messages"
  );
  assert.deepEqual(result.request.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(result.request.body, {
    recipient: { id: "psid-987654321" },
    messaging_type: "RESPONSE",
    message: {
      text: "Backstage clip\nhttps://rewards.example/clip-123",
    },
  });
  assert.equal(Object.hasOwn(result.request.headers, "Authorization"), false);
  assert.deepEqual(input, frozen);
  assertSecretFree(result);
});

test("requires explicit graphApiVersion and embeds it in URL", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();

  assert.equal(buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: undefined })).ok, false);
  assert.equal(buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: "" })).ok, false);
  assert.equal(
    buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: "21.0" })).reason,
    "GRAPH_API_VERSION_INVALID"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: "v21" })).reason,
    "GRAPH_API_VERSION_INVALID"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: "latest" })).reason,
    "GRAPH_API_VERSION_INVALID"
  );

  const ok = buildMetaMessengerGraphSendRequest(validBuilderInput({ graphApiVersion: "v22.0" }));
  assert.equal(ok.ok, true);
  assert.match(ok.request.url, /\/v22\.0\/page-123456789\/messages$/);
});

test("uses default Graph host and allows explicit base URL override for tests", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();
  const def = buildMetaMessengerGraphSendRequest(validBuilderInput());
  assert.match(def.request.url, /^https:\/\/graph\.facebook\.com\//);

  const overridden = buildMetaMessengerGraphSendRequest(
    validBuilderInput({ graphApiBaseUrl: "https://graph.test.local" })
  );
  assert.equal(
    overridden.request.url,
    "https://graph.test.local/v19.0/page-123456789/messages"
  );
});

test("message.text is deterministic from deliverable snapshot title and url", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();
  const first = buildMetaMessengerGraphSendRequest(validBuilderInput());
  const second = buildMetaMessengerGraphSendRequest(validBuilderInput());
  assert.deepEqual(first.request.body.message, second.request.body.message);
  assert.equal(first.request.body.message.text, "Backstage clip\nhttps://rewards.example/clip-123");

  const fallback = buildMetaMessengerGraphSendRequest(
    validBuilderInput({
      deliverable: validDeliverable({
        metadata: { displayTier: "Clip+", title: null, rewardType: "video" },
      }),
    })
  );
  assert.equal(fallback.request.body.message.text, "Clip+\nhttps://rewards.example/clip-123");
});

test("builder rejects missing identities and unsupported deliverables before any fetch", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();

  assert.equal(
    buildMetaMessengerGraphSendRequest(validBuilderInput({ recipientId: "" })).reason,
    "RECIPIENT_ID_REQUIRED"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(validBuilderInput({ providerAccountId: "" })).reason,
    "PROVIDER_ACCOUNT_ID_REQUIRED"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(
      validBuilderInput({ deliverable: validDeliverable({ type: "clip_xtra" }) })
    ).reason,
    "DELIVERABLE_TYPE_UNSUPPORTED"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(
      validBuilderInput({ deliverable: validDeliverable({ url: "http://insecure.example/x" }) })
    ).reason,
    "REWARD_URL_INVALID"
  );
  assert.equal(
    buildMetaMessengerGraphSendRequest(
      validBuilderInput({
        deliverable: validDeliverable({ url: "https://user:pass@rewards.example/x" }),
      })
    ).reason,
    "REWARD_URL_INVALID"
  );
});

test("builder rejects caller-controlled proactive send and auth injection fields", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();

  for (const [key, value] of [
    ["messaging_type", "UPDATE"],
    ["messagingType", "MESSAGE_TAG"],
    ["messageTag", "ACCOUNT_UPDATE"],
    ["tag", "ACCOUNT_UPDATE"],
    ["endpoint", "https://evil.example/messages"],
    ["Authorization", "Bearer stolen"],
    ["access_token", "stolen"],
    ["pageAccessToken", "stolen"],
  ]) {
    const result = buildMetaMessengerGraphSendRequest(validBuilderInput({ [key]: value }));
    assert.equal(result.ok, false, key);
    assert.ok(
      ["FORBIDDEN_TRANSPORT_FIELD", "MESSAGING_TYPE_OVERRIDE_FORBIDDEN"].includes(result.reason),
      key
    );
  }
});

test("builder does not require token and never embeds secrets", () => {
  const { buildMetaMessengerGraphSendRequest } = loadTransport();
  const result = buildMetaMessengerGraphSendRequest(validBuilderInput());
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.request, "pageAccessToken"), false);
  assertSecretFree(result.request);
  assertSecretFree(result.request.headers);
  assertSecretFree(result.request.body);
  assertSecretFree(result.request.safeMeta || {});
});

function mockResponse({ status = 200, body, headers = {}, jsonImpl } = {}) {
  const headerMap = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    status,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
    },
    async json() {
      if (typeof jsonImpl === "function") return jsonImpl();
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      if (typeof body === "string") return JSON.parse(body);
      return body;
    },
    async text() {
      if (body === undefined) return "";
      if (typeof body === "string") return body;
      return JSON.stringify(body);
    },
  };
}

test("executor success returns sent with providerMessageId and single Bearer fetch", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());
  assert.equal(built.ok, true);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return mockResponse({
      status: 200,
      body: { recipient_id: "psid-987654321", message_id: "  mid.abc-123  " },
    });
  };

  const result = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "sent");
  assert.equal(result.provider, "meta");
  assert.equal(result.channel, "messenger");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.providerMessageId, "mid.abc-123");
  assert.equal(result.retryable, false);
  assert.equal(result.terminal, true);
  assert.equal(result.failureCode, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, built.request.url);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token-value");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), built.request.body);
  assertSecretFree(result);
  assert.equal(Object.hasOwn(result, "Authorization"), false);
});

test("unconfirmed 2xx bodies never become sent and are terminal graph_success_unconfirmed", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());
  const cases = [
    { label: "missing", body: { recipient_id: "psid" } },
    { label: "empty", body: { message_id: "" } },
    { label: "non-string", body: { message_id: 123 } },
    { label: "empty-body", body: undefined },
    {
      label: "malformed",
      body: undefined,
      jsonImpl: async () => {
        throw new SyntaxError("bad json");
      },
    },
  ];

  for (const item of cases) {
    const result = await executeMetaMessengerGraphSend({
      request: built.request,
      pageAccessToken: "secret-token-value",
      fetchImpl: async () =>
        mockResponse({
          status: 200,
          body: item.body,
          jsonImpl: item.jsonImpl,
        }),
    });
    assert.equal(result.ok, false, item.label);
    assert.equal(result.outcome, "terminal_failed", item.label);
    assert.equal(result.retryable, false, item.label);
    assert.equal(result.terminal, true, item.label);
    assert.equal(result.failureCode, "graph_success_unconfirmed", item.label);
    assert.equal(result.providerMessageId, null, item.label);
    assertSecretFree(result);
  }
});

test("executor failures classify network timeout rate limit and auth errors", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());

  const network = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(network.outcome, "retryable_failed");
  assert.equal(network.failureCode, "graph_network_error");
  assert.equal(network.retryable, true);

  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const timeout = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () => {
      throw abortError;
    },
  });
  assert.equal(timeout.outcome, "retryable_failed");
  assert.equal(timeout.failureCode, "graph_timeout");
  assert.equal(timeout.retryable, true);

  const statusCases = [
    { status: 408, outcome: "retryable_failed", code: "graph_timeout", retryable: true },
    { status: 429, outcome: "retryable_failed", code: "graph_rate_limited", retryable: true },
    { status: 500, outcome: "retryable_failed", code: "graph_server_error", retryable: true },
    { status: 502, outcome: "retryable_failed", code: "graph_server_error", retryable: true },
    { status: 503, outcome: "retryable_failed", code: "graph_server_error", retryable: true },
    { status: 504, outcome: "retryable_failed", code: "graph_server_error", retryable: true },
    { status: 400, outcome: "terminal_failed", code: "graph_bad_request", retryable: false },
    { status: 401, outcome: "terminal_failed", code: "graph_unauthorized", retryable: false },
    { status: 403, outcome: "terminal_failed", code: "graph_forbidden", retryable: false },
    { status: 302, outcome: "terminal_failed", code: "graph_unexpected_redirect", retryable: false },
  ];

  for (const item of statusCases) {
    const result = await executeMetaMessengerGraphSend({
      request: built.request,
      pageAccessToken: "secret-token-value",
      fetchImpl: async () =>
        mockResponse({
          status: item.status,
          body: { error: { message: "provider text", code: 1, type: "OAuthException" } },
        }),
    });
    assert.equal(result.outcome, item.outcome, String(item.status));
    assert.equal(result.failureCode, item.code, String(item.status));
    assert.equal(result.retryable, item.retryable, String(item.status));
    assert.equal(result.terminal, !item.retryable, String(item.status));
    assert.equal(result.providerMessageId, null, String(item.status));
    assert.equal(Object.hasOwn(result.safeMetadata || {}, "errorMessage"), false, String(item.status));
    assertSecretFree(result);
  }
});

test("Meta is_transient true is retryable; permanent structured errors stay terminal", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());

  const transient = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 400,
        body: {
          error: {
            message: "temporary",
            type: "OAuthException",
            code: 2,
            error_subcode: 99,
            is_transient: true,
            fbtrace_id: "TRACE123",
          },
        },
      }),
  });
  assert.equal(transient.outcome, "retryable_failed");
  assert.equal(transient.failureCode, "graph_transient");
  assert.equal(transient.retryable, true);
  assert.equal(transient.safeMetadata.metaIsTransient, true);
  assert.equal(transient.safeMetadata.metaErrorCode, 2);
  assert.equal(transient.safeMetadata.metaErrorSubcode, 99);
  assert.equal(transient.safeMetadata.fbtraceId, "TRACE123");
  assert.equal(Object.hasOwn(transient.safeMetadata, "message"), false);

  const permanent = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 400,
        body: {
          error: {
            message: "bad user",
            type: "OAuthException",
            code: 100,
            error_subcode: 2018001,
            is_transient: false,
            fbtrace_id: "TRACE999",
          },
        },
      }),
  });
  assert.equal(permanent.outcome, "terminal_failed");
  assert.equal(permanent.failureCode, "graph_bad_request");
  assert.equal(permanent.retryable, false);
});

test("Retry-After seconds and HTTP-date are parsed and clamped without sleeping", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());

  const seconds = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 429,
        headers: { "Retry-After": "120" },
        body: { error: { code: 4, message: "rate" } },
      }),
  });
  assert.equal(seconds.failureCode, "graph_rate_limited");
  assert.equal(seconds.safeMetadata.retryAfterSeconds, 120);

  const future = new Date(Date.now() + 90_000).toUTCString();
  const dateBased = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 429,
        headers: { "Retry-After": future },
        body: { error: { code: 4 } },
      }),
  });
  assert.equal(dateBased.failureCode, "graph_rate_limited");
  assert.ok(dateBased.safeMetadata.retryAfterSeconds >= 1);
  assert.ok(dateBased.safeMetadata.retryAfterSeconds <= 3600);

  const huge = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 429,
        headers: { "Retry-After": "999999" },
        body: { error: { code: 4 } },
      }),
  });
  assert.equal(huge.safeMetadata.retryAfterSeconds, 3600);
});

test("malformed Meta error object and non-JSON error bodies classify by HTTP status", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());

  const malformed = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 400,
        body: { error: "not-an-object" },
      }),
  });
  assert.equal(malformed.outcome, "terminal_failed");
  assert.equal(malformed.failureCode, "graph_bad_request");

  const nonJson = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () =>
      mockResponse({
        status: 503,
        body: undefined,
        jsonImpl: async () => {
          throw new SyntaxError("nope");
        },
      }),
  });
  assert.equal(nonJson.outcome, "retryable_failed");
  assert.equal(nonJson.failureCode, "graph_server_error");
  assertSecretFree(nonJson);
  assert.equal(Object.hasOwn(nonJson, "body"), false);
  assert.equal(Object.hasOwn(nonJson.safeMetadata || {}, "rawBody"), false);
});

test("missing or empty pageAccessToken fails closed without fetch", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return mockResponse({ status: 200, body: { message_id: "mid.x" } });
  };

  const missing = await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "",
    fetchImpl,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureCode, "PAGE_ACCESS_TOKEN_REQUIRED");
  assert.equal(calls, 0);

  const absent = await executeMetaMessengerGraphSend({
    request: built.request,
    fetchImpl,
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.failureCode, "PAGE_ACCESS_TOKEN_REQUIRED");
  assert.equal(calls, 0);
});

test("validation failure does not call fetch; executor performs no retry loop", async () => {
  const { buildMetaMessengerGraphSendRequest, executeMetaMessengerGraphSend } = loadTransport();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("should not be called");
  };

  const invalid = buildMetaMessengerGraphSendRequest(validBuilderInput({ recipientId: "" }));
  assert.equal(invalid.ok, false);
  assert.equal(calls, 0);

  const built = buildMetaMessengerGraphSendRequest(validBuilderInput());
  await executeMetaMessengerGraphSend({
    request: built.request,
    pageAccessToken: "secret-token-value",
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("once");
    },
  });
  assert.equal(calls, 1);
});

test("transport module has no DB Redis repository claim or orchestration imports", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /require\(["']\.\/db["']\)|require\(["']\.\.\/\.\.\/db["']\)/);
  assert.doesNotMatch(source, /require\(["'].*redis["']\)/i);
  assert.doesNotMatch(source, /meta-messenger-outbound-repository/);
  assert.doesNotMatch(source, /claimCodeClipMetaMessengerOutboundDispatch/);
  assert.doesNotMatch(source, /recordCodeClipMetaMessengerOutboundDispatchResult/);
  assert.doesNotMatch(source, /createOrGetCodeClipMetaMessengerOutbound/);
  assert.doesNotMatch(source, /while\s*\(|setInterval|setTimeout\(\s*async/);
});
