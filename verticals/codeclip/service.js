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
      status: "not_found",
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

  if (result.status === "not_found" || !row) {
    return {
      httpStatus: 404,
      payload: {
        ok: false,
        status: "not_found",
      },
    };
  }

  if (result.status === "already_redeemed") {
    const refreshedRow = await getCodeClipXtraRedemptionByToken(token);

    return {
      httpStatus: 409,
      payload: {
        ok: false,
        status: "already_redeemed",
        redeemedAt: (refreshedRow || row).redeemed_at || null,
      },
    };
  }

  return {
    httpStatus: 200,
    payload: {
      ...codeClipVertical.validation.buildCodeClipXtraValidationPayload(row),
      ok: true,
      status: "redeemed",
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
  const codeClipEvent = codeClipVertical.routes.parseCodeClipRewardsMeta(interactionContext.event || {});

  if (Date.now() > Date.parse(codeClipEvent.endAt)) {
    return buildInteractionResult(200, {
      success: false,
      status: "expired",
      error: "bonus_window_expired",
    });
  }

  const codeClipRewardAssignments = await codeClipVertical.assignment.assignCodeClipRewards({
    redis,
    eventCode: interactionContext.eventCode,
    scanId: interactionContext.scanId,
    rewards: codeClipEvent.rewards || {},
  });

  const tier =
    codeClipRewardAssignments.clipPlus?.assigned ? "clipPlus" :
    codeClipRewardAssignments.clip?.assigned ? "clip" :
    codeClipRewardAssignments.openClip?.assigned ? "openClip" :
    "openClip";

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
        status: "assigned",
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
