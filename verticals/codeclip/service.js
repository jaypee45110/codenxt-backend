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
  redeemCodeClipXtraRedemption,
  getCodeClipXtraRedemptionByToken,
  codeClipVertical,
}) {
  const result = await redeemCodeClipXtraRedemption(token, redeemedBy);
  const row = result.row;

  if (result.status === REDEMPTION_STATES.NOT_FOUND || !row) {
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
    audienceIntent: createAudienceIntentSnapshot(audienceEntry),
  };
}

function createAudienceEntrySnapshot(audienceEntry = null) {
  if (!audienceEntry) return null;

  return {
    entryCode: audienceEntry.entryCode,
    scanId: audienceEntry.scanId,
    requestedVertical: audienceEntry.requestedVertical,
    source: audienceEntry.source,
    transport: audienceEntry.transport,
    receivedAt: audienceEntry.receivedAt,
  };
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

function buildInteractionResult(httpStatus, payload) {
  return {
    httpStatus,
    payload,
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
    routingOutcome: ROUTING_OUTCOMES.NO_CAMPAIGN_MATCH,
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

function createInteraction({
  interactionContext,
  routingOutcome,
  tier = null,
  rewardAssignments = null,
}) {
  const interactionState = resolveSuccessfulScanInteractionState();

  return {
    interactionId: null,
    eventCode: interactionContext.eventCode,
    eventId: interactionContext.eventId,
    scanId: interactionContext.scanId,
    rawScans: interactionContext.rawScans,
    uniqueScans: interactionContext.uniqueScans,
    scanRank: interactionContext.scanRank,
    audienceEntry: interactionContext.audienceEntry,
    audienceIntent: interactionContext.audienceIntent,
    state: interactionState.state,
    stateTransitions: interactionState.transitions,
    tier,
    timestamp: new Date().toISOString(),
    routingOutcome,
    rewardAssignments,
  };
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
      source: audienceEntry.source,
      transport: audienceEntry.transport,
      requestedVertical: audienceEntry.requestedVertical,
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

async function handleCodeClipScan({
  event,
  eventCode,
  eventId,
  scanId,
  rawScans,
  uniqueScans,
  scanRank,
  audienceEntry,
  redis,
  codeClipVertical,
  persistFinalScan,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
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
  const interactionRewardAssignments = interaction.rewardAssignments;

  await persistFinalScan(interaction.tier, {
    rewards: interactionRewardAssignments,
    interaction: createScanPayloadInteraction(interaction),
  }, interaction);

  if (saveCodeClipInteraction) {
    try {
      await saveCodeClipInteraction(interaction);
    } catch (dbError) {
      console.warn("codeClip Interaction Postgres save failed:", dbError.message);
    }
  }

  if (saveCodeClipRewardAssignments) {
    try {
      await saveCodeClipRewardAssignments(interaction.rewardAssignmentSnapshot);
    } catch (dbError) {
      console.warn("codeClip RewardAssignment Postgres save failed:", dbError.message);
    }
  }

  if (interactionRewardAssignments.clipXtra?.assigned) {
    try {
      await saveCodeClipXtraRedemption({
        token: interactionRewardAssignments.clipXtra.redemptionToken,
        eventCode: interaction.eventCode,
        eventId: interaction.eventId,
        scanId: interaction.scanId,
        vertical: "codeclip",
        rewardType: "clip_xtra",
        tier: "clipXtra",
        displayTier: "ClipXtra",
        partnerName: interactionRewardAssignments.clipXtra.partnerName,
        rewardTitle: interactionRewardAssignments.clipXtra.title,
        redemptionLocation: interactionRewardAssignments.clipXtra.redemptionLocation,
        redemptionDeadline: interactionRewardAssignments.clipXtra.redemptionDeadline,
        redemptionInstructions: interactionRewardAssignments.clipXtra.redemptionInstructions,
        status: REWARD_ASSIGNMENT_STATES.ASSIGNED,
        assignedAt: interactionRewardAssignments.clipXtra.assignedAt,
        rawPayload: {
          eventCode: interaction.eventCode,
          eventId: interaction.eventId,
          scanId: interaction.scanId,
          tier: interaction.tier,
          rewardType: "clip_xtra",
          clipXtra: interactionRewardAssignments.clipXtra,
        },
      });
    } catch (dbError) {
      console.warn("codeClip ClipXtra Postgres save failed:", dbError.message);
    }
  }

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
  });
}

module.exports = {
  validateClipXtraToken,
  redeemClipXtraToken,
  buildNoCampaignMatchInteraction,
  normalizeScanAudienceEntry,
  createRewardAssignmentSnapshot,
  handleCodeClipScan,
};
