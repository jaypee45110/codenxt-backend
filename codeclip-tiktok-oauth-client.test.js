const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CodeClipTikTokOAuthClientError,
  exchangeCodeClipTikTokAuthorizationCode,
} = require("./verticals/codeclip/tiktok/oauth-client");

const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const REDIRECT =
  "https://api.example.test/api/codeclip/providers/tiktok/oauth/callback";
const NOW = "2026-08-05T12:00:00.000Z";
const AUTH_CODE = "tt-auth-code-secret-value-do-not-leak";
const CLIENT_KEY = "tt_client_key_test_value";
const CLIENT_SECRET = "tt_client_secret_test_value_never_expose";

function envBase(extra = {}) {
  return {
    CODECLIP_TIKTOK_CLIENT_KEY: CLIENT_KEY,
    CODECLIP_TIKTOK_CLIENT_SECRET: CLIENT_SECRET,
    CODECLIP_TIKTOK_REDIRECT_URI: REDIRECT,
    ...extra,
  };
}

function validTokenBody(overrides = {}) {
  return {
    open_id: "OpenId_CaseSensitive_123",
    access_token: "access-token-value-xyz",
    refresh_token: "refresh-token-value-xyz",
    expires_in: 3600,
    refresh_expires_in: 86400,
    scope: "user.info.basic",
    token_type: "Bearer",
    ...overrides,
  };
}

function jsonResponse(body, { status = 200, headers = {}, asText } = {}) {
  const text =
    asText !== undefined
      ? asText
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const headerMap = new Map(
    Object.entries({
      "content-type": "application/json",
      ...headers,
    }).map(([k, v]) => [k.toLowerCase(), String(v)])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

function captureFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls);
  };
  return { fetchImpl, calls };
}

function assertNoLeakage(error, extras = []) {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  const message = String(error && error.message);
  const details = JSON.stringify(error && error.details);
  const blob = `${serialized}\n${message}\n${details}`;
  const forbidden = [
    AUTH_CODE,
    CLIENT_KEY,
    CLIENT_SECRET,
    "access-token-value-xyz",
    "refresh-token-value-xyz",
    "error_description",
    "log_id",
    "raw body should not appear",
    REDIRECT,
    ...extras,
  ];
  for (const value of forbidden) {
    assert.equal(
      blob.includes(value),
      false,
      `error leaked sensitive value: ${value}`
    );
  }
}

test("public API is minimal", () => {
  const mod = require("./verticals/codeclip/tiktok/oauth-client");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipTikTokOAuthClientError",
    "exchangeCodeClipTikTokAuthorizationCode",
  ]);
});

test("module has no console usage", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/tiktok/oauth-client.js"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("exchange succeeds with valid config and full token response", async () => {
  const { fetchImpl, calls } = captureFetch(async () =>
    jsonResponse(validTokenBody({ extra_field: "ignored", log_id: "L1" }))
  );

  const result = await exchangeCodeClipTikTokAuthorizationCode(
    { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
    { env: envBase(), fetchImpl }
  );

  assert.equal(result.openId, "OpenId_CaseSensitive_123");
  assert.equal(result.accessToken, "access-token-value-xyz");
  assert.equal(result.refreshToken, "refresh-token-value-xyz");
  assert.equal(result.tokenType, "Bearer");
  assert.deepEqual(result.scopes, ["user.info.basic"]);
  assert.equal(result.expiresIn, 3600);
  assert.equal(result.refreshExpiresIn, 86400);
  assert.equal(result.accessTokenExpiresAt, "2026-08-05T13:00:00.000Z");
  assert.equal(result.refreshTokenExpiresAt, "2026-08-06T12:00:00.000Z");
  assert.equal(Object.hasOwn(result, "raw"), false);
  assert.equal(Object.hasOwn(result, "extra_field"), false);
  assert.equal(Object.hasOwn(result, "log_id"), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded"
  );
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.ok(!String(calls[0].url).includes("?"));
  assert.ok(!String(calls[0].url).includes(CLIENT_SECRET));

  const params = new URLSearchParams(calls[0].init.body);
  assert.equal(params.get("client_key"), CLIENT_KEY);
  assert.equal(params.get("client_secret"), CLIENT_SECRET);
  assert.equal(params.get("code"), AUTH_CODE);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("redirect_uri"), REDIRECT);
  assert.equal([...params.keys()].sort().join(","), [
    "client_key",
    "client_secret",
    "code",
    "grant_type",
    "redirect_uri",
  ].sort().join(","));
});

test("missing client key fails closed without leaking secrets", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase({ CODECLIP_TIKTOK_CLIENT_KEY: "" }),
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokOAuthClientError);
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("missing client secret fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase({ CODECLIP_TIKTOK_CLIENT_SECRET: undefined }),
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("missing redirect URI config fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase({ CODECLIP_TIKTOK_REDIRECT_URI: "" }),
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("caller redirect mismatch fails without network call", async () => {
  let called = false;
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        {
          code: AUTH_CODE,
          redirectUri: "https://evil.example.test/callback",
          now: NOW,
        },
        {
          env: envBase(),
          fetchImpl: async () => {
            called = true;
            return jsonResponse(validTokenBody());
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_REDIRECT_URI");
      assertNoLeakage(error);
      return true;
    }
  );
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Success normalization
// ---------------------------------------------------------------------------

test("token_type is normalized case-insensitively to Bearer", async () => {
  const result = await exchangeCodeClipTikTokAuthorizationCode(
    { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
    {
      env: envBase(),
      fetchImpl: async () => jsonResponse(validTokenBody({ token_type: "bearer" })),
    }
  );
  assert.equal(result.tokenType, "Bearer");
});

test("scopes are split, trimmed, deduped, sorted; unknown fields ignored", async () => {
  const result = await exchangeCodeClipTikTokAuthorizationCode(
    { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
    {
      env: envBase(),
      fetchImpl: async () =>
        jsonResponse(
          validTokenBody({
            scope: " user.info.basic , user.info.basic , ",
            unknown_top: { nested: true },
            error_description: "should be ignored on success",
          })
        ),
    }
  );
  assert.deepEqual(result.scopes, ["user.info.basic"]);
  assert.equal(Object.hasOwn(result, "unknown_top"), false);
  assert.equal(Object.hasOwn(result, "error_description"), false);
});

// ---------------------------------------------------------------------------
// Missing / invalid fields
// ---------------------------------------------------------------------------

const requiredFieldCases = [
  ["open_id", { open_id: "" }],
  ["access_token", { access_token: "" }],
  ["refresh_token", { refresh_token: null }],
  ["token_type", { token_type: "mac" }],
  ["expires_in", { expires_in: 0 }],
  ["refresh_expires_in", { refresh_expires_in: -1 }],
  ["scope", { scope: "" }],
  ["scope missing required", { scope: "video.list" }],
  ["expires_in type", { expires_in: "3600.5" }],
  ["open_id type", { open_id: 123 }],
];

for (const [label, overrides] of requiredFieldCases) {
  test(`invalid success field fails closed: ${label}`, async () => {
    await assert.rejects(
      () =>
        exchangeCodeClipTikTokAuthorizationCode(
          { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
          {
            env: envBase(),
            fetchImpl: async () => jsonResponse(validTokenBody(overrides)),
          }
        ),
      (error) => {
        assert.ok(error instanceof CodeClipTikTokOAuthClientError);
        assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
        assertNoLeakage(error);
        return true;
      }
    );
  });
}

test("overlong open_id fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(validTokenBody({ open_id: "x".repeat(300) })),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error, ["x".repeat(50)]);
      return true;
    }
  );
});

test("missing authorization code fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: "   ", redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "AUTHORIZATION_CODE_REQUIRED");
      assertNoLeakage(error);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// HTTP / TikTok errors
// ---------------------------------------------------------------------------

test("TikTok JSON error maps invalid_grant safely", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(
              {
                error: "invalid_grant",
                error_description: "Authorization code is expired or invalid",
                log_id: "20260805120000ABCDEF",
              },
              { status: 400 }
            ),
        }
      ),
    (error) => {
      assert.equal(error.code, "AUTHORIZATION_CODE_INVALID");
      assertNoLeakage(error, [
        "Authorization code is expired or invalid",
        "20260805120000ABCDEF",
      ]);
      return true;
    }
  );
});

test("malformed JSON on success fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(null, {
              status: 200,
              asText: "{not-json",
            }),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error, ["{not-json"]);
      return true;
    }
  );
});

test("HTML response with wrong content type fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(null, {
              status: 200,
              headers: { "content-type": "text/html" },
              asText: "<html>raw body should not appear</html>",
            }),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("empty body fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(null, { status: 200, asText: "" }),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("HTTP 401 maps to token exchange failed without leakage", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(
              {
                error: "invalid_client",
                error_description: "client secret wrong",
                log_id: "log-401",
              },
              { status: 401 }
            ),
        }
      ),
    (error) => {
      assert.equal(error.code, "TOKEN_EXCHANGE_FAILED");
      assertNoLeakage(error, ["client secret wrong", "log-401"]);
      return true;
    }
  );
});

test("HTTP 429 maps to rate limited", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(
              { error: "rate_limit_exceeded", error_description: "slow down" },
              { status: 429 }
            ),
        }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_RATE_LIMITED");
      assertNoLeakage(error, ["slow down"]);
      return true;
    }
  );
});

test("HTTP 500 maps to service unavailable", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(
              { error: "server_error", error_description: "oops" },
              { status: 500 }
            ),
        }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_SERVICE_UNAVAILABLE");
      assertNoLeakage(error, ["oops"]);
      return true;
    }
  );
});

test("fetch reject maps to exchange failed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () => {
            throw new Error(`network down ${AUTH_CODE} ${CLIENT_SECRET}`);
          },
        }
      ),
    (error) => {
      assert.equal(error.code, "TOKEN_EXCHANGE_FAILED");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("timeout/abort maps to exchange failed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          timeoutMs: 1000,
          fetchImpl: async (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => {
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        }
      ),
    (error) => {
      assert.equal(error.code, "TOKEN_EXCHANGE_FAILED");
      assert.match(String(error.message), /timed out/i);
      assertNoLeakage(error);
      return true;
    }
  );
});

test("oversized body via content-length fails closed", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(validTokenBody(), {
              headers: {
                "content-type": "application/json",
                "content-length": String(65 * 1024),
              },
            }),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error);
      return true;
    }
  );
});

test("oversized body via text length fails closed", async () => {
  const huge = `{"open_id":"${"x".repeat(70 * 1024)}"}`;
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          fetchImpl: async () =>
            jsonResponse(null, {
              status: 200,
              asText: huge,
            }),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_TIKTOK_RESPONSE");
      assertNoLeakage(error, ["x".repeat(40)]);
      return true;
    }
  );
});

test("invalid timeoutMs rejects without clamp", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        {
          env: envBase(),
          timeoutMs: 500,
          fetchImpl: async () => jsonResponse(validTokenBody()),
        }
      ),
    (error) => {
      assert.equal(error.code, "INVALID_OAUTH_REQUEST");
      return true;
    }
  );
});

test("fetchImpl must be a function", async () => {
  await assert.rejects(
    () =>
      exchangeCodeClipTikTokAuthorizationCode(
        { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
        { env: envBase(), fetchImpl: null }
      ),
    (error) => {
      assert.equal(error.code, "TOKEN_EXCHANGE_FAILED");
      return true;
    }
  );
});

test("content-type application/json; charset=utf-8 is accepted", async () => {
  const result = await exchangeCodeClipTikTokAuthorizationCode(
    { code: AUTH_CODE, redirectUri: REDIRECT, now: NOW },
    {
      env: envBase(),
      fetchImpl: async () =>
        jsonResponse(validTokenBody(), {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    }
  );
  assert.equal(result.tokenType, "Bearer");
});
