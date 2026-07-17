const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  parseCodeClipYouTubeWebSubAtomFeed,
} = require("./verticals/codeclip/youtube-websub-feed");
const {
  processCodeClipYouTubeWebSubNotification,
  YOUTUBE_WEBSUB_MAX_BODY_BYTES,
} = require("./verticals/codeclip/youtube-websub-notification");
const {
  deriveCodeClipYouTubeWebSubSubscriptionSecret,
} = require("./verticals/codeclip/youtube-websub-secret");

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const CALLBACK_ID = "yt-callback-test";
const ROOT_SECRET = "test-root-secret";
const NOW = new Date("2026-07-18T10:00:00.000Z");

function youtubeXml(entries, overrides = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
  <link rel="self" href="${overrides.topic || TOPIC}"/>
  <id>yt:channel:${overrides.channelId || CHANNEL_ID}</id>
  <title>YouTube video feed</title>
  <updated>2026-07-18T10:00:00+00:00</updated>
  ${entries.join("\n")}
</feed>`;
}

function entryXml(videoId, options = {}) {
  return `<entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${options.channelId || CHANNEL_ID}</yt:channelId>
    <title>${options.title || "Published video"}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
    <author><name>codeClip Test</name><uri>https://www.youtube.com/channel/${options.channelId || CHANNEL_ID}</uri></author>
    <published>${options.published || "2026-07-18T09:00:00+00:00"}</published>
    <updated>${options.updated || "2026-07-18T09:01:00+00:00"}</updated>
  </entry>`;
}

function sign(rawBody, subscription = subscriptionRow()) {
  const secret = deriveCodeClipYouTubeWebSubSubscriptionSecret({
    rootSecret: ROOT_SECRET,
    secretVersion: subscription.secretVersion,
    callbackId: subscription.callbackId,
    providerAccountId: subscription.providerAccountId,
  });
  return `sha256=${crypto.createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex")}`;
}

function subscriptionRow(overrides = {}) {
  return {
    vertical: "codeclip",
    provider: "youtube",
    channel: "youtube",
    callbackId: CALLBACK_ID,
    providerAccountId: CHANNEL_ID,
    topic: TOPIC,
    status: "active",
    pendingMode: null,
    secretVersion: "v1",
    activationBoundaryAt: "2026-07-18T08:00:00.000Z",
    activationBoundaryVideoId: "boundary-video",
    activatedAt: "2026-07-18T08:00:00.000Z",
    leaseExpiresAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
}

function bindingRow(overrides = {}) {
  return {
    id: "42",
    eventCode: "CC-YOUTUBE-E2E",
    provider: "youtube",
    channel: "youtube",
    status: "active",
    ...overrides,
  };
}

function eventRow(rawEvent = {}) {
  return {
    raw_event: {
      id: "event-42",
      code: "CC-YOUTUBE-E2E",
      vertical: "codeclip",
      status: "active",
      activationMethod: "provider",
      activationChannels: ["youtube"],
      activationEvent: "published_video",
      endAt: "2026-08-01T00:00:00.000Z",
      rewards: {},
      ...rawEvent,
    },
  };
}

function notificationDeps(overrides = {}) {
  const state = {
    createdDeliveries: [],
    deliveryUpdates: [],
    firstActivations: [],
    existingDelivery: false,
    subscription: subscriptionRow(),
    binding: bindingRow(),
    event: eventRow(),
    ...overrides.state,
  };
  return {
    state,
    queryClient: { query: async () => ({ rows: [] }) },
    env: { CODECLIP_YOUTUBE_WEBSUB_SECRET: ROOT_SECRET },
    getSubscriptionByCallbackId: async () => state.subscription,
    findActiveBinding: async () => state.binding,
    getEventByCode: async () => state.event,
    createCodeClipProviderDelivery: async (delivery) => {
      if (state.existingDelivery) {
        return { status: "existing", row: { ...delivery, id: "delivery-existing" } };
      }
      state.createdDeliveries.push(delivery);
      return { status: "created", row: { ...delivery, id: "delivery-new" } };
    },
    updateCodeClipProviderDeliveryState: async (identity, updates) => {
      state.deliveryUpdates.push({ identity, updates });
      return { status: "updated", row: { ...identity, ...updates } };
    },
    recordFirstActivatedVideo: async (input) => {
      state.firstActivations.push(input);
      return state.subscription;
    },
    ...overrides.deps,
  };
}

async function postNotification(rawBody, overrides = {}) {
  const deps = notificationDeps(overrides);
  const subscription = deps.state.subscription || subscriptionRow();
  const headers = {
    "content-type": "application/atom+xml",
    "x-hub-signature": sign(rawBody, subscription),
    ...(overrides.headers || {}),
  };
  const result = await processCodeClipYouTubeWebSubNotification(
    {
      callbackId: CALLBACK_ID,
      headers,
      rawBody,
      now: NOW,
    },
    deps
  );
  return { result, state: deps.state };
}

test("YouTube Atom parser normalizes a single entry", () => {
  const feed = parseCodeClipYouTubeWebSubAtomFeed(youtubeXml([entryXml("videoABC123")]));

  assert.equal(feed.topic, TOPIC);
  assert.equal(feed.channelId, CHANNEL_ID);
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].videoId, "videoABC123");
  assert.equal(feed.entries[0].externalMessageId, `youtube:${CHANNEL_ID}:videoABC123:published`);
  assert.equal(feed.entries[0].eventType, "published_video");
});

test("YouTube Atom parser normalizes multiple entries separately", () => {
  const feed = parseCodeClipYouTubeWebSubAtomFeed(
    youtubeXml([entryXml("videoABC123"), entryXml("videoXYZ987")])
  );

  assert.deepEqual(feed.entries.map((entry) => entry.videoId), [
    "videoABC123",
    "videoXYZ987",
  ]);
});

test("YouTube Atom parser preserves no-entry feed semantics", () => {
  const feed = parseCodeClipYouTubeWebSubAtomFeed(youtubeXml([]));

  assert.equal(feed.topic, TOPIC);
  assert.equal(feed.channelId, CHANNEL_ID);
  assert.deepEqual(feed.entries, []);
});

test("YouTube Atom parser rejects malformed and unsafe XML", () => {
  assert.throws(
    () => parseCodeClipYouTubeWebSubAtomFeed("<feed><entry></feed>"),
    (error) => error.code === "MALFORMED_XML"
  );
  assert.throws(
    () => parseCodeClipYouTubeWebSubAtomFeed("<!DOCTYPE feed [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><feed/>"),
    (error) => error.code === "MALFORMED_XML"
  );
});

test("YouTube Atom parser rejects missing required fields and too many entries", () => {
  assert.throws(
    () => parseCodeClipYouTubeWebSubAtomFeed(youtubeXml(["<entry></entry>"])),
    (error) => error.code === "INVALID_ATOM_ENTRY"
  );

  const entries = Array.from({ length: 21 }, (_, index) => entryXml(`video${index}ABC`));
  assert.throws(
    () => parseCodeClipYouTubeWebSubAtomFeed(youtubeXml(entries)),
    (error) => error.code === "TOO_MANY_ENTRIES"
  );
});

test("YouTube notification rejects invalid content, empty body, and oversized body", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);
  const invalidType = await postNotification(xml, {
    headers: { "content-type": "application/json" },
  });
  assert.equal(invalidType.result.httpStatus, 415);
  assert.equal(invalidType.result.payload.code, "invalid_content_type");

  const empty = await postNotification("", {
    headers: { "x-hub-signature": "sha256=00" },
  });
  assert.equal(empty.result.httpStatus, 400);
  assert.equal(empty.result.payload.code, "empty_body");

  const oversized = await postNotification(Buffer.alloc(YOUTUBE_WEBSUB_MAX_BODY_BYTES + 1, "x"));
  assert.equal(oversized.result.httpStatus, 413);
  assert.equal(oversized.result.payload.code, "body_too_large");
});

test("YouTube notification requires valid per-subscription HMAC", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);
  const missing = await postNotification(xml, {
    headers: { "x-hub-signature": "" },
  });
  assert.equal(missing.result.httpStatus, 401);
  assert.equal(missing.result.payload.code, "signature_missing");

  const invalid = await postNotification(xml, {
    headers: { "x-hub-signature": "sha256=" + "0".repeat(64) },
  });
  assert.equal(invalid.result.httpStatus, 401);
  assert.equal(invalid.result.payload.code, "signature_invalid");

  const changedBody = await postNotification(xml.replace("videoABC123", "videoXYZ987"), {
    headers: { "x-hub-signature": sign(xml) },
  });
  assert.equal(changedBody.result.httpStatus, 401);
  assert.equal(changedBody.result.payload.code, "signature_invalid");
});

test("YouTube notification validates subscription status, lease, topic, and channel scope", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);

  const inactive = await postNotification(xml, {
    state: { subscription: subscriptionRow({ status: "disabled" }) },
  });
  assert.equal(inactive.result.httpStatus, 409);
  assert.equal(inactive.result.payload.code, "inactive_subscription");

  const unverified = await postNotification(xml, {
    state: { subscription: subscriptionRow({ status: "pending_subscribe" }) },
  });
  assert.equal(unverified.result.httpStatus, 409);
  assert.equal(unverified.result.payload.code, "unverified_subscription");

  const expired = await postNotification(xml, {
    state: { subscription: subscriptionRow({ leaseExpiresAt: "2026-07-18T09:59:00.000Z" }) },
  });
  assert.equal(expired.result.httpStatus, 410);
  assert.equal(expired.result.payload.code, "expired_subscription");

  const wrongTopicXml = youtubeXml([entryXml("videoABC123")], {
    topic: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}&extra=1`,
  });
  const wrongTopic = await postNotification(wrongTopicXml);
  assert.equal(wrongTopic.result.httpStatus, 400);
  assert.equal(wrongTopic.result.payload.code, "subscription_scope_mismatch");
});

test("YouTube notification records one delivery per entry and deduplicates existing entries", async () => {
  const xml = youtubeXml([entryXml("videoABC123"), entryXml("videoXYZ987")]);
  const first = await postNotification(xml);

  assert.equal(first.result.httpStatus, 202);
  assert.equal(first.result.payload.processed, 2);
  assert.equal(first.state.createdDeliveries.length, 2);
  assert.deepEqual(first.state.createdDeliveries.map((delivery) => delivery.externalMessageId), [
    `youtube:${CHANNEL_ID}:videoABC123:published`,
    `youtube:${CHANNEL_ID}:videoXYZ987:published`,
  ]);
  assert.equal(first.state.firstActivations.length, 2);

  const duplicate = await postNotification(xml, {
    state: { existingDelivery: true },
  });
  assert.equal(duplicate.result.httpStatus, 202);
  assert.equal(duplicate.result.payload.duplicate, 2);
  assert.equal(duplicate.state.createdDeliveries.length, 0);
  assert.equal(duplicate.state.firstActivations.length, 0);
});

test("YouTube notification ledger records historical and unconfigured entries as non-activating", async () => {
  const historical = await postNotification(
    youtubeXml([entryXml("oldVideo123", { published: "2026-07-18T07:59:00+00:00" })])
  );
  assert.equal(historical.result.httpStatus, 202);
  assert.equal(historical.state.deliveryUpdates[0].updates.publicResponseJson.status, "non_activating_historical");
  assert.equal(historical.state.firstActivations.length, 0);

  const unconfigured = await postNotification(youtubeXml([entryXml("videoABC123")]), {
    state: {
      event: eventRow({ activationEvent: "something_else" }),
    },
  });
  assert.equal(unconfigured.result.httpStatus, 202);
  assert.equal(unconfigured.state.deliveryUpdates[0].updates.publicResponseJson.status, "non_activating");
  assert.equal(unconfigured.state.firstActivations.length, 0);
});

test("YouTube notification fails closed on persistence and routing errors", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);

  const noSubscription = await postNotification(xml, {
    state: { subscription: null },
  });
  assert.equal(noSubscription.result.httpStatus, 404);
  assert.equal(noSubscription.result.payload.code, "unknown_subscription");

  const noBinding = await postNotification(xml, {
    state: { binding: null },
  });
  assert.equal(noBinding.result.httpStatus, 404);
  assert.equal(noBinding.result.payload.code, "unknown_subscription");

  const repositoryDown = await postNotification(xml, {
    deps: {
      getSubscriptionByCallbackId: async () => {
        throw new Error("database unavailable");
      },
    },
  });
  assert.equal(repositoryDown.result.httpStatus, 503);
  assert.equal(repositoryDown.result.payload.code, "persistence_failed");
});
