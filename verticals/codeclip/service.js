const INTERACTION_STATES = {
  EXPIRED: "expired",
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

function createInteraction({
  interactionContext,
  routingOutcome,
  tier = null,
  rewardAssignments = null,
}) {
  return {
    interactionId: null,
    eventCode: interactionContext.eventCode,
    eventId: interactionContext.eventId,
    scanId: interactionContext.scanId,
    rawScans: interactionContext.rawScans,
    uniqueScans: interactionContext.uniqueScans,
    scanRank: interactionContext.scanRank,
    tier,
    timestamp: new Date().toISOString(),
    routingOutcome,
    rewardAssignments,
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
  // Observational only: persistence and public responses still use the existing values below.
  void interaction;

  await persistFinalScan(tier, { rewards: codeClipRewardAssignments });

  if (codeClipRewardAssignments.clipXtra?.assigned) {
    try {
      await saveCodeClipXtraRedemption({
        token: codeClipRewardAssignments.clipXtra.redemptionToken,
        eventCode: interactionContext.eventCode,
        eventId: interactionContext.eventId,
        scanId: interactionContext.scanId,
        vertical: "codeclip",
        rewardType: "clip_xtra",
        tier: "clipXtra",
        displayTier: "ClipXtra",
        partnerName: codeClipRewardAssignments.clipXtra.partnerName,
        rewardTitle: codeClipRewardAssignments.clipXtra.title,
        redemptionLocation: codeClipRewardAssignments.clipXtra.redemptionLocation,
        redemptionDeadline: codeClipRewardAssignments.clipXtra.redemptionDeadline,
        redemptionInstructions: codeClipRewardAssignments.clipXtra.redemptionInstructions,
        status: REWARD_ASSIGNMENT_STATES.ASSIGNED,
        assignedAt: codeClipRewardAssignments.clipXtra.assignedAt,
        rawPayload: {
          eventCode: interactionContext.eventCode,
          eventId: interactionContext.eventId,
          scanId: interactionContext.scanId,
          tier,
          rewardType: "clip_xtra",
          clipXtra: codeClipRewardAssignments.clipXtra,
        },
      });
    } catch (dbError) {
      console.warn("codeClip ClipXtra Postgres save failed:", dbError.message);
    }
  }

  return buildInteractionResult(200, {
    success: true,
    eventCode: interactionContext.eventCode,
    eventId: interactionContext.eventId,
    rawScans: Number(interactionContext.rawScans || 0),
    uniqueScans: Number(interactionContext.uniqueScans || 0),
    scanRank: interactionContext.scanRank,
    tier,
    rewards: codeClipRewardAssignments,
    clipXtra: codeClipRewardAssignments.clipXtra || null,
  });
}

module.exports = {
  validateClipXtraToken,
  redeemClipXtraToken,
  handleCodeClipScan,
};
