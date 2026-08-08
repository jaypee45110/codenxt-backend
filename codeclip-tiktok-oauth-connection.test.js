const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CodeClipTikTokOAuthConnectionError,
  startCodeClipTikTokOAuthConnection,
  completeCodeClipTikTokOAuthConnection,
} = require("./verticals/codeclip/tiktok/oauth-connection");
const {
  CodeClipProviderCredentialError,
} = require("./verticals/codeclip/provider-credentials");
const {
  CodeClipProviderAccountBindingError,
} = require("./verticals/codeclip/provider-account-bindings");

const NOW = "2026-08-05T12:00:00.000Z";
const EVENT = "CC-TIKTOK-1";
const RETURN = "https://app.example.test/checkout/tiktok";
const REDIRECT =
  "https://api.example.test/api/codeclip/providers/tiktok/oauth/callback";
const AUTH_CODE = "tt-auth-code-secret-do-not-leak";
const RAW_STATE = "raw-state-value-secret-do-not-leak";
const OPEN_ID = "OpenId_Case_ABC";
const ACCESS = "access-token-secret-xyz";
const REFRESH = "refresh-token-secret-xyz";
const CLIENT_SECRET = "tt-client-secret-value";

function envBase(extra = {}) {
  return {
    CODECLIP_TIKTOK_CLIENT_KEY: "tt_client_key",
    CODECLIP_TIKTOK_CLIENT_SECRET: CLIENT_SECRET,
    CODECLIP_TIKTOK_SANDBOX_CLIENT_KEY: "tt_sandbox_client_key",
    CODECLIP_TIKTOK_SANDBOX_CLIENT_SECRET: "tt_sandbox_client_secret",
    CODECLIP_TIKTOK_REDIRECT_URI: REDIRECT,
    CODECLIP_TIKTOK_RETURN_URL_ALLOWLIST: RETURN,
    ...extra,
  };
}

function tokenResult(overrides = {}) {
  return {
    openId: OPEN_ID,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenType: "Bearer",
    scopes: ["user.info.basic"],
    accessTokenExpiresAt: "2026-08-05T13:00:00.000Z",
    refreshTokenExpiresAt: "2026-08-06T12:00:00.000Z",
    expiresIn: 3600,
    refreshExpiresIn: 86400,
    ...overrides,
  };
}

function claimedState(overrides = {}) {
  return {
    id: "42",
    eventCode: EVENT,
    environment: "sandbox",
    redirectUri: REDIRECT,
    returnUrl: RETURN,
    createdBy: "operator_key:system",
    status: "claimed",
    claimOwner: "tiktok-oauth-callback:test",
    claimVersion: 1,
    ...overrides,
  };
}

function assertNoLeak(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    AUTH_CODE,
    RAW_STATE,
    ACCESS,
    REFRESH,
    CLIENT_SECRET,
    OPEN_ID,
    "error_description",
    "log_id",
    "SELECT ",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function createPoolHarness({ onBegin } = {}) {
  const events = [];
  let clientReleased = false;
  const client = {
    async query(sql) {
      const normalized = String(sql).trim().toUpperCase();
      if (normalized === "BEGIN") {
        events.push("BEGIN");
        if (onBegin) onBegin();
        return { rows: [] };
      }
      if (normalized === "COMMIT") {
        events.push("COMMIT");
        return { rows: [] };
      }
      if (normalized === "ROLLBACK") {
        events.push("ROLLBACK");
        return { rows: [] };
      }
      events.push(`QUERY:${normalized.slice(0, 40)}`);
      return { rows: [] };
    },
    release() {
      clientReleased = true;
      events.push("RELEASE");
    },
  };
  return {
    events,
    isReleased: () => clientReleased,
    pool: {
      async connect() {
        events.push("CONNECT");
        return client;
      },
    },
    client,
  };
}

test("public API surface is minimal", () => {
  const mod = require("./verticals/codeclip/tiktok/oauth-connection");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipTikTokOAuthConnectionError",
    "completeCodeClipTikTokOAuthConnection",
    "startCodeClipTikTokOAuthConnection",
  ]);
});

test("module has no console usage", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/tiktok/oauth-connection.js"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
});

test("start returns authorization URL without raw state field", async () => {
  let nextId = 1;
  const queryClient = {
    async query(sql, params = []) {
      if (/^\s*BEGIN|COMMIT|ROLLBACK\s*$/i.test(String(sql).trim())) {
        return { rows: [] };
      }
      if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
        return { rows: [{ operation_now: new Date(params[0] || NOW) }] };
      }
      if (/INSERT INTO codeclip_tiktok_oauth_states/.test(sql)) {
        return {
          rows: [
            {
              id: nextId++,
              state_hash: params[0],
              event_code: params[1],
              environment: params[2],
              redirect_uri: params[3],
              requested_scopes: params[4],
              return_url: params[5],
              created_by: params[6],
              status: "pending",
              claim_owner: null,
              claimed_at: null,
              claim_expires_at: null,
              claim_version: 0,
              created_at: params[7],
              expires_at: params[8],
              completed_at: null,
              consumed_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const result = await startCodeClipTikTokOAuthConnection(
    {
      eventCode: EVENT,
      environment: "sandbox",
      returnUrl: RETURN,
      now: NOW,
    },
    {
      env: envBase(),
      queryClient,
      getEventByCode: async () => ({
        event_code: EVENT,
        vertical: "codeclip",
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(typeof result.authorizationUrl, "string");
  assert.ok(result.authorizationUrl.includes("https://www.tiktok.com/v2/auth/authorize/"));
  assert.equal(typeof result.expiresAt, "string");
  assert.equal(Object.hasOwn(result, "rawState"), false);
  assert.equal(Object.hasOwn(result, "state"), false);
  const url = new URL(result.authorizationUrl);
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.get("client_key"), "tt_sandbox_client_key");
});

test("start rejects operator_key actor and invalid actor shapes", async () => {
  const queryClient = { async query() { return { rows: [] }; } };
  const getEventByCode = async () => ({ event_code: EVENT, vertical: "codeclip" });

  await assert.rejects(
    () =>
      startCodeClipTikTokOAuthConnection(
        {
          eventCode: EVENT,
          environment: "sandbox",
          returnUrl: RETURN,
          actor: { type: "operator_key", id: "admin" },
          now: NOW,
        },
        { env: envBase(), queryClient, getEventByCode }
      ),
    (error) => error.code === "INVALID_CALLBACK"
  );

  await assert.rejects(
    () =>
      startCodeClipTikTokOAuthConnection(
        {
          eventCode: EVENT,
          environment: "sandbox",
          returnUrl: RETURN,
          actor: { type: "operator" },
          now: NOW,
        },
        { env: envBase(), queryClient, getEventByCode }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_CALLBACK");
      assertNoLeak(error);
      return true;
    }
  );
});

test("success path creates credential + binding + completes state in one TX", async () => {
  const harness = createPoolHarness();
  const calls = {
    claim: 0,
    exchange: 0,
    createCred: 0,
    updateCred: 0,
    createBind: 0,
    complete: 0,
    findCred: 0,
  };
  let exchangeDuringTx = false;

  const result = await completeCodeClipTikTokOAuthConnection(
    {
      code: AUTH_CODE,
      state: RAW_STATE,
      now: NOW,
      requestId: "req-1",
    },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => {
        calls.claim += 1;
        return {
          ok: true,
          claimVersion: 1,
          oauthState: claimedState(),
          alreadyCompleted: false,
        };
      },
      exchangeCode: async (input) => {
        calls.exchange += 1;
        assert.equal(input.code, AUTH_CODE);
        assert.equal(input.environment, "sandbox");
        assert.equal(input.redirectUri, REDIRECT);
        assert.equal(harness.events.includes("BEGIN"), false);
        return tokenResult();
      },
      findCredential: async () => {
        calls.findCred += 1;
        return null;
      },
      createCredential: async (input, opts) => {
        calls.createCred += 1;
        assert.equal(opts.queryClient, harness.client);
        assert.equal(input.provider, "tiktok");
        assert.equal(input.providerAccountId, OPEN_ID);
        assert.equal(input.accessToken, ACCESS);
        assert.deepEqual(input.metadata, {
          refreshTokenExpiresAt: "2026-08-06T12:00:00.000Z",
        });
        // Model C: stable system actor for credential audit
        assert.deepEqual(opts.actor, {
          type: "system",
          id: "tiktok_oauth_callback",
        });
        if (!harness.events.includes("BEGIN")) exchangeDuringTx = true;
        return {
          created: true,
          credential: { id: "9", status: "active", providerAccountId: OPEN_ID },
        };
      },
      updateCredentialTokens: async () => {
        calls.updateCred += 1;
        throw new Error("should not update");
      },
      createBinding: async (input, { queryClient }) => {
        calls.createBind += 1;
        assert.equal(queryClient, harness.client);
        assert.equal(input.provider, "tiktok");
        assert.equal(input.channel, "tiktok");
        assert.equal(input.eventCode, EVENT);
        assert.equal(input.providerAccountId, OPEN_ID);
        return {
          created: true,
          row: {
            id: "b1",
            eventCode: EVENT,
            provider: "tiktok",
            channel: "tiktok",
            providerAccountId: OPEN_ID,
            status: "active",
          },
        };
      },
      appendBindingAudit: async (payload) => {
        // Binding audit allowlist: operator_key without id
        assert.equal(payload.actorType, "operator_key");
        assert.equal(payload.actorId, null);
        return { ok: true };
      },
      completeState: async (input, { queryClient }) => {
        calls.complete += 1;
        assert.equal(queryClient, harness.client);
        assert.equal(input.stateId, "42");
        assert.equal(input.expectedClaimVersion, 1);
        assert.match(String(input.owner), /^tiktok-oauth-callback:/);
        return { status: "completed", alreadyCompleted: false };
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "connected");
  assert.equal(result.credentialCreated, true);
  assert.equal(result.bindingCreated, true);
  const location = new URL(result.redirectUrl);
  assert.equal(location.origin + location.pathname, "https://app.example.test/checkout/tiktok");
  assert.equal(location.searchParams.get("tiktok"), "connected");
  assert.equal(location.searchParams.has("code"), false);
  assert.equal(location.searchParams.has("state"), false);
  assert.equal(location.searchParams.has("openId"), false);
  assert.deepEqual(harness.events.filter((e) => e === "BEGIN" || e === "COMMIT"), [
    "BEGIN",
    "COMMIT",
  ]);
  assert.equal(harness.events.includes("ROLLBACK"), false);
  assert.equal(harness.isReleased(), true);
  assert.equal(calls.claim, 1);
  assert.equal(calls.exchange, 1);
  assert.equal(calls.createCred, 1);
  assert.equal(calls.createBind, 1);
  assert.equal(calls.complete, 1);
  assert.equal(exchangeDuringTx, false);
  assertNoLeak(result);
});

test("existing active credential updates tokens; same-event binding is idempotent", async () => {
  const harness = createPoolHarness();
  let updated = false;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 2,
        oauthState: claimedState({ claimVersion: 2 }),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => ({
        id: "7",
        status: "active",
        metadata: { prior: true },
      }),
      createCredential: async () => {
        throw new Error("should not create");
      },
      updateCredentialTokens: async (id, patch) => {
        updated = true;
        assert.equal(String(id), "7");
        assert.equal(patch.accessToken, ACCESS);
        assert.equal(patch.metadata.refreshTokenExpiresAt, "2026-08-06T12:00:00.000Z");
        assert.equal(patch.metadata.prior, true);
        return { credential: { id: "7", status: "active" } };
      },
      createBinding: async () => ({
        created: false,
        existing: true,
        row: {
          id: "b1",
          eventCode: EVENT,
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
        },
      }),
      completeState: async () => ({ status: "completed" }),
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(updated, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "already_connected");
  assert.equal(new URL(result.redirectUrl).searchParams.get("tiktok"), "already_connected");
});

test("reauthorization_required credential is recovered via token update", async () => {
  const harness = createPoolHarness();
  let updated = false;
  await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => ({
        id: "8",
        status: "reauthorization_required",
        metadata: {},
      }),
      updateCredentialTokens: async () => {
        updated = true;
        return { credential: { id: "8", status: "active" } };
      },
      createBinding: async () => ({
        created: true,
        row: {
          id: "b2",
          eventCode: EVENT,
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
        },
      }),
      appendBindingAudit: async () => ({}),
      completeState: async () => ({ status: "completed" }),
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(updated, true);
  assert.deepEqual(harness.events.filter((e) => e === "COMMIT"), ["COMMIT"]);
});

test("disabled credential fails closed without completing state", async () => {
  const harness = createPoolHarness();
  let completeCalls = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => ({ id: "1", status: "disabled", metadata: {} }),
      createBinding: async () => {
        throw new Error("binding should not run");
      },
      completeState: async () => {
        completeCalls += 1;
        return { status: "completed" };
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CREDENTIAL_DISABLED");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "reauthorization_required"
  );
  assert.equal(completeCalls, 0);
  assert.equal(harness.events.includes("ROLLBACK"), true);
  assert.equal(harness.events.includes("COMMIT"), false);
  assertNoLeak(result);
});

test("revoked credential fails closed", async () => {
  const harness = createPoolHarness();
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => ({ id: "1", status: "revoked", metadata: {} }),
      completeState: async () => {
        throw new Error("should not complete");
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(result.errorCode, "CREDENTIAL_REVOKED");
  assert.equal(harness.events.includes("ROLLBACK"), true);
});

test("binding conflict rolls back credential mutation and does not complete", async () => {
  const harness = createPoolHarness();
  let completeCalls = 0;
  let createCred = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async () => {
        createCred += 1;
        return { created: true, credential: { id: "9", status: "active" } };
      },
      createBinding: async () => {
        throw new CodeClipProviderAccountBindingError(
          "PROVIDER_ACCOUNT_BINDING_CONFLICT",
          "bound elsewhere",
          { eventCode: "OTHER-EVENT", bindingId: "x" }
        );
      },
      completeState: async () => {
        completeCalls += 1;
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(createCred, 1);
  assert.equal(completeCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "BINDING_CONFLICT");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "binding_conflict"
  );
  assert.equal(harness.events.includes("ROLLBACK"), true);
  assert.equal(harness.events.includes("COMMIT"), false);
});

test("disabled binding same event is reactivated in same transaction", async () => {
  const harness = createPoolHarness();
  let reactivated = false;
  let audited = false;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async () => ({
        created: true,
        credential: { id: "9", status: "active" },
      }),
      createBinding: async () => {
        throw new CodeClipProviderAccountBindingError(
          "PROVIDER_ACCOUNT_BINDING_CONFLICT",
          "disabled",
          {
            reactivationRequired: true,
            eventCode: EVENT,
            bindingId: "bind-disabled-1",
          }
        );
      },
      reactivateBinding: async (id, { queryClient }) => {
        reactivated = true;
        assert.equal(id, "bind-disabled-1");
        assert.equal(queryClient, harness.client);
        return {
          reactivated: true,
          row: {
            id,
            eventCode: EVENT,
            provider: "tiktok",
            channel: "tiktok",
            status: "active",
          },
        };
      },
      appendBindingAudit: async () => {
        audited = true;
      },
      completeState: async () => ({ status: "completed" }),
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(reactivated, true);
  assert.equal(audited, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "connected");
  assert.equal(harness.events.includes("COMMIT"), true);
});

test("provider cancel redirects without exchange or persistence", async () => {
  let exchange = 0;
  let complete = 0;
  let createCred = 0;
  let claimLease = null;
  const result = await completeCodeClipTikTokOAuthConnection(
    {
      state: RAW_STATE,
      error: "access_denied",
      error_description: "User cancelled login",
      now: NOW,
    },
    {
      queryClient: createPoolHarness().pool,
      claimState: async (input) => {
        claimLease = input.leaseMs;
        return {
          ok: true,
          claimVersion: 1,
          oauthState: claimedState(),
        };
      },
      exchangeCode: async () => {
        exchange += 1;
        return tokenResult();
      },
      createCredential: async () => {
        createCred += 1;
      },
      completeState: async () => {
        complete += 1;
      },
    }
  );
  assert.equal(exchange, 0);
  assert.equal(complete, 0);
  assert.equal(createCred, 0);
  assert.equal(claimLease, 300_000);
  assert.equal(result.ok, false);
  assert.equal(result.status, "authorization_cancelled");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "authorization_cancelled"
  );
  assertNoLeak(result);
  assert.equal(JSON.stringify(result).includes("User cancelled"), false);
  assert.equal(JSON.stringify(result).includes("access_denied"), false);
});

test("duplicate cancellation while claim active redirects safely without exchange", async () => {
  let exchange = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    {
      state: RAW_STATE,
      error: "access_denied",
      error_description: "User cancelled again",
      now: NOW,
    },
    {
      queryClient: createPoolHarness().pool,
      claimState: async () => ({
        ok: false,
        reason: "OAUTH_STATE_CONTENTION",
        oauthState: claimedState({
          claimOwner: "tiktok-oauth-callback:other",
          status: "claimed",
        }),
      }),
      exchangeCode: async () => {
        exchange += 1;
        return tokenResult();
      },
    }
  );
  assert.equal(exchange, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, "authorization_cancelled");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "authorization_cancelled"
  );
  assert.equal(JSON.stringify(result).includes("User cancelled again"), false);
  assertNoLeak(result);
});

test("code after cancellation claim cannot connect", async () => {
  let exchange = 0;
  let createCred = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    {
      code: AUTH_CODE,
      state: RAW_STATE,
      now: NOW,
    },
    {
      queryClient: createPoolHarness().pool,
      claimState: async () => ({
        ok: false,
        reason: "OAUTH_STATE_CONTENTION",
        oauthState: claimedState({ status: "claimed" }),
      }),
      exchangeCode: async () => {
        exchange += 1;
        return tokenResult();
      },
      createCredential: async () => {
        createCred += 1;
      },
    }
  );
  assert.equal(exchange, 0);
  assert.equal(createCred, 0);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "OAUTH_STATE_CONTENTION");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "authorization_failed"
  );
  assertNoLeak(result);
});

test("expired state after cancellation fails closed", async () => {
  const { CodeClipTikTokOAuthError } = require("./verticals/codeclip/tiktok/oauth-state");
  await assert.rejects(
    () =>
      completeCodeClipTikTokOAuthConnection(
        { code: AUTH_CODE, state: RAW_STATE, now: NOW },
        {
          queryClient: createPoolHarness().pool,
          claimState: async () => {
            throw new CodeClipTikTokOAuthError(
              "OAUTH_STATE_EXPIRED",
              "expired"
            );
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "OAUTH_STATE_EXPIRED");
      assertNoLeak(error);
      return true;
    }
  );
});

test("callback ignores query actor override and uses system credential actor", async () => {
  const harness = createPoolHarness();
  let seenActor = null;
  await completeCodeClipTikTokOAuthConnection(
    {
      code: AUTH_CODE,
      state: RAW_STATE,
      actor: { type: "operator", id: "attacker" },
      now: NOW,
    },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState({ createdBy: "system:tiktok_oauth_start" }),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async (_input, opts) => {
        seenActor = opts.actor;
        return {
          created: true,
          credential: { id: "9", status: "active" },
        };
      },
      createBinding: async () => ({
        created: true,
        row: {
          id: "b1",
          eventCode: EVENT,
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
        },
      }),
      appendBindingAudit: async () => ({}),
      completeState: async () => ({ status: "completed" }),
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.deepEqual(seenActor, {
    type: "system",
    id: "tiktok_oauth_callback",
  });
});

test("credential audit actor failure rolls back without completing state", async () => {
  const harness = createPoolHarness();
  let completeCalls = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async () => {
        throw new CodeClipProviderCredentialError(
          "INVALID_CREDENTIAL_INPUT",
          "actor invalid for audit"
        );
      },
      completeState: async () => {
        completeCalls += 1;
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(completeCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(harness.events.includes("ROLLBACK"), true);
  assert.equal(harness.events.includes("COMMIT"), false);
});

test("duplicate completed callback does not exchange or mutate", async () => {
  let exchange = 0;
  let findCred = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: createPoolHarness().pool,
      claimState: async () => ({
        ok: true,
        alreadyCompleted: true,
        status: "completed",
        oauthState: claimedState({ status: "completed" }),
      }),
      exchangeCode: async () => {
        exchange += 1;
        return tokenResult();
      },
      findCredential: async () => {
        findCred += 1;
        return null;
      },
    }
  );
  assert.equal(exchange, 0);
  assert.equal(findCred, 0);
  assert.equal(result.status, "already_connected");
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "already_connected"
  );
});

test("missing state fails closed without redirect", async () => {
  await assert.rejects(
    () =>
      completeCodeClipTikTokOAuthConnection(
        { code: AUTH_CODE, now: NOW },
        { queryClient: createPoolHarness().pool }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokOAuthConnectionError);
      assert.equal(error.code, "INVALID_CALLBACK");
      assertNoLeak(error);
      return true;
    }
  );
});

test("contention without returnUrl fails closed", async () => {
  await assert.rejects(
    () =>
      completeCodeClipTikTokOAuthConnection(
        { code: AUTH_CODE, state: RAW_STATE, now: NOW },
        {
          queryClient: createPoolHarness().pool,
          claimState: async () => ({
            ok: false,
            reason: "OAUTH_STATE_CONTENTION",
            oauthState: null,
          }),
        }
      ),
    (error) => error.code === "OAUTH_STATE_CONTENTION"
  );
});

test("exchange failure redirects authorization_failed without persistence", async () => {
  let createCred = 0;
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: createPoolHarness().pool,
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => {
        const {
          CodeClipTikTokOAuthClientError,
        } = require("./verticals/codeclip/tiktok/oauth-client");
        throw new CodeClipTikTokOAuthClientError(
          "AUTHORIZATION_CODE_INVALID",
          "bad code"
        );
      },
      createCredential: async () => {
        createCred += 1;
      },
    }
  );
  assert.equal(createCred, 0);
  assert.equal(result.ok, false);
  assert.equal(
    new URL(result.redirectUrl).searchParams.get("tiktok"),
    "authorization_failed"
  );
});

test("state completion failure rolls back credential and binding", async () => {
  const harness = createPoolHarness();
  const result = await completeCodeClipTikTokOAuthConnection(
    { code: AUTH_CODE, state: RAW_STATE, now: NOW },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async () => ({
        created: true,
        credential: { id: "9", status: "active" },
      }),
      createBinding: async () => ({
        created: true,
        row: {
          id: "b1",
          eventCode: EVENT,
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
        },
      }),
      appendBindingAudit: async () => ({}),
      completeState: async () => {
        const { CodeClipTikTokOAuthError } = require("./verticals/codeclip/tiktok/oauth-state");
        throw new CodeClipTikTokOAuthError("OAUTH_STATE_STALE", "fence");
      },
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(harness.events.includes("ROLLBACK"), true);
  assert.equal(harness.events.includes("COMMIT"), false);
});

test("query overrides for event/environment/return are ignored", async () => {
  const harness = createPoolHarness();
  let seenEvent = null;
  await completeCodeClipTikTokOAuthConnection(
    {
      code: AUTH_CODE,
      state: RAW_STATE,
      // attacker-controlled query-like fields must not drive persistence identity
      eventCode: "ATTACKER-EVENT",
      environment: "production",
      returnUrl: "https://evil.example.test/",
      now: NOW,
    },
    {
      queryClient: harness.pool,
      env: envBase(),
      claimState: async () => ({
        ok: true,
        claimVersion: 1,
        oauthState: claimedState(),
      }),
      exchangeCode: async () => tokenResult(),
      findCredential: async () => null,
      createCredential: async () => ({
        created: true,
        credential: { id: "9", status: "active" },
      }),
      createBinding: async (input) => {
        seenEvent = input.eventCode;
        return {
          created: true,
          row: {
            id: "b1",
            eventCode: input.eventCode,
            provider: "tiktok",
            channel: "tiktok",
            status: "active",
          },
        };
      },
      appendBindingAudit: async () => ({}),
      completeState: async () => ({ status: "completed" }),
      getEventByCode: async () => ({ event_code: EVENT, vertical: "codeclip" }),
    }
  );
  assert.equal(seenEvent, EVENT);
});
