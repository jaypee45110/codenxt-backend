const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipYouTubeWebSubDiagnosticProbeError,
  DIAGNOSTIC_CALLBACK_PATH_PREFIX,
  normalizeDiagnosticProbeId,
  normalizeDiagnosticCallbackId,
  normalizeYouTubeDiagnosticChannelId,
  normalizeYouTubeDiagnosticTopic,
  normalizeDiagnosticProbeRecord,
  assertDiagnosticProbeTransition,
  applyDiagnosticVerificationTransition,
  applyDiagnosticNotificationObservation,
  applyDiagnosticUnsubscribeTransition,
  applyDiagnosticDispatchFailureTransition,
  buildDiagnosticObservationIdentity,
  isDiagnosticProbeTerminal,
  serializeDiagnosticProbePublic,
  maskDiagnosticIdentifier,
  buildDiagnosticCallbackPath,
} = require("./verticals/codeclip/youtube-websub-diagnostic-probe");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const PROBE_ID = "diag_probeSmoke123";
const CALLBACK_ID = "diag_yt_callbackSmoke123456";
const HTTPS_TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const HTTP_TOPIC = `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

function assertDiagnosticError(fn, code = "validation_error") {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error instanceof CodeClipYouTubeWebSubDiagnosticProbeError, true);
      assert.equal(error.code, code);
      assert.equal(/diag_|callbackSmoke123456|UCvwiNkgNuGuizjo33NZhzPg/.test(error.message), false);
      return true;
    }
  );
}

test("diagnostic probe and callback identities are explicit and bounded", () => {
  assert.equal(normalizeDiagnosticProbeId(PROBE_ID), PROBE_ID);
  assert.equal(normalizeDiagnosticCallbackId(CALLBACK_ID), CALLBACK_ID);

  for (const value of [
    "",
    "probeSmoke123",
    "diag_short",
    "diag_probe with space",
    "diag_probe\nwithControl",
    ` ${PROBE_ID}`,
    `${PROBE_ID} `,
    `diag_${"a".repeat(91)}`,
  ]) {
    assertDiagnosticError(() => normalizeDiagnosticProbeId(value));
  }

  for (const value of [
    "yt_callbackSmoke123456",
    "diag_yt_short",
    "diag_yt_callback/segment",
    "diag_yt_callback?query",
    "diag_yt_callback#fragment",
    `diag_yt_${"a".repeat(81)}`,
  ]) {
    assertDiagnosticError(() => normalizeDiagnosticCallbackId(value), "invalid_callback_id");
  }

  for (const value of [
    "",
    "diag_yt_callback\nwithControl",
    ` ${CALLBACK_ID}`,
    `${CALLBACK_ID} `,
  ]) {
    assertDiagnosticError(() => normalizeDiagnosticCallbackId(value));
  }

});

test("diagnostic channel ID validation is strict", () => {
  assert.equal(normalizeYouTubeDiagnosticChannelId(CHANNEL_ID), CHANNEL_ID);

  for (const value of [
    "",
    "UCshort",
    "notAChannelId",
    "UCvwiNkgNuGuizjo33NZhzPg!",
    ` ${CHANNEL_ID}`,
    `${CHANNEL_ID} `,
    "UCvwiNkgNuGuizjo33NZhzPg\n",
  ]) {
    assertDiagnosticError(() => normalizeYouTubeDiagnosticChannelId(value));
  }
});

test("diagnostic topic accepts only canonical YouTube feed topics for the expected channel", () => {
  assert.equal(normalizeYouTubeDiagnosticTopic(HTTPS_TOPIC, CHANNEL_ID), HTTPS_TOPIC);
  assert.equal(normalizeYouTubeDiagnosticTopic(HTTP_TOPIC, CHANNEL_ID), HTTP_TOPIC);

  const rejected = [
    `ftp://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://www.youtube.com/feed/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}&alt=json`,
    "https://www.youtube.com/feeds/videos.xml",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa",
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}#fragment`,
    `https://user:pass@www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://example.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    ` ${HTTPS_TOPIC}`,
    `${HTTPS_TOPIC} `,
  ];

  for (const topic of rejected) {
    assertDiagnosticError(() => normalizeYouTubeDiagnosticTopic(topic, CHANNEL_ID));
  }
});

test("diagnostic callback path preserves route prefix and rejects path injection", () => {
  assert.equal(
    buildDiagnosticCallbackPath(CALLBACK_ID),
    `${DIAGNOSTIC_CALLBACK_PATH_PREFIX}${CALLBACK_ID}`
  );

  for (const value of [
    "diag_yt_callback/segment123456",
    "diag_yt_callbackSmoke123456?x=1",
    "diag_yt_callbackSmoke123456#frag",
  ]) {
    assertDiagnosticError(() => buildDiagnosticCallbackPath(value), "invalid_callback_id");
  }
});

test("diagnostic identifier masking is deterministic and never returns the full identifier", () => {
  assert.equal(maskDiagnosticIdentifier(CALLBACK_ID), "diag_y...3456");
  assert.equal(maskDiagnosticIdentifier(PROBE_ID), "diag_p...e123");
  assert.equal(maskDiagnosticIdentifier("short"), "sh...");
  assert.equal(maskDiagnosticIdentifier(""), null);

  for (const value of [CALLBACK_ID, PROBE_ID, "short"]) {
    assert.notEqual(maskDiagnosticIdentifier(value), value);
  }
});

test("diagnostic validation errors expose stable public-safe contracts", () => {
  try {
    normalizeYouTubeDiagnosticTopic(
      "https://attacker.example/feeds/videos.xml?channel_id=secretCallbackValue",
      CHANNEL_ID
    );
    assert.fail("expected diagnostic validation error");
  } catch (error) {
    assert.equal(error instanceof CodeClipYouTubeWebSubDiagnosticProbeError, true);
    assert.equal(error.name, "CodeClipYouTubeWebSubDiagnosticProbeError");
    assert.equal(error.code, "validation_error");
    assert.deepEqual(error.details, { fieldName: "topic" });
    assert.equal(error.message.includes("attacker.example"), false);
    assert.equal(error.message.includes("secretCallbackValue"), false);
  }
});


function baseProbe(overrides = {}) {
  return {
    probeId: PROBE_ID,
    callbackId: CALLBACK_ID,
    provider: "youtube",
    channel: "youtube",
    channelId: CHANNEL_ID,
    topic: HTTP_TOPIC,
    status: "pending_subscribe",
    pendingMode: "subscribe",
    secretVersion: "v1",
    leaseExpiresAt: null,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    verifiedAt: null,
    firstVerifiedAt: null,
    lastNotificationAt: null,
    unsubscribedAt: null,
    cleanupRequired: false,
    subscriptionMayExist: false,
    failedOperation: null,
    failedReasonCode: null,
    diagnosticMetadata: {},
    ...overrides,
  };
}

test("diagnostic probe record validation enforces youtube scope and state consistency", () => {
  const normalized = normalizeDiagnosticProbeRecord(baseProbe());
  assert.equal(normalized.provider, "youtube");
  assert.equal(normalized.channel, "youtube");
  assert.equal(normalized.topic, HTTP_TOPIC);
  assert.equal(normalized.pendingMode, "subscribe");

  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ provider: "meta" })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ channel: "sms" })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ topic: HTTPS_TOPIC.replace(CHANNEL_ID, "UCaaaaaaaaaaaaaaaaaaaaaa") })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ createdAt: "not-a-date" })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ updatedAt: "2026-07-23 10:00" })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ status: "active", pendingMode: "subscribe" })), "invalid_probe_state");
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ status: "pending_unsubscribe", pendingMode: null })), "invalid_probe_state");
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({
    status: "pending_unsubscribe",
    pendingMode: "unsubscribe",
    verifiedAt: null,
    firstVerifiedAt: null,
  })), "invalid_probe_state");
  assert.equal(normalizeDiagnosticProbeRecord(baseProbe({
    status: "pending_unsubscribe",
    pendingMode: "unsubscribe",
    cleanupRequired: true,
    subscriptionMayExist: true,
  })).status, "pending_unsubscribe");
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({
    status: "failed",
    pendingMode: null,
  })), "invalid_probe_state");
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({ secret: "do-not-store" })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({
    diagnosticMetadata: { unsupported: true },
  })));
  assertDiagnosticError(() => normalizeDiagnosticProbeRecord(baseProbe({
    diagnosticMetadata: { lastDispatch: { authorization: "Bearer secret" } },
  })));
});

test("diagnostic lifecycle transitions are explicit and fail closed", () => {
  const pending = baseProbe();
  const active = applyDiagnosticVerificationTransition(pending, {
    verifiedAt: "2026-07-23T10:05:00.000Z",
    leaseSeconds: 600,
  });
  assert.equal(active.status, "active");
  assert.equal(active.pendingMode, null);
  assert.equal(active.verifiedAt, "2026-07-23T10:05:00.000Z");
  assert.equal(active.firstVerifiedAt, "2026-07-23T10:05:00.000Z");
  assert.equal(active.leaseExpiresAt, "2026-07-23T10:15:00.000Z");
  assert.equal(active.subscriptionMayExist, true);
  assert.equal(active.diagnosticMetadata.lastVerification.mode, "subscribe");

  const pendingUnsubscribe = applyDiagnosticUnsubscribeTransition(active, {
    requestedAt: "2026-07-23T10:06:00.000Z",
  });
  assert.equal(pendingUnsubscribe.status, "pending_unsubscribe");
  assert.equal(pendingUnsubscribe.pendingMode, "unsubscribe");
  assert.equal(pendingUnsubscribe.leaseExpiresAt, active.leaseExpiresAt);

  const unsubscribed = applyDiagnosticUnsubscribeTransition(pendingUnsubscribe, {
    confirmedAt: "2026-07-23T10:07:00.000Z",
  });
  assert.equal(unsubscribed.status, "unsubscribed");
  assert.equal(unsubscribed.pendingMode, null);
  assert.equal(unsubscribed.leaseExpiresAt, null);
  assert.equal(unsubscribed.unsubscribedAt, "2026-07-23T10:07:00.000Z");
  assert.equal(isDiagnosticProbeTerminal(unsubscribed), true);
  assert.deepEqual(applyDiagnosticUnsubscribeTransition(unsubscribed, { requestedAt: "2026-07-23T10:08:00.000Z" }), unsubscribed);

  const failed = applyDiagnosticDispatchFailureTransition(baseProbe(), {
    failedAt: "2026-07-23T10:09:00.000Z",
    failedOperation: "subscribe",
    failedReasonCode: "hub_request_failed",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.pendingMode, null);
  assert.equal(failed.cleanupRequired, false);
  assert.equal(failed.subscriptionMayExist, false);
  assert.equal(isDiagnosticProbeTerminal(failed), true);
  assert.equal(failed.failedOperation, "subscribe");
  assert.equal(failed.failedReasonCode, "hub_request_failed");
  assert.equal(failed.diagnosticMetadata.lastFailure.reasonCode, "hub_request_failed");

  const duplicateVerification = applyDiagnosticVerificationTransition(active, {
    verifiedAt: "2026-07-23T10:04:00.000Z",
    leaseSeconds: 300,
  });
  assert.equal(duplicateVerification.verifiedAt, active.verifiedAt);
  assert.equal(duplicateVerification.firstVerifiedAt, active.firstVerifiedAt);
  assert.equal(duplicateVerification.leaseExpiresAt, active.leaseExpiresAt);

  const newerVerification = applyDiagnosticVerificationTransition(active, {
    verifiedAt: "2026-07-23T10:12:00.000Z",
    leaseSeconds: 900,
  });
  assert.equal(newerVerification.verifiedAt, "2026-07-23T10:12:00.000Z");
  assert.equal(newerVerification.firstVerifiedAt, active.firstVerifiedAt);
  assert.equal(newerVerification.leaseExpiresAt, "2026-07-23T10:27:00.000Z");
  assertDiagnosticError(() => applyDiagnosticVerificationTransition(unsubscribed, {
    verifiedAt: "2026-07-23T10:10:00.000Z",
    leaseSeconds: 600,
  }), "invalid_probe_transition");
  assertDiagnosticError(() => assertDiagnosticProbeTransition(active, "unsubscribed"), "invalid_probe_transition");
});

test("diagnostic failed state is terminal unless explicit cleanup risk exists", () => {
  const failedNoRisk = applyDiagnosticDispatchFailureTransition(baseProbe(), {
    failedAt: "2026-07-23T10:09:00.000Z",
    failedOperation: "subscribe",
    failedReasonCode: "hub_request_failed",
  });
  assert.equal(isDiagnosticProbeTerminal(failedNoRisk), true);
  assertDiagnosticError(() => applyDiagnosticUnsubscribeTransition(failedNoRisk, {
    requestedAt: "2026-07-23T10:10:00.000Z",
  }), "invalid_probe_transition");

  const failedWithRisk = applyDiagnosticDispatchFailureTransition(baseProbe(), {
    failedAt: "2026-07-23T10:09:00.000Z",
    failedOperation: "subscribe",
    failedReasonCode: "hub_request_accepted_without_callback",
    subscriptionMayExist: true,
    cleanupRequired: true,
  });
  assert.equal(isDiagnosticProbeTerminal(failedWithRisk), false);
  const pendingCleanup = applyDiagnosticUnsubscribeTransition(failedWithRisk, {
    requestedAt: "2026-07-23T10:10:00.000Z",
  });
  assert.equal(pendingCleanup.status, "pending_unsubscribe");
  assert.equal(pendingCleanup.pendingMode, "unsubscribe");
  assert.equal(pendingCleanup.verifiedAt, null);
  assert.equal(pendingCleanup.cleanupRequired, true);
  assert.equal(pendingCleanup.subscriptionMayExist, true);
  assert.equal(pendingCleanup.failedOperation, "subscribe");

  const cleaned = applyDiagnosticUnsubscribeTransition(pendingCleanup, {
    confirmedAt: "2026-07-23T10:11:00.000Z",
  });
  assert.equal(cleaned.status, "unsubscribed");
  assert.equal(cleaned.cleanupRequired, false);
  assert.equal(cleaned.subscriptionMayExist, false);
  assert.equal(cleaned.unsubscribedAt, "2026-07-23T10:11:00.000Z");
  assert.deepEqual(applyDiagnosticUnsubscribeTransition(cleaned, {
    confirmedAt: "2026-07-23T10:12:00.000Z",
  }), cleaned);
});

test("diagnostic notification observation updates only diagnostic metadata", () => {
  const active = applyDiagnosticVerificationTransition(baseProbe(), {
    verifiedAt: "2026-07-23T10:05:00.000Z",
    leaseSeconds: 600,
  });
  const observed = applyDiagnosticNotificationObservation(active, {
    channelId: CHANNEL_ID,
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:26:00.000Z",
    titleHash: "abcdef1234567890",
  });

  assert.equal(observed.status, "active");
  assert.equal(observed.pendingMode, null);
  assert.equal(observed.leaseExpiresAt, active.leaseExpiresAt);
  assert.equal(observed.lastNotificationAt, "2026-07-23T11:26:00.000Z");
  assert.equal(observed.diagnosticMetadata.lastNotification.videoId, "Q8yMXHgVtxc");
  assert.equal(observed.diagnosticMetadata.lastNotification.observationIdentity, "youtube:UCvwiNkgNuGuizjo33NZhzPg:Q8yMXHgVtxc:published:2026-07-23T11:24:51.000Z");
  assert.equal(observed.diagnosticMetadata.lastNotification.duplicate, false);
  assert.equal(buildDiagnosticObservationIdentity({
    channelId: CHANNEL_ID,
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
  }), observed.diagnosticMetadata.lastNotification.observationIdentity);

  const duplicate = applyDiagnosticNotificationObservation(observed, {
    channelId: CHANNEL_ID,
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:27:00.000Z",
  });
  assert.equal(duplicate.status, "active");
  assert.equal(duplicate.lastNotificationAt, "2026-07-23T11:27:00.000Z");
  assert.equal(duplicate.diagnosticMetadata.lastNotification.duplicate, true);

  const olderDuplicate = applyDiagnosticNotificationObservation(duplicate, {
    channelId: CHANNEL_ID,
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:20:00.000Z",
  });
  assert.equal(olderDuplicate.lastNotificationAt, duplicate.lastNotificationAt);

  assertDiagnosticError(() => applyDiagnosticNotificationObservation(active, {
    channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:26:00.000Z",
  }));
  assertDiagnosticError(() => applyDiagnosticNotificationObservation(active, {
    channelId: CHANNEL_ID,
    videoId: "bad video id",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:26:00.000Z",
  }));
  assertDiagnosticError(() => applyDiagnosticNotificationObservation(baseProbe(), {
    channelId: CHANNEL_ID,
    videoId: "Q8yMXHgVtxc",
    publishedAt: "2026-07-23T11:24:51.000Z",
    updatedAt: "2026-07-23T11:25:32.000Z",
    observedAt: "2026-07-23T11:26:00.000Z",
  }), "invalid_probe_transition");
});

test("diagnostic public serializer masks identities and excludes secret data", () => {
  const active = applyDiagnosticNotificationObservation(
    applyDiagnosticVerificationTransition(baseProbe({ secretVersion: "v1" }), {
      verifiedAt: "2026-07-23T10:05:00.000Z",
      leaseSeconds: 600,
    }),
    {
      channelId: CHANNEL_ID,
      videoId: "Q8yMXHgVtxc",
      publishedAt: "2026-07-23T11:24:51.000Z",
      updatedAt: "2026-07-23T11:25:32.000Z",
      observedAt: "2026-07-23T11:26:00.000Z",
      titleHash: "abcdef1234567890",
    }
  );
  const serialized = serializeDiagnosticProbePublic(active);
  assert.equal(serialized.probeId, "diag_p...e123");
  assert.equal(serialized.callbackId, "diag_y...3456");
  assert.equal(serialized.channelId, CHANNEL_ID);
  assert.equal(serialized.topic, HTTP_TOPIC);
  assert.equal(serialized.status, "active");
  assert.equal(serialized.pendingMode, null);
  assert.equal(serialized.cleanupRequired, false);
  assert.equal(serialized.subscriptionMayExist, true);
  assert.equal(serialized.firstVerifiedAt, "2026-07-23T10:05:00.000Z");
  assert.equal(serialized.notification.videoId, "Q8yMXH...Vtxc");
  assert.equal(serialized.notification.observationIdentity, "youtub...000Z");
  assert.equal(JSON.stringify(serialized).includes(CALLBACK_ID), false);
  assert.equal(JSON.stringify(serialized).includes(PROBE_ID), false);
  assert.equal(JSON.stringify(serialized).includes("secretVersion"), false);
  assert.equal(JSON.stringify(serialized).includes("v1"), false);
});
