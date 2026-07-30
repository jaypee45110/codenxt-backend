const {
  buildMetaMessengerRewardOutboundIntent,
} = require("./meta-messenger-outbound");

function normalizeString(value) {
  return String(value || "").trim();
}

function runtimeFailure(reason, error = null) {
  return {
    status: "failed",
    critical: true,
    reason,
    error,
  };
}

function buildRuntimeRewardResult(interaction = {}) {
  return {
    tier: interaction.tier,
    rewards: interaction.rewardAssignments,
  };
}

async function persistMetaMessengerRewardOutboundIntent({
  outboundContext = null,
  interaction = {},
  persistedInteraction = null,
  queryClient = null,
  createOrGetOutbound,
} = {}) {
  if (!outboundContext || typeof outboundContext !== "object") {
    return { status: "skipped", reason: "OUTBOUND_CONTEXT_MISSING" };
  }

  const intentResult = buildMetaMessengerRewardOutboundIntent({
    providerAccountId: outboundContext.providerAccountId,
    recipientId: outboundContext.recipientId,
    eventCode: outboundContext.eventCode,
    bindingId: outboundContext.bindingId,
    inboundDeliveryId: outboundContext.inboundDeliveryId,
    externalInboundMessageId: outboundContext.externalInboundMessageId,
    interactionId: normalizeString(persistedInteraction?.id) || null,
    createdAt: outboundContext.createdAt,
    result: buildRuntimeRewardResult(interaction),
  });

  if (!intentResult.ok) {
    if (intentResult.reason === "NO_DELIVERABLE_REWARD") {
      return { status: "skipped", reason: intentResult.reason };
    }
    return runtimeFailure(intentResult.reason);
  }

  if (!queryClient || typeof queryClient.query !== "function") {
    return runtimeFailure("QUERY_CLIENT_REQUIRED");
  }
  if (typeof createOrGetOutbound !== "function") {
    return runtimeFailure("OUTBOUND_REPOSITORY_REQUIRED");
  }

  let repositoryResult;
  try {
    repositoryResult = await createOrGetOutbound(intentResult.intent, queryClient);
  } catch (error) {
    return runtimeFailure("OUTBOUND_REPOSITORY_ERROR", error);
  }

  if (!repositoryResult?.ok) {
    return runtimeFailure(
      repositoryResult?.reason || "OUTBOUND_REPOSITORY_FAILED",
      repositoryResult?.error || null
    );
  }

  if (!["created", "existing"].includes(repositoryResult.status)) {
    return runtimeFailure("OUTBOUND_REPOSITORY_STATUS_UNSUPPORTED");
  }

  return {
    status: "committed",
    outboundStatus: repositoryResult.status,
    outboundId: repositoryResult.row?.id || null,
  };
}

module.exports = {
  persistMetaMessengerRewardOutboundIntent,
};
