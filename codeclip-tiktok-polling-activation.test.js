const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  CodeClipTikTokPollingActivationError,
  activateCodeClipTikTokPolling,
} = require("./verticals/codeclip/tiktok/polling-activation");
const {
  createCodeClipProviderPollAdapterRegistry,
} = require("./verticals/codeclip/provider-polling/adapter-registry");

const OPERATION_NOW = "2026-08-05T10:00:00.000Z";
const ACCOUNT_ID = "tiktok-account-activation";

function assertActivationError(error, code) {
  assert.ok(error instanceof CodeClipTikTokPollingActivationError);
  assert.equal(error.code, code);
  assert.equal(JSON.stringify(error).includes(ACCOUNT_ID), false);
  assert.equal(JSON.stringify(error).includes("secret"), false);
  assert.equal(JSON.stringify(error).includes("SELECT"), false);
}

function row(overrides = {}) {
  return {
    id: overrides.id || 1,
    vertical: overrides.vertical || "codeclip",
    provider: overrides.provider || "tiktok",
    environment: overrides.environment || "sandbox",
    account_lookup_key: overrides.account_lookup_key || overrides.provider_account_id || ACCOUNT_ID,
    provider_account_id: overrides.provider_account_id || overrides.account_lookup_key || ACCOUNT_ID,
    status: overrides.status || "active",
    poll_interval_ms: overrides.poll_interval_ms ?? 300_000,
    next_poll_at: overrides.next_poll_at ?? OPERATION_NOW,
    last_polled_at: overrides.last_polled_at ?? null,
    checkpoint: overrides.checkpoint || {},
    poll_claim_owner: overrides.poll_claim_owner ?? null,
    poll_claimed_at: overrides.poll_claimed_at ?? null,
    poll_claim_expires_at: overrides.poll_claim_expires_at ?? null,
    poll_claim_version: overrides.poll_claim_version ?? 0,
    consecutive_failures: overrides.consecutive_failures ?? 0,
    last_error_code: overrides.last_error_code ?? null,
    last_success_at: overrides.last_success_at ?? null,
    last_detection_at: overrides.last_detection_at ?? null,
    last_attempt_duration_ms: overrides.last_attempt_duration_ms ?? null,
    last_detections_count: overrides.last_detections_count ?? null,
    created_at: overrides.created_at || "2026-08-05T09:00:00.000Z",
    updated_at: overrides.updated_at || "2026-08-05T09:00:00.000Z",
    disabled_at: overrides.disabled_at ?? null,
  };
}

function makeStore(options = {}) {
  const state = {
    calls: [],
    events: options.events || [{ event_code: "CC-TIKTOK", vertical: "codeclip" }],
    bindings: options.bindings || [
      {
        id: 10,
        vertical: "codeclip",
        event_code: "CC-TIKTOK",
        provider: "tiktok",
        channel: "tiktok",
        provider_account_id: ACCOUNT_ID,
        status: "active",
        updated_at: "2026-08-05T09:00:00.000Z",
      },
    ],
    credentials: options.credentials || [
      {
        id: 20,
        vertical: "codeclip",
        provider: "tiktok",
        environment: "sandbox",
        account_lookup_key: ACCOUNT_ID,
        provider_account_id: ACCOUNT_ID,
        status: "active",
        token_type: "bearer",
        scopes: ["user.info.basic", "video.list"],
        has_access_token: true,
        has_refresh_token: true,
        access_token_expires_at: "2026-08-05T12:00:00.000Z",
        encryption_key_version: 1,
        reauthorization_reason: null,
        metadata: {},
        created_at: "2026-08-05T09:00:00.000Z",
        updated_at: "2026-08-05T09:00:00.000Z",
        disabled_at: null,
        revoked_at: null,
        last_refreshed_at: null,
      },
    ],
    sources: options.sources || [],
    nextSourceId: 100,
    rolledBack: false,
    committed: false,
  };

  async function query(sql, params = []) {
    state.calls.push({ sql, params });
    if (/^\s*BEGIN\s*$/i.test(sql)) return { rows: [] };
    if (/^\s*COMMIT\s*$/i.test(sql)) {
      state.committed = true;
      return { rows: [] };
    }
    if (/^\s*ROLLBACK\s*$/i.test(sql)) {
      state.rolledBack = true;
      return { rows: [] };
    }
    if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
      return { rows: [{ operation_now: params[0] || OPERATION_NOW }] };
    }
    if (/FROM campaigns/.test(sql)) {
      return { rows: state.events.filter((event) => event.event_code === params[0]) };
    }
    if (/FROM codeclip_provider_account_bindings/.test(sql)) {
      return {
        rows: state.bindings.filter(
          (binding) =>
            binding.vertical === params[0] &&
            binding.provider === params[1] &&
            binding.provider_account_id === params[2]
        ),
      };
    }
    if (/FROM codeclip_provider_credentials/.test(sql) && /account_lookup_key = \$4/.test(sql)) {
      return {
        rows: state.credentials
          .filter(
            (credential) =>
              credential.vertical === params[0] &&
              credential.provider === params[1] &&
              credential.environment === params[2] &&
              credential.account_lookup_key === params[3]
          )
          .map((credential) => ({ ...credential })),
      };
    }
    if (/FROM codeclip_provider_credentials/.test(sql) && /WHERE id = \$1/.test(sql)) {
      return {
        rows: state.credentials
          .filter((credential) => String(credential.id) === String(params[0]))
          .map((credential) => ({ ...credential })),
      };
    }
    if (/FROM codeclip_provider_poll_sources/.test(sql) && /account_lookup_key = \$4/.test(sql)) {
      const source = state.sources.find(
        (item) =>
          item.vertical === params[0] &&
          item.provider === params[1] &&
          item.environment === params[2] &&
          item.account_lookup_key === params[3]
      );
      return { rows: source ? [{ ...source }] : [] };
    }
    if (/FROM codeclip_provider_poll_sources/.test(sql) && /FOR UPDATE/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      return { rows: source ? [{ ...source }] : [] };
    }
    if (/INSERT INTO codeclip_provider_poll_sources/.test(sql)) {
      const source = row({
        id: state.nextSourceId++,
        provider: params[1],
        environment: params[2],
        account_lookup_key: params[3],
        provider_account_id: params[4],
        poll_interval_ms: params[5],
        next_poll_at: params[6],
        checkpoint: JSON.parse(params[7]),
        created_at: params[8],
        updated_at: params[8],
      });
      state.sources.push(source);
      return { rows: [{ ...source }] };
    }
    if (/UPDATE codeclip_provider_poll_sources/.test(sql) && /AND status = 'paused'/.test(sql)) {
      const source = state.sources.find((item) => String(item.id) === String(params[0]));
      if (!source || source.status !== "paused") return { rows: [] };
      source.status = "active";
      source.next_poll_at = params[1];
      source.last_error_code = null;
      source.poll_claim_owner = null;
      source.poll_claimed_at = null;
      source.poll_claim_expires_at = null;
      source.updated_at = params[2];
      return { rows: [{ ...source }] };
    }
    return { rows: [] };
  }

  return {
    state,
    pool: {
      async connect() {
        return { query, release() {} };
      },
    },
  };
}

function goodRegistry() {
  return { get: () => ({ provider: "tiktok", poll: async () => ({}) }) };
}

test("activation module exposes only the public API and has no console logging", () => {
  const exported = require("./verticals/codeclip/tiktok/polling-activation");
  assert.deepEqual(Object.keys(exported).sort(), [
    "CodeClipTikTokPollingActivationError",
    "activateCodeClipTikTokPolling",
  ].sort());
  const source = fs.readFileSync(
    require.resolve("./verticals/codeclip/tiktok/polling-activation"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
});

test("activation creates an immediately due TikTok poll source after all gates pass", async () => {
  const { pool, state } = makeStore();
  const result = await activateCodeClipTikTokPolling(
    {
      eventCode: "CC-TIKTOK",
      environment: "sandbox",
      providerAccountId: ACCOUNT_ID,
      pollIntervalMs: 300_000,
      now: OPERATION_NOW,
    },
    { queryClient: pool, adapterRegistry: goodRegistry() }
  );

  assert.deepEqual(result, {
    ok: true,
    status: "activated",
    sourceId: "100",
    provider: "tiktok",
    environment: "sandbox",
    eventCode: "CC-TIKTOK",
    pollIntervalMs: 300_000,
    nextPollAt: OPERATION_NOW,
  });
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].status, "active");
  assert.deepEqual(state.sources[0].checkpoint, {});
  assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
});

test("activation is idempotent for existing active source", async () => {
  const existing = row({ id: 44, status: "active", checkpoint: { initialized: true } });
  const { pool, state } = makeStore({ sources: [existing] });
  const result = await activateCodeClipTikTokPolling(
    {
      eventCode: "CC-TIKTOK",
      environment: "sandbox",
      providerAccountId: ACCOUNT_ID,
      now: OPERATION_NOW,
    },
    { queryClient: pool, adapterRegistry: goodRegistry() }
  );
  assert.equal(result.status, "already_active");
  assert.equal(result.sourceId, "44");
  assert.equal(state.sources.length, 1);
  assert.deepEqual(state.sources[0].checkpoint, { initialized: true });
});

test("activation reactivates paused source without resetting checkpoint", async () => {
  const checkpoint = {
    initialized: true,
    highWaterPublishedAt: "2026-08-05T09:00:00.000Z",
    highWaterVideoId: "old",
  };
  const existing = row({
    id: 45,
    status: "paused",
    next_poll_at: null,
    checkpoint,
    last_error_code: "reauthorization_required",
  });
  const { pool, state } = makeStore({ sources: [existing] });
  const result = await activateCodeClipTikTokPolling(
    {
      eventCode: "CC-TIKTOK",
      environment: "sandbox",
      providerAccountId: ACCOUNT_ID,
      now: OPERATION_NOW,
    },
    { queryClient: pool, adapterRegistry: goodRegistry() }
  );
  assert.equal(result.status, "reactivated");
  assert.equal(state.sources[0].status, "active");
  assert.equal(state.sources[0].next_poll_at, OPERATION_NOW);
  assert.equal(state.sources[0].last_error_code, null);
  assert.deepEqual(state.sources[0].checkpoint, checkpoint);
});

test("activation rejects disabled source and leaves it unchanged", async () => {
  const existing = row({ id: 46, status: "disabled", next_poll_at: null, checkpoint: { keep: true } });
  const { pool, state } = makeStore({ sources: [existing] });
  await assert.rejects(
    () =>
      activateCodeClipTikTokPolling(
        {
          eventCode: "CC-TIKTOK",
          environment: "sandbox",
          providerAccountId: ACCOUNT_ID,
          now: OPERATION_NOW,
        },
        { queryClient: pool, adapterRegistry: goodRegistry() }
      ),
    (error) => {
      assertActivationError(error, "TIKTOK_POLL_SOURCE_DISABLED");
      return true;
    }
  );
  assert.equal(state.sources[0].status, "disabled");
  assert.deepEqual(state.sources[0].checkpoint, { keep: true });
});

test("activation requires event, active same-event binding, usable credential and exact video.list scope", async () => {
  for (const [name, override, code] of [
    ["missing event", { events: [] }, "EVENT_NOT_FOUND"],
    ["wrong vertical event", { events: [{ event_code: "CC-TIKTOK", vertical: "codepod" }] }, "INVALID_EVENT"],
    ["missing binding", { bindings: [] }, "TIKTOK_BINDING_NOT_FOUND"],
    [
      "disabled binding",
      { bindings: [{ id: 1, vertical: "codeclip", event_code: "CC-TIKTOK", provider: "tiktok", channel: "tiktok", provider_account_id: ACCOUNT_ID, status: "disabled", updated_at: OPERATION_NOW }] },
      "TIKTOK_BINDING_DISABLED",
    ],
    [
      "binding conflict",
      { bindings: [{ id: 1, vertical: "codeclip", event_code: "CC-OTHER", provider: "tiktok", channel: "tiktok", provider_account_id: ACCOUNT_ID, status: "active", updated_at: OPERATION_NOW }] },
      "TIKTOK_BINDING_CONFLICT",
    ],
    ["missing credential", { credentials: [] }, "TIKTOK_CREDENTIAL_NOT_FOUND"],
    [
      "missing token",
      { credentials: [{ ...makeStore().state.credentials[0], has_access_token: false }] },
      "TIKTOK_CREDENTIAL_UNUSABLE",
    ],
    [
      "expired token",
      { credentials: [{ ...makeStore().state.credentials[0], access_token_expires_at: "2026-08-05T09:00:00.000Z" }] },
      "TIKTOK_CREDENTIAL_UNUSABLE",
    ],
    [
      "reauth",
      { credentials: [{ ...makeStore().state.credentials[0], status: "reauthorization_required" }] },
      "TIKTOK_REAUTHORIZATION_REQUIRED",
    ],
    [
      "disabled credential",
      { credentials: [{ ...makeStore().state.credentials[0], status: "disabled" }] },
      "TIKTOK_CREDENTIAL_DISABLED",
    ],
    [
      "revoked credential",
      { credentials: [{ ...makeStore().state.credentials[0], status: "revoked" }] },
      "TIKTOK_CREDENTIAL_REVOKED",
    ],
    [
      "missing scope",
      { credentials: [{ ...makeStore().state.credentials[0], scopes: ["user.info.basic"] }] },
      "TIKTOK_VIDEO_LIST_SCOPE_REQUIRED",
    ],
    [
      "substring scope",
      { credentials: [{ ...makeStore().state.credentials[0], scopes: ["prefix.video.list"] }] },
      "TIKTOK_VIDEO_LIST_SCOPE_REQUIRED",
    ],
    [
      "wrong environment",
      { credentials: [{ ...makeStore().state.credentials[0], environment: "production" }] },
      "TIKTOK_CREDENTIAL_NOT_FOUND",
    ],
  ]) {
    const { pool, state } = makeStore(override);
    await assert.rejects(
      () =>
        activateCodeClipTikTokPolling(
          {
            eventCode: "CC-TIKTOK",
            environment: "sandbox",
            providerAccountId: ACCOUNT_ID,
            now: OPERATION_NOW,
          },
          { queryClient: pool, adapterRegistry: goodRegistry() }
        ),
      (error) => {
        assertActivationError(error, code);
        return true;
      },
      name
    );
    assert.equal(state.sources.length, 0, `${name} must not mutate sources`);
  }
});

test("activation validates adapter registry before database mutation", async () => {
  const { pool, state } = makeStore();
  for (const registry of [
    null,
    {},
    { get: () => null },
    { get: () => ({ provider: "youtube", poll: async () => ({}) }) },
    { get: () => { throw new Error("not registered"); } },
  ]) {
    await assert.rejects(
      () =>
        activateCodeClipTikTokPolling(
          {
            eventCode: "CC-TIKTOK",
            environment: "sandbox",
            providerAccountId: ACCOUNT_ID,
            now: OPERATION_NOW,
          },
          { queryClient: pool, adapterRegistry: registry }
        ),
      (error) => {
        assertActivationError(error, "TIKTOK_POLL_ADAPTER_NOT_AVAILABLE");
        return true;
      }
    );
  }
  assert.equal(state.calls.some((call) => /BEGIN/.test(call.sql)), false);
  assert.equal(state.sources.length, 0);
});

test("default production registry can satisfy adapter gate without HTTP", async () => {
  const { pool, state } = makeStore();
  await activateCodeClipTikTokPolling(
    {
      eventCode: "CC-TIKTOK",
      environment: "sandbox",
      providerAccountId: ACCOUNT_ID,
      now: OPERATION_NOW,
    },
    { queryClient: pool }
  );
  assert.equal(state.sources.length, 1);
});

test("activation rejects invalid public input and query dependencies", async () => {
  for (const input of [
    {},
    { eventCode: "", environment: "sandbox", providerAccountId: ACCOUNT_ID },
    { eventCode: "CC", environment: "dev", providerAccountId: ACCOUNT_ID },
    { eventCode: "CC", environment: "sandbox", providerAccountId: "" },
    { eventCode: "CC", environment: "sandbox", providerAccountId: ACCOUNT_ID, pollIntervalMs: 29_999 },
    { eventCode: "CC", environment: "sandbox", providerAccountId: ACCOUNT_ID, pollIntervalMs: "300000" },
  ]) {
    await assert.rejects(
      () =>
        activateCodeClipTikTokPolling(input, {
          queryClient: makeStore().pool,
          adapterRegistry: goodRegistry(),
        }),
      (error) => {
        assertActivationError(error, "INVALID_POLLING_ACTIVATION");
        return true;
      }
    );
  }

  await assert.rejects(
    () =>
      activateCodeClipTikTokPolling(
        {
          eventCode: "CC",
          environment: "sandbox",
          providerAccountId: ACCOUNT_ID,
        },
        { queryClient: { query: async () => ({ rows: [] }) }, adapterRegistry: goodRegistry() }
      ),
    (error) => {
      assertActivationError(error, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
});
