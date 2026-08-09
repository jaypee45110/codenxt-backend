const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodeClipTikTokOperatorStatus,
} = require("./verticals/codeclip/tiktok/operator-status");

const NOW = "2026-08-09T12:00:00.000Z";
const EVENT = "CC-TIKTOK-STATUS";
const ACCOUNT = "secret-open-id-must-not-leak";

function queryClientWithDeliveryRows(rows = [{}]) {
  return {
    async query() {
      return { rows };
    },
  };
}

test("TikTok operator status serializes sandbox connection scopes and poll health safely", async () => {
  const status = await buildCodeClipTikTokOperatorStatus(
    { eventCode: EVENT, environment: "sandbox" },
    {
      now: NOW,
      queryClient: queryClientWithDeliveryRows([
        {
          total: 3,
          processing: 0,
          completed: 1,
          retryable_failed: 0,
          terminal_failed: 2,
          pending_completion_ready: 0,
          terminal_completion_input_insufficient: 1,
          terminal_invalid_event_mapping: 1,
          latest_error_class: "COMPLETION_INPUT_INSUFFICIENT",
        },
      ]),
      listBindingsForEvent: async () => [
        {
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
          providerAccountId: ACCOUNT,
          eventCode: EVENT,
        },
      ],
      findCredential: async () => ({
        id: 9,
        status: "active",
        scopes: ["user.info.basic", "video.list"],
        hasAccessToken: true,
        hasRefreshToken: true,
        accessTokenExpiresAt: "2026-08-10T12:00:00.000Z",
        expired: false,
        reauthorizationRequired: false,
        reauthorizationReason: null,
        lastRefreshedAt: "2026-08-09T10:00:00.000Z",
      }),
      inspectUsability: async () => ({
        usableForProviderApi: true,
        reauthorizationRequired: false,
      }),
      findPollSource: async () => ({
        status: "active",
        environment: "sandbox",
        pollIntervalMs: 300000,
        nextPollAt: "2026-08-09T12:05:00.000Z",
        lastPolledAt: "2026-08-09T12:00:00.000Z",
        lastSuccessAt: "2026-08-09T12:00:00.000Z",
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastDetectionsCount: 0,
        checkpoint: { initialized: true },
        pollClaimOwner: null,
        pollClaimExpiresAt: null,
        pollClaimVersion: 11,
      }),
    }
  );

  assert.equal(status.ok, true);
  assert.equal(status.provider, "tiktok");
  assert.equal(status.channel, "tiktok");
  assert.equal(status.eventCode, EVENT);
  assert.equal(status.requestedEnvironment, "sandbox");
  const sandbox = status.environments.sandbox;
  assert.equal(sandbox.connection.environment, "sandbox");
  assert.equal(sandbox.connection.scopes.userInfoBasic, true);
  assert.equal(sandbox.connection.scopes.videoList, true);
  assert.equal(sandbox.credential.scopes.userInfoBasic, true);
  assert.equal(sandbox.credential.scopes.videoList, true);
  assert.equal(sandbox.pollingSource.status, "active");
  assert.equal(sandbox.pollingSource.checkpointInitialized, true);
  assert.equal(sandbox.pollingSource.claimActive, false);
  assert.equal(sandbox.pollingHealth.classification, "healthy");
  assert.equal(status.delivery.detectionSource, "provider_polling");
  assert.equal(status.delivery.total, 3);
  assert.equal(status.delivery.completed, 1);
  assert.equal(status.delivery.terminalFailed, 2);
  assert.equal(status.delivery.health.classification, "terminal_delivery");
  assert.equal(status.summary.environment, "sandbox");
  assert.equal(status.summary.scopes.videoList, true);

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(ACCOUNT), false);
  assert.equal(serialized.includes("access_token"), false);
  assert.equal(serialized.includes("refresh_token"), false);
  assert.equal(serialized.includes("providerAccountId"), false);
});

test("production without poll source is not_configured not an error", async () => {
  const status = await buildCodeClipTikTokOperatorStatus(
    { eventCode: EVENT, environment: "production" },
    {
      now: NOW,
      queryClient: queryClientWithDeliveryRows([
        {
          total: 0,
          processing: 0,
          completed: 0,
          retryable_failed: 0,
          terminal_failed: 0,
          pending_completion_ready: 0,
          terminal_completion_input_insufficient: 0,
          terminal_invalid_event_mapping: 0,
          latest_error_class: null,
        },
      ]),
      listBindingsForEvent: async () => [],
      findCredential: async () => null,
      inspectUsability: async () => null,
      findPollSource: async () => null,
    }
  );
  assert.equal(status.environments.production.pollingSource, null);
  assert.equal(
    status.environments.production.pollingHealth.classification,
    "not_configured"
  );
  assert.equal(status.environments.production.credential.present, false);
  assert.equal(status.delivery.health.classification, "healthy");
});

test("both environments returned when environment omitted", async () => {
  const status = await buildCodeClipTikTokOperatorStatus(
    { eventCode: EVENT },
    {
      now: NOW,
      queryClient: queryClientWithDeliveryRows([{}]),
      listBindingsForEvent: async () => [
        {
          provider: "tiktok",
          channel: "tiktok",
          status: "active",
          providerAccountId: ACCOUNT,
          eventCode: EVENT,
        },
      ],
      findCredential: async ({ environment }) =>
        environment === "sandbox"
          ? {
              id: 1,
              status: "active",
              scopes: ["user.info.basic", "video.list"],
              hasAccessToken: true,
              hasRefreshToken: true,
              expired: false,
              reauthorizationRequired: false,
            }
          : null,
      inspectUsability: async () => ({ usableForProviderApi: true }),
      findPollSource: async ({ environment }) =>
        environment === "sandbox"
          ? {
              status: "active",
              environment: "sandbox",
              pollIntervalMs: 300000,
              consecutiveFailures: 0,
              lastSuccessAt: NOW,
              checkpoint: { initialized: true },
            }
          : null,
    }
  );
  assert.ok(status.environments.sandbox);
  assert.ok(status.environments.production);
  assert.equal(status.environments.sandbox.credential.present, true);
  assert.equal(status.environments.production.credential.present, false);
  assert.equal(
    status.environments.production.pollingHealth.classification,
    "not_configured"
  );
  assert.equal(JSON.stringify(status).includes(ACCOUNT), false);
});
