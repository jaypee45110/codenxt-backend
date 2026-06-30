const INTERACTION_STATES = {
  RECEIVED: "received",
  ROUTED: "routed",
  REWARD_ASSIGNED: "reward_assigned",
  PROCESSED: "processed",
  EXPIRED: "expired",
};

const INTERACTION_TRANSITIONS = {
  RECEIVE: "receive",
  ROUTE_MATCH: "route_match",
  ASSIGN_REWARD: "assign_reward",
  COMPLETE: "complete",
  EXPIRE: "expire",
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
}) {
  return {
    event,
    eventCode,
    eventId,
    scanId,
    rawScans,
    uniqueScans,
    scanRank,
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

function buildRoutingMatch(interactionContext) {
  return {
    outcome: ROUTING_OUTCOMES.MATCH,
    interactionContext,
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

function buildInteractionStateSnapshot(transitions, fallbackState = INTERACTION_STATES.PROCESSED) {
  const lastTransition = transitions[transitions.length - 1] || null;

  return {
    state: lastTransition?.to || fallbackState,
    transitions,
  };
}

function resolveSuccessfulScanInteractionState() {
  return buildInteractionStateSnapshot([
    buildInteractionStateTransition({
      from: null,
      to: INTERACTION_STATES.RECEIVED,
      transition: INTERACTION_TRANSITIONS.RECEIVE,
    }),
    buildInteractionStateTransition({
      from: INTERACTION_STATES.RECEIVED,
      to: INTERACTION_STATES.ROUTED,
      transition: INTERACTION_TRANSITIONS.ROUTE_MATCH,
    }),
    buildInteractionStateTransition({
      from: INTERACTION_STATES.ROUTED,
      to: INTERACTION_STATES.REWARD_ASSIGNED,
      transition: INTERACTION_TRANSITIONS.ASSIGN_REWARD,
    }),
    buildInteractionStateTransition({
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
    state: interaction.state,
    tier: interaction.tier,
    routingOutcome: interaction.routingOutcome,
    rewardAssignments: interaction.rewardAssignments,
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
  redis,
  codeClipVertical,
  persistFinalScan,
  saveCodeClipInteraction,
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
  const interactionRewardAssignments = interaction.rewardAssignments;

  await persistFinalScan(interaction.tier, {
    rewards: interactionRewardAssignments,
    interaction: createScanPayloadInteraction(interaction),
  });

  if (saveCodeClipInteraction) {
    try {
      await saveCodeClipInteraction(interaction);
    } catch (dbError) {
      console.warn("codeClip Interaction Postgres save failed:", dbError.message);
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
  handleCodeClipScan,
};
