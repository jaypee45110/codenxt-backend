const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderPollingIngestError,
  ingestCodeClipProviderPollDetections,
} = require("./verticals/codeclip/provider-polling/delivery-ingest");
const {
  getCodeClipProviderPollingCompletionInput,
} = require("./verticals/codeclip/provider-polling/detection-metadata");

const OPERATION_NOW = "2026-08-04T12:00:00.000Z";

test("ingest creates one delivery per detection×binding then completes", async () => {
  const creates = [];
  const completeCalls = [];

  const result = await ingestCodeClipProviderPollDetections(
    {
      pollSourceId: "1",
      owner: "worker-1",
      expectedVersion: 2,
      checkpoint: { cursor: "n1" },
      nextPollAt: "2026-08-04T12:05:00.000Z",
      provider: "youtube",
      providerAccountId: "UC_channel",
      detections: [
        {
          providerObjectId: "vid-1",
          publishedAt: "2026-08-01T00:00:00.000Z",
          detectedAt: OPERATION_NOW,
          source: "data_api_polling",
          deliverySource: "data_api_polling",
        },
        {
          providerObjectId: "vid-2",
          publishedAt: "2026-08-01T01:00:00.000Z",
          detectedAt: OPERATION_NOW,
          source: "data_api_polling",
          deliverySource: "data_api_polling",
        },
      ],
      bindings: [{ eventCode: "CC-EP-1" }],
      observability: {
        lastSuccessAt: OPERATION_NOW,
        lastDetectionAt: OPERATION_NOW,
        lastDetectionsCount: 2,
        lastAttemptDurationMs: 12,
      },
      now: OPERATION_NOW,
    },
    {
      queryClient: { query: async () => ({ rows: [] }) },
      createDelivery: async (delivery) => {
        creates.push(delivery);
        return {
          status: creates.length === 1 ? "created" : "existing",
          row: { id: creates.length },
        };
      },
      completeClaim: async (input, opts) => {
        completeCalls.push({ input, opts });
        assert.equal(typeof opts.beforeComplete, "function");
        await opts.beforeComplete({
          queryClient: opts.queryClient || {},
          pollSource: { id: "1" },
          operationNow: OPERATION_NOW,
        });
        return {
          status: "completed",
          pollSource: {
            id: "1",
            nextPollAt: input.nextPollAt,
            pollClaimOwner: null,
            checkpoint: input.checkpoint,
          },
        };
      },
    }
  );

  assert.equal(result.status, "ingested");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].externalMessageId, "poll:youtube:vid-1");
  assert.equal(creates[1].externalMessageId, "poll:youtube:vid-2");
  assert.equal(creates[0].eventCode, "CC-EP-1");
  assert.equal(creates[0].initialDeliverySource, "data_api_polling");
  assert.deepEqual(creates[0].providerDetectionMetadata, {
    provider: "youtube",
    channel: "youtube",
    providerContentId: "vid-1",
    publishedAt: "2026-08-01T00:00:00.000Z",
    detectedAt: OPERATION_NOW,
    detectionSource: "data_api_polling",
  });
  assert.equal(result.createdCount, 1);
  assert.equal(result.existingCount, 1);
  assert.deepEqual(result.deliveryIds, ["1", "2"]);
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].input.expectedVersion, 2);
  assert.deepEqual(completeCalls[0].input.checkpoint, { cursor: "n1" });
});

test("ingest with zero bindings advances without creating deliveries", async () => {
  const creates = [];
  const result = await ingestCodeClipProviderPollDetections(
    {
      pollSourceId: "9",
      owner: "worker-1",
      expectedVersion: 1,
      checkpoint: {},
      nextPollAt: OPERATION_NOW,
      provider: "youtube",
      providerAccountId: "UC_channel",
      detections: [
        {
          providerObjectId: "vid-1",
          deliverySource: "data_api_polling",
        },
      ],
      bindings: [],
      now: OPERATION_NOW,
    },
    {
      queryClient: {},
      createDelivery: async (d) => {
        creates.push(d);
        return { status: "created", row: { id: 1 } };
      },
      completeClaim: async (input, opts) => {
        await opts.beforeComplete({ queryClient: {}, operationNow: OPERATION_NOW });
        return {
          status: "completed",
          pollSource: { id: "9", nextPollAt: input.nextPollAt },
        };
      },
    }
  );

  assert.equal(creates.length, 0);
  assert.equal(result.requiredDeliveryCount, 0);
  assert.equal(result.bindingCount, 0);
  assert.equal(result.createdCount, 0);
});

test("ingest rolls back path when delivery status is not created/existing", async () => {
  await assert.rejects(
    () =>
      ingestCodeClipProviderPollDetections(
        {
          pollSourceId: "1",
          owner: "worker-1",
          expectedVersion: 1,
          checkpoint: {},
          provider: "youtube",
          providerAccountId: "UC_channel",
          detections: [
            {
              providerObjectId: "vid-1",
              publishedAt: "2026-08-01T00:00:00.000Z",
              source: "data_api_polling",
              deliverySource: "data_api_polling",
            },
          ],
          bindings: [{ eventCode: "CC-1" }],
          now: OPERATION_NOW,
        },
        {
          queryClient: {},
          createDelivery: async () => ({ status: "failed", row: null }),
          completeClaim: async (_input, opts) => {
            await opts.beforeComplete({ queryClient: {} });
            return { status: "completed", pollSource: { id: "1" } };
          },
        }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingIngestError);
      assert.equal(error.code, "DELIVERY_PERSISTENCE_FAILED");
      return true;
    }
  );
});

test("ingest persists TikTok safe detection metadata and reconstructs completion input", async () => {
  const creates = [];
  const result = await ingestCodeClipProviderPollDetections(
    {
      pollSourceId: "42",
      owner: "worker-tiktok",
      expectedVersion: 5,
      checkpoint: { initialized: true },
      provider: "tiktok",
      providerAccountId: "sandbox-account",
      detections: [
        {
          providerObjectId: "video-1",
          publishedAt: "2026-08-05T10:00:00.000Z",
          detectedAt: OPERATION_NOW,
          source: "display_api_polling",
          deliverySource: "provider_polling",
          canonicalUrl: "https://www.tiktok.com/@creator/video/video-1",
          title: "must not be persisted",
          accessToken: "must-not-be-persisted",
          rawPayload: { token: "must-not-be-persisted" },
        },
      ],
      bindings: [{ eventCode: "CC-TIKTOK" }],
      now: OPERATION_NOW,
    },
    {
      queryClient: {},
      createDelivery: async (delivery) => {
        creates.push(delivery);
        return { status: "created", row: { id: "900" } };
      },
      completeClaim: async (input, opts) => {
        await opts.beforeComplete({ queryClient: {}, operationNow: OPERATION_NOW });
        return { status: "completed", pollSource: { id: input.pollSourceId } };
      },
    }
  );

  assert.equal(result.createdCount, 1);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].providerDetectionMetadata, {
    provider: "tiktok",
    channel: "tiktok",
    providerContentId: "video-1",
    publishedAt: "2026-08-05T10:00:00.000Z",
    detectedAt: OPERATION_NOW,
    detectionSource: "display_api_polling",
    canonicalUrl: "https://www.tiktok.com/@creator/video/video-1",
  });
  assert.equal(JSON.stringify(creates[0]).includes("must-not-be-persisted"), false);

  const replay = getCodeClipProviderPollingCompletionInput({
    provider: "tiktok",
    initialDeliverySource: "provider_polling",
    providerDetectionMetadata: creates[0].providerDetectionMetadata,
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.completionInput, creates[0].providerDetectionMetadata);
});

test("ingest rejects malformed polling detection metadata before completing claim", async () => {
  let completed = false;
  await assert.rejects(
    () =>
      ingestCodeClipProviderPollDetections(
        {
          pollSourceId: "42",
          owner: "worker-tiktok",
          expectedVersion: 5,
          checkpoint: {},
          provider: "tiktok",
          providerAccountId: "sandbox-account",
          detections: [
            {
              providerObjectId: "video-1",
              publishedAt: "not-an-iso-date",
              detectedAt: OPERATION_NOW,
              source: "display_api_polling",
              deliverySource: "provider_polling",
            },
          ],
          bindings: [{ eventCode: "CC-TIKTOK" }],
          now: OPERATION_NOW,
        },
        {
          queryClient: {},
          completeClaim: async () => {
            completed = true;
          },
        }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingIngestError);
      assert.equal(error.code, "INVALID_DETECTION_METADATA");
      return true;
    }
  );
  assert.equal(completed, false);
});

test("old provider_polling delivery without metadata is not completion-ready", () => {
  const result = getCodeClipProviderPollingCompletionInput({
    provider: "tiktok",
    initialDeliverySource: "provider_polling",
    providerDetectionMetadata: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "COMPLETION_INPUT_INSUFFICIENT");
});

test("ingest maps fence mismatch from completeClaim", async () => {
  const {
    CodeClipProviderPollSourceError,
  } = require("./verticals/codeclip/provider-poll-sources");

  await assert.rejects(
    () =>
      ingestCodeClipProviderPollDetections(
        {
          pollSourceId: "1",
          owner: "worker-old",
          expectedVersion: 1,
          checkpoint: {},
          provider: "youtube",
          providerAccountId: "UC_channel",
          detections: [],
          bindings: [],
          now: OPERATION_NOW,
        },
        {
          queryClient: {},
          completeClaim: async () => {
            throw new CodeClipProviderPollSourceError(
              "POLL_CLAIM_FENCE_MISMATCH",
              "poll claim fence did not match"
            );
          },
        }
      ),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollingIngestError);
      assert.equal(error.code, "POLL_CLAIM_FENCE_MISMATCH");
      return true;
    }
  );
});
