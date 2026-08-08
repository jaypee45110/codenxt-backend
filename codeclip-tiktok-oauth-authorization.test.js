const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCodeClipTikTokAuthorizationUrl,
  createCodeClipTikTokOAuthAuthorization,
} = require("./verticals/codeclip/tiktok/oauth-authorization");
const { CodeClipTikTokOAuthError } = require("./verticals/codeclip/tiktok/oauth-state");

const REDIRECT =
  "https://api.example.test/api/codeclip/providers/tiktok/oauth/callback";
const RETURN = "https://app.example.test/checkout/tiktok";
const NOW = "2026-08-05T12:00:00.000Z";
const PRODUCTION_CLIENT_KEY = "tt_client_key_test";
const SANDBOX_CLIENT_KEY = "tt_sandbox_client_key_test";

function envBase(extra = {}) {
  return {
    CODECLIP_TIKTOK_CLIENT_KEY: PRODUCTION_CLIENT_KEY,
    CODECLIP_TIKTOK_SANDBOX_CLIENT_KEY: SANDBOX_CLIENT_KEY,
    CODECLIP_TIKTOK_REDIRECT_URI: REDIRECT,
    CODECLIP_TIKTOK_RETURN_URL_ALLOWLIST: RETURN,
    ...extra,
  };
}

function createStateStore() {
  const calls = [];
  const rows = [];
  let nextId = 1;
  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*BEGIN|COMMIT|ROLLBACK\s*$/i.test(sql.trim())) return { rows: [] };
      if (/SELECT COALESCE\(\$1::timestamptz, NOW\(\)\) AS operation_now/i.test(sql)) {
        return {
          rows: [{ operation_now: new Date(params[0] || NOW) }],
        };
      }
      if (/INSERT INTO codeclip_tiktok_oauth_states/.test(sql)) {
        const row = {
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
        };
        rows.push(row);
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    },
  };
}

test("build TikTok authorization URL uses official v2 endpoint and params", () => {
  const url = new URL(
    buildCodeClipTikTokAuthorizationUrl({
      clientKey: "ck",
      redirectUri: REDIRECT,
      state: "state-value-xyz",
      scopes: ["user.info.basic"],
    })
  );
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "ck");
  assert.equal(url.searchParams.get("scope"), "user.info.basic");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("state"), "state-value-xyz");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_verifier"), null);
});

test("build TikTok authorization URL accepts disable_auto_auth", () => {
  const url = new URL(
    buildCodeClipTikTokAuthorizationUrl({
      clientKey: "ck",
      redirectUri: REDIRECT,
      state: "s",
      scopes: ["user.info.basic"],
      disableAutoAuth: 1,
    })
  );
  assert.equal(url.searchParams.get("disable_auto_auth"), "1");
});

test("create authorization returns URL without separate raw state", async () => {
  const client = createStateStore();
  const result = await createCodeClipTikTokOAuthAuthorization(
    {
      eventCode: "CC-EP-1",
      environment: "sandbox",
      redirectUri: REDIRECT,
      returnUrl: RETURN,
      actor: { type: "operator", id: "ops.1" },
      now: NOW,
    },
    {
      queryClient: client,
      env: envBase(),
      getEventByCode: async (code) =>
        code === "CC-EP-1" ? { vertical: "codeclip", code } : null,
    }
  );

  assert.equal(typeof result.authorizationUrl, "string");
  assert.equal(Object.hasOwn(result, "rawState"), false);
  assert.equal(Object.hasOwn(result, "state"), false);
  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("client_key"), SANDBOX_CLIENT_KEY);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.ok(url.searchParams.get("state"));
  assert.equal(result.expiresAt, "2026-08-05T12:10:00.000Z");

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("client_secret"), false);
});

test("create authorization uses production client key for production environment", async () => {
  const client = createStateStore();
  const result = await createCodeClipTikTokOAuthAuthorization(
    {
      eventCode: "CC-EP-1",
      environment: "production",
      redirectUri: REDIRECT,
      returnUrl: RETURN,
      actor: { type: "system" },
      now: NOW,
    },
    {
      queryClient: client,
      env: envBase(),
      getEventByCode: async () => ({ vertical: "codeclip" }),
    }
  );

  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("client_key"), PRODUCTION_CLIENT_KEY);
  assert.equal(url.searchParams.get("scope"), "user.info.basic");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
});

test("sandbox authorization fails closed without sandbox client key", async () => {
  const client = createStateStore();
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "CC-EP-1",
          environment: "sandbox",
          redirectUri: REDIRECT,
          returnUrl: RETURN,
          actor: { type: "system" },
          now: NOW,
        },
        {
          queryClient: client,
          env: envBase({ CODECLIP_TIKTOK_SANDBOX_CLIENT_KEY: "" }),
          getEventByCode: async () => ({ vertical: "codeclip" }),
        }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      assert.equal(JSON.stringify(error).includes(SANDBOX_CLIENT_KEY), false);
      return true;
    }
  );
});

test("create authorization fails closed on missing config and event", async () => {
  const client = createStateStore();
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "CC-EP-1",
          environment: "sandbox",
          redirectUri: REDIRECT,
          returnUrl: RETURN,
          actor: { type: "system" },
        },
        {
          queryClient: client,
          env: {},
          getEventByCode: async () => ({ vertical: "codeclip" }),
        }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokOAuthError);
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      return true;
    }
  );

  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "MISSING",
          environment: "sandbox",
          redirectUri: REDIRECT,
          returnUrl: RETURN,
          actor: { type: "system" },
        },
        {
          queryClient: client,
          env: envBase(),
          getEventByCode: async () => null,
        }
      ),
    (error) => error.code === "EVENT_NOT_FOUND"
  );

  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "OTHER",
          environment: "sandbox",
          redirectUri: REDIRECT,
          returnUrl: RETURN,
          actor: { type: "system" },
        },
        {
          queryClient: client,
          env: envBase(),
          getEventByCode: async () => ({ vertical: "codepod" }),
        }
      ),
    (error) => error.code === "INVALID_EVENT"
  );
});

test("create authorization rejects redirect mismatch and return URL", async () => {
  const client = createStateStore();
  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "CC-EP-1",
          environment: "sandbox",
          redirectUri: "https://evil.example/callback",
          returnUrl: RETURN,
          actor: { type: "system" },
        },
        {
          queryClient: client,
          env: envBase(),
          getEventByCode: async () => ({ vertical: "codeclip" }),
        }
      ),
    (error) => error.code === "INVALID_REDIRECT_URI"
  );

  await assert.rejects(
    () =>
      createCodeClipTikTokOAuthAuthorization(
        {
          eventCode: "CC-EP-1",
          environment: "sandbox",
          redirectUri: REDIRECT,
          returnUrl: "https://evil.example/path",
          actor: { type: "system" },
        },
        {
          queryClient: client,
          env: envBase(),
          getEventByCode: async () => ({ vertical: "codeclip" }),
        }
      ),
    (error) => error.code === "INVALID_RETURN_URL"
  );
});

test("public APIs are minimal", () => {
  const auth = require("./verticals/codeclip/tiktok/oauth-authorization");
  const state = require("./verticals/codeclip/tiktok/oauth-state");
  assert.deepEqual(Object.keys(auth).sort(), [
    "buildCodeClipTikTokAuthorizationUrl",
    "createCodeClipTikTokOAuthAuthorization",
  ]);
  assert.deepEqual(Object.keys(state).sort(), [
    "CodeClipTikTokOAuthError",
    "claimCodeClipTikTokOAuthState",
    "completeCodeClipTikTokOAuthState",
    "createCodeClipTikTokOAuthState",
  ]);
});
