const INTERACTION_STATES = {
  RECEIVED: "received",
  ROUTED: "routed",
  REWARD_ASSIGNED: "reward_assigned",
  PROCESSED: "processed",
  UNMATCHED: "unmatched",
  EXPIRED: "expired",
};

const INTERACTION_TRANSITIONS = {
  RECEIVE: "receive",
  ROUTE_MATCH: "route_match",
  NO_CAMPAIGN_MATCH: "no_campaign_match",
  ASSIGN_REWARD: "assign_reward",
  COMPLETE: "complete",
  EXPIRE: "expire",
};

const {
  normalizeActivationChannels,
  readActivationValue,
} = require("./provider-activation");

const INTERACTION_STATE_MACHINE = {
  transitions: [
    {
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    },
    {
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.UNMATCHED,
      transition: INTERACTION_TRANSITIONS.NO_CAMPAIGN_MATCH,
    },
    {
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.ROUTED,
      transition: INTERACTION_TRANSITIONS.ROUTE_MATCH,
    },
    {
      from: INTERACTION_STATES.ROUTED,
      to: INTERACTION_STATES.REWARD_ASSIGNED,
      transition: INTERACTION_TRANSITIONS.ASSIGN_REWARD,
    },
    {
      from: INTERACTION_STATES.REWARD_ASSIGNED,
      to: INTERACTION_STATES.PROCESSED,
      transition: INTERACTION_TRANSITIONS.COMPLETE,
    },
  ],
};

const PROVIDER_EVENT_INTERACTION_STATE_MACHINE = {
  transitions: [
    {
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    },
    {
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.ROUTED,
      transition: INTERACTION_TRANSITIONS.ROUTE_MATCH,
    },
    {
      from: INTERACTION_STATES.ROUTED,
      to: INTERACTION_STATES.PROCESSED,
      transition: INTERACTION_TRANSITIONS.COMPLETE,
    },
  ],
};

const REWARD_ASSIGNMENT_STATES = {
  ASSIGNED: "assigned",
};

const REDEMPTION_STATES = {
  NOT_FOUND: "not_found",
  REDEEMED: "redeemed",
  ALREADY_REDEEMED: "already_redeemed",
};

const CODECLIP_FAILURE_REASONS = {
  BONUS_WINDOW_EXPIRED: "bonus_window_expired",
};

const KNOWN_REQUESTED_VERTICALS = new Set([
  "codeclip",
  "codepod",
  "codeperks",
  "codedemo",
  "codetone",
]);

async function validateClipXtraToken({
  token,
  redis,
  getCodeClipXtraRedemptionByToken,
  codeClipVertical,
}) {
  const postgresClipXtra = await getCodeClipXtraRedemptionByToken(token);
  if (postgresClipXtra) {
    return {
      found: true,
      payload: codeClipVertical.validation.buildCodeClipXtraValidationPayload(postgresClipXtra),
    };
  }

  if (redis) {
    const rawClipXtra = await redis.get(codeClipVertical.tokens.buildCodeClipXtraTokenKey(token));
    const clipXtra = rawClipXtra ? JSON.parse(rawClipXtra) : null;

    if (clipXtra) {
      return {
        found: true,
        payload: codeClipVertical.validation.buildCodeClipXtraValidationPayload(clipXtra),
      };
    }
  }

  return {
    found: false,
    payload: {
      ok: false,
      status: REDEMPTION_STATES.NOT_FOUND,
    },
  };
}

async function redeemClipXtraToken({
  token,
  redeemedBy,
  redis,
  redeemCodeClipXtraRedemption,
  getCodeClipXtraRedemptionByToken,
  codeClipVertical,
}) {
  const result = await redeemCodeClipXtraRedemption(token, redeemedBy);
  const row = result.row;

  if (result.status === REDEMPTION_STATES.NOT_FOUND || !row) {
    if (redis) {
      const tokenKey = codeClipVertical.tokens.buildCodeClipXtraTokenKey(token);
      const rawClipXtra = await redis.get(tokenKey);
      const clipXtra = rawClipXtra ? JSON.parse(rawClipXtra) : null;

      if (clipXtra) {
        if (clipXtra.redeemedAt || clipXtra.status === REDEMPTION_STATES.REDEEMED) {
          const attempts = Number(clipXtra.alreadyRedeemedAttempts || 0) + 1;
          const updated = {
            ...clipXtra,
            status: REDEMPTION_STATES.REDEEMED,
            alreadyRedeemedAttempts: attempts,
          };
          await redis.set(tokenKey, JSON.stringify(updated));

          return {
            httpStatus: 409,
            payload: {
              ok: false,
              status: REDEMPTION_STATES.ALREADY_REDEEMED,
              redeemedAt: updated.redeemedAt || null,
            },
          };
        }

        const redeemedAt = new Date().toISOString();
        const updated = {
          ...clipXtra,
          status: REDEMPTION_STATES.REDEEMED,
          redeemedAt,
          redeemedBy: String(redeemedBy || "partner").trim() || "partner",
        };
        await redis.set(tokenKey, JSON.stringify(updated));

        return {
          httpStatus: 200,
          payload: {
            ...codeClipVertical.validation.buildCodeClipXtraValidationPayload(updated),
            ok: true,
            status: REDEMPTION_STATES.REDEEMED,
            redeemed: true,
            redeemedAt,
          },
        };
      }
    }

    return {
      httpStatus: 404,
      payload: {
        ok: false,
        status: REDEMPTION_STATES.NOT_FOUND,
      },
    };
  }

  if (result.status === REDEMPTION_STATES.ALREADY_REDEEMED) {
    const refreshedRow = await getCodeClipXtraRedemptionByToken(token);

    return {
      httpStatus: 409,
      payload: {
        ok: false,
        status: REDEMPTION_STATES.ALREADY_REDEEMED,
        redeemedAt: (refreshedRow || row).redeemed_at || null,
      },
    };
  }

  return {
    httpStatus: 200,
    payload: {
      ...codeClipVertical.validation.buildCodeClipXtraValidationPayload(row),
      ok: true,
      status: REDEMPTION_STATES.REDEEMED,
    },
  };
}

function buildInteractionContext({
  event,
  eventCode,
  eventId,
  scanId,
  rawScans,
  uniqueScans,
  scanRank,
  audienceEntry,
  audienceIntent = null,
}) {
  return {
    event,
    eventCode,
    eventId,
    scanId,
    rawScans,
    uniqueScans,
    scanRank,
    audienceEntry: createAudienceEntrySnapshot(audienceEntry),
    audienceIntent: audienceIntent || createAudienceIntentSnapshot(audienceEntry),
  };
}

function createAudienceEntrySnapshot(audienceEntry = null) {
  if (!audienceEntry) return null;

  const snapshot = {
    entryCode: audienceEntry.entryCode,
    requestedVertical: audienceEntry.requestedVertical,
    source: audienceEntry.source,
    transport: audienceEntry.transport,
    receivedAt: audienceEntry.receivedAt,
  };

  if (audienceEntry.scanId !== undefined) snapshot.scanId = audienceEntry.scanId;
  if (audienceEntry.keyword !== undefined) snapshot.keyword = audienceEntry.keyword;

  return snapshot;
}

function createAudienceIntentSnapshot(audienceEntry = null) {
  if (!audienceEntry) return null;

  return {
    type: "scan",
    entryCode: audienceEntry.entryCode,
    scanId: audienceEntry.scanId,
    requestedVertical: audienceEntry.requestedVertical,
    source: "scan",
    transport: "http",
  };
}

function normalizeScanAudienceEntry(input = {}) {
  const entryCode = String(input.entryCode || "").trim();
  const errors = [];
  const warnings = [];

  if (!entryCode) {
    return {
      ok: false,
      audienceEntry: null,
      audienceIntent: null,
      warnings,
      errors: [{ code: "ENTRY_CODE_REQUIRED" }],
    };
  }

  const scanId = String(input.scanId || "").trim();
  const requestedVertical = String(input.requestedVertical || "").trim().toLowerCase();

  if (!scanId) {
    warnings.push({ code: "SCAN_ID_MISSING" });
  }

  if (requestedVertical && !KNOWN_REQUESTED_VERTICALS.has(requestedVertical)) {
    warnings.push({ code: "UNKNOWN_VERTICAL" });
  }

  const audienceEntry = {
    entryCode,
    scanId,
    requestedVertical,
    source: "scan",
    transport: "http",
    receivedAt: input.receivedAt || new Date().toISOString(),
  };

  return {
    ok: true,
    audienceEntry,
    audienceIntent: createAudienceIntentSnapshot(audienceEntry),
    warnings,
    errors,
  };
}

function createKeywordAudienceIntentSnapshot(audienceEntry = null) {
  if (!audienceEntry) return null;

  return {
    type: "keyword",
    entryCode: audienceEntry.entryCode,
    keyword: audienceEntry.keyword,
    requestedVertical: audienceEntry.requestedVertical,
    source: "keyword",
    transport: "message",
  };
}

function normalizeKeywordAudienceEntry(input = {}) {
  const entryCode = String(input.entryCode || "").trim();
  const keyword = String(input.keyword || "").trim();
  const errors = [];
  const warnings = [];

  if (!entryCode) {
    errors.push({ code: "ENTRY_CODE_REQUIRED" });
  }

  if (!keyword) {
    errors.push({ code: "KEYWORD_REQUIRED" });
  }

  if (errors.length) {
    return {
      ok: false,
      audienceEntry: null,
      audienceIntent: null,
      warnings,
      errors,
    };
  }

  const requestedVertical = String(input.requestedVertical || "").trim().toLowerCase();

  if (requestedVertical && !KNOWN_REQUESTED_VERTICALS.has(requestedVertical)) {
    warnings.push({ code: "UNKNOWN_VERTICAL" });
  }

  const audienceEntry = {
    entryCode,
    keyword,
    requestedVertical,
    source: "keyword",
    transport: "message",
    receivedAt: input.receivedAt || new Date().toISOString(),
  };

  return {
    ok: true,
    audienceEntry,
    audienceIntent: createKeywordAudienceIntentSnapshot(audienceEntry),
    warnings,
    errors,
  };
}

const AUDIENCE_ENTRY_ADAPTERS = {
  scan: normalizeScanAudienceEntry,
  keyword: normalizeKeywordAudienceEntry,
};

function normalizeAudienceEntry(entryType, input = {}) {
  const normalizedEntryType = String(entryType || "").trim().toLowerCase();

  if (!normalizedEntryType) {
    return {
      ok: false,
      audienceEntry: null,
      audienceIntent: null,
      warnings: [],
      errors: [{ code: "ENTRY_TYPE_REQUIRED" }],
    };
  }

  const adapter = AUDIENCE_ENTRY_ADAPTERS[normalizedEntryType];

  if (!adapter) {
    return {
      ok: false,
      audienceEntry: null,
      audienceIntent: null,
      warnings: [],
      errors: [{ code: "ENTRY_ADAPTER_NOT_FOUND" }],
    };
  }

  return adapter(input);
}

function buildInteractionResult(httpStatus, payload, internal = {}) {
  return {
    httpStatus,
    payload,
    internal,
  };
}

const ROUTING_OUTCOMES = {
  MATCH: "MATCH",
  NO_CAMPAIGN_MATCH: "NO_CAMPAIGN_MATCH",
  ROUTING_CONFLICT: "ROUTING_CONFLICT",
};

function createRoutingOutcome({
  outcome,
  interactionContext,
  reason = null,
  candidates = [],
}) {
  const routingOutcome = {
    outcome,
    interactionContext,
  };

  if (reason) routingOutcome.reason = reason;
  if (candidates.length) routingOutcome.candidates = candidates;

  return routingOutcome;
}

function buildRoutingMatch(interactionContext) {
  return createRoutingOutcome({
    outcome: ROUTING_OUTCOMES.MATCH,
    interactionContext,
  });
}

function sanitizeRoutingCandidate(candidate = {}) {
  return {
    eventCode: String(candidate.eventCode || candidate.code || "").trim(),
    eventId: candidate.eventId || candidate.id || null,
    vertical: String(candidate.vertical || "").trim().toLowerCase(),
    activationMethod: String(candidate.activationMethod || "").trim(),
    activationKeyword: String(candidate.activationKeyword || "").trim(),
    activationChannels: Array.isArray(candidate.activationChannels)
      ? candidate.activationChannels.map((channel) => String(channel || "").trim()).filter(Boolean)
      : [],
  };
}

function buildNoCampaignMatchInteraction({
  eventCode,
  scanId,
  audienceEntry,
}) {
  const audienceEntrySnapshot = createAudienceEntrySnapshot(audienceEntry);
  const interactionContext = {
    eventCode,
    eventId: null,
    audienceEntry: audienceEntrySnapshot,
  };
  const routingOutcome = createRoutingOutcome({
    outcome: ROUTING_OUTCOMES.NO_CAMPAIGN_MATCH,
    interactionContext,
    reason: "event_not_found",
  });
  const interactionState = buildInteractionStateSnapshot([
    buildValidInteractionStateTransition({
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    }),
    buildValidInteractionStateTransition({
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.UNMATCHED,
      transition: INTERACTION_TRANSITIONS.NO_CAMPAIGN_MATCH,
    }),
  ], INTERACTION_STATES.UNMATCHED);

  return {
    interactionId: null,
    eventCode,
    eventId: null,
    scanId,
    audienceEntry: audienceEntrySnapshot,
    audienceIntent: createAudienceIntentSnapshot(audienceEntry),
    audienceContext: createAudienceContextSnapshot(interactionContext, {
      vertical: null,
      activationMethod: "",
      activationKeyword: "",
      activationChannels: [],
      rewards: {},
    }),
    state: interactionState.state,
    stateTransitions: interactionState.transitions,
    timestamp: new Date().toISOString(),
    routingOutcome: routingOutcome.outcome,
  };
}

function buildRoutingConflictInteraction({
  eventCode,
  scanId,
  audienceEntry,
  candidates = [],
  reason = "multiple_campaign_matches",
}) {
  const audienceEntrySnapshot = createAudienceEntrySnapshot(audienceEntry);
  const sanitizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map(sanitizeRoutingCandidate)
    .filter((candidate) => candidate.eventCode || candidate.eventId);
  const interactionContext = {
    eventCode,
    eventId: null,
    audienceEntry: audienceEntrySnapshot,
  };
  const routingOutcome = createRoutingOutcome({
    outcome: ROUTING_OUTCOMES.ROUTING_CONFLICT,
    interactionContext,
    reason,
    candidates: sanitizedCandidates,
  });
  const interactionState = buildInteractionStateSnapshot([
    buildValidInteractionStateTransition({
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    }),
    buildValidInteractionStateTransition({
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.UNMATCHED,
      transition: INTERACTION_TRANSITIONS.NO_CAMPAIGN_MATCH,
      reason,
    }),
  ], INTERACTION_STATES.UNMATCHED);

  return {
    interactionId: null,
    eventCode,
    eventId: null,
    scanId,
    audienceEntry: audienceEntrySnapshot,
    audienceIntent: createAudienceIntentSnapshot(audienceEntry),
    audienceContext: createAudienceContextSnapshot(interactionContext, {
      vertical: null,
      activationMethod: "",
      activationKeyword: "",
      activationChannels: [],
      rewards: {},
    }),
    state: interactionState.state,
    stateTransitions: interactionState.transitions,
    timestamp: new Date().toISOString(),
    routingOutcome: routingOutcome.outcome,
    reason: routingOutcome.reason,
    candidates: routingOutcome.candidates || [],
  };
}

function buildInteractionStateTransition({
  from = null,
  to,
  transition,
  reason = null,
}) {
  return {
    from,
    to,
    transition,
    reason,
    timestamp: new Date().toISOString(),
  };
}

function buildValidInteractionStateTransition(input) {
  const isValidTransition = INTERACTION_STATE_MACHINE.transitions.some((allowed) => (
    allowed.from === input.from &&
    allowed.to === input.to &&
    allowed.transition === input.transition
  ));

  if (!isValidTransition) {
    throw new Error(`Invalid codeClip interaction state transition: ${input.transition}`);
  }

  return buildInteractionStateTransition(input);
}

function buildValidProviderEventInteractionStateTransition(input) {
  const isValidTransition = PROVIDER_EVENT_INTERACTION_STATE_MACHINE.transitions.some((allowed) => (
    allowed.from === input.from &&
    allowed.to === input.to &&
    allowed.transition === input.transition
  ));

  if (!isValidTransition) {
    throw new Error(`Invalid codeClip provider-event interaction state transition: ${input.transition}`);
  }

  return buildInteractionStateTransition(input);
}

function buildInteractionStateSnapshot(transitions, fallbackState = INTERACTION_STATES.PROCESSED) {
  const lastTransition = transitions[transitions.length - 1] || null;

  return {
    state: lastTransition?.to || fallbackState,
    transitions,
  };
}

function resolveSuccessfulScanInteractionState() {
  return buildInteractionStateSnapshot([
    buildValidInteractionStateTransition({
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    }),
    buildValidInteractionStateTransition({
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.ROUTED,
      transition: INTERACTION_TRANSITIONS.ROUTE_MATCH,
    }),
    buildValidInteractionStateTransition({
      from: INTERACTION_STATES.ROUTED,
      to: INTERACTION_STATES.REWARD_ASSIGNED,
      transition: INTERACTION_TRANSITIONS.ASSIGN_REWARD,
    }),
    buildValidInteractionStateTransition({
      from: INTERACTION_STATES.REWARD_ASSIGNED,
      to: INTERACTION_STATES.PROCESSED,
      transition: INTERACTION_TRANSITIONS.COMPLETE,
    }),
  ]);
}

function resolveSuccessfulProviderEventInteractionState() {
  return buildInteractionStateSnapshot([
    buildValidProviderEventInteractionStateTransition({
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    }),
    buildValidProviderEventInteractionStateTransition({
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.ROUTED,
      transition: INTERACTION_TRANSITIONS.ROUTE_MATCH,
    }),
    buildValidProviderEventInteractionStateTransition({
      from: INTERACTION_STATES.ROUTED,
      to: INTERACTION_STATES.PROCESSED,
      transition: INTERACTION_TRANSITIONS.COMPLETE,
      reason: "provider_event_has_no_individual_recipient",
    }),
  ]);
}

function createInteraction({
  interactionContext,
  routingOutcome,
  tier = null,
  rewardAssignments = null,
  interactionType = null,
  interactionState = null,
  providerEvent = null,
}) {
  const resolvedInteractionState = interactionState || resolveSuccessfulScanInteractionState();

  const interaction = {
    interactionId: null,
    eventCode: interactionContext.eventCode,
    eventId: interactionContext.eventId,
    scanId: interactionContext.scanId,
    rawScans: interactionContext.rawScans,
    uniqueScans: interactionContext.uniqueScans,
    scanRank: interactionContext.scanRank,
    audienceEntry: interactionContext.audienceEntry,
    audienceIntent: interactionContext.audienceIntent,
    state: resolvedInteractionState.state,
    stateTransitions: resolvedInteractionState.transitions,
    tier,
    timestamp: new Date().toISOString(),
    routingOutcome,
    rewardAssignments,
  };

  if (interactionType) interaction.interactionType = interactionType;
  if (providerEvent) interaction.providerEvent = providerEvent;

  return interaction;
}

function createScanPayloadInteraction(interaction) {
  return {
    eventCode: interaction.eventCode,
    eventId: interaction.eventId,
    scanId: interaction.scanId,
    rawScans: interaction.rawScans,
    uniqueScans: interaction.uniqueScans,
    scanRank: interaction.scanRank,
    audienceEntry: interaction.audienceEntry,
    state: interaction.state,
    tier: interaction.tier,
    routingOutcome: interaction.routingOutcome,
    rewardAssignments: interaction.rewardAssignments,
  };
}

function createAudienceContextSnapshot(interactionContext = {}, codeClipEvent = {}) {
  const rewards = codeClipEvent.rewards || {};
  const audienceEntry = interactionContext.audienceEntry || {};
  const audienceIntent = interactionContext.audienceIntent || {};

  return {
    campaign: {
      eventCode: interactionContext.eventCode,
      eventId: interactionContext.eventId,
      vertical: codeClipEvent.vertical,
      venue: codeClipEvent.venue,
      city: codeClipEvent.city,
      startAt: codeClipEvent.startAt,
      unlockAt: codeClipEvent.unlockAt,
      endAt: codeClipEvent.endAt,
    },
    activation: {
      method: codeClipEvent.activationMethod,
      keyword: codeClipEvent.activationKeyword,
      channels: Array.isArray(codeClipEvent.activationChannels) ? codeClipEvent.activationChannels : [],
    },
    entry: {
      source: audienceIntent.source || audienceEntry.source,
      transport: audienceIntent.transport || audienceEntry.transport,
      requestedVertical: audienceIntent.requestedVertical || audienceEntry.requestedVertical,
    },
    rewardContext: {
      hasOpenClip: !!rewards.openClip?.enabled,
      hasClip: !!rewards.clip?.enabled,
      hasClipPlus: !!rewards.clipPlus?.enabled,
      hasClipXtra: !!rewards.clipXtra?.active,
    },
  };
}

function createRewardAssignmentSnapshot(interaction = {}) {
  const rewardAssignments = interaction.rewardAssignments || {};

  return {
    eventCode: interaction.eventCode,
    eventId: interaction.eventId,
    scanId: interaction.scanId,
    interactionState: interaction.state,
    routingOutcome: interaction.routingOutcome,
    audienceContext: interaction.audienceContext || null,
    assignments: Object.entries(rewardAssignments).map(([tier, assignment = {}]) => ({
      tier,
      displayTier: assignment.displayTier,
      assigned: assignment.assigned,
      status: assignment.status,
      reason: assignment.reason,
      rewardType: assignment.rewardType,
      title: assignment.title,
      type: assignment.type,
      contentUrl: assignment.contentUrl,
      contentFileName: assignment.contentFileName,
      quantity: assignment.quantity,
      assignedCount: assignment.assignedCount,
      remaining: assignment.remaining,
      unlimited: assignment.unlimited,
      exhausted: assignment.exhausted,
      noReward: assignment.noReward,
      redemptionToken: assignment.redemptionToken,
      partnerName: assignment.partnerName,
      product: assignment.product,
      redemptionLocation: assignment.redemptionLocation,
      redemptionDeadline: assignment.redemptionDeadline,
      redemptionInstructions: assignment.redemptionInstructions,
      partnerLogo: assignment.partnerLogo,
      partnerLogoFileName: assignment.partnerLogoFileName,
      assignedAt: assignment.assignedAt,
      rawAssignment: assignment,
    })),
  };
}

function createProviderEventInteraction({
  event = {},
  eventCode,
  eventId,
  providerEvent = {},
  occurredAt = null,
} = {}) {
  const providerEventId = String(
    providerEvent.providerEventId || providerEvent.externalMessageId || ""
  ).trim();

  if (!providerEventId) {
    const error = new Error("codeClip provider event interaction requires providerEventId");
    error.code = "INVALID_PROVIDER_EVENT";
    error.fieldName = "providerEventId";
    throw error;
  }

  const providerEventMetadata = {
    provider: String(providerEvent.provider || "").trim().toLowerCase(),
    channel: String(providerEvent.channel || "").trim().toLowerCase(),
    activationEvent: String(providerEvent.activationEvent || "").trim().toLowerCase(),
    providerEventId,
    videoId: String(providerEvent.videoId || "").trim(),
    externalMessageId: String(providerEvent.externalMessageId || "").trim(),
    publishedAt: providerEvent.publishedAt || null,
    updatedAt: providerEvent.updatedAt || null,
    title: String(providerEvent.title || "").trim(),
    canonicalUrl: String(providerEvent.canonicalUrl || "").trim(),
  };
  const activationChannels =
    normalizeActivationChannels(readActivationValue(event, "activationChannels")) || [];
  const interactionContext = buildInteractionContext({
    event,
    eventCode,
    eventId,
    scanId: providerEventId,
    rawScans: null,
    uniqueScans: null,
    scanRank: null,
    audienceEntry: null,
    audienceIntent: {
      type: "provider_event",
      source: "provider_event",
      transport: "websub",
      provider: providerEventMetadata.provider,
      channel: providerEventMetadata.channel,
      activationEvent: providerEventMetadata.activationEvent,
      providerEventId,
    },
  });
  const interaction = createInteraction({
    interactionContext,
    routingOutcome: ROUTING_OUTCOMES.MATCH,
    tier: null,
    rewardAssignments: {},
    interactionType: "provider_event",
    interactionState: resolveSuccessfulProviderEventInteractionState(),
    providerEvent: providerEventMetadata,
  });

  interaction.vertical = "codeclip";
  interaction.timestamp = occurredAt || providerEvent.publishedAt || providerEvent.updatedAt || interaction.timestamp;
  interaction.audienceContext = {
    campaign: {
      eventCode,
      eventId,
      vertical: event.vertical,
      venue: event.venue,
      city: event.city,
      startAt: event.startAt,
      unlockAt: event.unlockAt,
      endAt: event.endAt,
    },
    activation: {
      method: readActivationValue(event, "activationMethod"),
      keyword: readActivationValue(event, "activationKeyword"),
      channels: activationChannels,
      event: readActivationValue(event, "activationEvent"),
    },
    entry: {
      source: "provider_event",
      transport: "websub",
    },
    providerEvent: providerEventMetadata,
    rewardContext: {
      supported: false,
      reason: "provider_event_has_no_individual_recipient",
    },
  };
  interaction.persistenceStatus = createPersistenceStatus();
  interaction.rewardAssignmentSnapshot = createRewardAssignmentSnapshot(interaction);
  interaction.rewardAssignmentSnapshot.persistenceStatus = interaction.persistenceStatus;
  interaction.persistenceSkipReasons = {
    rewardAssignments: "provider_event_has_no_individual_recipient",
    clipXtraRedemption: "provider_event_has_no_individual_recipient",
  };

  return interaction;
}

function createPersistenceStatus() {
  return {
    interaction: { attempted: false, ok: null, error: null },
    rewardAssignments: { attempted: false, ok: null, error: null },
    clipXtraRedemption: { attempted: false, ok: null, error: null },
  };
}

function recordPersistenceStep(status, step, ok, error = null, metadata = {}) {
  if (!status || !status[step]) return;

  status[step] = {
    attempted: true,
    ok,
    error: error ? String(error.message || error) : null,
    ...metadata,
  };
}

function recordPersistenceSkipped(status, step, reason = "not_required") {
  if (!status || !status[step]) return;

  status[step] = {
    attempted: false,
    ok: null,
    error: null,
    skipped: true,
    reason,
  };
}

function getPersistableRewardAssignments(snapshot = {}) {
  const assignments = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  return assignments.filter((assignment) => assignment?.tier);
}

function requireConfirmedPersistenceRow(row, step) {
  if (!row) {
    throw new Error(`${step} persistence did not confirm write`);
  }
}

function requireConfirmedRewardAssignmentWrites(snapshot = {}, rows = []) {
  const expectedAssignments = getPersistableRewardAssignments(snapshot);

  if (!expectedAssignments.length) {
    return { required: false, expected: 0 };
  }

  if (!Array.isArray(rows) || rows.length !== expectedAssignments.length) {
    throw new Error(
      `reward assignment persistence confirmed ${Array.isArray(rows) ? rows.length : 0} of ${expectedAssignments.length} writes`
    );
  }

  return { required: true, expected: expectedAssignments.length };
}

function buildPersistenceDecision(status = {}) {
  const failedSteps = Object.entries(status)
    .filter(([, stepStatus]) => stepStatus?.attempted && stepStatus.ok === false)
    .map(([step]) => step);
  const criticalSteps = new Set([
    "interaction",
    "rewardAssignments",
    "clipXtraRedemption",
  ]);
  const criticalFailures = failedSteps.filter((step) =>
    criticalSteps.has(step)
  );
  const severity = criticalFailures.length
    ? "critical"
    : failedSteps.length
      ? "degraded"
      : "ok";

  return {
    ok: failedSteps.length === 0,
    severity,
    failedSteps,
    criticalFailures,
  };
}

function applyPersistenceGuaranteePolicy(persistenceDecision = {}) {
  const severity = String(persistenceDecision?.severity || "").trim().toLowerCase();

  if (severity === "ok") {
    return {
      severity: "ok",
      shouldContinue: true,
      requiresRetry: false,
      requiresOperatorAttention: false,
      reason: "persistence_ok",
    };
  }

  if (severity === "degraded") {
    return {
      severity: "degraded",
      shouldContinue: true,
      requiresRetry: true,
      requiresOperatorAttention: true,
      reason: "persistence_degraded",
    };
  }

  if (severity === "critical") {
    return {
      severity: "critical",
      shouldContinue: false,
      requiresRetry: true,
      requiresOperatorAttention: true,
      reason: "persistence_critical",
    };
  }

  return {
    severity: "critical",
    shouldContinue: false,
    requiresRetry: true,
    requiresOperatorAttention: true,
    reason: "unknown_persistence_severity",
  };
}

function buildPersistenceAction(policy = {}) {
  const reason = String(policy?.reason || "").trim();

  if (reason === "persistence_ok") {
    return {
      action: "continue",
      logLevel: "none",
      retry: false,
      escalate: false,
      reason,
    };
  }

  if (reason === "persistence_degraded") {
    return {
      action: "continue_with_internal_warning",
      logLevel: "warn",
      retry: true,
      escalate: true,
      reason,
    };
  }

  if (reason === "persistence_critical") {
    return {
      action: "continue_with_internal_error_marker",
      logLevel: "error",
      retry: true,
      escalate: true,
      reason,
    };
  }

  return {
    action: "continue_with_internal_error_marker",
    logLevel: "error",
    retry: true,
    escalate: true,
    reason: "unknown_persistence_policy",
  };
}

function recordPersistenceAction(action = {}, interaction = {}, logger = console) {
  const event = {
    interactionId: interaction.interactionId || null,
    eventCode: interaction.eventCode || "",
    severity: interaction.persistenceGuaranteePolicy?.severity || "",
    action: action.action || "",
    retry: Boolean(action.retry),
    escalate: Boolean(action.escalate),
    reason: action.reason || "",
  };

  if (action.logLevel === "warn" && logger?.warn) {
    logger.warn("codeClip COAS persistence action", event);
  } else if (action.logLevel === "error" && logger?.error) {
    logger.error("codeClip COAS persistence action", event);
  }

  return event;
}

async function savePersistenceActionOutbox({ interaction = {}, saveCodeClipOutboxEvent } = {}) {
  const action = interaction.persistenceAction || {};
  if (!saveCodeClipOutboxEvent || (!action.retry && !action.escalate)) return null;

  try {
    const recoveryInteractionSnapshot = JSON.parse(JSON.stringify(interaction || null));
    const recoveryRewardAssignmentSnapshot = JSON.parse(JSON.stringify(interaction.rewardAssignmentSnapshot || null));
    const recoveryClipXtraRedemptionSnapshot = JSON.parse(JSON.stringify(createClipXtraRedemptionRecord(interaction) || null));

    return await saveCodeClipOutboxEvent({
      eventType: "codeclip.persistence_action",
      eventCode: interaction.eventCode,
      eventId: interaction.eventId,
      scanId: interaction.scanId,
      messageId: interaction.scanId,
      routingOutcome: interaction.routingOutcome,
      interactionState: interaction.state,
      severity: interaction.persistenceGuaranteePolicy?.severity,
      action: action.action,
      retry: Boolean(action.retry),
      escalate: Boolean(action.escalate),
      reason: action.reason,
      payload: {
        persistenceStatus: interaction.persistenceStatus,
        persistenceDecision: interaction.persistenceDecision,
        persistenceGuaranteePolicy: interaction.persistenceGuaranteePolicy,
        persistenceAction: interaction.persistenceAction,
        interaction: {
          eventCode: interaction.eventCode,
          eventId: interaction.eventId,
          scanId: interaction.scanId,
          routingOutcome: interaction.routingOutcome,
          state: interaction.state,
          tier: interaction.tier,
        },
        recovery: {
          interaction: recoveryInteractionSnapshot,
          rewardAssignmentSnapshot: recoveryRewardAssignmentSnapshot,
          clipXtraRedemption: recoveryClipXtraRedemptionSnapshot,
        },
      },
    });
  } catch (dbError) {
    console.warn("codeClip persistence action outbox save failed:", dbError.message);
    return null;
  }
}

function createClipXtraRedemptionRecord(interaction = {}) {
  const clipXtra = interaction.rewardAssignments?.clipXtra;
  if (!clipXtra?.assigned) return null;

  return {
    token: clipXtra.redemptionToken,
    eventCode: interaction.eventCode,
    eventId: interaction.eventId,
    scanId: interaction.scanId,
    vertical: "codeclip",
    rewardType: "clip_xtra",
    tier: "clipXtra",
    displayTier: "ClipXtra",
    partnerName: clipXtra.partnerName,
    rewardTitle: clipXtra.title,
    redemptionLocation: clipXtra.redemptionLocation,
    redemptionDeadline: clipXtra.redemptionDeadline,
    redemptionInstructions: clipXtra.redemptionInstructions,
    status: REWARD_ASSIGNMENT_STATES.ASSIGNED,
    assignedAt: clipXtra.assignedAt,
    rawPayload: {
      eventCode: interaction.eventCode,
      eventId: interaction.eventId,
      scanId: interaction.scanId,
      tier: interaction.tier,
      rewardType: "clip_xtra",
      clipXtra,
    },
  };
}

function markPersistenceError(error, step) {
  if (error && typeof error === "object") {
    error.persistenceStep = step;
  }

  return error;
}

function recordCommittedCorePersistence(status, outcomes = []) {
  for (const outcome of outcomes) {
    if (outcome.type === "skipped") {
      recordPersistenceSkipped(status, outcome.step, outcome.reason);
    } else if (outcome.type === "write") {
      recordPersistenceStep(status, outcome.step, true, null, {
        committed: true,
      });
    }
  }
}

function recordRolledBackCorePersistence(status, outcomes = [], error = null) {
  const causeStep = error?.persistenceStep || null;
  const transactionPhase = error?.transactionPhase || null;
  const rollbackAttempted = error?.rollbackAttempted === true;
  const rollbackSucceeded = error?.rollbackSucceeded === true;
  const rolledBack = rollbackSucceeded;

  for (const outcome of outcomes) {
    if (outcome.type === "skipped") {
      recordPersistenceSkipped(status, outcome.step, outcome.reason);
    } else if (outcome.type === "write") {
      recordPersistenceStep(
        status,
        outcome.step,
        false,
        causeStep === outcome.step ? error : null,
        {
          committed: false,
          rolledBack,
          rollbackAttempted,
          rollbackSucceeded,
          causeStep,
          transactionPhase,
        }
      );
    }
  }

  if (causeStep && status?.[causeStep] && !status[causeStep].attempted) {
    recordPersistenceStep(status, causeStep, false, error, {
      committed: false,
      rolledBack,
      rollbackAttempted,
      rollbackSucceeded,
      causeStep,
      transactionPhase,
    });
  }

  if (!outcomes.length && status?.interaction && !status.interaction.attempted) {
    recordPersistenceStep(status, "interaction", false, error, {
      committed: false,
      rolledBack,
      rollbackAttempted,
      rollbackSucceeded,
      causeStep,
      transactionPhase,
    });
  }
}

async function persistCodeClipCoreInteraction({
  interaction,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
  runCodeClipCorePersistenceTransaction,
  logPrefix = "codeClip",
}) {
  const runTransaction = runCodeClipCorePersistenceTransaction || (async (work) => work({}));
  const outcomes = [];

  try {
    await runTransaction(async ({ queryClient } = {}) => {
      try {
        const persistedInteraction = saveCodeClipInteraction
          ? await saveCodeClipInteraction(interaction, queryClient)
          : null;
        requireConfirmedPersistenceRow(persistedInteraction, "interaction");
        outcomes.push({ step: "interaction", type: "write" });
      } catch (dbError) {
        throw markPersistenceError(dbError, "interaction");
      }

      try {
        const expectedAssignments = getPersistableRewardAssignments(interaction.rewardAssignmentSnapshot);

        if (!expectedAssignments.length) {
          outcomes.push({
            step: "rewardAssignments",
            type: "skipped",
            reason:
              interaction.interactionType === "provider_event"
                ? interaction.persistenceSkipReasons?.rewardAssignments ||
                  "provider_event_has_no_individual_recipient"
                : "no_persistable_assignments",
          });
        } else {
          const persistedRewardAssignments = saveCodeClipRewardAssignments
            ? await saveCodeClipRewardAssignments(interaction.rewardAssignmentSnapshot, queryClient)
            : null;
          requireConfirmedRewardAssignmentWrites(
            interaction.rewardAssignmentSnapshot,
            persistedRewardAssignments
          );
          outcomes.push({ step: "rewardAssignments", type: "write" });
        }
      } catch (dbError) {
        throw markPersistenceError(dbError, "rewardAssignments");
      }

      if (interaction.rewardAssignments?.clipXtra?.assigned) {
        try {
          const persistedClipXtraRedemption = saveCodeClipXtraRedemption
            ? await saveCodeClipXtraRedemption(createClipXtraRedemptionRecord(interaction), queryClient)
            : null;
          requireConfirmedPersistenceRow(persistedClipXtraRedemption, "clipXtra redemption");
          outcomes.push({ step: "clipXtraRedemption", type: "write" });
        } catch (dbError) {
          throw markPersistenceError(dbError, "clipXtraRedemption");
        }
      } else {
        outcomes.push({
          step: "clipXtraRedemption",
          type: "skipped",
          reason:
            interaction.interactionType === "provider_event"
              ? interaction.persistenceSkipReasons?.clipXtraRedemption ||
                "provider_event_has_no_individual_recipient"
              : "clipxtra_not_assigned",
        });
      }
    });

    recordCommittedCorePersistence(interaction.persistenceStatus, outcomes);
  } catch (dbError) {
    recordRolledBackCorePersistence(interaction.persistenceStatus, outcomes, dbError);
    console.warn(`${logPrefix} core Postgres persistence failed:`, dbError.message);
  }
}

async function handleCodeClipScan({
  event,
  eventCode,
  eventId,
  scanId,
  rawScans,
  uniqueScans,
  scanRank,
  audienceEntry,
  audienceIntent = null,
  redis,
  codeClipVertical,
  persistFinalScan,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
  saveCodeClipOutboxEvent,
  runCodeClipCorePersistenceTransaction,
  recordPersistenceAction: recordPersistenceActionHandler = recordPersistenceAction,
}) {
  const interactionContext = buildInteractionContext({
    event,
    eventCode,
    eventId,
    scanId,
    rawScans,
    uniqueScans,
    scanRank,
    audienceEntry,
    audienceIntent,
  });
  const routingOutcome = buildRoutingMatch(interactionContext);
  const codeClipEvent = codeClipVertical.routes.parseCodeClipRewardsMeta(routingOutcome.interactionContext.event || {});

  if (Date.now() > Date.parse(codeClipEvent.endAt)) {
    return buildInteractionResult(200, {
      success: false,
      status: INTERACTION_STATES.EXPIRED,
      error: CODECLIP_FAILURE_REASONS.BONUS_WINDOW_EXPIRED,
    });
  }

  const codeClipRewardAssignments = await codeClipVertical.assignment.assignCodeClipRewards({
    redis,
    eventCode: routingOutcome.interactionContext.eventCode,
    scanId: routingOutcome.interactionContext.scanId,
    rewards: codeClipEvent.rewards || {},
  });

  const tier =
    codeClipRewardAssignments.clipPlus?.assigned ? "clipPlus" :
    codeClipRewardAssignments.clip?.assigned ? "clip" :
    codeClipRewardAssignments.openClip?.assigned ? "openClip" :
    "openClip";

  const interaction = createInteraction({
    interactionContext: routingOutcome.interactionContext,
    routingOutcome: routingOutcome.outcome,
    tier,
    rewardAssignments: codeClipRewardAssignments,
  });
  interaction.audienceContext = createAudienceContextSnapshot(routingOutcome.interactionContext, codeClipEvent);
  interaction.rewardAssignmentSnapshot = createRewardAssignmentSnapshot(interaction);
  interaction.persistenceStatus = createPersistenceStatus();
  interaction.rewardAssignmentSnapshot.persistenceStatus = interaction.persistenceStatus;
  const interactionRewardAssignments = interaction.rewardAssignments;

  await persistFinalScan(interaction.tier, {
    rewards: interactionRewardAssignments,
    interaction: createScanPayloadInteraction(interaction),
  }, interaction);

  await persistCodeClipCoreInteraction({
    interaction,
    saveCodeClipInteraction,
    saveCodeClipRewardAssignments,
    saveCodeClipXtraRedemption,
    runCodeClipCorePersistenceTransaction,
    logPrefix: "codeClip scan",
  });

  interaction.persistenceDecision = buildPersistenceDecision(interaction.persistenceStatus);
  interaction.persistenceGuaranteePolicy = applyPersistenceGuaranteePolicy(interaction.persistenceDecision);
  interaction.persistenceAction = buildPersistenceAction(interaction.persistenceGuaranteePolicy);
  recordPersistenceActionHandler(interaction.persistenceAction, interaction);
  await savePersistenceActionOutbox({ interaction, saveCodeClipOutboxEvent });

  return buildInteractionResult(200, {
    success: true,
    eventCode: interaction.eventCode,
    eventId: interaction.eventId,
    rawScans: Number(interaction.rawScans || 0),
    uniqueScans: Number(interaction.uniqueScans || 0),
    scanRank: interaction.scanRank,
    tier: interaction.tier,
    rewards: interactionRewardAssignments,
    clipXtra: interactionRewardAssignments.clipXtra || null,
  }, {
    persistenceDecision: interaction.persistenceDecision,
    persistenceAction: interaction.persistenceAction,
    persistenceGuaranteePolicy: interaction.persistenceGuaranteePolicy,
  });
}

async function handleCodeClipKeywordEntry({
  event,
  eventCode,
  eventId,
  keyword,
  messageId,
  requestedVertical,
  receivedAt,
  redis,
  codeClipVertical,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
  saveCodeClipOutboxEvent,
  runCodeClipCorePersistenceTransaction,
  recordPersistenceAction: recordPersistenceActionHandler = recordPersistenceAction,
}) {
  const normalizedKeywordEntry = normalizeAudienceEntry("keyword", {
    entryCode: eventCode,
    keyword,
    requestedVertical,
    receivedAt,
  });

  if (!normalizedKeywordEntry.ok) {
    return buildInteractionResult(400, {
      success: false,
      errors: normalizedKeywordEntry.errors,
    });
  }

  const scanId = String(messageId || "").trim();
  const interactionContext = buildInteractionContext({
    event,
    eventCode,
    eventId,
    scanId,
    rawScans: null,
    uniqueScans: null,
    scanRank: null,
    audienceEntry: normalizedKeywordEntry.audienceEntry,
    audienceIntent: normalizedKeywordEntry.audienceIntent,
  });
  const routingOutcome = buildRoutingMatch(interactionContext);
  const codeClipEvent = codeClipVertical.routes.parseCodeClipRewardsMeta(routingOutcome.interactionContext.event || {});

  if (Date.now() > Date.parse(codeClipEvent.endAt)) {
    return buildInteractionResult(200, {
      success: false,
      status: INTERACTION_STATES.EXPIRED,
      error: CODECLIP_FAILURE_REASONS.BONUS_WINDOW_EXPIRED,
    });
  }

  const codeClipRewardAssignments = await codeClipVertical.assignment.assignCodeClipRewards({
    redis,
    eventCode: routingOutcome.interactionContext.eventCode,
    scanId: routingOutcome.interactionContext.scanId,
    rewards: codeClipEvent.rewards || {},
  });

  const tier =
    codeClipRewardAssignments.clipPlus?.assigned ? "clipPlus" :
    codeClipRewardAssignments.clip?.assigned ? "clip" :
    codeClipRewardAssignments.openClip?.assigned ? "openClip" :
    "openClip";

  const interaction = createInteraction({
    interactionContext: routingOutcome.interactionContext,
    routingOutcome: routingOutcome.outcome,
    tier,
    rewardAssignments: codeClipRewardAssignments,
  });
  interaction.audienceContext = createAudienceContextSnapshot(routingOutcome.interactionContext, codeClipEvent);
  interaction.rewardAssignmentSnapshot = createRewardAssignmentSnapshot(interaction);
  interaction.persistenceStatus = createPersistenceStatus();
  interaction.rewardAssignmentSnapshot.persistenceStatus = interaction.persistenceStatus;
  const interactionRewardAssignments = interaction.rewardAssignments;

  await persistCodeClipCoreInteraction({
    interaction,
    saveCodeClipInteraction,
    saveCodeClipRewardAssignments,
    saveCodeClipXtraRedemption,
    runCodeClipCorePersistenceTransaction,
    logPrefix: "codeClip keyword",
  });

  interaction.persistenceDecision = buildPersistenceDecision(interaction.persistenceStatus);
  interaction.persistenceGuaranteePolicy = applyPersistenceGuaranteePolicy(interaction.persistenceDecision);
  interaction.persistenceAction = buildPersistenceAction(interaction.persistenceGuaranteePolicy);
  recordPersistenceActionHandler(interaction.persistenceAction, interaction);
  await savePersistenceActionOutbox({ interaction, saveCodeClipOutboxEvent });

  return buildInteractionResult(200, {
    success: true,
    eventCode: interaction.eventCode,
    eventId: interaction.eventId,
    messageId: interaction.scanId,
    tier: interaction.tier,
    rewards: interaction.rewardAssignments,
    clipXtra: interaction.rewardAssignments.clipXtra || null,
  }, {
    persistenceStatus: interaction.persistenceStatus,
    persistenceDecision: interaction.persistenceDecision,
    persistenceAction: interaction.persistenceAction,
    persistenceGuaranteePolicy: interaction.persistenceGuaranteePolicy,
  });
}

module.exports = {
  validateClipXtraToken,
  redeemClipXtraToken,
  buildNoCampaignMatchInteraction,
  buildRoutingConflictInteraction,
  normalizeScanAudienceEntry,
  normalizeKeywordAudienceEntry,
  normalizeAudienceEntry,
  createProviderEventInteraction,
  createRewardAssignmentSnapshot,
  buildPersistenceDecision,
  applyPersistenceGuaranteePolicy,
  buildPersistenceAction,
  recordPersistenceAction,
  persistCodeClipCoreInteraction,
  handleCodeClipScan,
  handleCodeClipKeywordEntry,
};
