function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeRequestedVertical(value) {
  const requestedVertical = normalizeString(value).toLowerCase();
  return requestedVertical || "codepod";
}

function normalizeCodePodScanAudienceEntry(input = {}) {
  const entryCode = normalizeString(input.eventCode || input.entryCode);
  const scanId = normalizeString(input.scanId);
  const warnings = [];

  if (!entryCode) {
    return {
      ok: false,
      audienceEntry: null,
      audienceIntent: null,
      warnings,
      errors: [
        {
          code: "ENTRY_CODE_REQUIRED",
          message: "entryCode is required",
        },
      ],
    };
  }

  if (!scanId) {
    warnings.push({
      code: "SCAN_ID_MISSING",
      message: "scanId is missing",
    });
  }

  const audienceEntry = {
    entryCode,
    eventCode: entryCode,
    requestedVertical: normalizeRequestedVertical(input.requestedVertical),
    source: "scan",
    transport: "http",
    metadata: {
      vertical: "codepod",
    },
  };

  const eventId = normalizeString(input.eventId);
  const receivedAt = normalizeString(input.receivedAt);

  if (eventId) audienceEntry.eventId = eventId;
  if (scanId) audienceEntry.scanId = scanId;
  if (receivedAt) audienceEntry.receivedAt = receivedAt;

  const audienceIntent = {
    vertical: "codepod",
    intentType: "scan",
    entryCode,
    eventCode: entryCode,
    source: "scan",
    transport: "http",
  };

  if (scanId) audienceIntent.scanId = scanId;

  return {
    ok: true,
    audienceEntry,
    audienceIntent,
    warnings,
    errors: [],
  };
}

function createCodePodInteractionSnapshot(input = {}) {
  const eventCode = normalizeString(input.eventCode);

  if (!eventCode) return null;

  return {
    interactionId: null,
    vertical: "codepod",
    interactionType: "scan",
    eventCode,
    eventId: normalizeString(input.eventId),
    scanId: normalizeString(input.scanId),
    rawScans: input.rawScans,
    uniqueScans: input.uniqueScans,
    scanRank: input.scanRank,
    audienceEntry: input.audienceEntry || null,
    audienceIntent: input.audienceIntent || null,
    state: "observed",
    stateTransitions: [],
    tier: normalizeString(input.tier),
    timestamp: input.timestamp || new Date().toISOString(),
    routingOutcome: "MATCH",
  };
}

module.exports = {
  createCodePodInteractionSnapshot,
  normalizeCodePodScanAudienceEntry,
};
