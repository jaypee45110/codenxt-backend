const test = require("node:test");
const assert = require("node:assert/strict");

const {
  eventMatchesBoundProviderActivation,
  eventMatchesBoundProviderEventActivation,
  resolveCodeClipProviderActivationEvent,
} = require("./verticals/codeclip/provider-activation");

function codeClipEvent(overrides = {}) {
  return {
    id: "event-1",
    code: "CC-1",
    vertical: "codeclip",
    activationKeyword: "CLIP",
    activationChannels: ["sms"],
    ...overrides,
  };
}

test("codeClip provider activation lookup requires provider and keyword", () => {
  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      keyword: "CLIP",
      events: [codeClipEvent()],
    }),
    { ok: false, reason: "PROVIDER_REQUIRED" }
  );

  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      events: [codeClipEvent()],
    }),
    { ok: false, reason: "KEYWORD_REQUIRED" }
  );
});

test("codeClip provider activation lookup matches codeClip keyword case-insensitively", () => {
  const event = codeClipEvent({
    activationKeyword: " Clip ",
    activationChannels: [" SMS "],
  });

  const result = resolveCodeClipProviderActivationEvent({
    provider: " SMS ",
    keyword: " clip ",
    events: [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.event, event);
});

test("codeClip provider activation lookup never matches other verticals", () => {
  const codePodEvent = codeClipEvent({
    id: "codepod-event",
    vertical: "codepod",
    activationKeyword: "CLIP",
    activationChannels: ["sms"],
  });

  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "CLIP",
      events: [codePodEvent],
    }),
    { ok: false, reason: "NO_MATCH" }
  );
});

test("codeClip provider activation lookup requires provider channel match when activationChannels exists", () => {
  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "CLIP",
      events: [
        codeClipEvent({
          activationChannels: ["Instagram"],
        }),
      ],
    }),
    { ok: false, reason: "NO_MATCH" }
  );

  const instagramEvent = codeClipEvent({
    activationChannels: ["Instagram"],
  });
  const metaResult = resolveCodeClipProviderActivationEvent({
    provider: "meta",
    keyword: "CLIP",
    events: [instagramEvent],
  });

  assert.equal(metaResult.ok, true);
  assert.equal(metaResult.event, instagramEvent);
});

test("codeClip provider activation lookup supports metadata and config activation fields", () => {
  const metadataEvent = codeClipEvent({
    activationKeyword: "",
    activationChannels: undefined,
    metadata: {
      activationKeyword: "OPEN",
      activationChannels: "[\"Messenger\"]",
    },
  });
  const configEvent = codeClipEvent({
    activationKeyword: "",
    activationChannels: undefined,
    config: {
      activationKeyword: "VIP",
      activationChannels: "sms",
    },
  });

  const metaResult = resolveCodeClipProviderActivationEvent({
    provider: "meta",
    keyword: "open",
    events: [metadataEvent, configEvent],
  });
  assert.equal(metaResult.ok, true);
  assert.equal(metaResult.event, metadataEvent);

  const smsResult = resolveCodeClipProviderActivationEvent({
    provider: "sms",
    keyword: "vip",
    events: [metadataEvent, configEvent],
  });
  assert.equal(smsResult.ok, true);
  assert.equal(smsResult.event, configEvent);
});

test("codeClip provider activation lookup respects providerAccountId when event is bound", () => {
  const event = codeClipEvent({
    providerAccountIds: [" page-1 "],
  });

  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "CLIP",
      events: [event],
    }),
    { ok: false, reason: "NO_MATCH" }
  );

  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "CLIP",
      providerAccountId: "page-2",
      events: [event],
    }),
    { ok: false, reason: "NO_MATCH" }
  );

  const result = resolveCodeClipProviderActivationEvent({
    provider: "sms",
    keyword: "CLIP",
    providerAccountId: " PAGE-1 ",
    events: [event],
  });

  assert.equal(result.ok, true);
  assert.equal(result.event, event);
});

test("codeClip provider activation lookup returns ambiguous when multiple codeClip events match", () => {
  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "clip",
      events: [
        codeClipEvent({ id: "event-1" }),
        codeClipEvent({ id: "event-2" }),
      ],
    }),
    { ok: false, reason: "AMBIGUOUS_MATCH" }
  );
});

test("codeClip provider activation lookup returns no match for missing activation keyword", () => {
  assert.deepEqual(
    resolveCodeClipProviderActivationEvent({
      provider: "sms",
      keyword: "clip",
      events: [
        codeClipEvent({
          activationKeyword: "",
        }),
      ],
    }),
    { ok: false, reason: "NO_MATCH" }
  );
});

test("bound codeClip provider activation accepts keyword ingress when activation method is both", () => {
  assert.equal(
    eventMatchesBoundProviderActivation(
      codeClipEvent({
        activationMethod: "both",
        activationChannels: ["Messenger"],
        providerAccountIds: ["legacy-other-account"],
      }),
      {
        provider: "meta",
        channel: "messenger",
        keyword: "clip",
      }
    ),
    true
  );
});

test("bound codeClip provider event activation accepts TikTok published videos", () => {
  assert.equal(
    eventMatchesBoundProviderEventActivation(
      codeClipEvent({
        activationMethod: "provider",
        activationChannels: [" TikTok "],
        activationEvent: " Published_Video ",
      }),
      {
        provider: "tiktok",
        channel: "tiktok",
        activationEvent: "published_video",
      }
    ),
    true
  );
});

test("bound codeClip provider event activation keeps Meta and YouTube isolated", () => {
  const youtubeEvent = codeClipEvent({
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
  });
  const metaEvent = codeClipEvent({
    activationMethod: "both",
    activationChannels: ["messenger"],
    activationEvent: "published_video",
  });

  assert.equal(
    eventMatchesBoundProviderEventActivation(youtubeEvent, {
      provider: "youtube",
      channel: "youtube",
      activationEvent: "published_video",
    }),
    true
  );
  assert.equal(
    eventMatchesBoundProviderEventActivation(youtubeEvent, {
      provider: "tiktok",
      channel: "tiktok",
      activationEvent: "published_video",
    }),
    false
  );
  assert.equal(
    eventMatchesBoundProviderEventActivation(metaEvent, {
      provider: "meta",
      channel: "messenger",
      activationEvent: "published_video",
    }),
    true
  );
});
