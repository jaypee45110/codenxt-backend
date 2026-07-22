const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipYouTubeWebSubSubscriptionsTable } = require("./db");
const {
  CodeClipYouTubeWebSubSubscriptionError,
  SUBSCRIPTION_STATUSES,
  PENDING_MODES,
  claimCodeClipYouTubeWebSubRenewDispatch,
  claimCodeClipYouTubeWebSubSubscribeDispatch,
  claimCodeClipYouTubeWebSubUnsubscribeDispatch,
  createPendingCodeClipYouTubeWebSubSubscription,
  disableCodeClipYouTubeWebSubSubscription,
  getCodeClipYouTubeWebSubSubscriptionByCallbackId,
  getCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId,
  markCodeClipYouTubeWebSubSubscriptionExpired,
  markCodeClipYouTubeWebSubSubscriptionRenewalPending,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribePending,
  markCodeClipYouTubeWebSubSubscriptionUnsubscribed,
  markCodeClipYouTubeWebSubSubscriptionVerified,
  normalizeSubscriptionInput,
  recordCodeClipYouTubeWebSubRenewDispatchResult,
  recordCodeClipYouTubeWebSubSubscribeDispatchResult,
  recordCodeClipYouTubeWebSubUnsubscribeDispatchResult,
  recordCodeClipYouTubeWebSubSubscriptionAudit,
  recordCodeClipYouTubeWebSubFirstActivatedVideo,
  toInternalCodeClipYouTubeWebSubSubscription,
  updateCodeClipYouTubeWebSubSubscriptionLease,
} = require("./verticals/codeclip/youtube-websub-subscriptions");

const CHANNEL_ID = "UCabcdefghijklmno12345678";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

function validInput(overrides = {}) {
  return {
    callbackId: "yt_cb_123",
    providerAccountId: CHANNEL_ID,
    topic: TOPIC,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: overrides.id || "1",
    vertical: overrides.vertical || "codeclip",
    callback_id: overrides.callback_id || "yt_cb_123",
    provider: overrides.provider || "youtube",
    channel: overrides.channel || "youtube",
    provider_account_id: overrides.provider_account_id || CHANNEL_ID,
    topic: overrides.topic || TOPIC,
    status: overrides.status || SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
    pending_mode: overrides.pending_mode ?? PENDING_MODES.SUBSCRIBE,
    secret_version: overrides.secret_version || "v1",
    activation_boundary_at: overrides.activation_boundary_at || null,
    activation_boundary_video_id: overrides.activation_boundary_video_id || null,
    activated_at: overrides.activated_at || null,
    first_activated_video_id: overrides.first_activated_video_id || null,
    first_activated_at: overrides.first_activated_at || null,
    lease_started_at: overrides.lease_started_at || null,
    lease_expires_at: overrides.lease_expires_at || null,
    last_verified_at: overrides.last_verified_at || null,
    metadata: overrides.metadata || {},
    created_at: overrides.created_at || "2026-07-17T00:00:00.000Z",
    updated_at: overrides.updated_at || "2026-07-17T00:00:00.000Z",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSafeAttemptNumber(value) {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value < 2147483647
  );
}

function claimableDispatch(dispatch, nowEpochMs, expectedMode = "subscribe") {
  if (dispatch === undefined || dispatch === null) return true;
  if (typeof dispatch !== "object" || Array.isArray(dispatch)) return false;
  if (dispatch.status === "failed") {
    return (
      dispatch.mode === expectedMode &&
      dispatch.retryEligible === true &&
      isSafeAttemptNumber(dispatch.attemptNumber)
    );
  }
  if (dispatch.status === "started") {
    return (
      dispatch.mode === expectedMode &&
      isSafeAttemptNumber(dispatch.attemptNumber) &&
      Number.isSafeInteger(dispatch.staleAfterEpochMs) &&
      dispatch.staleAfterEpochMs >= 0 &&
      dispatch.staleAfterEpochMs <= nowEpochMs
    );
  }
  return false;
}

function createSubscriptionClient() {
  const calls = [];
  const rows = [];
  let nextId = 1;

  function find(callbackId) {
    return rows.find(
      (item) =>
        item.callback_id === callbackId &&
        item.vertical === "codeclip" &&
        item.provider === "youtube" &&
        item.channel === "youtube"
    ) || null;
  }

  function touch(current) {
    current.updated_at = "2026-07-17T00:00:01.000Z";
    return current;
  }

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/INSERT INTO codeclip_youtube_websub_subscriptions/.test(sql)) {
        const openStatuses = new Set([
          SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
          SUBSCRIPTION_STATUSES.ACTIVE,
          SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
          SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
        ]);
        const existingOpen = rows.find(
          (item) =>
            item.vertical === params[0] &&
            item.provider === params[2] &&
            item.provider_account_id === params[4] &&
            openStatuses.has(item.status) &&
            openStatuses.has(params[6])
        );
        if (existingOpen) {
          const error = new Error("duplicate open subscription");
          error.code = "23505";
          error.constraint = "codeclip_youtube_websub_subscriptions_open_account_uidx";
          throw error;
        }
        const inserted = row({
          id: String(nextId++),
          vertical: params[0],
          callback_id: params[1],
          provider: params[2],
          channel: params[3],
          provider_account_id: params[4],
          topic: params[5],
          status: params[6],
          pending_mode: params[7],
          secret_version: params[8],
          activation_boundary_at: params[9],
          activation_boundary_video_id: params[10],
          activated_at: params[11],
          first_activated_video_id: params[12],
          first_activated_at: params[13],
          lease_started_at: params[14],
          lease_expires_at: params[15],
          last_verified_at: params[16],
          metadata: JSON.parse(params[17]),
        });
        rows.push(inserted);
        return { rows: [inserted] };
      }

      if (/INSERT INTO codeclip_youtube_websub_subscription_audit/.test(sql)) {
        const inserted = {
          id: String(nextId++),
          vertical: "codeclip",
          provider: "youtube",
          callback_id: params[0],
          provider_account_id: params[1],
          event_code: params[2],
          action: params[3],
          mode: params[4],
          result_code: params[5],
          hub_http_status: params[6],
          retryable: params[7],
          metadata: JSON.parse(params[8]),
          created_at: "2026-07-18T00:00:02.000Z",
        };
        return { rows: [inserted] };
      }

      if (
        /UPDATE codeclip_youtube_websub_subscriptions/.test(sql) &&
        /attemptNumber/.test(sql) &&
        /staleAfterEpochMs/.test(sql)
      ) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        const nowEpochMs = params[4] ?? 1_800_000_000_000;
        const mode = params[5];
        const requiredStatus = params[6];
        const requiredPendingMode = params[7];
        if (
          current.status !== requiredStatus ||
          current.pending_mode !== requiredPendingMode ||
          !claimableDispatch(current.metadata.dispatch, nowEpochMs, mode)
        ) {
          return { rows: [] };
        }
        const previousAttemptNumber = isSafeAttemptNumber(current.metadata.dispatch?.attemptNumber)
          ? current.metadata.dispatch.attemptNumber
          : 0;
        current.metadata = {
          ...current.metadata,
          dispatch: {
            attemptId: params[1],
            attemptNumber: previousAttemptNumber + 1,
            previousAttemptCount: previousAttemptNumber,
            status: "started",
            mode,
            startedAt: "2026-07-17T00:00:01.000Z",
            staleAfterEpochMs: nowEpochMs + params[3] * 1000,
            requestedLeaseSeconds: params[2],
            retryEligible: false,
          },
        };
        return { rows: [touch(current)] };
      }

      if (
        /UPDATE codeclip_youtube_websub_subscriptions/.test(sql) &&
        /resultCode/.test(sql) &&
        /completedAt/.test(sql)
      ) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        const dispatch = current.metadata.dispatch;
        const mode = params[6];
        const allowedStates = [
          { status: params[7], pending_mode: params[8] },
          { status: params[9], pending_mode: params[10] },
          { status: params[11], pending_mode: params[12] },
        ];
        if (
          typeof dispatch !== "object" ||
          dispatch === null ||
          dispatch.attemptId !== params[1] ||
          dispatch.status !== "started" ||
          dispatch.mode !== mode ||
          !allowedStates.some((state) =>
            current.status === state.status &&
            current.pending_mode === state.pending_mode
          )
        ) {
          return { rows: [] };
        }
        current.metadata = {
          ...current.metadata,
          dispatch: {
            ...dispatch,
            attemptId: params[1],
            status: params[2],
            mode,
            resultCode: params[3],
            hubHttpStatus: params[4],
            retryEligible: params[5],
            completedAt: "2026-07-17T00:00:02.000Z",
          },
        };
        return { rows: [touch(current)] };
      }

      if (/FROM codeclip_youtube_websub_subscriptions/.test(sql) && /callback_id = \$1/.test(sql)) {
        return { rows: find(params[0]) ? [find(params[0])] : [] };
      }

      if (/FROM codeclip_youtube_websub_subscriptions/.test(sql) && /provider_account_id = \$1/.test(sql)) {
        return {
          rows: rows
            .filter(
              (item) =>
                item.provider_account_id === params[0] &&
                item.vertical === "codeclip" &&
                item.provider === "youtube" &&
                item.channel === "youtube" &&
                (
                  !/status IN/.test(sql) ||
                  [
                    SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
                    SUBSCRIPTION_STATUSES.ACTIVE,
                    SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
                    SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
                  ].includes(item.status)
                )
            )
            .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
            .slice(0, 1),
        };
      }

      if (/UPDATE codeclip_youtube_websub_subscriptions/.test(sql) && /status = 'active'/.test(sql)) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        current.status = "active";
        current.pending_mode = null;
        current.activation_boundary_at = current.activation_boundary_at || params[1];
        current.activation_boundary_video_id = current.activation_boundary_video_id || params[2];
        current.activated_at = current.activated_at || params[3];
        current.lease_started_at = params[4];
        current.lease_expires_at = params[5];
        current.last_verified_at = params[3];
        return { rows: [touch(current)] };
      }

      if (/UPDATE codeclip_youtube_websub_subscriptions/.test(sql) && /status = \$2/.test(sql)) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        current.status = params[1];
        current.pending_mode = params[2];
        return { rows: [touch(current)] };
      }

      if (/UPDATE codeclip_youtube_websub_subscriptions/.test(sql) && /lease_started_at = COALESCE/.test(sql)) {
        const current = find(params[0]);
        if (!current) return { rows: [] };
        current.lease_started_at = params[1] || current.lease_started_at;
        current.lease_expires_at = params[2] || current.lease_expires_at;
        current.last_verified_at = params[3] || current.last_verified_at;
        return { rows: [touch(current)] };
      }

      if (/UPDATE codeclip_youtube_websub_subscriptions/.test(sql) && /first_activated_video_id IS NULL/.test(sql)) {
        const current = find(params[0]);
        if (!current || current.first_activated_video_id) return { rows: [] };
        current.first_activated_video_id = params[1];
        current.first_activated_at = params[2];
        return { rows: [touch(current)] };
      }

      return { rows: [] };
    },
  };
}

const CURRENT_AUDIT_MODE_CONSTRAINT =
  "CHECK (((mode IS NULL) OR (mode = ANY (ARRAY['subscribe'::text, 'renew'::text, 'unsubscribe'::text]))))";
const OLD_AUDIT_MODE_CONSTRAINT =
  "CHECK (((mode IS NULL) OR (mode = ANY (ARRAY['subscribe'::text, 'unsubscribe'::text]))))";

function isAuditConstraintInspect(sql) {
  return /pg_get_constraintdef/.test(sql) &&
    /codeclip_youtube_websub_subscription_audit/.test(sql);
}

function isAuditConstraintDdl(sql) {
  return /ALTER TABLE codeclip_youtube_websub_subscription_audit/.test(sql) &&
    /codeclip_youtube_websub_subscription_audit_mode_check/.test(sql);
}

function createSchemaEnsureClient({ constraintDefinition = CURRENT_AUDIT_MODE_CONSTRAINT } = {}) {
  const calls = [];
  let definition = constraintDefinition;
  return {
    calls,
    rows: [],
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (isAuditConstraintInspect(sql)) {
        return { rows: definition ? [{ definition }] : [] };
      }
      if (/ADD CONSTRAINT codeclip_youtube_websub_subscription_audit_mode_check/.test(sql)) {
        definition = CURRENT_AUDIT_MODE_CONSTRAINT;
      }
      return { rows: [] };
    },
  };
}

function createConcurrentSchemaEnsurePool({ constraintDefinition = OLD_AUDIT_MODE_CONSTRAINT } = {}) {
  const calls = [];
  let definition = constraintDefinition;
  let locked = false;
  const waiters = [];

  async function acquireLock() {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }

  function releaseLock() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    locked = false;
  }

  function createClient(clientId) {
    return {
      async query(sql, params = []) {
        calls.push({ clientId, sql, params });
        if (/pg_advisory_xact_lock/.test(sql)) {
          await acquireLock();
          return { rows: [] };
        }
        if (isAuditConstraintInspect(sql)) {
          return { rows: definition ? [{ definition }] : [] };
        }
        if (/ADD CONSTRAINT codeclip_youtube_websub_subscription_audit_mode_check/.test(sql)) {
          definition = CURRENT_AUDIT_MODE_CONSTRAINT;
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          releaseLock();
        }
        return { rows: [] };
      },
      release() {},
    };
  }

  return {
    calls,
    async query(sql, params = []) {
      calls.push({ clientId: "pool", sql, params });
      return { rows: [] };
    },
    async connect() {
      return createClient(calls.filter((call) => call.sql === "BEGIN").length + 1);
    },
  };
}

test("YouTube WebSub subscription schema ensure is idempotent and preserves data", async () => {
  const existingRow = row({ callback_id: "existing_cb" });
  const client = createSchemaEnsureClient();
  client.rows = [clone(existingRow)];

  await ensureCodeClipYouTubeWebSubSubscriptionsTable(client);
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(client);

  const sql = client.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS codeclip_youtube_websub_subscriptions/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS first_activated_video_id TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS first_activated_at TIMESTAMPTZ/);
  assert.match(sql, /CHECK \(provider = 'youtube'\)/);
  assert.match(sql, /CHECK \(channel = 'youtube'\)/);
  assert.match(sql, /callback_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /codeclip_youtube_websub_subscriptions_account_idx/);
  assert.match(sql, /codeclip_youtube_websub_subscriptions_topic_idx/);
  assert.match(sql, /codeclip_youtube_websub_subscriptions_status_lease_idx/);
  assert.match(sql, /codeclip_youtube_websub_subscriptions_open_account_uidx/);
  const openIndexSql = client.calls
    .map((call) => call.sql)
    .find((statement) => /codeclip_youtube_websub_subscriptions_open_account_uidx/.test(statement));
  assert.match(openIndexSql, /'pending_subscribe'/);
  assert.match(openIndexSql, /'active'/);
  assert.match(openIndexSql, /'pending_renewal'/);
  assert.match(openIndexSql, /'pending_unsubscribe'/);
  assert.doesNotMatch(openIndexSql, /'expired'/);
  assert.doesNotMatch(openIndexSql, /'unsubscribed'/);
  assert.doesNotMatch(openIndexSql, /'disabled'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS codeclip_youtube_websub_subscription_audit/);
  assert.match(sql, /subscription_requested/);
  assert.match(sql, /renewal_requested/);
  assert.match(sql, /unsubscribe_requested/);
  assert.match(sql, /hub_request_accepted/);
  assert.match(sql, /hub_request_failed/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /pg_get_constraintdef/);
  assert.match(sql, /codeclip_youtube_websub_subscription_audit_mode_check/);
  assert.match(sql, /'renew'/);
  assert.match(sql, /codeclip_youtube_websub_subscription_audit_callback_idx/);
  assert.match(sql, /codeclip_youtube_websub_subscription_audit_account_idx/);
  assert.equal(client.calls.filter((call) => isAuditConstraintDdl(call.sql)).length, 0);
  assert.deepEqual(client.rows, [existingRow]);
});

test("YouTube WebSub audit mode constraint is upgraded only when missing or stale", async () => {
  const missing = createSchemaEnsureClient({ constraintDefinition: null });
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(missing);
  assert.equal(missing.calls.filter((call) => isAuditConstraintDdl(call.sql)).length, 2);

  const stale = createSchemaEnsureClient({ constraintDefinition: OLD_AUDIT_MODE_CONSTRAINT });
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(stale);
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(stale);
  assert.equal(stale.calls.filter((call) => isAuditConstraintDdl(call.sql)).length, 2);

  const current = createSchemaEnsureClient({ constraintDefinition: CURRENT_AUDIT_MODE_CONSTRAINT });
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(current);
  await ensureCodeClipYouTubeWebSubSubscriptionsTable(current);
  assert.equal(current.calls.filter((call) => isAuditConstraintDdl(call.sql)).length, 0);
});

test("YouTube WebSub audit mode constraint upgrade is advisory-lock serialized", async () => {
  const pool = createConcurrentSchemaEnsurePool({
    constraintDefinition: OLD_AUDIT_MODE_CONSTRAINT,
  });
  await Promise.all([
    ensureCodeClipYouTubeWebSubSubscriptionsTable(pool),
    ensureCodeClipYouTubeWebSubSubscriptionsTable(pool),
  ]);

  assert.equal(pool.calls.filter((call) => /pg_advisory_xact_lock/.test(call.sql)).length, 2);
  assert.equal(pool.calls.filter((call) => isAuditConstraintInspect(call.sql)).length, 2);
  assert.equal(pool.calls.filter((call) => isAuditConstraintDdl(call.sql)).length, 2);
});

test("YouTube WebSub subscription input validation accepts canonical channel IDs", () => {
  const normalized = normalizeSubscriptionInput(validInput());

  assert.equal(normalized.vertical, "codeclip");
  assert.equal(normalized.provider, "youtube");
  assert.equal(normalized.channel, "youtube");
  assert.equal(normalized.providerAccountId, CHANNEL_ID);
  assert.equal(normalized.status, SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE);
  assert.equal(normalized.pendingMode, PENDING_MODES.SUBSCRIBE);
  assert.equal(normalized.secretVersion, "v1");
});

test("YouTube WebSub subscription input validation rejects unsafe identifiers and fields", () => {
  const invalidInputs = [
    { providerAccountId: `https://youtube.com/channel/${CHANNEL_ID}` },
    { providerAccountId: "@codeclip" },
    { providerAccountId: "not-a-channel-id" },
    { topic: TOPIC.replace("https://", "http://") },
    { topic: "not-a-url" },
    { topic: "https://www.youtube.com/feeds/videos.xml?channel_id=UCotherchannelid1234567890" },
    { callbackId: "../bad" },
    { callbackId: "bad/callback" },
    { status: "ready" },
    { pendingMode: "activate" },
    { activationBoundaryAt: "not-a-date" },
    { firstActivatedAt: {} },
    { firstActivatedVideoId: "bad video" },
    { metadata: [] },
  ];

  for (const overrides of invalidInputs) {
    assert.throws(
      () => normalizeSubscriptionInput(validInput(overrides)),
      CodeClipYouTubeWebSubSubscriptionError
    );
  }
});

test("YouTube WebSub subscription repository requires queryClient", async () => {
  await assert.rejects(
    () => createPendingCodeClipYouTubeWebSubSubscription(validInput()),
    (error) => error.code === "DATABASE_UNAVAILABLE"
  );
});

test("YouTube WebSub subscription create and reads are scoped and parameterized", async () => {
  const client = createSubscriptionClient();
  const created = await createPendingCodeClipYouTubeWebSubSubscription(
    {
      ...validInput(),
      rootSecret: "must-not-store",
      derivedSecret: "must-not-store",
    },
    { queryClient: client }
  );

  assert.equal(created.status, SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE);
  assert.equal(created.pendingMode, PENDING_MODES.SUBSCRIBE);
  assert.equal(created.providerAccountId, CHANNEL_ID);
  assert.equal(created.secretVersion, "v1");
  assert.equal(JSON.stringify(client.calls), JSON.stringify(client.calls).replace(/must-not-store/g, ""));

  const byCallback = await getCodeClipYouTubeWebSubSubscriptionByCallbackId("yt_cb_123", {
    queryClient: client,
  });
  assert.equal(byCallback.id, created.id);

  const byAccount = await getCodeClipYouTubeWebSubSubscriptionByProviderAccountId(CHANNEL_ID, {
    queryClient: client,
  });
  assert.equal(byAccount.id, created.id);

  for (const call of client.calls) {
    assert.ok(Array.isArray(call.params));
    assert.match(call.sql, /codeclip_youtube_websub_subscriptions/);
    if (/SELECT|UPDATE/.test(call.sql)) {
      assert.match(call.sql, /vertical = 'codeclip'/);
      assert.match(call.sql, /provider = 'youtube'/);
      assert.match(call.sql, /channel = 'youtube'/);
    }
  }
});

test("YouTube WebSub subscribe dispatch claim allows absent and JSON-null dispatch only as initial states", async () => {
  const absent = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: absent });
  const absentClaim = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_absent",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: absent,
  });

  assert.equal(absentClaim.metadata.dispatch.attemptId, "attempt_absent");
  assert.equal(absentClaim.metadata.dispatch.attemptNumber, 1);
  assert.equal(absentClaim.metadata.dispatch.previousAttemptCount, 0);
  assert.equal(absentClaim.metadata.dispatch.status, "started");
  assert.equal(absentClaim.metadata.dispatch.mode, "subscribe");
  assert.equal(absentClaim.metadata.dispatch.staleAfterEpochMs, 1_800_000_060_000);

  const jsonNull = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({ metadata: { dispatch: null } }),
    { queryClient: jsonNull }
  );
  const jsonNullClaim = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_null",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: jsonNull,
  });

  assert.equal(jsonNullClaim.metadata.dispatch.attemptId, "attempt_null");
  assert.equal(jsonNullClaim.metadata.dispatch.attemptNumber, 1);
});

test("YouTube WebSub subscribe dispatch claim fails closed for malformed dispatch metadata", async () => {
  const malformedDispatches = [
    {},
    { status: "pending" },
    { status: "failed", retryEligible: true, attemptNumber: 1 },
    { status: "failed", mode: "unsubscribe", retryEligible: true, attemptNumber: 1 },
    { status: "started", staleAfterEpochMs: 1, attemptNumber: 1 },
    { status: "started", mode: "unsubscribe", staleAfterEpochMs: 1, attemptNumber: 1 },
    { status: "started", mode: "subscribe", staleAfterEpochMs: "1", attemptNumber: 1 },
    { status: "started", mode: "subscribe", staleAfterEpochMs: 1, attemptNumber: "1" },
    { status: "started", mode: "subscribe", staleAfterEpochMs: 1, attemptNumber: 1.5 },
    { status: "started", mode: "subscribe", staleAfterEpochMs: 1, attemptNumber: -1 },
    { status: "started", mode: "subscribe", staleAfterEpochMs: 1, attemptNumber: 2147483647 },
  ];

  for (const dispatch of malformedDispatches) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({ metadata: { dispatch } }),
      { queryClient: client }
    );
    const claimed = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
      attemptId: "attempt_malformed",
      leaseSeconds: 864000,
      staleAfterSeconds: 60,
      nowEpochMs: 1_800_000_000_000,
      queryClient: client,
    });

    assert.equal(claimed, null, `malformed dispatch was claimable: ${JSON.stringify(dispatch)}`);
  }
});

test("YouTube WebSub subscribe dispatch claim supports retryable failed subscribe and mode isolation", async () => {
  const retryable = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      metadata: {
        dispatch: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          status: "failed",
          mode: "subscribe",
          retryEligible: true,
        },
      },
    }),
    { queryClient: retryable }
  );

  const claimed = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_2",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: retryable,
  });
  assert.equal(claimed.metadata.dispatch.attemptId, "attempt_2");
  assert.equal(claimed.metadata.dispatch.attemptNumber, 2);
  assert.equal(claimed.metadata.dispatch.previousAttemptCount, 1);

  for (const dispatch of [
    { attemptId: "attempt_1", attemptNumber: 1, status: "failed", retryEligible: true },
    {
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "failed",
      mode: "unsubscribe",
      retryEligible: true,
    },
  ]) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({ metadata: { dispatch } }),
      { queryClient: client }
    );
    const result = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
      attemptId: "attempt_rejected",
      leaseSeconds: 864000,
      staleAfterSeconds: 60,
      nowEpochMs: 1_800_000_000_000,
      queryClient: client,
    });
    assert.equal(result, null);
  }
});

test("YouTube WebSub subscribe dispatch claim rejects terminal success and non-retryable failure", async () => {
  for (const dispatch of [
    {
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "accepted",
      mode: "subscribe",
      retryEligible: false,
      resultCode: "hub_request_accepted",
    },
    {
      attemptId: "attempt_1",
      attemptNumber: 1,
      status: "failed",
      mode: "subscribe",
      retryEligible: false,
      resultCode: "hub_request_rejected",
    },
  ]) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({ metadata: { dispatch } }),
      { queryClient: client }
    );

    const claimed = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
      attemptId: "attempt_2",
      leaseSeconds: 864000,
      staleAfterSeconds: 60,
      nowEpochMs: 1_800_000_000_000,
      queryClient: client,
    });

    assert.equal(claimed, null);
    assert.equal(client.rows[0].metadata.dispatch.attemptId, "attempt_1");
    assert.equal(client.rows[0].metadata.dispatch.status, dispatch.status);
  }
});

test("YouTube WebSub subscribe dispatch claim supports numeric stale reclaim and rejects fresh claims", async () => {
  const stale = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      metadata: {
        dispatch: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          status: "started",
          mode: "subscribe",
          staleAfterEpochMs: 1_799_999_999_999,
          retryEligible: false,
        },
      },
    }),
    { queryClient: stale }
  );
  const reclaimed = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_2",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: stale,
  });
  assert.equal(reclaimed.metadata.dispatch.attemptId, "attempt_2");
  assert.equal(reclaimed.metadata.dispatch.attemptNumber, 2);

  const fresh = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      metadata: {
        dispatch: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          status: "started",
          mode: "subscribe",
          staleAfterEpochMs: 1_800_000_060_000,
          retryEligible: false,
        },
      },
    }),
    { queryClient: fresh }
  );
  const rejected = await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_2",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: fresh,
  });
  assert.equal(rejected, null);
});

test("YouTube WebSub subscribe dispatch validates stale comparison inputs", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });

  for (const nowEpochMs of [1.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
    await assert.rejects(
      () => claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
        attemptId: "attempt_invalid_now",
        staleAfterSeconds: 60,
        nowEpochMs,
        queryClient: client,
      }),
      CodeClipYouTubeWebSubSubscriptionError
    );
  }

  for (const staleAfterSeconds of [0, -1, 3601, 1.5]) {
    await assert.rejects(
      () => claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
        attemptId: "attempt_invalid_stale",
        staleAfterSeconds,
        nowEpochMs: 1_800_000_000_000,
        queryClient: client,
      }),
      CodeClipYouTubeWebSubSubscriptionError
    );
  }
});

test("YouTube WebSub subscribe dispatch result is owned by exact attempt and preserves verified callback race", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });
  await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_1",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: client,
  });

  const wrongAttempt = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_other",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryable: true,
    queryClient: client,
  });
  assert.equal(wrongAttempt, null);

  client.rows[0].status = SUBSCRIPTION_STATUSES.ACTIVE;
  client.rows[0].pending_mode = null;
  const accepted = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_1",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryable: true,
    queryClient: client,
  });

  assert.equal(accepted.status, SUBSCRIPTION_STATUSES.ACTIVE);
  assert.equal(accepted.pendingMode, null);
  assert.equal(accepted.metadata.dispatch.status, "accepted");
  assert.equal(accepted.metadata.dispatch.retryEligible, false);
  assert.equal(accepted.lastVerifiedAt, null);
});

test("YouTube WebSub subscribe dispatch result records retryable and terminal failures", async () => {
  const retryable = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: retryable });
  await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_retryable_failure",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: retryable,
  });
  const retryableFailure = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_retryable_failure",
    resultCode: "hub_request_timeout",
    hubHttpStatus: 503,
    retryable: true,
    queryClient: retryable,
  });
  assert.equal(retryableFailure.status, SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE);
  assert.equal(retryableFailure.pendingMode, PENDING_MODES.SUBSCRIBE);
  assert.equal(retryableFailure.metadata.dispatch.status, "failed");
  assert.equal(retryableFailure.metadata.dispatch.mode, "subscribe");
  assert.equal(retryableFailure.metadata.dispatch.resultCode, "hub_request_timeout");
  assert.equal(retryableFailure.metadata.dispatch.hubHttpStatus, 503);
  assert.equal(retryableFailure.metadata.dispatch.retryEligible, true);
  assert.equal(retryableFailure.metadata.dispatch.completedAt, "2026-07-17T00:00:02.000Z");

  const terminal = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: terminal });
  await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_terminal_failure",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: terminal,
  });
  const terminalFailure = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_terminal_failure",
    resultCode: "hub_request_rejected",
    hubHttpStatus: 400,
    retryable: false,
    queryClient: terminal,
  });
  assert.equal(terminalFailure.status, SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE);
  assert.equal(terminalFailure.pendingMode, PENDING_MODES.SUBSCRIBE);
  assert.equal(terminalFailure.metadata.dispatch.status, "failed");
  assert.equal(terminalFailure.metadata.dispatch.mode, "subscribe");
  assert.equal(terminalFailure.metadata.dispatch.resultCode, "hub_request_rejected");
  assert.equal(terminalFailure.metadata.dispatch.hubHttpStatus, 400);
  assert.equal(terminalFailure.metadata.dispatch.retryEligible, false);
  assert.equal(terminalFailure.metadata.dispatch.completedAt, "2026-07-17T00:00:02.000Z");
});

test("YouTube WebSub late result cannot overwrite a reclaimed attempt", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      metadata: {
        dispatch: {
          attemptId: "attempt_1",
          attemptNumber: 1,
          status: "started",
          mode: "subscribe",
          staleAfterEpochMs: 1_799_999_999_999,
          retryEligible: false,
        },
      },
    }),
    { queryClient: client }
  );
  await claimCodeClipYouTubeWebSubSubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_2",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: client,
  });

  const late = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_1",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    queryClient: client,
  });
  assert.equal(late, null);
  assert.equal(client.rows[0].metadata.dispatch.attemptId, "attempt_2");
  assert.equal(client.rows[0].metadata.dispatch.status, "started");
});

test("YouTube WebSub subscribe dispatch result cannot modify renewal, unsubscribe, or unrelated state", async () => {
  for (const currentState of [
    { status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL, pending_mode: PENDING_MODES.SUBSCRIBE },
    { status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE, pending_mode: PENDING_MODES.UNSUBSCRIBE },
    { status: SUBSCRIPTION_STATUSES.DISABLED, pending_mode: null },
  ]) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({
        status: currentState.status,
        pendingMode: currentState.pending_mode,
        metadata: {
          dispatch: {
            attemptId: "attempt_1",
            attemptNumber: 1,
            status: "started",
            mode: "subscribe",
            staleAfterEpochMs: 1_800_000_060_000,
            retryEligible: false,
          },
        },
      }),
      { queryClient: client }
    );

    const result = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
      attemptId: "attempt_1",
      resultCode: "hub_request_accepted",
      hubHttpStatus: 202,
      queryClient: client,
    });
    assert.equal(result, null);
    assert.equal(client.rows[0].metadata.dispatch.status, "started");
  }
});

test("YouTube WebSub renew and unsubscribe dispatch claims are mode and state isolated", async () => {
  const renewClient = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
      pendingMode: PENDING_MODES.SUBSCRIBE,
    }),
    { queryClient: renewClient }
  );
  const renewClaim = await claimCodeClipYouTubeWebSubRenewDispatch("yt_cb_123", {
    attemptId: "attempt_renew",
    leaseSeconds: 864000,
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: renewClient,
  });
  assert.equal(renewClaim.metadata.dispatch.mode, "renew");
  assert.equal(renewClaim.metadata.dispatch.status, "started");

  const unsubscribeAgainstRenew = await claimCodeClipYouTubeWebSubUnsubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_wrong_unsubscribe",
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: renewClient,
  });
  assert.equal(unsubscribeAgainstRenew, null);

  const unsubscribeClient = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
      pendingMode: PENDING_MODES.UNSUBSCRIBE,
    }),
    { queryClient: unsubscribeClient }
  );
  const unsubscribeClaim = await claimCodeClipYouTubeWebSubUnsubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_unsubscribe",
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: unsubscribeClient,
  });
  assert.equal(unsubscribeClaim.metadata.dispatch.mode, "unsubscribe");

  const renewAgainstUnsubscribe = await claimCodeClipYouTubeWebSubRenewDispatch("yt_cb_123", {
    attemptId: "attempt_wrong_renew",
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: unsubscribeClient,
  });
  assert.equal(renewAgainstUnsubscribe, null);
});

test("YouTube WebSub renew and unsubscribe dispatch results require exact mode and preserve callback state", async () => {
  const renewClient = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
      pendingMode: PENDING_MODES.SUBSCRIBE,
    }),
    { queryClient: renewClient }
  );
  await claimCodeClipYouTubeWebSubRenewDispatch("yt_cb_123", {
    attemptId: "attempt_renew",
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: renewClient,
  });
  const wrongSubscribeResult = await recordCodeClipYouTubeWebSubSubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_renew",
    resultCode: "hub_request_accepted",
    queryClient: renewClient,
  });
  assert.equal(wrongSubscribeResult, null);
  renewClient.rows[0].status = SUBSCRIPTION_STATUSES.ACTIVE;
  renewClient.rows[0].pending_mode = null;
  const renewAccepted = await recordCodeClipYouTubeWebSubRenewDispatchResult("yt_cb_123", {
    attemptId: "attempt_renew",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryable: true,
    queryClient: renewClient,
  });
  assert.equal(renewAccepted.status, SUBSCRIPTION_STATUSES.ACTIVE);
  assert.equal(renewAccepted.pendingMode, null);
  assert.equal(renewAccepted.metadata.dispatch.mode, "renew");
  assert.equal(renewAccepted.metadata.dispatch.status, "accepted");
  assert.equal(renewAccepted.metadata.dispatch.retryEligible, false);

  const unsubscribeClient = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({
      status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
      pendingMode: PENDING_MODES.UNSUBSCRIBE,
    }),
    { queryClient: unsubscribeClient }
  );
  await claimCodeClipYouTubeWebSubUnsubscribeDispatch("yt_cb_123", {
    attemptId: "attempt_unsubscribe",
    staleAfterSeconds: 60,
    nowEpochMs: 1_800_000_000_000,
    queryClient: unsubscribeClient,
  });
  const wrongRenewResult = await recordCodeClipYouTubeWebSubRenewDispatchResult("yt_cb_123", {
    attemptId: "attempt_unsubscribe",
    resultCode: "hub_request_accepted",
    queryClient: unsubscribeClient,
  });
  assert.equal(wrongRenewResult, null);
  unsubscribeClient.rows[0].status = SUBSCRIPTION_STATUSES.UNSUBSCRIBED;
  unsubscribeClient.rows[0].pending_mode = null;
  const unsubscribeAccepted = await recordCodeClipYouTubeWebSubUnsubscribeDispatchResult("yt_cb_123", {
    attemptId: "attempt_unsubscribe",
    resultCode: "hub_request_accepted",
    hubHttpStatus: 202,
    retryable: true,
    queryClient: unsubscribeClient,
  });
  assert.equal(unsubscribeAccepted.status, SUBSCRIPTION_STATUSES.UNSUBSCRIBED);
  assert.equal(unsubscribeAccepted.pendingMode, null);
  assert.equal(unsubscribeAccepted.metadata.dispatch.mode, "unsubscribe");
  assert.equal(unsubscribeAccepted.metadata.dispatch.status, "accepted");
});

test("YouTube WebSub renew and unsubscribe dispatch claims fail closed for malformed dispatch metadata", async () => {
  const cases = [
    {
      status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
      pendingMode: PENDING_MODES.SUBSCRIBE,
      claim: claimCodeClipYouTubeWebSubRenewDispatch,
      mode: "renew",
    },
    {
      status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
      pendingMode: PENDING_MODES.UNSUBSCRIBE,
      claim: claimCodeClipYouTubeWebSubUnsubscribeDispatch,
      mode: "unsubscribe",
    },
  ];

  for (const item of cases) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({
        status: item.status,
        pendingMode: item.pendingMode,
        metadata: {
          dispatch: {
            status: "started",
            mode: item.mode,
            staleAfterEpochMs: "1",
            attemptNumber: 1,
          },
        },
      }),
      { queryClient: client }
    );
    const claim = await item.claim("yt_cb_123", {
      attemptId: `attempt_${item.mode}`,
      staleAfterSeconds: 60,
      nowEpochMs: 1_800_000_000_000,
      queryClient: client,
    });
    assert.equal(claim, null);
  }
});

test("YouTube WebSub renew and unsubscribe dispatch results reject old attempts after newer claims", async () => {
  const cases = [
    {
      status: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
      pendingMode: PENDING_MODES.SUBSCRIBE,
      claim: claimCodeClipYouTubeWebSubRenewDispatch,
      record: recordCodeClipYouTubeWebSubRenewDispatchResult,
      mode: "renew",
    },
    {
      status: SUBSCRIPTION_STATUSES.PENDING_UNSUBSCRIBE,
      pendingMode: PENDING_MODES.UNSUBSCRIBE,
      claim: claimCodeClipYouTubeWebSubUnsubscribeDispatch,
      record: recordCodeClipYouTubeWebSubUnsubscribeDispatchResult,
      mode: "unsubscribe",
    },
  ];

  for (const item of cases) {
    const client = createSubscriptionClient();
    await createPendingCodeClipYouTubeWebSubSubscription(
      validInput({
        status: item.status,
        pendingMode: item.pendingMode,
        metadata: {
          dispatch: {
            status: "started",
            mode: item.mode,
            attemptId: "attempt_old",
            staleAfterEpochMs: 1,
            attemptNumber: 1,
          },
        },
      }),
      { queryClient: client }
    );
    const newerClaim = await item.claim("yt_cb_123", {
      attemptId: "attempt_new",
      staleAfterSeconds: 60,
      nowEpochMs: 1_800_000_000_000,
      queryClient: client,
    });
    assert.equal(newerClaim.metadata.dispatch.attemptId, "attempt_new");

    const oldResult = await item.record("yt_cb_123", {
      attemptId: "attempt_old",
      resultCode: "hub_request_accepted",
      hubHttpStatus: 202,
      retryable: false,
      queryClient: client,
    });
    assert.equal(oldResult, null);
    assert.equal(client.rows[0].metadata.dispatch.attemptId, "attempt_new");
    assert.equal(client.rows[0].metadata.dispatch.status, "started");
  }
});

test("YouTube WebSub subscribe dispatch claim is single-winner in PostgreSQL", async (t) => {
  const connectionString = process.env.CODECLIP_YOUTUBE_WEBSUB_CONCURRENCY_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("CODECLIP_YOUTUBE_WEBSUB_CONCURRENCY_TEST_DATABASE_URL is not configured");
    return;
  }

  const parsed = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    t.skip("concurrency test requires an explicitly isolated local PostgreSQL database");
    return;
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const schema = `codeclip_websub_test_${process.pid}_${Date.now()}`;
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.codeclip_youtube_websub_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        vertical TEXT NOT NULL DEFAULT 'codeclip',
        callback_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT 'youtube',
        channel TEXT NOT NULL DEFAULT 'youtube',
        provider_account_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        status TEXT NOT NULL,
        pending_mode TEXT,
        secret_version TEXT NOT NULL DEFAULT 'v1',
        activation_boundary_at TIMESTAMPTZ,
        activation_boundary_video_id TEXT,
        activated_at TIMESTAMPTZ,
        first_activated_video_id TEXT,
        first_activated_at TIMESTAMPTZ,
        lease_started_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        last_verified_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `
        INSERT INTO ${schema}.codeclip_youtube_websub_subscriptions (
          callback_id,
          provider_account_id,
          topic,
          status,
          pending_mode,
          secret_version,
          metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `,
      [
        "yt_pg_concurrency",
        CHANNEL_ID,
        TOPIC,
        SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE,
        PENDING_MODES.SUBSCRIBE,
        "v1",
        "{}",
      ]
    );
    await clientA.query(`SET search_path TO ${schema}`);
    await clientB.query(`SET search_path TO ${schema}`);

    const [first, second] = await Promise.all([
      claimCodeClipYouTubeWebSubSubscribeDispatch("yt_pg_concurrency", {
        attemptId: "attempt_pg_1",
        staleAfterSeconds: 60,
        nowEpochMs: 1_800_000_000_000,
        queryClient: clientA,
      }),
      claimCodeClipYouTubeWebSubSubscribeDispatch("yt_pg_concurrency", {
        attemptId: "attempt_pg_2",
        staleAfterSeconds: 60,
        nowEpochMs: 1_800_000_000_000,
        queryClient: clientB,
      }),
    ]);

    const winners = [first, second].filter(Boolean);
    const losers = [first, second].filter((item) => item === null);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const winningAttemptId = winners[0].metadata.dispatch.attemptId;
    const losingAttemptId = winningAttemptId === "attempt_pg_1" ? "attempt_pg_2" : "attempt_pg_1";
    const persisted = (await pool.query(
      `SELECT metadata FROM ${schema}.codeclip_youtube_websub_subscriptions WHERE callback_id = $1`,
      ["yt_pg_concurrency"]
    )).rows[0].metadata.dispatch;

    assert.equal(persisted.attemptId, winningAttemptId);
    assert.equal(persisted.attemptNumber, 1);

    const losingResult = await recordCodeClipYouTubeWebSubSubscribeDispatchResult(
      "yt_pg_concurrency",
      {
        attemptId: losingAttemptId,
        resultCode: "hub_request_accepted",
        hubHttpStatus: 202,
        queryClient: clientA,
      }
    );
    assert.equal(losingResult, null);

    const afterLosingResult = (await pool.query(
      `SELECT metadata FROM ${schema}.codeclip_youtube_websub_subscriptions WHERE callback_id = $1`,
      ["yt_pg_concurrency"]
    )).rows[0].metadata.dispatch;
    assert.equal(afterLosingResult.attemptId, winningAttemptId);
    assert.equal(afterLosingResult.status, "started");
  } finally {
    clientA.release();
    clientB.release();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});

test("YouTube WebSub open subscription uniqueness allows expired history but rejects simultaneous open rows", async () => {
  const client = createSubscriptionClient();
  const expired = await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({ callbackId: "yt_expired", status: SUBSCRIPTION_STATUSES.EXPIRED, pendingMode: null }),
    { queryClient: client }
  );
  const nextPending = await createPendingCodeClipYouTubeWebSubSubscription(
    validInput({ callbackId: "yt_pending_after_expired" }),
    { queryClient: client }
  );

  assert.equal(expired.status, SUBSCRIPTION_STATUSES.EXPIRED);
  assert.equal(nextPending.status, SUBSCRIPTION_STATUSES.PENDING_SUBSCRIBE);

  await assert.rejects(
    () => createPendingCodeClipYouTubeWebSubSubscription(
      validInput({ callbackId: "yt_second_pending" }),
      { queryClient: client }
    ),
    (error) =>
      error.code === "23505" &&
      error.constraint === "codeclip_youtube_websub_subscriptions_open_account_uidx"
  );

  const open = await getOpenCodeClipYouTubeWebSubSubscriptionByProviderAccountId(CHANNEL_ID, {
    queryClient: client,
  });
  assert.equal(open.callbackId, "yt_pending_after_expired");
});

test("YouTube WebSub subscription audit is parameterized and stores only allowlisted metadata", async () => {
  const client = createSubscriptionClient();
  const derivedSecret = "derived-secret-must-not-store";
  const rootSecret = "root-secret-must-not-store";
  const audit = await recordCodeClipYouTubeWebSubSubscriptionAudit(
    {
      callbackId: "yt_cb_123",
      providerAccountId: CHANNEL_ID,
      eventCode: "CC-YOUTUBE-AUDIT",
      action: "hub_request_failed",
      mode: "subscribe",
      resultCode: "hub_request_timeout",
      hubHttpStatus: 503,
      retryable: true,
      metadata: {
        requestedLeaseSeconds: 864000,
        operationSource: "operator_key",
        previousStatus: SUBSCRIPTION_STATUSES.ACTIVE,
        resultingStatus: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
        reason: `network error ${rootSecret}`,
        detail: `exception ${derivedSecret}`,
        secret: rootSecret,
        token: "token-value",
        authorization: "Bearer value",
        header: "x-secret",
        body: "<xml/>",
        signature: "sha256=value",
      },
    },
    { queryClient: client }
  );

  assert.equal(audit.vertical, "codeclip");
  assert.equal(audit.provider, "youtube");
  assert.equal(audit.action, "hub_request_failed");
  assert.equal(audit.resultCode, "hub_request_timeout");
  assert.equal(audit.hubHttpStatus, 503);
  assert.equal(audit.retryable, true);
  assert.deepEqual(audit.metadata, {
    requestedLeaseSeconds: 864000,
    operationSource: "operator_key",
    previousStatus: SUBSCRIPTION_STATUSES.ACTIVE,
    resultingStatus: SUBSCRIPTION_STATUSES.PENDING_RENEWAL,
  });
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(rootSecret), false);
  assert.equal(serialized.includes(derivedSecret), false);
  assert.equal(serialized.includes("network error"), false);
  assert.equal(serialized.includes("exception"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("<xml"), false);
  assert.equal(serialized.includes("sha256="), false);
});

test("YouTube WebSub audit mode accepts lifecycle modes and keeps pending mode strict", async () => {
  for (const mode of ["subscribe", "renew", "unsubscribe"]) {
    const client = createSubscriptionClient();
    const audit = await recordCodeClipYouTubeWebSubSubscriptionAudit(
      {
        callbackId: "yt_cb_123",
        providerAccountId: CHANNEL_ID,
        action: mode === "renew" ? "renewal_requested" : "hub_request_accepted",
        mode,
        resultCode: `${mode}_accepted`,
      },
      { queryClient: client }
    );
    assert.equal(audit.mode, mode);
  }

  await assert.rejects(
    () => recordCodeClipYouTubeWebSubSubscriptionAudit(
      {
        callbackId: "yt_cb_123",
        providerAccountId: CHANNEL_ID,
        action: "hub_request_accepted",
        mode: "refresh",
        resultCode: "hub_request_accepted",
      },
      { queryClient: createSubscriptionClient() }
    ),
    (error) =>
      error instanceof CodeClipYouTubeWebSubSubscriptionError &&
      error.code === "INVALID_YOUTUBE_WEBSUB_SUBSCRIPTION" &&
      error.details?.fieldName === "auditMode"
  );

  assert.throws(
    () => normalizeSubscriptionInput(validInput({ pendingMode: "renew" })),
    (error) =>
      error instanceof CodeClipYouTubeWebSubSubscriptionError &&
      error.code === "INVALID_YOUTUBE_WEBSUB_SUBSCRIPTION" &&
      error.details?.fieldName === "pendingMode"
  );
});

test("YouTube WebSub verified transition sets lease and preserves activation boundary on renewal", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });

  const first = await markCodeClipYouTubeWebSubSubscriptionVerified("yt_cb_123", {
    verifiedAt: "2026-07-17T10:00:00.000Z",
    leaseStartedAt: "2026-07-17T10:00:00.000Z",
    leaseExpiresAt: "2026-07-18T10:00:00.000Z",
    activationBoundaryAt: "2026-07-17T10:00:00.000Z",
    activationBoundaryVideoId: "videoA",
    queryClient: client,
  });

  assert.equal(first.status, SUBSCRIPTION_STATUSES.ACTIVE);
  assert.equal(first.pendingMode, null);
  assert.equal(first.activationBoundaryAt, "2026-07-17T10:00:00.000Z");
  assert.equal(first.activationBoundaryVideoId, "videoA");
  assert.equal(first.activatedAt, "2026-07-17T10:00:00.000Z");
  assert.equal(first.leaseExpiresAt, "2026-07-18T10:00:00.000Z");
  assert.equal(first.lastVerifiedAt, "2026-07-17T10:00:00.000Z");

  const renewal = await markCodeClipYouTubeWebSubSubscriptionVerified("yt_cb_123", {
    verifiedAt: "2026-07-18T09:00:00.000Z",
    leaseStartedAt: "2026-07-18T09:00:00.000Z",
    leaseExpiresAt: "2026-07-19T09:00:00.000Z",
    activationBoundaryAt: "2026-07-18T09:00:00.000Z",
    activationBoundaryVideoId: "videoB",
    queryClient: client,
  });

  assert.equal(renewal.activationBoundaryAt, "2026-07-17T10:00:00.000Z");
  assert.equal(renewal.activationBoundaryVideoId, "videoA");
  assert.equal(renewal.activatedAt, "2026-07-17T10:00:00.000Z");
  assert.equal(renewal.leaseExpiresAt, "2026-07-19T09:00:00.000Z");
});

test("YouTube WebSub state transitions preserve activation state", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });
  await markCodeClipYouTubeWebSubSubscriptionVerified("yt_cb_123", {
    verifiedAt: "2026-07-17T10:00:00.000Z",
    activationBoundaryAt: "2026-07-17T10:00:00.000Z",
    activationBoundaryVideoId: "videoA",
    leaseExpiresAt: "2026-07-18T10:00:00.000Z",
    queryClient: client,
  });
  await recordCodeClipYouTubeWebSubFirstActivatedVideo("yt_cb_123", {
    videoId: "videoFirst",
    activatedAt: "2026-07-17T11:00:00.000Z",
    queryClient: client,
  });

  for (const transition of [
    markCodeClipYouTubeWebSubSubscriptionRenewalPending,
    markCodeClipYouTubeWebSubSubscriptionUnsubscribePending,
    markCodeClipYouTubeWebSubSubscriptionExpired,
    markCodeClipYouTubeWebSubSubscriptionUnsubscribed,
    disableCodeClipYouTubeWebSubSubscription,
  ]) {
    const updated = await transition("yt_cb_123", { queryClient: client });
    assert.equal(updated.activationBoundaryAt, "2026-07-17T10:00:00.000Z");
    assert.equal(updated.activationBoundaryVideoId, "videoA");
    assert.equal(updated.activatedAt, "2026-07-17T10:00:00.000Z");
    assert.equal(updated.firstActivatedVideoId, "videoFirst");
    assert.equal(updated.firstActivatedAt, "2026-07-17T11:00:00.000Z");
  }
});

test("YouTube WebSub lease update only changes lease fields", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });
  await markCodeClipYouTubeWebSubSubscriptionVerified("yt_cb_123", {
    verifiedAt: "2026-07-17T10:00:00.000Z",
    activationBoundaryAt: "2026-07-17T10:00:00.000Z",
    leaseExpiresAt: "2026-07-18T10:00:00.000Z",
    queryClient: client,
  });

  const updated = await updateCodeClipYouTubeWebSubSubscriptionLease("yt_cb_123", {
    leaseExpiresAt: "2026-07-19T10:00:00.000Z",
    queryClient: client,
  });

  assert.equal(updated.status, SUBSCRIPTION_STATUSES.ACTIVE);
  assert.equal(updated.pendingMode, null);
  assert.equal(updated.activationBoundaryAt, "2026-07-17T10:00:00.000Z");
  assert.equal(updated.leaseStartedAt, "2026-07-17T10:00:00.000Z");
  assert.equal(updated.leaseExpiresAt, "2026-07-19T10:00:00.000Z");
});

test("YouTube WebSub first activation is atomic set-once", async () => {
  const client = createSubscriptionClient();
  await createPendingCodeClipYouTubeWebSubSubscription(validInput(), { queryClient: client });

  const first = await recordCodeClipYouTubeWebSubFirstActivatedVideo("yt_cb_123", {
    videoId: "videoFirst",
    activatedAt: "2026-07-17T11:00:00.000Z",
    queryClient: client,
  });
  const second = await recordCodeClipYouTubeWebSubFirstActivatedVideo("yt_cb_123", {
    videoId: "videoSecond",
    activatedAt: "2026-07-17T12:00:00.000Z",
    queryClient: client,
  });

  assert.equal(first.firstActivatedVideoId, "videoFirst");
  assert.equal(second.firstActivatedVideoId, "videoFirst");
  assert.equal(second.firstActivatedAt, "2026-07-17T11:00:00.000Z");
  assert.match(
    client.calls.find((call) => /first_activated_video_id IS NULL/.test(call.sql)).sql,
    /WHERE callback_id = \$1/
  );
});

test("YouTube WebSub first activation rejects invalid input and unknown callback returns null", async () => {
  const client = createSubscriptionClient();

  await assert.rejects(
    () => recordCodeClipYouTubeWebSubFirstActivatedVideo("missing", { queryClient: client }),
    (error) => error.code === "INVALID_YOUTUBE_WEBSUB_SUBSCRIPTION"
  );

  assert.equal(
    await recordCodeClipYouTubeWebSubFirstActivatedVideo("unknown", {
      videoId: "videoFirst",
      queryClient: client,
    }),
    null
  );
});

test("YouTube WebSub internal mapping excludes metadata and secret values", () => {
  const mapped = toInternalCodeClipYouTubeWebSubSubscription(
    row({
      metadata: { internal: "hidden", secret: "must-not-leak" },
    })
  );

  assert.equal(mapped.callbackId, "yt_cb_123");
  assert.equal(Object.hasOwn(mapped, "metadata"), false);
  assert.equal(JSON.stringify(mapped).includes("must-not-leak"), false);
});
