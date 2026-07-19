const test = require("node:test");
const assert = require("node:assert/strict");

const {
  app,
  initializeCodeClipStartup,
  startBackendServer,
} = require("./server");

test("codeClip startup initializes provider account binding schema before listen", async () => {
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
      databaseClient: {
        async ensureCodeClipProviderAccountBindingsTable() {
          events.push("ensure-bindings");
        },
        async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
          events.push("ensure-youtube-websub-subscriptions");
        },
        async ensureCodeClipYouTubeOAuthStatesTable() {
          events.push("ensure-youtube-oauth-states");
        },
        async ensureCodeClipProviderAccountBindingAuditTable() {
          events.push("ensure-binding-audit");
        },
      },
    });

    assert.equal(server, fakeServer);
    assert.deepEqual(events, [
      "ensure-bindings",
      "ensure-youtube-websub-subscriptions",
      "ensure-youtube-oauth-states",
      "ensure-binding-audit",
      "listen:0",
    ]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup binding init failure prevents listen", async () => {
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
          databaseClient: {
            async ensureCodeClipProviderAccountBindingsTable() {
              events.push("ensure-bindings");
              throw new Error("binding schema unavailable");
            },
            async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
              events.push("ensure-youtube-websub-subscriptions");
            },
            async ensureCodeClipYouTubeOAuthStatesTable() {
              events.push("ensure-youtube-oauth-states");
            },
            async ensureCodeClipProviderAccountBindingAuditTable() {
              events.push("ensure-binding-audit");
            },
          },
        }),
      /binding schema unavailable/
    );

    assert.deepEqual(events, ["ensure-bindings"]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup YouTube WebSub init failure prevents audit init and listen", async () => {
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
          databaseClient: {
            async ensureCodeClipProviderAccountBindingsTable() {
              events.push("ensure-bindings");
            },
            async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
              events.push("ensure-youtube-websub-subscriptions");
              throw new Error("youtube websub subscription schema unavailable");
            },
            async ensureCodeClipYouTubeOAuthStatesTable() {
              events.push("ensure-youtube-oauth-states");
            },
            async ensureCodeClipProviderAccountBindingAuditTable() {
              events.push("ensure-binding-audit");
            },
          },
        }),
      /youtube websub subscription schema unavailable/
    );

    assert.deepEqual(events, ["ensure-bindings", "ensure-youtube-websub-subscriptions"]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup YouTube OAuth state init failure prevents audit init and listen", async () => {
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
          databaseClient: {
            async ensureCodeClipProviderAccountBindingsTable() {
              events.push("ensure-bindings");
            },
            async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
              events.push("ensure-youtube-websub-subscriptions");
            },
            async ensureCodeClipYouTubeOAuthStatesTable() {
              events.push("ensure-youtube-oauth-states");
              throw new Error("youtube oauth state schema unavailable");
            },
            async ensureCodeClipProviderAccountBindingAuditTable() {
              events.push("ensure-binding-audit");
            },
          },
        }),
      /youtube oauth state schema unavailable/
    );

    assert.deepEqual(events, [
      "ensure-bindings",
      "ensure-youtube-websub-subscriptions",
      "ensure-youtube-oauth-states",
    ]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup audit init failure prevents listen", async () => {
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
          databaseClient: {
            async ensureCodeClipProviderAccountBindingsTable() {
              events.push("ensure-bindings");
            },
            async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
              events.push("ensure-youtube-websub-subscriptions");
            },
            async ensureCodeClipYouTubeOAuthStatesTable() {
              events.push("ensure-youtube-oauth-states");
            },
            async ensureCodeClipProviderAccountBindingAuditTable() {
              events.push("ensure-binding-audit");
              throw new Error("binding audit schema unavailable");
            },
          },
        }),
      /binding audit schema unavailable/
    );

    assert.deepEqual(events, [
      "ensure-bindings",
      "ensure-youtube-websub-subscriptions",
      "ensure-youtube-oauth-states",
      "ensure-binding-audit",
    ]);
  } finally {
    app.listen = originalListen;
  }
});

test("codeClip startup binding init is repeatable and does not run unrelated startup hooks", async () => {
  const calls = [];
  const databaseClient = {
    async ensureCodeClipProviderAccountBindingsTable() {
      calls.push("ensure-bindings");
    },
    async ensureCodeClipYouTubeWebSubSubscriptionsTable() {
      calls.push("ensure-youtube-websub-subscriptions");
    },
    async ensureCodeClipYouTubeOAuthStatesTable() {
      calls.push("ensure-youtube-oauth-states");
    },
    async ensureCodeClipProviderAccountBindingAuditTable() {
      calls.push("ensure-binding-audit");
    },
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
  };

  await initializeCodeClipStartup({ databaseClient });
  await initializeCodeClipStartup({ databaseClient });

  assert.deepEqual(calls, [
    "ensure-bindings",
    "ensure-youtube-websub-subscriptions",
    "ensure-youtube-oauth-states",
    "ensure-binding-audit",
    "ensure-bindings",
    "ensure-youtube-websub-subscriptions",
    "ensure-youtube-oauth-states",
    "ensure-binding-audit",
  ]);
});
