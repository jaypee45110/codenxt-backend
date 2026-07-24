const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  processCodeClipYouTubeWebSubDiagnosticNotification,
  verifyCodeClipYouTubeWebSubDiagnosticCallback,
} = require("./verticals/codeclip/youtube-websub-diagnostic-callback");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
} = require("./verticals/codeclip/youtube-websub-secret");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const CALLBACK_ID = "diag_yt_callbackRuntime1234";
const PROBE_ID = "diag_probeRuntime123";
const NOW = "2026-07-24T10:12:00.000Z";

function feed(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
    <link rel="self" href="${TOPIC}"/>
    <id>yt:channel:${CHANNEL_ID}</id>
    <updated>2026-07-24T10:12:00+00:00</updated>
    ${entries.join("\n")}
  </feed>`;
}

function entry(videoId, options = {}) {
  return `<entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${options.channelId || CHANNEL_ID}</yt:channelId>
    <title>${options.title || "Diagnostic title"}</title>
    <published>${options.published || "2026-07-24T10:04:00+00:00"}</published>
    <updated>${options.updated || "2026-07-24T10:04:30+00:00"}</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
  </entry>`;
}

function sign(rawBody) {
  const secret = deriveCodeClipYouTubeWebSubSubscriptionSecret({
    rootSecret: "root-secret",
    secretVersion: "diag-v1",
    callbackId: CALLBACK_ID,
    providerAccountId: CHANNEL_ID,
  });
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function probe(overrides = {}) {
  return {
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    channelId: CHANNEL_ID,
    topic: TOPIC,
    status: "pending_subscribe",
    pendingMode: "subscribe",
    secretVersion: "diag-v1",
    leaseExpiresAt: null,
    verifiedAt: null,
    firstVerifiedAt: null,
    lastNotificationAt: null,
    unsubscribedAt: null,
    cleanupRequired: false,
    subscriptionMayExist: true,
    diagnosticMetadata: {},
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

test("diagnostic GET subscribe challenge persists verification before returning challenge", async () => {
  const calls = [];
  const result = await verifyCodeClipYouTubeWebSubDiagnosticCallback(
    {
      callbackId: CALLBACK_ID,
      query: {
        "hub.mode": "subscribe",
        "hub.topic": TOPIC,
        "hub.challenge": "challenge-value",
        "hub.lease_seconds": "86400",
      },
      now: NOW,
    },
    {
      queryClient: { query: async () => ({ rows: [] }) },
      runTransaction: async (work, queryClient) => work({ queryClient }),
      markVerificationReceived: async (input) => {
        calls.push(input);
        return { status: "updated", row: probe({ status: "active", pendingMode: null }) };
      },
    }
  );
  assert.equal(result.accepted, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.challenge, "challenge-value");
  assert.equal(calls[0].callbackId, CALLBACK_ID);
  assert.equal(calls[0].topic, TOPIC);
  assert.equal(calls[0].channelId, CHANNEL_ID);
  assert.equal(calls[0].leaseSeconds, 86400);
});

test("diagnostic GET rejects malformed subscribe challenge without leaking callback", async () => {
  const result = await verifyCodeClipYouTubeWebSubDiagnosticCallback({
    callbackId: CALLBACK_ID,
    query: { "hub.mode": "subscribe", "hub.topic": TOPIC, "hub.challenge": "" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.httpStatus, 400);
  assert.equal(JSON.stringify(result).includes(CALLBACK_ID), false);
});

test("diagnostic GET unsubscribe completes cleanup", async () => {
  const calls = [];
  const result = await verifyCodeClipYouTubeWebSubDiagnosticCallback(
    {
      callbackId: CALLBACK_ID,
      query: {
        "hub.mode": "unsubscribe",
        "hub.topic": TOPIC,
        "hub.challenge": "cleanup-challenge",
      },
      now: NOW,
    },
    {
      getProbeByCallbackId: async () => ({ row: probe({ status: "pending_unsubscribe", pendingMode: "unsubscribe" }) }),
      runTransaction: async (work, queryClient) => work({ queryClient }),
      markCleanupCompleted: async (input) => {
        calls.push(input);
        return { status: "updated", row: probe({ status: "unsubscribed" }) };
      },
    }
  );
  assert.equal(result.accepted, true);
  assert.equal(result.challenge, "cleanup-challenge");
  assert.equal(calls[0].callbackId, CALLBACK_ID);
});

test("diagnostic POST persists one entry and returns minimal accepted response", async () => {
  const rawBody = Buffer.from(feed([entry("Q8yMabcVtxc")]));
  const observations = [];
  const result = await processCodeClipYouTubeWebSubDiagnosticNotification(
    {
      callbackId: CALLBACK_ID,
      headers: {
        "content-type": "application/atom+xml",
        "x-hub-signature": sign(rawBody),
      },
      rawBody,
      now: NOW,
    },
    {
      env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" },
      getProbeByCallbackId: async () => ({ row: probe({ status: "active", pendingMode: null }) }),
      runTransaction: async (work, queryClient) => work({ queryClient }),
      recordObservation: async (input) => {
        observations.push(input);
        return { status: "recorded" };
      },
    }
  );
  assert.equal(result.accepted, true);
  assert.equal(result.httpStatus, 204);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].videoId, "Q8yMabcVtxc");
  assert.equal(observations[0].topic, TOPIC);
});

test("diagnostic POST duplicates and updates remain internal", async () => {
  const rawBody = Buffer.from(feed([entry("Q8yMabcVtxc", { updated: "2026-07-24T10:13:30+00:00" })]));
  const result = await processCodeClipYouTubeWebSubDiagnosticNotification(
    {
      callbackId: CALLBACK_ID,
      headers: { "content-type": "text/xml", "x-hub-signature": sign(rawBody) },
      rawBody,
      now: NOW,
    },
    {
      env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" },
      getProbeByCallbackId: async () => ({ row: probe({ status: "active", pendingMode: null }) }),
      runTransaction: async (work, queryClient) => work({ queryClient }),
      recordObservation: async () => ({ status: "updated" }),
    }
  );
  assert.equal(result.httpStatus, 204);
  assert.deepEqual(result.publicBody, null);
});

test("diagnostic POST multiple entries are one transaction and fail closed on partial failure", async () => {
  const rawBody = Buffer.from(feed([
    entry("Q8yMabcVtxc"),
    entry("NewVid1234"),
  ]));
  const calls = [];
  await assert.rejects(async () => {
    const result = await processCodeClipYouTubeWebSubDiagnosticNotification(
      {
        callbackId: CALLBACK_ID,
        headers: { "content-type": "application/xml", "x-hub-signature": sign(rawBody) },
        rawBody,
        now: NOW,
      },
      {
        env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" },
        getProbeByCallbackId: async () => ({ row: probe({ status: "active", pendingMode: null }) }),
        runTransaction: async (work, queryClient) => {
          calls.push("begin");
          try {
            await work({ queryClient });
          } catch (error) {
            calls.push("rollback");
            throw error;
          }
        },
        recordObservation: async (input) => {
          calls.push(input.videoId);
          if (input.videoId === "NewVid1234") throw new Error("repository failed");
          return { status: "recorded" };
        },
      }
    );
    if (!result.accepted) throw Object.assign(new Error(result.code), { result });
  });
  assert.deepEqual(calls, ["begin", "Q8yMabcVtxc", "NewVid1234", "rollback"]);
});

test("diagnostic POST rejects empty feed, malformed XML, wrong content type and bad signature", async () => {
  const validEmpty = Buffer.from(feed([]));
  const base = {
    callbackId: CALLBACK_ID,
    headers: { "content-type": "application/atom+xml", "x-hub-signature": sign(validEmpty) },
    rawBody: validEmpty,
  };
  const options = {
    env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: "root-secret" },
    getProbeByCallbackId: async () => ({ row: probe({ status: "active", pendingMode: null }) }),
  };
  assert.equal((await processCodeClipYouTubeWebSubDiagnosticNotification(base, options)).httpStatus, 400);
  assert.equal((await processCodeClipYouTubeWebSubDiagnosticNotification({ ...base, headers: { "content-type": "application/json" } }, options)).httpStatus, 415);
  assert.equal((await processCodeClipYouTubeWebSubDiagnosticNotification({ ...base, rawBody: Buffer.from("<feed>"), headers: { "content-type": "application/atom+xml", "x-hub-signature": "sha256=bad" } }, options)).httpStatus, 401);
});
