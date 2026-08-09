const test = require("node:test");
const assert = require("node:assert/strict");

const {
  completeOneProviderPollingDelivery,
  runCodeClipProviderPollingDeliveryCompletionCycle,
} = require("./verticals/codeclip/provider-polling/delivery-completion");

const NOW = "2026-08-09T05:10:00.000Z";

function eventRow(overrides = {}) {
  return {
    id: "event-1",
    code: "CC-TIKTOK-COMPLETE",
    vertical: "codeclip",
    status: "active",
    activationMethod: "provider",
    activationChannels: ["tiktok"],
    activationEvent: "published_video",
    raw_event: {
      id: "event-1",
      code: "CC-TIKTOK-COMPLETE",
      vertical: "codeclip",
      status: "active",
      activationMethod: "provider",
      activationChannels: ["tiktok"],
      activationEvent: "published_video",
      venue: "Test Venue",
      city: "Oslo",
      startAt: "2026-08-09T00:00:00.000Z",
      unlockAt: "2026-08-09T00:00:00.000Z",
      endAt: "2026-08-10T00:00:00.000Z",
      ...overrides.raw_event,
    },
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    id: "delivery-1",
    provider: "tiktok",
    providerAccountId: "sandbox-account",
    eventCode: "CC-TIKTOK-COMPLETE",
    eventId: "event-1",
    externalMessageId: "poll:tiktok:video-1",
    initialDeliverySource: "provider_polling",
    providerDetectionMetadata: {
      provider: "tiktok",
      channel: "tiktok",
      providerContentId: "video-1",
      publishedAt: "2026-08-09T04:00:00.000Z",
      detectedAt: "2026-08-09T04:01:00.000Z",
      detectionSource: "display_api_polling",
      canonicalUrl: "https://www.tiktok.com/@creator/video/video-1",
    },
    verificationState: "verified",
    processingState: "processing",
    corePersistenceState: "not_started",
    completionState: "not_completed",
    terminalState: false,
    ...overrides,
  };
}

function queryClient({ source = { environment: "sandbox", status: "active" } } = {}) {
  return {
    calls: [],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      if (/FROM codeclip_provider_poll_sources/.test(sql)) {
        return { rows: source ? [source] : [] };
      }
      return { rows: [] };
    },
  };
}

function deps(overrides = {}) {
  const stateUpdates = [];
  const persisted = [];
  const log = [];
  return {
    stateUpdates,
    persisted,
    log,
    queryClient: overrides.queryClient || queryClient(),
    getEventByCode: async () => overrides.event || eventRow(),
    findActiveBinding: async () =>
      overrides.binding === undefined
        ? {
            provider: "tiktok",
            channel: "tiktok",
            eventCode: "CC-TIKTOK-COMPLETE",
          }
        : overrides.binding,
    updateDeliveryState: async (_identity, updates) => {
      stateUpdates.push(updates);
      return { status: "updated", row: { ...delivery(), ...updates } };
    },
    claimDelivery: async ({ delivery: claimedDelivery }) => {
      stateUpdates.push({
        corePersistenceState: "processing",
        lastAttemptAt: NOW,
      });
      return { ...claimedDelivery, corePersistenceState: "processing" };
    },
    saveCodeClipInteraction: async (interaction) => {
      persisted.push({ step: "interaction", interaction });
      return { id: "interaction-1" };
    },
    saveCodeClipRewardAssignments: async () => [],
    saveCodeClipXtraRedemption: async () => null,
    runCodeClipCorePersistenceTransaction:
      overrides.runCodeClipCorePersistenceTransaction ||
      (async (work) => work({ queryClient: {} })),
    logger: {
      info: (event, fields) => log.push({ level: "info", event, fields }),
      warn: (event, fields) => log.push({ level: "warn", event, fields }),
    },
    now: NOW,
    ...overrides,
  };
}

test("TikTok provider_polling completion persists provider-event core state and completes ledger", async () => {
  const options = deps();
  const result = await completeOneProviderPollingDelivery(delivery(), options);

  assert.equal(result.status, "completed");
  assert.equal(options.persisted.length, 1);
  assert.equal(options.persisted[0].interaction.interactionType, "provider_event");
  assert.equal(options.persisted[0].interaction.providerEvent.provider, "tiktok");
  assert.equal(options.persisted[0].interaction.providerEvent.channel, "tiktok");
  assert.equal(options.persisted[0].interaction.providerEvent.activationEvent, "published_video");
  assert.equal(options.persisted[0].interaction.providerEvent.videoId, "video-1");
  assert.equal(options.persisted[0].interaction.providerEvent.providerEventId, "poll:tiktok:video-1");
  assert.equal(options.persisted[0].interaction.providerEvent.canonicalUrl, "https://www.tiktok.com/@creator/video/video-1");
  assert.equal(options.stateUpdates[0].corePersistenceState, "processing");
  assert.equal(options.stateUpdates[1].corePersistenceState, "committed");
  assert.equal(options.stateUpdates[1].processingState, "completed");
  assert.equal(options.stateUpdates[1].completionState, "completed");
  assert.equal(options.stateUpdates[1].terminalState, true);
  assert.equal(options.stateUpdates[1].retryEligible, false);
  assert.equal(JSON.stringify(options.log).includes("sandbox-account"), false);
});

test("old TikTok provider_polling row without metadata fails closed without core persistence", async () => {
  const options = deps();
  const result = await completeOneProviderPollingDelivery(
    delivery({ providerDetectionMetadata: null }),
    options
  );

  assert.equal(result.status, "terminal_failed");
  assert.equal(result.code, "COMPLETION_INPUT_INSUFFICIENT");
  assert.equal(options.persisted.length, 0);
  assert.equal(options.stateUpdates.length, 1);
  assert.equal(options.stateUpdates[0].errorClass, "COMPLETION_INPUT_INSUFFICIENT");
  assert.equal(options.stateUpdates[0].terminalState, true);
  assert.equal(options.stateUpdates[0].retryEligible, false);
});

test("old row without metadata fails closed before source resolution", async () => {
  const options = deps({ queryClient: queryClient({ source: null }) });
  const result = await completeOneProviderPollingDelivery(
    delivery({ providerDetectionMetadata: null }),
    options
  );

  assert.equal(result.status, "terminal_failed");
  assert.equal(result.code, "COMPLETION_INPUT_INSUFFICIENT");
  assert.equal(options.persisted.length, 0);
  assert.equal(options.stateUpdates[0].errorClass, "COMPLETION_INPUT_INSUFFICIENT");
});

test("completed, terminal, wrong provider and wrong source deliveries are skipped", async () => {
  for (const candidate of [
    delivery({ processingState: "completed", corePersistenceState: "committed", completionState: "completed", terminalState: true }),
    delivery({ terminalState: true }),
    delivery({ provider: "youtube" }),
    delivery({ initialDeliverySource: "websub" }),
  ]) {
    const options = deps();
    const result = await completeOneProviderPollingDelivery(candidate, options);
    assert.equal(result.status, "skipped");
    assert.equal(options.stateUpdates.length, 0);
    assert.equal(options.persisted.length, 0);
  }
});

test("malformed metadata and invalid event mapping are terminal safe failures", async () => {
  const malformed = deps();
  const malformedResult = await completeOneProviderPollingDelivery(
    delivery({
      providerDetectionMetadata: {
        provider: "tiktok",
        providerContentId: "video-1",
      },
    }),
    malformed
  );
  assert.equal(malformedResult.code, "COMPLETION_INPUT_INSUFFICIENT");
  assert.equal(malformed.persisted.length, 0);

  const invalidEvent = deps({
    event: eventRow({ raw_event: { activationEvent: "something_else" } }),
  });
  const invalidResult = await completeOneProviderPollingDelivery(delivery(), invalidEvent);
  assert.equal(invalidResult.code, "INVALID_EVENT_MAPPING");
  assert.equal(invalidEvent.persisted.length, 0);
  assert.equal(invalidEvent.stateUpdates.at(-1).terminalState, true);
});

test("transient core persistence failure is retryable and not completed", async () => {
  const options = deps({
    runCodeClipCorePersistenceTransaction: async () => {
      throw new Error("forced persistence failure");
    },
  });
  const result = await completeOneProviderPollingDelivery(delivery(), options);

  assert.equal(result.status, "retryable_failed");
  assert.equal(result.code, "CORE_PERSISTENCE_FAILED");
  assert.equal(options.stateUpdates[0].corePersistenceState, "processing");
  assert.equal(options.stateUpdates[1].processingState, "failed");
  assert.equal(options.stateUpdates[1].corePersistenceState, "failed");
  assert.equal(options.stateUpdates[1].retryEligible, true);
  assert.equal(options.stateUpdates[1].terminalState, false);
});

test("cycle selects only active environment-matching TikTok deliveries", async () => {
  const options = deps({
    listDeliveries: async () => [
      delivery(),
      delivery({ id: "delivery-2", externalMessageId: "poll:tiktok:video-2" }),
    ],
  });
  const result = await runCodeClipProviderPollingDeliveryCompletionCycle(
    { provider: "tiktok", environment: "sandbox", limit: 10 },
    options
  );

  assert.equal(result.selected, 2);
  assert.equal(result.completed, 2);
  assert.equal(options.persisted.length, 2);
});

test("explicit environment mismatch is skipped without terminal mutation", async () => {
  const options = deps({ queryClient: queryClient({ source: null }) });
  const result = await completeOneProviderPollingDelivery(delivery(), {
    ...options,
    environment: "production",
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.code, "environment_mismatch");
  assert.equal(options.stateUpdates.length, 0);
  assert.equal(options.persisted.length, 0);
});

test("completion requires no provider HTTP dependency", async () => {
  const options = deps();
  options.fetch = () => {
    throw new Error("provider HTTP must not be called");
  };
  const result = await completeOneProviderPollingDelivery(delivery(), options);
  assert.equal(result.status, "completed");
});

test("TikTok provider_polling completion persists and replays idempotently in PostgreSQL", async (t) => {
  const connectionString =
    process.env.CODECLIP_PROVIDER_POLL_SOURCES_CONCURRENCY_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("CODECLIP_PROVIDER_POLL_SOURCES_CONCURRENCY_TEST_DATABASE_URL is not configured");
    return;
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    t.skip("concurrency test database URL is invalid");
    return;
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    t.skip("completion E2E requires local PostgreSQL");
    return;
  }

  const { Pool } = require("pg");
  const database = require("./db");
  const {
    createCodeClipProviderAccountBinding,
  } = require("./verticals/codeclip/provider-account-bindings");

  const pool = new Pool({ connectionString });
  const schema = `codeclip_poll_completion_${process.pid}_${Date.now()}`;
  const eventCode = "CC-TIKTOK-COMPLETE-PG";
  const accountId = "tiktok-completion-pg-account";
  const externalMessageId = "poll:tiktok:pg-video-1";
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await database.ensureCodeClipProviderDeliveriesTable(pool);
    await database.ensureCodeClipProviderAccountBindingsTable(pool);
    await database.ensureCodeClipProviderPollSourcesTable(pool);
    await pool.query(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        vertical TEXT NOT NULL,
        event_code TEXT UNIQUE NOT NULL,
        name TEXT,
        status TEXT,
        raw_event JSONB
      )
    `);
    await pool.query(`
      CREATE TABLE codeclip_interactions (
        id BIGSERIAL PRIMARY KEY,
        event_code TEXT NOT NULL,
        event_id TEXT,
        scan_id TEXT NOT NULL,
        vertical TEXT NOT NULL DEFAULT 'codeclip',
        routing_outcome TEXT NOT NULL DEFAULT 'MATCH',
        interaction_state TEXT NOT NULL DEFAULT 'processed',
        tier TEXT,
        scan_rank INTEGER,
        raw_scans INTEGER,
        unique_scans INTEGER,
        reward_assignments JSONB,
        raw_payload JSONB,
        occurred_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (event_code, scan_id)
      )
    `);
    await pool.query(
      `
        INSERT INTO campaigns (id, vertical, event_code, name, status, raw_event)
        VALUES ($1, 'codeclip', $2, 'Completion PG Episode', 'active', $3::jsonb)
      `,
      [
        "event-pg",
        eventCode,
        JSON.stringify({
          id: "event-pg",
          vertical: "codeclip",
          status: "active",
          activationMethod: "provider",
          activationChannels: ["tiktok"],
          activationEvent: "published_video",
          startAt: "2026-08-09T00:00:00.000Z",
          unlockAt: "2026-08-09T00:00:00.000Z",
          endAt: "2026-08-10T00:00:00.000Z",
        }),
      ]
    );
    await createCodeClipProviderAccountBinding(
      {
        eventCode,
        provider: "tiktok",
        channel: "tiktok",
        providerAccountId: accountId,
        createdBy: "completion-pg",
      },
      {
        queryClient: pool,
        getEventByCode: async () => ({ event_code: eventCode, vertical: "codeclip" }),
      }
    );
    await pool.query(
      `
        INSERT INTO codeclip_provider_poll_sources (
          vertical, provider, environment, account_lookup_key,
          provider_account_id, status, poll_interval_ms
        )
        VALUES ('codeclip', 'tiktok', 'sandbox', $1, $1, 'active', 30000)
      `,
      [accountId]
    );
    const created = await database.createCodeClipProviderDelivery(
      {
        provider: "tiktok",
        providerAccountId: accountId,
        eventCode,
        eventId: "event-pg",
        externalMessageId,
        initialDeliverySource: "provider_polling",
        providerDetectionMetadata: {
          provider: "tiktok",
          channel: "tiktok",
          providerContentId: "pg-video-1",
          publishedAt: "2026-08-09T04:00:00.000Z",
          detectedAt: "2026-08-09T04:01:00.000Z",
          detectionSource: "display_api_polling",
          canonicalUrl: "https://www.tiktok.com/@creator/video/pg-video-1",
        },
      },
      pool
    );
    assert.equal(created.status, "created");

    const getEventByCode = async (code) => {
      const result = await pool.query(
        `SELECT * FROM campaigns WHERE event_code = $1`,
        [code]
      );
      return result.rows[0] || null;
    };
    const before = await database.getCodeClipProviderDeliveryByIdentity(
      {
        provider: "tiktok",
        providerAccountId: accountId,
        eventCode,
        externalMessageId,
      },
      pool
    );
    const completed = await completeOneProviderPollingDelivery(before, {
      queryClient: pool,
      getEventByCode,
      runCodeClipCorePersistenceTransaction: async (work) =>
        work({ queryClient: pool }),
      now: NOW,
      environment: "sandbox",
    });
    assert.equal(completed.status, "completed");

    const interactionCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM codeclip_interactions WHERE event_code = $1`,
      [eventCode]
    );
    assert.equal(interactionCount.rows[0].c, 1);

    const after = await database.getCodeClipProviderDeliveryByIdentity(
      {
        provider: "tiktok",
        providerAccountId: accountId,
        eventCode,
        externalMessageId,
      },
      pool
    );
    assert.equal(after.corePersistenceState, "committed");
    assert.equal(after.processingState, "completed");
    assert.equal(after.completionState, "completed");
    assert.equal(after.terminalState, true);

    const replay = await completeOneProviderPollingDelivery(after, {
      queryClient: pool,
      getEventByCode,
      runCodeClipCorePersistenceTransaction: async (work) =>
        work({ queryClient: pool }),
      now: NOW,
      environment: "sandbox",
    });
    assert.equal(replay.status, "skipped");
    const replayCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM codeclip_interactions WHERE event_code = $1`,
      [eventCode]
    );
    assert.equal(replayCount.rows[0].c, 1);

    const oldRow = await database.createCodeClipProviderDelivery(
      {
        provider: "tiktok",
        providerAccountId: accountId,
        eventCode,
        externalMessageId: "poll:tiktok:old-no-metadata",
        initialDeliverySource: "provider_polling",
      },
      pool
    );
    assert.equal(oldRow.status, "created");
    const oldResult = await completeOneProviderPollingDelivery(oldRow.row, {
      queryClient: pool,
      getEventByCode,
      now: NOW,
      environment: "sandbox",
    });
    assert.equal(oldResult.code, "COMPLETION_INPUT_INSUFFICIENT");
    const finalCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM codeclip_interactions WHERE event_code = $1`,
      [eventCode]
    );
    assert.equal(finalCount.rows[0].c, 1);
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch {
      // ignore cleanup failure in test teardown
    }
    await pool.end();
  }
});
