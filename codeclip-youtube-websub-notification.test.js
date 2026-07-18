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
    calls: [],
    createdDeliveries: [],
    deliveryUpdates: [],
    firstActivations: [],
    providerEventInteractions: [],
    persistenceCalls: [],
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
    getSubscriptionByCallbackId: async () => {
      state.calls.push("subscription");
      return state.subscription;
    },
    findActiveBinding: async () => {
      state.calls.push("binding");
      return state.binding;
    },
    getEventByCode: async () => {
      state.calls.push("event");
      return state.event;
    },
    createCodeClipProviderDelivery: async (delivery) => {
      state.calls.push("delivery_claim");
      if (state.existingDelivery) {
        return { status: "existing", row: { ...delivery, id: "delivery-existing" } };
      }
      state.createdDeliveries.push(delivery);
      return { status: "created", row: { ...delivery, id: "delivery-new" } };
    },
    updateCodeClipProviderDeliveryState: async (identity, updates) => {
      state.calls.push(
        updates.completionState === "completed" && updates.terminalState === true
          ? "delivery_terminal"
          : "delivery_update"
      );
      state.deliveryUpdates.push({ identity, updates });
      return { status: "updated", row: { ...identity, ...updates } };
    },
    recordFirstActivatedVideo: async (input) => {
      state.calls.push("first_video");
      state.firstActivations.push(input);
      return state.subscription;
    },
    createProviderEventInteraction: (input) => {
      state.calls.push("create_interaction");
      state.providerEventInteractions.push(input);
      return {
        interactionType: "provider_event",
        eventCode: input.eventCode,
        eventId: input.eventId,
        scanId: input.providerEvent.providerEventId,
        providerEvent: input.providerEvent,
        persistenceStatus: {
          interaction: { attempted: false, ok: null, error: null },
          rewardAssignments: { attempted: false, ok: null, error: null },
          clipXtraRedemption: { attempted: false, ok: null, error: null },
        },
        rewardAssignmentSnapshot: { assignments: [] },
      };
    },
    persistCodeClipCoreInteraction: async (input) => {
      state.calls.push("core_persistence");
      state.persistenceCalls.push(input);
      input.interaction.persistenceStatus.interaction = {
        attempted: true,
        ok: true,
        error: null,
        committed: true,
      };
      input.interaction.persistenceStatus.rewardAssignments = {
        attempted: false,
        ok: null,
        error: null,
        skipped: true,
        reason: "provider_event_has_no_individual_recipient",
      };
      input.interaction.persistenceStatus.clipXtraRedemption = {
        attempted: false,
        ok: null,
        error: null,
        skipped: true,
        reason: "provider_event_has_no_individual_recipient",
      };
    },
    saveCodeClipInteraction: async () => ({ id: "interaction-row" }),
    saveCodeClipRewardAssignments: async () => {
      throw new Error("reward assignments should be skipped by core");
    },
    saveCodeClipXtraRedemption: async () => {
      throw new Error("ClipXtra should be skipped by core");
    },
    runCodeClipCorePersistenceTransaction: async (work) =>
      work({ queryClient: { transaction: "youtube-provider-event" } }),
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

test("YouTube notification persists provider-event runtime after activation resolution", async () => {
  const xml = youtubeXml([entryXml("videoABC123", {
    title: "Runtime Video",
    published: "2026-07-18T09:15:00+00:00",
    updated: "2026-07-18T09:16:00+00:00",
  })]);
  const { result, state } = await postNotification(xml);
  const interactionInput = state.providerEventInteractions[0];
  const persistenceCall = state.persistenceCalls[0];
  const terminalUpdate = state.deliveryUpdates[state.deliveryUpdates.length - 1].updates;

  assert.equal(result.httpStatus, 202);
  assert.equal(result.payload.status, "processed");
  assert.equal(state.providerEventInteractions.length, 1);
  assert.equal(interactionInput.event, state.event.raw_event);
  assert.equal(interactionInput.eventCode, state.binding.eventCode);
  assert.equal(interactionInput.eventId, "event-42");
  assert.deepEqual(interactionInput.providerEvent, {
    provider: "youtube",
    channel: "youtube",
    activationEvent: "published_video",
    providerEventId: `youtube:${CHANNEL_ID}:videoABC123:published`,
    videoId: "videoABC123",
    externalMessageId: `youtube:${CHANNEL_ID}:videoABC123:published`,
    publishedAt: "2026-07-18T09:15:00.000Z",
    updatedAt: "2026-07-18T09:16:00.000Z",
    title: "Runtime Video",
    canonicalUrl: "https://www.youtube.com/watch?v=videoABC123",
  });
  assert.equal(interactionInput.occurredAt, "2026-07-18T09:15:00.000Z");
  assert.equal(state.persistenceCalls.length, 1);
  assert.equal(persistenceCall.interaction.providerEvent.provider, "youtube");
  assert.equal(persistenceCall.interaction.providerEvent.channel, "youtube");
  assert.equal(terminalUpdate.processingState, "completed");
  assert.equal(terminalUpdate.corePersistenceState, "committed");
  assert.equal(terminalUpdate.completionState, "completed");
  assert.equal(terminalUpdate.publicResponseJson.status, "processed");
  assert.equal(terminalUpdate.terminalState, true);
  assert.deepEqual(state.calls, [
    "subscription",
    "binding",
    "event",
    "delivery_claim",
    "first_video",
    "create_interaction",
    "core_persistence",
    "delivery_terminal",
  ]);
});

test("YouTube notification passes core persistence dependencies to the adapter pipeline", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);
  const saveInteraction = async () => ({ id: "custom-interaction" });
  const saveRewards = async () => [];
  const saveClipXtra = async () => ({ id: "custom-clipxtra" });
  const runTransaction = async (work) =>
    work({ queryClient: { transaction: "custom-transaction" } });
  let persistenceInput = null;

  const { result } = await postNotification(xml, {
    deps: {
      saveCodeClipInteraction: saveInteraction,
      saveCodeClipRewardAssignments: saveRewards,
      saveCodeClipXtraRedemption: saveClipXtra,
      runCodeClipCorePersistenceTransaction: runTransaction,
      persistCodeClipCoreInteraction: async (input) => {
        persistenceInput = input;
        input.interaction.persistenceStatus.interaction = {
          attempted: true,
          ok: true,
          error: null,
          committed: true,
        };
      },
    },
  });

  assert.equal(result.httpStatus, 202);
  assert.equal(persistenceInput.saveCodeClipInteraction, saveInteraction);
  assert.equal(persistenceInput.saveCodeClipRewardAssignments, saveRewards);
  assert.equal(persistenceInput.saveCodeClipXtraRedemption, saveClipXtra);
  assert.equal(persistenceInput.runCodeClipCorePersistenceTransaction, runTransaction);
});

test("YouTube notification marks delivery retryable when provider-event persistence fails", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);
  const { result, state } = await postNotification(xml, {
    deps: {
      persistCodeClipCoreInteraction: async ({ interaction }) => {
        interaction.persistenceStatus.interaction = {
          attempted: true,
          ok: false,
          error: "provider event persistence failed",
          committed: false,
        };
      },
    },
  });
  const failedUpdate = state.deliveryUpdates[state.deliveryUpdates.length - 1].updates;

  assert.equal(result.httpStatus, 503);
  assert.equal(result.payload.code, "persistence_failed");
  assert.equal(failedUpdate.processingState, "failed");
  assert.equal(failedUpdate.corePersistenceState, "failed");
  assert.equal(failedUpdate.completionState, "not_completed");
  assert.equal(failedUpdate.responseStatus, 503);
  assert.equal(failedUpdate.publicResponseJson.code, "persistence_failed");
  assert.equal(failedUpdate.errorClass, "persistence_failed");
  assert.equal(failedUpdate.retryEligible, true);
  assert.equal(failedUpdate.terminalState, false);
  assert.equal(state.calls.includes("delivery_terminal"), false);
});

test("YouTube notification honors recipient-required policy only from the resolved episode", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);
  const recipientRequired = await postNotification(xml, {
    state: {
      event: eventRow({ providerEventRewardMode: "individual_reward" }),
    },
  });

  assert.equal(recipientRequired.result.httpStatus, 202);
  assert.equal(
    recipientRequired.state.deliveryUpdates[0].updates.publicResponseJson.status,
    "provider_event_recipient_required"
  );
  assert.equal(recipientRequired.state.providerEventInteractions.length, 0);
  assert.equal(recipientRequired.state.persistenceCalls.length, 0);

  const externalOnly = await postNotification(
    youtubeXml([entryXml("videoABC123", { title: "individual_reward" })]),
    {
      deps: {
        createProviderEventInteraction: (input) => {
          assert.equal(input.providerEvent.providerEventRewardMode, undefined);
          assert.equal(input.providerEvent.title, "individual_reward");
          return notificationDeps().createProviderEventInteraction(input);
        },
      },
    }
  );
  assert.equal(externalOnly.result.httpStatus, 202);
  assert.equal(externalOnly.result.payload.status, "processed");
});

test("YouTube notification provider-event allowlist excludes external identity and secret fields", async () => {
  const xml = youtubeXml([entryXml("videoABC123", { title: "secret signature phone email meta" })]);
  let providerEvent = null;
  const { result } = await postNotification(xml, {
    deps: {
      createProviderEventInteraction: (input) => {
        providerEvent = input.providerEvent;
        return notificationDeps().createProviderEventInteraction(input);
      },
    },
  });

  assert.equal(result.httpStatus, 202);
  assert.equal(providerEvent.secret, undefined);
  assert.equal(providerEvent.signature, undefined);
  assert.equal(providerEvent.hmac, undefined);
  assert.equal(providerEvent.rawXml, undefined);
  assert.equal(providerEvent.userId, undefined);
  assert.equal(providerEvent.phone, undefined);
  assert.equal(providerEvent.email, undefined);
  assert.equal(providerEvent.metaUserId, undefined);
});

test("YouTube notification keeps existing non-runtime WebSub flows unchanged", async () => {
  const xml = youtubeXml([entryXml("videoABC123")]);

  const duplicate = await postNotification(xml, {
    state: { existingDelivery: true },
  });
  assert.equal(duplicate.result.httpStatus, 202);
  assert.equal(duplicate.result.payload.duplicate, 1);
  assert.equal(duplicate.state.providerEventInteractions.length, 0);
  assert.equal(duplicate.state.persistenceCalls.length, 0);

  const unbound = await postNotification(xml, {
    state: { binding: null },
  });
  assert.equal(unbound.result.httpStatus, 404);
  assert.equal(unbound.result.payload.code, "unknown_subscription");

  const inactiveEpisode = await postNotification(xml, {
    state: { event: eventRow({ status: "disabled" }) },
  });
  assert.equal(inactiveEpisode.result.httpStatus, 202);
  assert.equal(
    inactiveEpisode.state.deliveryUpdates[0].updates.publicResponseJson.status,
    "non_activating"
  );
  assert.equal(inactiveEpisode.state.providerEventInteractions.length, 0);

  const wrongChannel = await postNotification(xml, {
    state: { event: eventRow({ activationChannels: ["instagram"] }) },
  });
  assert.equal(wrongChannel.result.httpStatus, 202);
  assert.equal(wrongChannel.state.deliveryUpdates[0].updates.publicResponseJson.status, "non_activating");

  const wrongEvent = await postNotification(xml, {
    state: { event: eventRow({ activationEvent: "something_else" }) },
  });
  assert.equal(wrongEvent.result.httpStatus, 202);
  assert.equal(wrongEvent.state.deliveryUpdates[0].updates.publicResponseJson.status, "non_activating");

  const historical = await postNotification(
    youtubeXml([entryXml("oldVideo123", { published: "2026-07-18T07:59:00+00:00" })])
  );
  assert.equal(historical.result.httpStatus, 202);
  assert.equal(
    historical.state.deliveryUpdates[0].updates.publicResponseJson.status,
    "non_activating_historical"
  );
  assert.equal(historical.state.providerEventInteractions.length, 0);
  assert.equal(historical.state.firstActivations.length, 0);
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
