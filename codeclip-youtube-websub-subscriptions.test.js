const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureCodeClipYouTubeWebSubSubscriptionsTable } = require("./db");
const {
  CodeClipYouTubeWebSubSubscriptionError,
  SUBSCRIPTION_STATUSES,
  PENDING_MODES,
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

test("YouTube WebSub subscription schema ensure is idempotent and preserves data", async () => {
  const existingRow = row({ callback_id: "existing_cb" });
  const client = {
    calls: [],
    rows: [clone(existingRow)],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      return { rows: [] };
    },
  };

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
  assert.match(sql, /codeclip_youtube_websub_subscription_audit_callback_idx/);
  assert.match(sql, /codeclip_youtube_websub_subscription_audit_account_idx/);
  assert.deepEqual(client.rows, [existingRow]);
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
