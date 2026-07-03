function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeRequestedVertical(value) {
  const requestedVertical = normalizeString(value).toLowerCase();
  return requestedVertical || "codepod";
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
  createCodePodAudienceContextSnapshot,
  createCodePodInteractionSnapshot,
  normalizeCodePodDigitalSouvenir,
  normalizeCodePodScanAudienceEntry,
};
