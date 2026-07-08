function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeRequestedVertical(value) {
  const requestedVertical = normalizeString(value).toLowerCase();
  return requestedVertical || "codepod";
}

function normalizeCodePodPartnerReward(input = {}) {
  const quantity = Math.max(0, Math.floor(Number(input.quantity || 0) || 0));

  return {
    active: input.active === true || input.active === "true",
    rewardType: "partner_reward",
    tier: "gold",
    displayTier: "GoldXtra",
    partnerName: String(input.partnerName || "").trim(),
    product: String(input.product || "").trim(),
    title: String(input.title || "").trim(),
    quantity,
    redemptionLocation: String(input.redemptionLocation || "").trim(),
    redemptionDeadline: String(input.redemptionDeadline || "").trim(),
    redemptionInstructions: String(input.redemptionInstructions || "").trim(),
    partnerLogo: String(input.partnerLogo || "").trim(),
    partnerLogoFileName: String(input.partnerLogoFileName || "").trim(),
  };
}

function parseCodePodPartnerReward(input = {}) {
  if (typeof input === "string") {
    try {
      return normalizeCodePodPartnerReward(JSON.parse(input));
    } catch {
      return normalizeCodePodPartnerReward({});
    }
  }

  return normalizeCodePodPartnerReward(input || {});
}

function normalizeCodePodDigitalSouvenir(input = {}) {
  if (typeof input === "string") {
    try {
      return normalizeCodePodDigitalSouvenir(JSON.parse(input));
    } catch {
      return normalizeCodePodDigitalSouvenir({});
    }
  }

  const normalizeTier = (tier = {}) => ({
    enabled: tier.enabled === true || tier.enabled === "true",
    title: String(tier.title || "").trim(),
    type: String(tier.type || "image").trim(),
    contentUrl: String(tier.contentUrl || tier.url || "").trim(),
    contentFileName: String(tier.contentFileName || tier.fileName || "").trim(),
    quantity: Math.max(0, Math.floor(Number(tier.quantity || 0) || 0)),
  });

  return {
    general: normalizeTier(input.general || {}),
    silver: normalizeTier(input.silver || {}),
    gold: normalizeTier(input.gold || {}),
    goldXtra: input.goldXtra || {},
  };
}

async function assignCodePodDigitalSouvenirTier(eventCode, scanId, digitalSouvenir, event = {}, deps = {}) {
  const inventory = normalizeCodePodDigitalSouvenir(digitalSouvenir || {});
  const scanKey = scanId ? `codepod:digitalSouvenir:scan:${eventCode}:${scanId}` : "";
  const redis = deps.redis;
  const redisEnabled = Boolean(deps.redisEnabled && redis);

  const buildAssignment = (tier, assignedCount = 0, quantity = 0, unlimited = false) => ({
    tier,
    assignedCount: Number(assignedCount || 0),
    quantity: Number(quantity || 0),
    remaining: unlimited ? null : Math.max(0, Number(quantity || 0) - Number(assignedCount || 0)),
    unlimited,
    exhausted: false,
    noReward: false,
  });

  if (redisEnabled) {
    if (scanKey) {
      const stored = await redis.get(scanKey);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          // Continue with a fresh assignment if the cached value is malformed.
        }
      }
    }

    const tryLimitedTier = async (tier) => {
      const quantity = Math.max(0, Math.floor(Number(inventory[tier]?.quantity || 0) || 0));
      if (quantity <= 0) return null;

      const counterKey = `codepod:digitalSouvenir:assigned:${eventCode}:${tier}`;
      const assignedCount = await redis.incr(counterKey);
      if (assignedCount <= quantity) {
        const assignment = buildAssignment(tier, assignedCount, quantity, false);
        if (scanKey) await redis.set(scanKey, JSON.stringify(assignment));
        return assignment;
      }

      await redis.decr(counterKey);
      return null;
    };

    const gold = await tryLimitedTier("gold");
    if (gold) return gold;

    const silver = await tryLimitedTier("silver");
    if (silver) return silver;

    const generalQuantity = Math.max(0, Math.floor(Number(inventory.general?.quantity || 0) || 0));
    const generalCounterKey = `codepod:digitalSouvenir:assigned:${eventCode}:general`;
    const assignedGeneral = await redis.incr(generalCounterKey);
    if (generalQuantity === 0 || assignedGeneral <= generalQuantity) {
      const assignment = buildAssignment("general", assignedGeneral, generalQuantity, generalQuantity === 0);
      if (scanKey) await redis.set(scanKey, JSON.stringify(assignment));
      return assignment;
    }

    await redis.decr(generalCounterKey);
    const exhausted = {
      ...buildAssignment("general", assignedGeneral - 1, generalQuantity, false),
      exhausted: true,
      noReward: true,
    };
    if (scanKey) await redis.set(scanKey, JSON.stringify(exhausted));
    return exhausted;
  }

  event._codepodDigitalSouvenirAssigned = event._codepodDigitalSouvenirAssigned || { gold: 0, silver: 0, general: 0 };
  event._codepodDigitalSouvenirScan = event._codepodDigitalSouvenirScan || {};

  if (scanId && event._codepodDigitalSouvenirScan[scanId]) {
    return event._codepodDigitalSouvenirScan[scanId];
  }

  const assignLocal = (tier, quantity, unlimited = false) => {
    event._codepodDigitalSouvenirAssigned[tier] = Number(event._codepodDigitalSouvenirAssigned[tier] || 0) + 1;
    const assignment = buildAssignment(tier, event._codepodDigitalSouvenirAssigned[tier], quantity, unlimited);
    if (scanId) event._codepodDigitalSouvenirScan[scanId] = assignment;
    return assignment;
  };

  const goldQuantity = Math.max(0, Math.floor(Number(inventory.gold?.quantity || 0) || 0));
  if (goldQuantity > Number(event._codepodDigitalSouvenirAssigned.gold || 0)) {
    return assignLocal("gold", goldQuantity, false);
  }

  const silverQuantity = Math.max(0, Math.floor(Number(inventory.silver?.quantity || 0) || 0));
  if (silverQuantity > Number(event._codepodDigitalSouvenirAssigned.silver || 0)) {
    return assignLocal("silver", silverQuantity, false);
  }

  const generalQuantity = Math.max(0, Math.floor(Number(inventory.general?.quantity || 0) || 0));
  if (generalQuantity === 0 || generalQuantity > Number(event._codepodDigitalSouvenirAssigned.general || 0)) {
    return assignLocal("general", generalQuantity, generalQuantity === 0);
  }

  const exhausted = {
    ...buildAssignment("general", event._codepodDigitalSouvenirAssigned.general, generalQuantity, false),
    exhausted: true,
    noReward: true,
  };
  if (scanId) event._codepodDigitalSouvenirScan[scanId] = exhausted;
  return exhausted;
}

async function assignCodePodGoldXtra(eventCode, scanId, partnerReward, deps = {}) {
  const redis = deps.redis;
  const redisEnabled = Boolean(deps.redisEnabled && redis);
  const createGoldXtraToken = deps.createGoldXtraToken;

  if (!redisEnabled || !eventCode || !scanId) return null;

  const reward = parseCodePodPartnerReward(partnerReward);
  if (!reward.active || reward.quantity <= 0) return null;

  const assignedKey = `codepod:partnerReward:assigned:${eventCode}`;
  const scanKey = `codepod:partnerReward:scan:${eventCode}:${scanId}`;

  try {
    const storedAssignment = await redis.get(scanKey);
    if (storedAssignment) {
      const assignment = JSON.parse(storedAssignment);
      if (assignment?.assigned) {
        const assignedCount = Number(await redis.get(assignedKey) || assignment.assignedCount || 0);
        if (!assignment.redemptionToken) {
          assignment.redemptionToken = await createGoldXtraToken({
            eventCode,
            scanId,
            tier: "gold",
            displayTier: "GoldXtra",
            rewardType: "partner_reward",
            status: "assigned",
            assignedCount,
            assignedAt: assignment.assignedAt || new Date().toISOString(),
          });
          await redis.set(scanKey, JSON.stringify(assignment));
        }
        return {
          ...reward,
          assigned: true,
          redemptionToken: assignment.redemptionToken || "",
          assignedAt: assignment.assignedAt || "",
          assignedCount,
          remaining: Math.max(0, reward.quantity - assignedCount),
        };
      }
      return null;
    }

    const assignedCount = await redis.incr(assignedKey);
    if (assignedCount > reward.quantity) {
      await redis.decr(assignedKey);
      return null;
    }

    const assignment = {
      assigned: true,
      assignedCount,
      assignedAt: new Date().toISOString(),
    };
    assignment.redemptionToken = await createGoldXtraToken({
      eventCode,
      scanId,
      tier: "gold",
      displayTier: "GoldXtra",
      rewardType: "partner_reward",
      status: "assigned",
      assignedCount,
      assignedAt: assignment.assignedAt,
      reward: {
        title: reward.title,
        partnerName: reward.partnerName,
        product: reward.product,
        redemptionLocation: reward.redemptionLocation,
        redemptionDeadline: reward.redemptionDeadline,
        redemptionInstructions: reward.redemptionInstructions,
        partnerLogo: reward.partnerLogo,
        partnerLogoFileName: reward.partnerLogoFileName,
      },
    });
    await redis.set(scanKey, JSON.stringify(assignment));

    return {
      ...reward,
      assigned: true,
      redemptionToken: assignment.redemptionToken,
      assignedAt: assignment.assignedAt,
      assignedCount,
      remaining: Math.max(0, reward.quantity - assignedCount),
    };
  } catch (error) {
    console.warn("codePod GoldXtra assignment failed:", error.message);
    return null;
  }
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

function normalizeCodePodKeywordAudienceEntry(input = {}) {
  const entryCode = normalizeString(input.eventCode || input.entryCode);
  const keyword = normalizeString(input.keyword);
  const warnings = [];
  const errors = [];

  if (!entryCode) {
    errors.push({
      code: "ENTRY_CODE_REQUIRED",
      message: "entryCode is required",
    });
  }

  if (!keyword) {
    errors.push({
      code: "KEYWORD_REQUIRED",
      message: "keyword is required",
    });
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

  const audienceEntry = {
    vertical: "codepod",
    entryCode,
    eventCode: entryCode,
    keyword,
    requestedVertical: normalizeRequestedVertical(input.requestedVertical),
    source: "keyword",
    transport: "message",
    metadata: {
      vertical: "codepod",
    },
  };

  const eventId = normalizeString(input.eventId);
  const messageId = normalizeString(input.messageId);
  const provider = normalizeString(input.provider);
  const providerAccountId = normalizeString(input.providerAccountId);
  const receivedAt = normalizeString(input.receivedAt);

  if (eventId) audienceEntry.eventId = eventId;
  if (messageId) audienceEntry.messageId = messageId;
  if (provider) audienceEntry.provider = provider;
  if (providerAccountId) audienceEntry.providerAccountId = providerAccountId;
  if (receivedAt) audienceEntry.receivedAt = receivedAt;

  const audienceIntent = {
    vertical: "codepod",
    intentType: "keyword",
    entryCode,
    eventCode: entryCode,
    keyword,
    source: "keyword",
    transport: "message",
  };

  if (messageId) audienceIntent.messageId = messageId;
  if (provider) audienceIntent.provider = provider;
  if (providerAccountId) audienceIntent.providerAccountId = providerAccountId;

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

function createCodePodAudienceContextSnapshot(input = {}) {
  const eventCode = normalizeString(input.eventCode);

  if (!eventCode) return null;

  return {
    vertical: "codepod",
    contextType: "audience",
    eventCode,
    eventId: normalizeString(input.eventId),
    scanId: normalizeString(input.scanId),
    audienceEntry: input.audienceEntry || null,
    audienceIntent: input.audienceIntent || null,
    source: "scan",
    transport: "http",
    metadata: {
      vertical: "codepod",
    },
  };
}

module.exports = {
  assignCodePodDigitalSouvenirTier,
  assignCodePodGoldXtra,
  createCodePodAudienceContextSnapshot,
  createCodePodInteractionSnapshot,
  normalizeCodePodDigitalSouvenir,
  normalizeCodePodKeywordAudienceEntry,
  normalizeCodePodPartnerReward,
  normalizeCodePodScanAudienceEntry,
  parseCodePodPartnerReward,
};
