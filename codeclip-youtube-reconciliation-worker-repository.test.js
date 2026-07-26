const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureCodeClipYouTubeReconciliationClaimsTable,
  ensureCodeClipYouTubeReconciliationObservabilityTables,
  claimCodeClipYouTubeReconciliationSubscription,
  recordCodeClipYouTubeReconciliationDetectionObservation,
  recordCodeClipYouTubeReconciliationWorkerHeartbeat,
  releaseCodeClipYouTubeReconciliationSubscriptionClaim,
} = require("./db");

function createClaimClient() {
  const calls = [];
  const claims = new Map();
  return {
    calls,
    claims,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO codeclip_youtube_reconciliation_claims/.test(sql)) {
        const [callbackId, claimId, claimedAt, expiresAt] = params;
        const current = claims.get(callbackId);
        if (current && Date.parse(current.expires_at) > Date.parse(claimedAt)) {
          return { rows: [] };
        }
        const row = {
          callback_id: callbackId,
          claim_id: claimId,
          claimed_at: claimedAt,
          expires_at: expiresAt,
          updated_at: claimedAt,
        };
        claims.set(callbackId, row);
        return { rows: [row] };
      }
      if (/SELECT \*/.test(sql) && /codeclip_youtube_reconciliation_claims/.test(sql)) {
        const row = claims.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/DELETE FROM codeclip_youtube_reconciliation_claims/.test(sql)) {
        const [callbackId, claimId] = params;
        const current = claims.get(callbackId);
        if (!current || current.claim_id !== claimId) return { rows: [] };
        claims.delete(callbackId);
        return { rows: [current] };
      }
      if (/INSERT INTO codeclip_youtube_reconciliation_detection_observations/.test(sql)) {
        return { rows: [{ id: "1", created_at: params[5] || "2026-07-26T12:00:00.000Z" }] };
      }
      if (/INSERT INTO codeclip_youtube_reconciliation_worker_heartbeats/.test(sql)) {
        return { rows: [{ worker_id: params[0], status: params[1], updated_at: "2026-07-26T12:00:00.000Z" }] };
      }
      return { rows: [] };
    },
  };
}

test("YouTube reconciliation claim schema is isolated and lease based", async () => {
  const client = createClaimClient();
  await ensureCodeClipYouTubeReconciliationClaimsTable(client);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_youtube_reconciliation_claims/);
  assert.match(client.calls[0].sql, /callback_id TEXT PRIMARY KEY/);
  assert.match(client.calls[0].sql, /claim_id TEXT NOT NULL/);
  assert.match(client.calls[0].sql, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(client.calls[0].sql, /CHECK \(expires_at > claimed_at\)/);
  assert.match(client.calls[1].sql, /codeclip_youtube_reconciliation_claims_expires_at_idx/);
});

test("YouTube reconciliation observability schema stores detection observations and heartbeat summaries", async () => {
  const client = createClaimClient();
  await ensureCodeClipYouTubeReconciliationObservabilityTables(client);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_youtube_reconciliation_detection_observations/);
  assert.match(client.calls[0].sql, /channel_fingerprint TEXT NOT NULL/);
  assert.match(client.calls[1].sql, /codeclip_youtube_reconciliation_detection_observations_event_idx/);
  assert.match(client.calls[2].sql, /CREATE TABLE IF NOT EXISTS codeclip_youtube_reconciliation_worker_heartbeats/);
  assert.match(client.calls[2].sql, /worker_id TEXT PRIMARY KEY/);

  const observation = await recordCodeClipYouTubeReconciliationDetectionObservation({
    eventCode: "CC-YT-WORKER",
    channelFingerprint: "cb0961933f4f",
    videoId: "video123",
    detectionSource: "atom",
    outcome: "duplicate_reconciliation_after_websub",
    initialDeliverySource: "websub",
    observedAt: "2026-07-26T12:00:00.000Z",
    queryClient: client,
  });
  const heartbeat = await recordCodeClipYouTubeReconciliationWorkerHeartbeat({
    workerId: "worker-1",
    status: "ok",
    summary: { processedCompleted: 1 },
    now: "2026-07-26T12:00:00.000Z",
    queryClient: client,
  });

  assert.equal(observation.status, "recorded");
  assert.equal(heartbeat.status, "recorded");
  assert.equal(JSON.stringify(client.calls).includes("UCvwiNkgNuGuizjo33NZhzPg"), false);
});

test("YouTube reconciliation claim is atomic, blocks active contenders, allows stale takeover, and releases by owner only", async () => {
  const client = createClaimClient();
  const first = await claimCodeClipYouTubeReconciliationSubscription({
    callbackId: "yt_claim_1",
    claimId: "claim-1",
    now: "2026-07-26T12:00:00.000Z",
    leaseMs: 300000,
    queryClient: client,
  });
  const contended = await claimCodeClipYouTubeReconciliationSubscription({
    callbackId: "yt_claim_1",
    claimId: "claim-2",
    now: "2026-07-26T12:01:00.000Z",
    leaseMs: 300000,
    queryClient: client,
  });
  const stale = await claimCodeClipYouTubeReconciliationSubscription({
    callbackId: "yt_claim_1",
    claimId: "claim-3",
    now: "2026-07-26T12:06:00.000Z",
    leaseMs: 300000,
    queryClient: client,
  });
  const oldOwnerRelease = await releaseCodeClipYouTubeReconciliationSubscriptionClaim({
    callbackId: "yt_claim_1",
    claimId: "claim-1",
    queryClient: client,
  });
  const release = await releaseCodeClipYouTubeReconciliationSubscriptionClaim({
    callbackId: "yt_claim_1",
    claimId: "claim-3",
    queryClient: client,
  });
  assert.equal(first.status, "claimed");
  assert.equal(contended.status, "contended");
  assert.equal(stale.status, "claimed");
  assert.equal(oldOwnerRelease.status, "not_owner");
  assert.equal(release.status, "released");
});

test("YouTube reconciliation claim fails closed on malformed state and unsafe lease", async () => {
  const client = createClaimClient();
  await assert.rejects(
    () => claimCodeClipYouTubeReconciliationSubscription({
      callbackId: "yt_claim_bad",
      claimId: "claim-bad",
      now: "not-a-date",
      leaseMs: 300000,
      queryClient: client,
    }),
    /now/
  );
  await assert.rejects(
    () => claimCodeClipYouTubeReconciliationSubscription({
      callbackId: "yt_claim_bad",
      claimId: "claim-bad",
      now: "2026-07-26T12:00:00.000Z",
      leaseMs: -1,
      queryClient: client,
    }),
    /lease/
  );
});
