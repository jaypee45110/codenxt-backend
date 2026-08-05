const test = require("node:test");
const assert = require("node:assert/strict");

const {
  app,
  initializeCodeClipStartup,
  startBackendServer,
} = require("./server");

const CODECLIP_STARTUP_ENSURES = [
  ["ensureCampaignsTable", "ensure-campaigns"],
  ["ensureEventScansTable", "ensure-event-scans"],
  ["ensureEventRegistrationsTable", "ensure-event-registrations"],
  ["ensureCodeClipInteractionsTable", "ensure-codeclip-interactions"],
  ["ensureCodeClipRewardAssignmentsTable", "ensure-codeclip-reward-assignments"],
  ["ensureCodeClipXtraRedemptionsTable", "ensure-codeclip-clipxtra-redemptions"],
  ["ensureCodeClipOutboxEventsTable", "ensure-codeclip-outbox"],
  ["ensureCodeClipProviderAccountBindingsTable", "ensure-codeclip-provider-bindings"],
  ["ensureCodeClipProviderAccountBindingAuditTable", "ensure-codeclip-provider-binding-audit"],
  ["ensureCodeClipProviderCredentialsTable", "ensure-codeclip-provider-credentials"],
  ["ensureCodeClipProviderCredentialAuditTable", "ensure-codeclip-provider-credential-audit"],
  ["ensureCodeClipProviderPollSourcesTable", "ensure-codeclip-provider-poll-sources"],
  ["ensureCodeClipProviderDeliveriesTable", "ensure-codeclip-provider-deliveries"],
  ["ensureCodeClipYouTubeWebSubSubscriptionsTable", "ensure-codeclip-youtube-websub-subscriptions"],
  ["ensureCodeClipYouTubeWebSubDiagnosticProbeTables", "ensure-codeclip-youtube-websub-diagnostic-probes"],
  ["ensureCodeClipYouTubeOAuthStatesTable", "ensure-codeclip-youtube-oauth-states"],
  ["ensureCodeClipTikTokOAuthStatesTable", "ensure-codeclip-tiktok-oauth-states"],
];

const EXPECTED_CODECLIP_STARTUP_EVENTS = CODECLIP_STARTUP_ENSURES.map(([, label]) => label);

function createCodeClipStartupDatabaseClient(events, { failAt } = {}) {
  const client = {};

  for (const [methodName, label] of CODECLIP_STARTUP_ENSURES) {
    client[methodName] = async () => {
      events.push(label);
      if (methodName === failAt) {
        throw new Error(`${label} schema unavailable`);
      }
    };
  }

  return client;
}

test("codeClip startup initializes every active schema before listen", async () => {
  const events = [];
  const originalListen = app.listen;
  const fakeServer = { close() {} };

  app.listen = (port) => {
    events.push(`listen:${port}`);
    return fakeServer;
  };

  try {
    const server = await startBackendServer({
      port: 0,
      databaseClient: createCodeClipStartupDatabaseClient(events),
    });

    assert.equal(server, fakeServer);
    assert.deepEqual(events, [
      ...EXPECTED_CODECLIP_STARTUP_EVENTS,
      "listen:0",
    ]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup schema init is repeatable and does not run unrelated startup hooks", async () => {
  const calls = [];
  const databaseClient = {
    ...createCodeClipStartupDatabaseClient(calls),
    async testDbConnection() {
      calls.push("test-db");
      throw new Error("testDbConnection should not run inside codeClip init");
    },
    async ensureCodePodGoldXtraRedemptionsTable() {
      calls.push("codepod-goldxtra");
      throw new Error("codePod init should not run inside codeClip init");
    },
    async ensureCodePodKeywordInteractionsTable() {
      calls.push("codepod-keyword");
      throw new Error("codePod init should not run inside codeClip init");
    },
    async ensureCodeDemoHandshakesTable() {
      calls.push("codedemo-handshakes");
      throw new Error("codeDemo init should not run inside codeClip init");
    },
  };

  await initializeCodeClipStartup({ databaseClient });
  await initializeCodeClipStartup({ databaseClient });

  assert.deepEqual(calls, [
    ...EXPECTED_CODECLIP_STARTUP_EVENTS,
    ...EXPECTED_CODECLIP_STARTUP_EVENTS,
  ]);
});

test("codeClip startup schema failure is visible and prevents listen", async () => {
  const events = [];
  const originalListen = app.listen;

  app.listen = () => {
    events.push("listen");
    throw new Error("listen should not be called");
  };

  try {
    await assert.rejects(
      () =>
        startBackendServer({
          port: 0,
          databaseClient: createCodeClipStartupDatabaseClient(events, {
            failAt: "ensureCodeClipRewardAssignmentsTable",
          }),
        }),
      /ensure-codeclip-reward-assignments schema unavailable/
    );

    assert.deepEqual(events, EXPECTED_CODECLIP_STARTUP_EVENTS.slice(0, 5));
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup initializes provider delivery schema without waiting for first request", async () => {
  const calls = [];
  const databaseClient = createCodeClipStartupDatabaseClient(calls);

  await initializeCodeClipStartup({ databaseClient });

  assert.equal(calls.includes("ensure-codeclip-provider-deliveries"), true);
  assert.equal(calls.includes("ensure-codeclip-interactions"), true);
  assert.equal(calls.includes("ensure-codeclip-clipxtra-redemptions"), true);
  assert.equal(calls.includes("ensure-codeclip-outbox"), true);
});

test("codeClip startup wires credential schema ensures after bindings and before deliveries", async () => {
  const calls = [];
  const previousKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const previousActive = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;

  try {
    await initializeCodeClipStartup({
      databaseClient: createCodeClipStartupDatabaseClient(calls),
    });

    const credentialsIndex = calls.indexOf("ensure-codeclip-provider-credentials");
    const credentialAuditIndex = calls.indexOf("ensure-codeclip-provider-credential-audit");
    const bindingAuditIndex = calls.indexOf("ensure-codeclip-provider-binding-audit");
    const deliveriesIndex = calls.indexOf("ensure-codeclip-provider-deliveries");

    assert.ok(credentialsIndex >= 0, "credentials ensure must run");
    assert.ok(credentialAuditIndex >= 0, "credential audit ensure must run");
    assert.equal(credentialsIndex < credentialAuditIndex, true);
    assert.equal(bindingAuditIndex < credentialsIndex, true);
    assert.equal(credentialAuditIndex < deliveriesIndex, true);
    assert.equal(
      calls.filter((label) => label === "ensure-codeclip-provider-credentials").length,
      1
    );
    assert.equal(
      calls.filter((label) => label === "ensure-codeclip-provider-credential-audit").length,
      1
    );
  } finally {
    if (previousKeys === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = previousKeys;
    }
    if (previousActive === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = previousActive;
    }
  }
});

test("codeClip startup wires poll sources schema after credentials and before deliveries", async () => {
  const calls = [];
  const previousKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const previousActive = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;

  try {
    await initializeCodeClipStartup({
      databaseClient: createCodeClipStartupDatabaseClient(calls),
    });

    const credentialsIndex = calls.indexOf("ensure-codeclip-provider-credentials");
    const credentialAuditIndex = calls.indexOf("ensure-codeclip-provider-credential-audit");
    const pollSourcesIndex = calls.indexOf("ensure-codeclip-provider-poll-sources");
    const deliveriesIndex = calls.indexOf("ensure-codeclip-provider-deliveries");
    const youtubeIndex = calls.indexOf("ensure-codeclip-youtube-websub-subscriptions");

    assert.ok(pollSourcesIndex >= 0, "poll sources ensure must run");
    assert.equal(credentialAuditIndex < pollSourcesIndex, true);
    assert.equal(credentialsIndex < pollSourcesIndex, true);
    assert.equal(pollSourcesIndex < deliveriesIndex, true);
    assert.equal(pollSourcesIndex < youtubeIndex, true);
    assert.equal(
      calls.filter((label) => label === "ensure-codeclip-provider-poll-sources").length,
      1
    );
    // No auto-create of poll sources; ensure only.
    assert.equal(calls.includes("create-codeclip-provider-poll-source"), false);
  } finally {
    if (previousKeys === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = previousKeys;
    }
    if (previousActive === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = previousActive;
    }
  }
});

test("codeClip startup requires TikTok OAuth states ensure after YouTube OAuth states", async () => {
  const calls = [];
  const tiktokEnvKeys = Object.keys(process.env).filter((key) =>
    key.startsWith("CODECLIP_TIKTOK_")
  );
  const savedTikTokEnv = {};
  for (const key of tiktokEnvKeys) {
    savedTikTokEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    await initializeCodeClipStartup({
      databaseClient: createCodeClipStartupDatabaseClient(calls),
    });

    const youtubeOauthIndex = calls.indexOf("ensure-codeclip-youtube-oauth-states");
    const tiktokOauthIndex = calls.indexOf("ensure-codeclip-tiktok-oauth-states");

    assert.ok(youtubeOauthIndex >= 0, "YouTube OAuth states ensure must run");
    assert.ok(tiktokOauthIndex >= 0, "TikTok OAuth states ensure must run");
    assert.equal(
      tiktokOauthIndex,
      youtubeOauthIndex + 1,
      "TikTok OAuth ensure follows YouTube OAuth ensure"
    );
    assert.equal(
      calls.filter((label) => label === "ensure-codeclip-tiktok-oauth-states").length,
      1,
      "TikTok OAuth ensure runs exactly once"
    );
    assert.equal(
      calls[calls.length - 1],
      "ensure-codeclip-tiktok-oauth-states",
      "TikTok OAuth ensure is the final codeClip schema ensure"
    );
  } finally {
    for (const key of tiktokEnvKeys) {
      if (savedTikTokEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedTikTokEnv[key];
      }
    }
  }
});

test("codeClip startup fails closed when TikTok OAuth states ensure is not wired", async () => {
  const events = [];
  const databaseClient = createCodeClipStartupDatabaseClient(events);
  delete databaseClient.ensureCodeClipTikTokOAuthStatesTable;

  await assert.rejects(
    () => initializeCodeClipStartup({ databaseClient }),
    (error) => {
      assert.ok(error instanceof TypeError || error instanceof Error);
      assert.match(
        String(error && error.message),
        /ensureCodeClipTikTokOAuthStatesTable|is not a function|undefined/
      );
      return true;
    }
  );

  assert.equal(
    events.includes("ensure-codeclip-tiktok-oauth-states"),
    false,
    "TikTok ensure label must not be recorded when method is missing"
  );
  assert.equal(
    events.includes("ensure-codeclip-youtube-oauth-states"),
    true,
    "prior ensures still run before the missing TikTok ensure throws"
  );
});
