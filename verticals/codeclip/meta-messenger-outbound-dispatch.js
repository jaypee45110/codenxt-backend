/**
 * B11.2E Meta Messenger Outbound Dispatch Orchestration
 *
 * One invocation = one outboundId.
 * Uses B11.2C claim/record and B11.2D Graph transport.
 * Not a worker, scheduler, scanner, or retry loop.
 *
 * claimDisposition:
 *   "claimed" | "existing" | "not_acquired"
 *
 * attemptNumber is present only when claimDisposition is claimed|existing.
 */

const {
  claimCodeClipMetaMessengerOutboundDispatch,
  recordCodeClipMetaMessengerOutboundDispatchResult,
} = require("./meta-messenger-outbound-repository");
const {
  buildMetaMessengerGraphSendRequest,
  executeMetaMessengerGraphSend,
} = require("./meta-messenger-graph-transport");

const FAILURE_METADATA_ALLOWLIST = new Set([
  "httpStatus",
  "metaErrorCode",
  "metaErrorSubcode",
  "metaErrorType",
  "metaIsTransient",
  "fbtraceId",
  "retryAfterSeconds",
  "durationMs",
  "transportFailureCode",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeFailureCode(value, fallback = "orchestration_failed") {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
  if (!normalized) return fallback;
  return normalized.slice(0, 120);
}

function baseResult(partial = {}) {
  return {
    ok: false,
    outcome: "failed",
    claimDisposition: "not_acquired",
    outboundId: null,
    attemptId: null,
    providerAccepted: false,
    dispatchRecorded: false,
    retryable: false,
    manualReviewRequired: false,
    providerMessageId: null,
    failureCode: null,
    ...partial,
  };
}

function withAttemptNumber(result, attemptNumber) {
  return {
    ...result,
    attemptNumber,
  };
}

function pickAllowlistedFailureMetadata(safeMetadata = {}, failureCode = null) {
  const source =
    safeMetadata && typeof safeMetadata === "object" && !Array.isArray(safeMetadata)
      ? safeMetadata
      : {};
  const out = {};
  for (const key of FAILURE_METADATA_ALLOWLIST) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = source[key];
    }
  }
  if (failureCode) {
    out.transportFailureCode = failureCode;
  }
  if (Number.isFinite(Number(source.httpStatus))) {
    out.httpStatus = Number(source.httpStatus);
  }
  return out;
}

/**
 * Pure mapper: transport result → B11.2C record payload fields.
 * Never includes providerMessageId.
 */
function mapMetaMessengerTransportResultToDispatchRecord(transportResult = {}) {
  const outcome = normalizeString(transportResult.outcome).toLowerCase();
  if (outcome === "sent") {
    return { outcome: "sent" };
  }

  const failureCode = normalizeFailureCode(
    transportResult.failureCode || "graph_transport_failed"
  );
  const safeMetadata = transportResult.safeMetadata || {};
  const httpStatus = Number(transportResult.httpStatus);
  const metadata = pickAllowlistedFailureMetadata(
    {
      ...safeMetadata,
      httpStatus: Number.isFinite(httpStatus) ? httpStatus : safeMetadata.httpStatus,
    },
    failureCode
  );

  if (outcome === "retryable_failed") {
    return {
      outcome: "retryable_failed",
      failureCode,
      failureMetadata: metadata,
    };
  }

  return {
    outcome: "terminal_failed",
    failureCode,
    failureMetadata: metadata,
  };
}

function resolveClaimDisposition(claimResult) {
  if (claimResult && claimResult.ok === true && claimResult.status === "claimed") {
    return "claimed";
  }
  if (claimResult && claimResult.ok === true && claimResult.status === "existing") {
    return "existing";
  }
  return "not_acquired";
}

async function recordOwnedResult({
  recordDispatchResult,
  queryClient,
  outboundId,
  attemptId,
  attemptNumber,
  outcome,
  failureCode,
  failureMetadata,
  now,
}) {
  const payload = {
    outboundId,
    attemptId,
    attemptNumber,
    outcome,
    now,
  };
  if (outcome !== "sent") {
    payload.failureCode = failureCode;
    if (failureMetadata && Object.keys(failureMetadata).length > 0) {
      payload.failureMetadata = failureMetadata;
    }
  }
  // Never pass providerMessageId to B11.2C.
  return recordDispatchResult(payload, queryClient);
}

/**
 * Dispatch one Meta Messenger outbound through claim → credentials → transport → record.
 */
async function dispatchCodeClipMetaMessengerOutbound({
  outboundId,
  attemptId,
  staleAfterSeconds,
  queryClient,
  resolvePageAccessCredentials,
  fetchImpl,
  now,
  timeoutMs,
  claimDispatch = claimCodeClipMetaMessengerOutboundDispatch,
  recordDispatchResult = recordCodeClipMetaMessengerOutboundDispatchResult,
  buildRequest = buildMetaMessengerGraphSendRequest,
  executeSend = executeMetaMessengerGraphSend,
} = {}) {
  const normalizedOutboundId = Number(outboundId);
  const normalizedAttemptId = normalizeString(attemptId);

  if (!Number.isInteger(normalizedOutboundId) || normalizedOutboundId <= 0) {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      failureCode: "outbound_id_invalid",
      attemptId: normalizedAttemptId || null,
    });
  }
  if (!normalizedAttemptId) {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      failureCode: "attempt_id_required",
    });
  }
  if (!queryClient) {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: "query_client_required",
    });
  }
  if (typeof resolvePageAccessCredentials !== "function") {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: "credentials_resolver_required",
    });
  }
  if (typeof claimDispatch !== "function" || typeof recordDispatchResult !== "function") {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: "dispatch_dependencies_required",
    });
  }

  let claimResult;
  try {
    claimResult = await claimDispatch(
      {
        outboundId: normalizedOutboundId,
        attemptId: normalizedAttemptId,
        staleAfterSeconds,
        now,
      },
      queryClient
    );
  } catch {
    return baseResult({
      outcome: "failed",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: "claim_failed",
    });
  }

  const claimDisposition = resolveClaimDisposition(claimResult);
  if (claimDisposition === "not_acquired") {
    return baseResult({
      outcome: "claim_conflict",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: normalizeFailureCode(claimResult?.reason, "claim_conflict"),
      retryable: false,
      row: claimResult?.row || null,
    });
  }

  const row = claimResult.row;
  const attemptNumber = Number(row?.attemptCount);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    return baseResult({
      outcome: "claim_conflict",
      claimDisposition: "not_acquired",
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      failureCode: "claim_attempt_number_invalid",
    });
  }

  const ownedBase = {
    claimDisposition,
    outboundId: normalizedOutboundId,
    attemptId: normalizedAttemptId,
  };

  // --- Credentials ---
  let credentials;
  try {
    credentials = await resolvePageAccessCredentials({
      providerAccountId: row.providerAccountId,
      bindingId: row.bindingId || null,
      outboundId: normalizedOutboundId,
    });
  } catch {
    const recorded = await recordOwnedResult({
      recordDispatchResult,
      queryClient,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      attemptNumber,
      outcome: "retryable_failed",
      failureCode: "credentials_resolver_error",
      failureMetadata: {},
      now,
    });
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          outcome: "credentials_failed",
          failureCode: "credentials_resolver_error",
          retryable: true,
          dispatchRecorded: Boolean(recorded?.ok && (recorded.recorded || recorded.existing)),
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  if (!credentials || credentials.ok !== true) {
    const retryable = credentials?.retryable === true;
    const failureCode = normalizeFailureCode(
      credentials?.reason || "credentials_unavailable",
      "credentials_unavailable"
    );
    const outcome = retryable ? "retryable_failed" : "terminal_failed";
    const recorded = await recordOwnedResult({
      recordDispatchResult,
      queryClient,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      attemptNumber,
      outcome,
      failureCode,
      failureMetadata: {},
      now,
    });
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          outcome: "credentials_failed",
          failureCode,
          retryable,
          dispatchRecorded: Boolean(recorded?.ok && (recorded.recorded || recorded.existing)),
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  const pageAccessToken =
    typeof credentials.pageAccessToken === "string" ? credentials.pageAccessToken.trim() : "";
  const graphApiVersion = normalizeString(credentials.graphApiVersion);
  if (!pageAccessToken) {
    const recorded = await recordOwnedResult({
      recordDispatchResult,
      queryClient,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      attemptNumber,
      outcome: "terminal_failed",
      failureCode: "credentials_unavailable",
      failureMetadata: {},
      now,
    });
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          outcome: "credentials_failed",
          failureCode: "credentials_unavailable",
          retryable: false,
          dispatchRecorded: Boolean(recorded?.ok && (recorded.recorded || recorded.existing)),
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  // --- Build request (B11.2D) ---
  const built = buildRequest({
    providerAccountId: row.providerAccountId,
    recipientId: row.recipientId,
    deliverable: row.deliverable,
    graphApiVersion,
    timeoutMs,
  });

  if (!built?.ok) {
    const failureCode = normalizeFailureCode(built?.reason, "builder_failed");
    const recorded = await recordOwnedResult({
      recordDispatchResult,
      queryClient,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      attemptNumber,
      outcome: "terminal_failed",
      failureCode,
      failureMetadata: {},
      now,
    });
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          outcome: "builder_failed",
          failureCode,
          retryable: false,
          dispatchRecorded: Boolean(recorded?.ok && (recorded.recorded || recorded.existing)),
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  // --- Execute exactly one Graph attempt (B11.2D) ---
  let transportResult;
  try {
    transportResult = await executeSend({
      request: built.request,
      pageAccessToken,
      fetchImpl,
      timeoutMs,
    });
  } catch {
    transportResult = {
      ok: false,
      outcome: "retryable_failed",
      httpStatus: 0,
      providerMessageId: null,
      retryable: true,
      terminal: false,
      failureCode: "graph_network_error",
      safeMetadata: {},
    };
  }

  const mapped = mapMetaMessengerTransportResultToDispatchRecord(transportResult);
  const providerAccepted = transportResult?.ok === true && transportResult?.outcome === "sent";
  const providerMessageId =
    providerAccepted && typeof transportResult.providerMessageId === "string"
      ? transportResult.providerMessageId.trim() || null
      : null;

  // --- Record attempt-bound result (B11.2C) ---
  let recorded;
  try {
    recorded = await recordOwnedResult({
      recordDispatchResult,
      queryClient,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      attemptNumber,
      outcome: mapped.outcome,
      failureCode: mapped.failureCode,
      failureMetadata: mapped.failureMetadata,
      now,
    });
  } catch {
    recorded = {
      ok: false,
      status: "failed",
      reason: "RECORD_FAILED",
    };
  }

  if (providerAccepted && !(recorded?.ok && (recorded.recorded || recorded.existing))) {
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          ok: false,
          outcome: "provider_sent_record_unconfirmed",
          providerAccepted: true,
          dispatchRecorded: false,
          retryable: false,
          manualReviewRequired: true,
          providerMessageId,
          failureCode: normalizeFailureCode(recorded?.reason, "dispatch_record_unconfirmed"),
          record: {
            ok: false,
            status: recorded?.status || "failed",
            reason: recorded?.reason || null,
          },
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  if (!recorded?.ok) {
    return withAttemptNumber(
      {
        ...baseResult({
          ...ownedBase,
          outcome: "record_conflict",
          providerAccepted,
          dispatchRecorded: false,
          retryable: false,
          manualReviewRequired: providerAccepted,
          providerMessageId,
          failureCode: normalizeFailureCode(recorded?.reason, "record_conflict"),
          record: {
            ok: false,
            status: recorded?.status || "conflict",
            reason: recorded?.reason || null,
          },
          row: recorded?.row || row,
        }),
      },
      attemptNumber
    );
  }

  if (mapped.outcome === "sent") {
    return withAttemptNumber(
      {
        ok: true,
        outcome: "sent",
        claimDisposition,
        outboundId: normalizedOutboundId,
        attemptId: normalizedAttemptId,
        providerAccepted: true,
        dispatchRecorded: true,
        retryable: false,
        manualReviewRequired: false,
        providerMessageId,
        failureCode: null,
        record: {
          ok: true,
          status: recorded.status,
          recorded: Boolean(recorded.recorded),
          existing: Boolean(recorded.existing),
        },
        row: recorded.row || row,
      },
      attemptNumber
    );
  }

  return withAttemptNumber(
    {
      ok: false,
      outcome: mapped.outcome,
      claimDisposition,
      outboundId: normalizedOutboundId,
      attemptId: normalizedAttemptId,
      providerAccepted: false,
      dispatchRecorded: true,
      retryable: mapped.outcome === "retryable_failed",
      manualReviewRequired: false,
      providerMessageId: null,
      failureCode: mapped.failureCode || null,
      record: {
        ok: true,
        status: recorded.status,
        recorded: Boolean(recorded.recorded),
        existing: Boolean(recorded.existing),
      },
      row: recorded.row || row,
    },
    attemptNumber
  );
}

module.exports = {
  dispatchCodeClipMetaMessengerOutbound,
  mapMetaMessengerTransportResultToDispatchRecord,
};
