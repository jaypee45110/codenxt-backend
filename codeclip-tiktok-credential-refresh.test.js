const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const refreshRepoPath = require.resolve(
  "./verticals/codeclip/provider-credential-refresh"
);
const credentialsPath = require.resolve("./verticals/codeclip/provider-credentials");
const oauthClientPath = require.resolve("./verticals/codeclip/tiktok/oauth-client");
const orchestratorPath = require.resolve(
  "./verticals/codeclip/tiktok/credential-refresh"
);

const originalRefreshRepo = require(refreshRepoPath);
const originalCredentials = require(credentialsPath);
const originalOAuthClient = require(oauthClientPath);

const NOW = "2026-08-05T12:00:00.000Z";
const CREDENTIAL_ID = "42";
const OPEN_ID = "OpenId_TikTok_Account_1";
const ACCESS = "access-token-secret-xyz";
const REFRESH_OLD = "refresh-token-old-secret";
const REFRESH_NEW = "refresh-token-new-secret";
const OWNER = "worker.tiktok.a";

const stubs = {
  claim: null,
  complete: null,
  release: null,
  secrets: null,
  refreshHttp: null,
};

class StubRefreshError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CodeClipProviderCredentialRefreshError";
    this.code = code;
    this.details = {};
  }
}

function tokenResult(overrides = {}) {
  return {
    openId: OPEN_ID,
    accessToken: ACCESS,
    refreshToken: REFRESH_NEW,
    tokenType: "Bearer",
    scopes: ["user.info.basic"],
    accessTokenExpiresAt: "2026-08-05T13:00:00.000Z",
    refreshTokenExpiresAt: "2026-08-06T12:00:00.000Z",
    expiresIn: 3600,
    refreshExpiresIn: 86400,
    ...overrides,
  };
}

function secretsOk(overrides = {}) {
  const { credential: credentialOverrides, ...rest } = overrides;
  return {
    ok: true,
    purpose: "refresh",
    refreshToken: REFRESH_OLD,
    credential: {
      id: CREDENTIAL_ID,
      provider: "tiktok",
      environment: "sandbox",
      status: "active",
      providerAccountId: OPEN_ID,
      hasAccessToken: true,
      accessTokenExpiresAt: "2026-08-05T11:00:00.000Z",
      expired: true,
      ...credentialOverrides,
    },
    ...rest,
  };
}

function createPoolHarness() {
  return {
    async connect() {
      return {
        async query() {
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

function assertNoLeak(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    ACCESS,
    REFRESH_OLD,
    REFRESH_NEW,
    OPEN_ID,
    "error_description",
    "log_id",
    "SELECT ",
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function loadOrchestrator() {
  require.cache[refreshRepoPath] = {
    id: refreshRepoPath,
    filename: refreshRepoPath,
    loaded: true,
    exports: {
      CodeClipProviderCredentialRefreshError: StubRefreshError,
      claimCodeClipProviderCredentialRefresh: async (...args) => {
        if (!stubs.claim) throw new Error("claim stub not set");
        return stubs.claim(...args);
      },
      completeCodeClipProviderCredentialRefresh: async (...args) => {
        if (!stubs.complete) throw new Error("complete stub not set");
        return stubs.complete(...args);
      },
      releaseCodeClipProviderCredentialRefresh: async (...args) => {
        if (!stubs.release) throw new Error("release stub not set");
        return stubs.release(...args);
      },
    },
  };

  require.cache[credentialsPath] = {
    id: credentialsPath,
    filename: credentialsPath,
    loaded: true,
    exports: {
      ...originalCredentials,
      getCodeClipProviderCredentialSecretsForUse: async (...args) => {
        if (!stubs.secrets) throw new Error("secrets stub not set");
        return stubs.secrets(...args);
      },
    },
  };

  require.cache[oauthClientPath] = {
    id: oauthClientPath,
    filename: oauthClientPath,
    loaded: true,
    exports: {
      CodeClipTikTokOAuthClientError: originalOAuthClient.CodeClipTikTokOAuthClientError,
      exchangeCodeClipTikTokAuthorizationCode:
        originalOAuthClient.exchangeCodeClipTikTokAuthorizationCode,
      refreshCodeClipTikTokAccessToken: async (...args) => {
        if (!stubs.refreshHttp) throw new Error("refreshHttp stub not set");
        return stubs.refreshHttp(...args);
      },
    },
  };

  delete require.cache[orchestratorPath];
  return require(orchestratorPath);
}

function resetStubs() {
  stubs.claim = null;
  stubs.complete = null;
  stubs.release = null;
  stubs.secrets = null;
  stubs.refreshHttp = null;
}

function restoreModules() {
  require.cache[refreshRepoPath] = {
    id: refreshRepoPath,
    filename: refreshRepoPath,
    loaded: true,
    exports: originalRefreshRepo,
  };
  require.cache[credentialsPath] = {
    id: credentialsPath,
    filename: credentialsPath,
    loaded: true,
    exports: originalCredentials,
  };
  require.cache[oauthClientPath] = {
    id: oauthClientPath,
    filename: oauthClientPath,
    loaded: true,
    exports: originalOAuthClient,
  };
  delete require.cache[orchestratorPath];
}

test("public API is exact", () => {
  restoreModules();
  const mod = require(orchestratorPath);
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipTikTokCredentialRefreshError",
    "refreshCodeClipTikTokCredential",
  ]);
});

test("module has no console usage", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "verticals/codeclip/tiktok/credential-refresh.js"),
    "utf8"
  );
  assert.equal(/console\./.test(source), false);
});

test("public options do not accept repository overrides", () => {
  restoreModules();
  const source = fs.readFileSync(orchestratorPath, "utf8");
  assert.equal(/claimRefresh\s*=/.test(source), false);
  assert.equal(/completeRefresh\s*=/.test(source), false);
  assert.equal(/releaseRefresh\s*=/.test(source), false);
  assert.equal(/getSecrets\s*=/.test(source), false);
  assert.equal(/refreshAccessToken\s*=/.test(source), false);
  // Locked imports present
  assert.match(source, /claimCodeClipProviderCredentialRefresh/);
  assert.match(source, /completeCodeClipProviderCredentialRefresh/);
  assert.match(source, /releaseCodeClipProviderCredentialRefresh/);
  assert.match(source, /getCodeClipProviderCredentialSecretsForUse/);
  assert.match(source, /refreshCodeClipTikTokAccessToken/);
});

test("requires pool with connect()", async () => {
  restoreModules();
  const { refreshCodeClipTikTokCredential, CodeClipTikTokCredentialRefreshError } =
    require(orchestratorPath);
  await assert.rejects(
    () =>
      refreshCodeClipTikTokCredential(
        { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
        { queryClient: { query: async () => ({ rows: [] }) } }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokCredentialRefreshError);
      assert.equal(error.code, "DATABASE_UNAVAILABLE");
      return true;
    }
  );
});

test("success path: claim, HTTP, complete with rotation and metadata", async () => {
  resetStubs();
  let completeArgs = null;
  let httpArgs = null;
  stubs.claim = async (input) => {
    assert.equal(String(input.credentialId), CREDENTIAL_ID);
    assert.equal(input.owner, OWNER);
    return {
      ok: true,
      claimed: true,
      credentialId: CREDENTIAL_ID,
      claimedAt: NOW,
      expiresAt: "2026-08-05T12:01:00.000Z",
    };
  };
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async (input) => {
    httpArgs = input;
    assert.equal(input.refreshToken, REFRESH_OLD);
    return tokenResult();
  };
  stubs.complete = async (input) => {
    completeArgs = input;
    assert.equal(input.owner, OWNER);
    assert.equal(input.accessToken, ACCESS);
    assert.equal(input.refreshToken, REFRESH_NEW);
    assert.deepEqual(input.metadata, {
      refreshTokenExpiresAt: "2026-08-06T12:00:00.000Z",
    });
    assert.deepEqual(input.actor, {
      type: "system",
      id: "tiktok_token_refresh",
    });
    return {
      status: "completed",
      credential: {
        id: CREDENTIAL_ID,
        status: "active",
        accessTokenExpiresAt: "2026-08-05T13:00:00.000Z",
        metadata: {
          refreshTokenExpiresAt: "2026-08-06T12:00:00.000Z",
          prior: true,
        },
      },
    };
  };
  stubs.release = async () => {
    throw new Error("should not release on success");
  };

  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, leaseMs: 60_000, now: NOW },
    { queryClient: createPoolHarness() }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "refreshed");
  assert.equal(result.credentialId, CREDENTIAL_ID);
  assert.equal(result.accessTokenExpiresAt, "2026-08-05T13:00:00.000Z");
  assert.equal(result.refreshTokenExpiresAt, "2026-08-06T12:00:00.000Z");
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(Object.hasOwn(result, "openId"), false);
  assert.ok(completeArgs);
  assert.ok(httpArgs);
  assertNoLeak(result);
  restoreModules();
});

test("identical refresh token is completed explicitly", async () => {
  resetStubs();
  let completedRefresh = null;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => tokenResult({ refreshToken: REFRESH_OLD });
  stubs.complete = async (input) => {
    completedRefresh = input.refreshToken;
    return {
      status: "completed",
      credential: {
        accessTokenExpiresAt: tokenResult().accessTokenExpiresAt,
        metadata: {
          refreshTokenExpiresAt: tokenResult().refreshTokenExpiresAt,
        },
      },
    };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(completedRefresh, REFRESH_OLD);
  restoreModules();
});

test("claim contention returns retryable result", async () => {
  resetStubs();
  stubs.claim = async () => ({
    ok: false,
    reason: "REFRESH_CLAIM_CONTENTION",
  });
  stubs.secrets = async () => {
    throw new Error("should not secret-read");
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "retryable");
  assert.equal(result.classification, "REFRESH_CLAIM_CONTENTION");
  assertNoLeak(result);
  restoreModules();
});

test("unsupported provider clears claim without reauthorization", async () => {
  resetStubs();
  let released = null;
  let httpCalled = false;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () =>
    secretsOk({ credential: { provider: "meta" } });
  stubs.refreshHttp = async () => {
    httpCalled = true;
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: input.outcome };
  };
  const {
    refreshCodeClipTikTokCredential,
    CodeClipTikTokCredentialRefreshError,
  } = loadOrchestrator();
  await assert.rejects(
    () =>
      refreshCodeClipTikTokCredential(
        { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
        { queryClient: createPoolHarness() }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipTikTokCredentialRefreshError);
      assert.equal(error.code, "UNSUPPORTED_CREDENTIAL_PROVIDER");
      return true;
    }
  );
  assert.equal(httpCalled, false);
  assert.equal(released.outcome, "failed_retryable");
  assert.equal(released.reason, "unsupported_credential_provider");
  restoreModules();
});

test("identity mismatch releases reauthorization without complete", async () => {
  resetStubs();
  let released = null;
  let completed = false;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () =>
    tokenResult({ openId: "Different_OpenId_Account" });
  stubs.complete = async () => {
    completed = true;
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: "failed_reauthorization" };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(completed, false);
  assert.equal(released.outcome, "failed_reauthorization");
  assert.equal(released.reason, "tiktok_refresh_identity_mismatch");
  assert.deepEqual(released.actor, {
    type: "system",
    id: "tiktok_token_refresh",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "reauthorization_required");
  assert.equal(result.classification, "TIKTOK_ACCOUNT_IDENTITY_MISMATCH");
  assertNoLeak(result);
  restoreModules();
});

test("invalid grant releases reauthorization", async () => {
  resetStubs();
  let released = null;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => {
    throw new originalOAuthClient.CodeClipTikTokOAuthClientError(
      "TIKTOK_REAUTHORIZATION_REQUIRED",
      "invalid grant"
    );
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: input.outcome };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(released.outcome, "failed_reauthorization");
  assert.equal(result.status, "reauthorization_required");
  assert.equal(result.classification, "TIKTOK_REAUTHORIZATION_REQUIRED");
  restoreModules();
});

test("rate limit releases retryable", async () => {
  resetStubs();
  let released = null;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => {
    throw new originalOAuthClient.CodeClipTikTokOAuthClientError(
      "TIKTOK_RATE_LIMITED",
      "429"
    );
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: input.outcome };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(released.outcome, "failed_retryable");
  assert.equal(result.status, "retryable");
  assert.equal(result.classification, "TIKTOK_RATE_LIMITED");
  restoreModules();
});

test("config missing after claim releases retryable then throws", async () => {
  resetStubs();
  let released = null;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => {
    throw new originalOAuthClient.CodeClipTikTokOAuthClientError(
      "TIKTOK_CONFIG_NOT_AVAILABLE",
      "missing secret"
    );
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: input.outcome };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  await assert.rejects(
    () =>
      refreshCodeClipTikTokCredential(
        { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
        { queryClient: createPoolHarness() }
      ),
    (error) => {
      assert.equal(error.code, "TIKTOK_CONFIG_NOT_AVAILABLE");
      assertNoLeak(error);
      return true;
    }
  );
  assert.equal(released.outcome, "failed_retryable");
  assert.equal(released.reason, "tiktok_refresh_config_unavailable");
  restoreModules();
});

test("complete race maps to CREDENTIAL_REFRESH_RACE", async () => {
  resetStubs();
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => tokenResult();
  stubs.complete = async () => {
    throw new StubRefreshError("REFRESH_CLAIM_OWNER_MISMATCH", "stale");
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  await assert.rejects(
    () =>
      refreshCodeClipTikTokCredential(
        { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
        { queryClient: createPoolHarness() }
      ),
    (error) => {
      assert.equal(error.code, "CREDENTIAL_REFRESH_RACE");
      assertNoLeak(error);
      return true;
    }
  );
  restoreModules();
});

test("malformed TikTok response is retryable release", async () => {
  resetStubs();
  let released = null;
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => {
    throw new originalOAuthClient.CodeClipTikTokOAuthClientError(
      "INVALID_TIKTOK_REFRESH_RESPONSE",
      "bad json"
    );
  };
  stubs.release = async (input) => {
    released = input;
    return { status: "failed", outcome: input.outcome };
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  const result = await refreshCodeClipTikTokCredential(
    { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
    { queryClient: createPoolHarness() }
  );
  assert.equal(released.outcome, "failed_retryable");
  assert.equal(result.status, "retryable");
  restoreModules();
});

test("release failure after HTTP error throws typed error not soft result", async () => {
  resetStubs();
  stubs.claim = async () => ({ ok: true, credentialId: CREDENTIAL_ID });
  stubs.secrets = async () => secretsOk();
  stubs.refreshHttp = async () => {
    throw new originalOAuthClient.CodeClipTikTokOAuthClientError(
      "TIKTOK_RATE_LIMITED",
      "429"
    );
  };
  stubs.release = async () => {
    throw new StubRefreshError("REFRESH_CLAIM_STALE", "cannot release");
  };
  const { refreshCodeClipTikTokCredential } = loadOrchestrator();
  await assert.rejects(
    () =>
      refreshCodeClipTikTokCredential(
        { credentialId: CREDENTIAL_ID, owner: OWNER, now: NOW },
        { queryClient: createPoolHarness() }
      ),
    (error) => {
      assert.equal(error.code, "CREDENTIAL_REFRESH_RACE");
      assertNoLeak(error);
      return true;
    }
  );
  restoreModules();
});

test("generic secret-read refresh returns providerAccountId", async () => {
  restoreModules();
  const {
    getCodeClipProviderCredentialSecretsForUse,
  } = require("./verticals/codeclip/provider-credentials");
  const {
    encryptCodeClipProviderCredentialSecret,
  } = require("./verticals/codeclip/provider-credential-crypto");

  const rows = [];
  const client = {
    async query(sql, params = []) {
      if (
        /FROM codeclip_provider_credentials/.test(sql) &&
        /refresh_token_envelope/.test(sql)
      ) {
        assert.match(sql, /provider_account_id/);
        const row = rows.find((r) => String(r.id) === String(params[0]));
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };

  const envKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const envActive =
    process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  const key = crypto.randomBytes(32).toString("base64");
  process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = `1:${key}`;
  process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = "1";
  try {
    const accessEnv = encryptCodeClipProviderCredentialSecret({
      plaintext: "a",
      env: process.env,
    });
    const refreshEnv = encryptCodeClipProviderCredentialSecret({
      plaintext: "r-secret",
      env: process.env,
    });
    rows.push({
      id: 7,
      provider: "tiktok",
      environment: "sandbox",
      provider_account_id: "OpenId_Exact_Case",
      status: "active",
      has_access_token: true,
      has_refresh_token: true,
      access_token_expires_at: "2026-08-01T00:00:00.000Z",
      access_token_envelope: accessEnv.envelope,
      refresh_token_envelope: refreshEnv.envelope,
    });

    const result = await getCodeClipProviderCredentialSecretsForUse(
      { id: 7, purpose: "refresh", now: new Date(NOW) },
      { queryClient: client, env: process.env }
    );
    assert.equal(result.ok, true);
    assert.equal(result.refreshToken, "r-secret");
    assert.equal(result.credential.providerAccountId, "OpenId_Exact_Case");
    assert.equal(Object.hasOwn(result, "accessToken"), false);
  } finally {
    if (envKeys === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = envKeys;
    }
    if (envActive === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION =
        envActive;
    }
  }
});
