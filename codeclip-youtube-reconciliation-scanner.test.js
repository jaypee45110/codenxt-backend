const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ATOM_SOURCE,
  DATA_API_SOURCE,
  buildDeliveryIdentity,
  classifyTargetUploads,
  discoverEligibleTargets,
  fetchAtomUploads,
  fetchDataApiUploads,
  formatHumanReport,
  scanCodeClipYouTubeReconciliation,
} = require("./verticals/codeclip/youtube-reconciliation-scanner");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const OTHER_CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_CODE = "CC-YT-SCAN";
const BOUNDARY = "2026-07-25T08:46:01.000Z";
const NOW = new Date("2026-07-26T08:00:00.000Z");

function binding(overrides = {}) {
  return {
    id: "1",
    vertical: "codeclip",
    eventCode: EVENT_CODE,
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    status: "active",
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "10",
    vertical: "codeclip",
    callbackId: "yt_cb_scan",
    provider: "youtube",
    channel: "youtube",
    providerAccountId: CHANNEL_ID,
    topic: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    status: "active",
    pendingMode: null,
    activationBoundaryAt: BOUNDARY,
    activationBoundaryVideoId: null,
    ...overrides,
  };
}

function eventRecord(overrides = {}) {
  return {
    id: "event-id",
    vertical: "codeclip",
    status: "active",
    activationMethod: "provider",
    activationChannels: ["youtube"],
    activationEvent: "published_video",
    ...overrides,
  };
}

function upload(videoId, overrides = {}) {
  return {
    eventType: "published_video",
    activationIdentity: `youtube:${CHANNEL_ID}:${videoId}:published`,
    externalMessageId: `youtube:${CHANNEL_ID}:${videoId}:published`,
    videoId,
    channelId: CHANNEL_ID,
    title: "SideBySideTest",
    publishedAt: "2026-07-25T08:47:17.000Z",
    updatedAt: "2026-07-25T08:48:00.000Z",
    ...overrides,
  };
}

function xml(entries, channelId = CHANNEL_ID, options = {}) {
  const topic = options.topic || `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
    <link rel="self" href="${topic}"/>
    <id>yt:channel:${channelId}</id>
    <updated>2026-07-25T08:48:00Z</updated>
    ${entries
      .map(
        (entry) => `<entry>
          <id>yt:video:${entry.videoId}</id>
          <yt:videoId>${entry.videoId}</yt:videoId>
          <yt:channelId>${entry.channelId || channelId}</yt:channelId>
          <title>${entry.title || "SideBySideTest"}</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=${entry.videoId}"/>
          <published>${entry.publishedAt}</published>
          <updated>${entry.updatedAt || entry.publishedAt}</updated>
        </entry>`
      )
      .join("")}
  </feed>`;
}

async function discover(overrides = {}) {
  return discoverEligibleTargets({
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [binding(overrides.binding)] }),
    listSubscriptions: async () => [subscription(overrides.subscription)],
    getEventByCode: async () => eventRecord(overrides.event),
    ...overrides.input,
  });
}

test("active eligible binding/subscription is discovered", async () => {
  const result = await discover();
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0].providerAccountId, CHANNEL_ID);
});

test("inactive binding is excluded", async () => {
  const result = await discover({ binding: { status: "disabled" } });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skipped[0].reason, "binding_not_active_youtube");
});

test("inactive subscription is excluded", async () => {
  const result = await discover({ subscription: { status: "expired" } });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skipped[0].reason, "no_active_subscription");
});

test("pending subscription is excluded", async () => {
  const result = await discover({
    subscription: { status: "active", pendingMode: "subscribe" },
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skipped[0].reason, "subscription_pending");
});

test("malformed providerAccountId fails closed", async () => {
  const result = await discover({ binding: { providerAccountId: "https://youtube.test/@bad" } });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.errors[0].code, "invalid_provider_binding");
});

test("binding/subscription channel mismatch fails closed explicitly", async () => {
  const result = await discover({ subscription: { providerAccountId: OTHER_CHANNEL_ID } });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.skipped[0].reason, "subscription_channel_mismatch");
});

test("upload before activation boundary is excluded", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("before1", { publishedAt: "2026-07-25T08:46:00.000Z" })] },
    { queryClient: {}, lookbackHours: 72 }
  );
  assert.equal(candidate.classification, "excluded_before_activation");
});

test("upload exactly at activation boundary follows existing exclusive semantics", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("exact1", { publishedAt: BOUNDARY })] },
    { queryClient: {}, lookbackHours: 72 }
  );
  assert.equal(candidate.classification, "excluded_before_activation");
});

test("upload after activation boundary is included", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("after1")] },
    { queryClient: {}, lookbackHours: 72, getDeliveryByIdentity: async () => null }
  );
  assert.equal(candidate.classification, "missing");
});

test("existing completed delivery is classified correctly", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("done01")] },
    {
      queryClient: {},
      lookbackHours: 72,
      getDeliveryByIdentity: async () => ({
        id: "99",
        corePersistenceState: "committed",
        completionState: "completed",
        processingState: "completed",
        terminalState: true,
        retryEligible: false,
        publicResponseJson: { ok: true },
        responseStatus: 202,
      }),
    }
  );
  assert.equal(candidate.classification, "existing_completed");
});

test("existing incomplete delivery is classified correctly", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("incomp1")] },
    {
      queryClient: {},
      lookbackHours: 72,
      getDeliveryByIdentity: async () => ({
        id: "98",
        corePersistenceState: "committed",
        completionState: "not_completed",
        processingState: "completed",
        terminalState: false,
      }),
    }
  );
  assert.equal(candidate.classification, "existing_incomplete");
});

test("missing delivery is classified as missing", async () => {
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("miss01")] },
    { queryClient: {}, lookbackHours: 72, getDeliveryByIdentity: async () => null }
  );
  assert.equal(candidate.classification, "missing");
});

test("duplicate source entries collapse by videoId", async () => {
  const candidates = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("dup001"), upload("dup001")] },
    { queryClient: {}, lookbackHours: 72, getDeliveryByIdentity: async () => null }
  );
  assert.equal(candidates.length, 1);
});

test("same title with different video IDs remains two candidates", async () => {
  const candidates = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("title1"), upload("title2")] },
    { queryClient: {}, lookbackHours: 72, getDeliveryByIdentity: async () => null }
  );
  assert.equal(candidates.length, 2);
});

test("one target source failure does not abort all targets", async () => {
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({
      items: [
        binding({ providerAccountId: CHANNEL_ID }),
        binding({ id: "2", providerAccountId: OTHER_CHANNEL_ID }),
      ],
    }),
    listSubscriptions: async ({ providerAccountId }) => [
      subscription({
        providerAccountId,
        topic: `https://www.youtube.com/feeds/videos.xml?channel_id=${providerAccountId}`,
      }),
    ],
    getEventByCode: async () => eventRecord(),
    sourceAdapter: {
      source: ATOM_SOURCE,
      fetchUploads: async (target) => {
        if (target.channelId === CHANNEL_ID) throw new Error("source down with sensitive text");
        return { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("oknext", { channelId: OTHER_CHANNEL_ID })] };
      },
    },
    getDeliveryByIdentity: async () => null,
  });
  assert.equal(report.summary.targetsEligible, 2);
  assert.equal(report.errors.length, 1);
  assert.equal(report.summary.missingCandidates, 1);
});

test("source adapter malformed response handling is sanitized", async () => {
  await assert.rejects(
    () =>
      fetchAtomUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        { now: NOW, fetchImpl: async () => ({ ok: true, text: async () => "<feed>" }) }
      ),
    /malformed/
  );
});

test("Atom adapter accepts canonical YouTube http self-link", async () => {
  const result = await fetchAtomUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    {
      now: NOW,
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          xml([upload("atomok")], CHANNEL_ID, {
            topic: `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
          }),
      }),
    }
  );

  assert.equal(result.source, ATOM_SOURCE);
  assert.equal(result.sourceIdentity, `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].videoId, "atomok");
});

test("Atom adapter validates channel identity", async () => {
  await assert.rejects(
    () =>
      fetchAtomUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        {
          now: NOW,
          fetchImpl: async () => ({
            ok: true,
            text: async () =>
              xml([upload("atom01", { channelId: OTHER_CHANNEL_ID })], OTHER_CHANNEL_ID),
          }),
        }
      ),
    /identity/
  );
});

test("Data API adapter requires explicit API key", async () => {
  await assert.rejects(
    () =>
      fetchDataApiUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        {
          now: NOW,
          fetchImpl: async () => {
            throw new Error("must not call network without key");
          },
        }
      ),
    /source unavailable|api key/i
  );
});

test("Data API adapter resolves uploads playlist and normalizes playlist uploads", async () => {
  const calls = [];
  const result = await fetchDataApiUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    {
      now: NOW,
      apiKey: "test-api-key",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push({
          path: parsed.pathname,
          part: parsed.searchParams.get("part"),
          id: parsed.searchParams.get("id"),
          playlistId: parsed.searchParams.get("playlistId"),
          maxResults: parsed.searchParams.get("maxResults"),
          key: parsed.searchParams.get("key"),
        });
        if (parsed.pathname.endsWith("/channels")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: CHANNEL_ID,
                  contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } },
                },
              ],
            }),
          };
        }
        if (parsed.pathname.endsWith("/playlistItems")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  snippet: {
                    title: "BeTwelve",
                    channelId: CHANNEL_ID,
                    videoOwnerChannelId: CHANNEL_ID,
                  },
                  contentDetails: {
                    videoId: "fXATUaUPMQ0",
                    videoPublishedAt: "2026-07-27T07:57:47Z",
                  },
                  status: { privacyStatus: "public" },
                },
              ],
            }),
          };
        }
        throw new Error("unexpected URL");
      },
    }
  );

  assert.equal(result.source, DATA_API_SOURCE);
  assert.equal(result.sourceIdentity, "UUuploadsPlaylist");
  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].videoId, "fXATUaUPMQ0");
  assert.equal(result.uploads[0].channelId, CHANNEL_ID);
  assert.equal(result.uploads[0].title, "BeTwelve");
  assert.equal(result.uploads[0].publishedAt, "2026-07-27T07:57:47.000Z");
  assert.equal(result.uploads[0].externalMessageId, `youtube:${CHANNEL_ID}:fXATUaUPMQ0:published`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/youtube/v3/channels");
  assert.equal(calls[0].part, "contentDetails");
  assert.equal(calls[0].id, CHANNEL_ID);
  assert.equal(calls[1].path, "/youtube/v3/playlistItems");
  assert.equal(calls[1].part, "snippet,contentDetails,status");
  assert.equal(calls[1].playlistId, "UUuploadsPlaylist");
  assert.equal(calls[1].maxResults, "10");
  assert.equal(calls.every((call) => call.key === "test-api-key"), true);
});

test("Data API scanner classifies uploads through the existing delivery identity", async () => {
  const deliveries = new Map([
    [
      `youtube:${CHANNEL_ID}:fXATUaUPMQ0:published`,
      {
        id: "delivery-b12",
        processingState: "completed",
        corePersistenceState: "committed",
        completionState: "completed",
        terminalState: true,
        retryEligible: false,
        responseStatus: 202,
        publicResponseJson: { ok: true },
      },
    ],
  ]);
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    source: DATA_API_SOURCE,
    apiKey: "test-api-key",
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [binding()] }),
    listSubscriptions: async () => [subscription()],
    getEventByCode: async () => eventRecord(),
    getDeliveryByIdentity: async (identity) => deliveries.get(identity.externalMessageId) || null,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/channels")) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } } },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              snippet: { title: "BeTwelve", channelId: CHANNEL_ID, videoOwnerChannelId: CHANNEL_ID },
              contentDetails: { videoId: "fXATUaUPMQ0", videoPublishedAt: "2026-07-27T07:57:47Z" },
              status: { privacyStatus: "public" },
            },
          ],
        }),
      };
    },
  });

  assert.equal(report.source, DATA_API_SOURCE);
  assert.equal(report.summary.uploadsExamined, 1);
  assert.equal(report.summary.existingDeliveries, 1);
  assert.equal(report.summary.missingCandidates, 0);
  assert.equal(report.candidates[0].classification, "existing_completed");
});

test("Data API adapter skips non-public uploads while preserving public uploads", async () => {
  const result = await fetchDataApiUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    {
      now: NOW,
      apiKey: "test-api-key",
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/channels")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                { id: CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } } },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                snippet: { title: "PrivateUpload", channelId: CHANNEL_ID, videoOwnerChannelId: CHANNEL_ID },
                contentDetails: { videoId: "private1", videoPublishedAt: "2026-07-27T07:57:47Z" },
                status: { privacyStatus: "private" },
              },
              {
                snippet: { title: "PublicUpload", channelId: CHANNEL_ID, videoOwnerChannelId: CHANNEL_ID },
                contentDetails: { videoId: "public1", videoPublishedAt: "2026-07-27T07:59:47Z" },
                status: { privacyStatus: "public" },
              },
            ],
          }),
        };
      },
    }
  );

  assert.equal(result.uploads.length, 1);
  assert.equal(result.uploads[0].videoId, "public1");
  assert.equal(result.uploads[0].channelId, CHANNEL_ID);
  assert.equal(result.uploads[0].publishedAt, "2026-07-27T07:59:47.000Z");
  assert.equal(result.uploads[0].externalMessageId, `youtube:${CHANNEL_ID}:public1:published`);
});

test("Data API adapter fail-closes on malformed or mismatched channel identity", async () => {
  await assert.rejects(
    () =>
      fetchDataApiUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        {
          now: NOW,
          apiKey: "test-api-key",
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/channels")) {
              return {
                ok: true,
                json: async () => ({
                  items: [
                    { id: CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } } },
                  ],
                }),
              };
            }
            return {
              ok: true,
              json: async () => ({
                items: [
                  {
                    snippet: { title: "WrongOwner", channelId: CHANNEL_ID, videoOwnerChannelId: OTHER_CHANNEL_ID },
                    contentDetails: { videoId: "wrong1", videoPublishedAt: "2026-07-27T07:57:47Z" },
                    status: { privacyStatus: "public" },
                  },
                ],
              }),
            };
          },
        }
      ),
    /identity|mismatch|source/i
  );
});

test("Data API adapter fail-closes when privacy status is missing", async () => {
  await assert.rejects(
    () =>
      fetchDataApiUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        {
          now: NOW,
          apiKey: "test-api-key",
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/channels")) {
              return {
                ok: true,
                json: async () => ({
                  items: [
                    { id: CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } } },
                  ],
                }),
              };
            }
            return {
              ok: true,
              json: async () => ({
                items: [
                  {
                    snippet: { title: "NoPrivacy", channelId: CHANNEL_ID, videoOwnerChannelId: CHANNEL_ID },
                    contentDetails: { videoId: "nopub1", videoPublishedAt: "2026-07-27T07:57:47Z" },
                  },
                ],
              }),
            };
          },
        }
      ),
    /malformed|source/i
  );
});

test("Data API adapter fail-closes before building identity for malformed video id", async () => {
  await assert.rejects(
    () =>
      fetchDataApiUploads(
        { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
        {
          now: NOW,
          apiKey: "test-api-key",
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/channels")) {
              return {
                ok: true,
                json: async () => ({
                  items: [
                    { id: CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UUuploadsPlaylist" } } },
                  ],
                }),
              };
            }
            return {
              ok: true,
              json: async () => ({
                items: [
                  {
                    snippet: { title: "BadVideo", channelId: CHANNEL_ID, videoOwnerChannelId: CHANNEL_ID },
                    contentDetails: { videoId: "", videoPublishedAt: "2026-07-27T07:57:47Z" },
                    status: { privacyStatus: "public" },
                  },
                ],
              }),
            };
          },
        }
      ),
    /malformed|source/i
  );
});

test("scanner never invokes delivery creation", async () => {
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [binding()] }),
    listSubscriptions: async () => [subscription()],
    getEventByCode: async () => eventRecord(),
    sourceAdapter: {
      source: ATOM_SOURCE,
      fetchUploads: async () => ({ source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("nocrea")] }),
    },
    createCodeClipProviderDelivery: async () => {
      throw new Error("must not be called");
    },
    getDeliveryByIdentity: async () => null,
  });
  assert.equal(report.summary.missingCandidates, 1);
});

test("scanner never invokes interaction or reward processing", async () => {
  const forbidden = async () => {
    throw new Error("must not be called");
  };
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [binding()] }),
    listSubscriptions: async () => [subscription()],
    getEventByCode: async () => eventRecord(),
    sourceAdapter: {
      source: ATOM_SOURCE,
      fetchUploads: async () => ({ source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("nopipe")] }),
    },
    createProviderEventInteraction: forbidden,
    persistCodeClipCoreInteraction: forbidden,
    saveCodeClipRewardAssignments: forbidden,
    saveCodeClipXtraRedemption: forbidden,
    getDeliveryByIdentity: async () => null,
  });
  assert.equal(report.summary.missingCandidates, 1);
});

test("JSON output contract is stable", async () => {
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [] }),
    listSubscriptions: async () => [],
    getEventByCode: async () => eventRecord(),
  });
  const keys = Object.keys(report);
  assert.deepEqual(keys, ["version", "mode", "source", "startedAt", "completedAt", "summary", "targets", "candidates", "errors"]);
  assert.equal(report.mode, "read_only");
});

test("no secret leakage in JSON, human output, target errors, or report errors", async () => {
  const secret = "SECRETPAYLOAD-TOKENFRAG-12345";
  const fragments = [secret, "SECRETPAYLOAD", "TOKENFRAG", "12345"];
  const report = await scanCodeClipYouTubeReconciliation({
    now: NOW,
    queryClient: { query: async () => ({ rows: [] }) },
    listBindings: async () => ({ items: [binding()] }),
    listSubscriptions: async () => [subscription()],
    getEventByCode: async () => eventRecord(),
    sourceAdapter: {
      source: ATOM_SOURCE,
      fetchUploads: async () => {
        const error = new Error(`source failed ${secret}`);
        error.code = "source_failed";
        throw error;
      },
    },
  });
  const jsonOutput = JSON.stringify(report);
  const humanOutput = formatHumanReport(report);
  const targetErrors = JSON.stringify(report.targets.map((target) => target.error));
  const reportErrors = JSON.stringify(report.errors);
  for (const fragment of fragments) {
    assert.equal(jsonOutput.includes(fragment), false);
    assert.equal(humanOutput.includes(fragment), false);
    assert.equal(targetErrors.includes(fragment), false);
    assert.equal(reportErrors.includes(fragment), false);
  }
});

test("database lookup failure is sanitized in candidate output", async () => {
  const secret = "DBSECRETLOOKUP-TOKENFRAG-999";
  const [candidate] = await classifyTargetUploads(
    { ...subscription(), eventCode: EVENT_CODE, channelId: CHANNEL_ID },
    { source: ATOM_SOURCE, observedAt: NOW.toISOString(), uploads: [upload("dberr1")] },
    {
      queryClient: {},
      lookbackHours: 72,
      getDeliveryByIdentity: async () => {
        throw new Error(`db failed ${secret}`);
      },
    }
  );
  assert.equal(candidate.classification, "invalid_candidate");
  const serialized = JSON.stringify(candidate);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("DBSECRETLOOKUP"), false);
  assert.equal(candidate.error.message, "Delivery lookup failed");
});

test("delivery identity uses event code and video id, not title", () => {
  const identity = buildDeliveryIdentity({
    providerAccountId: CHANNEL_ID,
    eventCode: EVENT_CODE,
    externalMessageId: `youtube:${CHANNEL_ID}:uf0IPCAiRqY:published`,
  });
  assert.deepEqual(identity, {
    provider: "youtube",
    providerAccountId: CHANNEL_ID,
    eventCode: EVENT_CODE,
    externalMessageId: `youtube:${CHANNEL_ID}:uf0IPCAiRqY:published`,
  });
});
