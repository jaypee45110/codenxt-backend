const { normalizeCodeClipRewards } = require("./rewards");
const { createCodeClipXtraToken } = require("./tokens");

const CODECLIP_REWARD_TIERS = ["clipPlus", "clip", "openClip"];

const REWARD_ASSIGNMENT_STATES = {
  ASSIGNED: "assigned",
  UNAVAILABLE: "unavailable",
};

const CODECLIP_FAILURE_REASONS = {
  REDIS_REQUIRED: "redis_required",
};

function buildCodeClipRewardAssignment(tier, reward = {}, assignedCount = 0, quantity = 0, unlimited = false) {
  return {
    assigned: true,
    tier,
    displayTier: tier === "clipPlus" ? "Clip+" : tier === "clip" ? "Clip" : "OpenClip",
    title: reward.title || "",
    type: reward.type || "image",
    contentUrl: reward.contentUrl || "",
    contentFileName: reward.contentFileName || "",
    assignedCount: Number(assignedCount || 0),
    quantity: Number(quantity || 0),
    remaining: unlimited ? null : Math.max(0, Number(quantity || 0) - Number(assignedCount || 0)),
    unlimited,
    assignedAt: new Date().toISOString(),
  };
}

function calculateCodeClipRewardQuantity(tier, reward = {}) {
  if (tier === "openClip") return Number(reward.quantity || 0);
  return Math.max(0, Math.floor(Number(reward.quantity || 0) || 0));
}

function createRewardAssignmentResult() {
  return {};
}

function setRewardAssignment(result, tier, assignment) {
  result[tier] = assignment;
}

async function assignCodeClipRewards({ redis, eventCode, scanId, rewards }) {
  const inventory = normalizeCodeClipRewards(rewards || {});
  const rewardAssignmentResult = createRewardAssignmentResult();

  for (const tier of CODECLIP_REWARD_TIERS) {
    const reward = inventory[tier];
    if (!reward?.enabled) continue;

    const quantity = calculateCodeClipRewardQuantity(tier, reward);
    const unlimited = tier === "openClip" && quantity === 0;

    if (!redis || !eventCode || !scanId || unlimited) {
      setRewardAssignment(rewardAssignmentResult, tier, buildCodeClipRewardAssignment(tier, reward, 0, quantity, unlimited));
      continue;
    }

    const assignedKey = `codeclip:reward:assigned:${eventCode}:${tier}`;
    const scanKey = `codeclip:reward:scan:${eventCode}:${scanId}:${tier}`;

    const storedScanAssignment = await redis.get(scanKey);
    if (storedScanAssignment) {
      setRewardAssignment(rewardAssignmentResult, tier, JSON.parse(storedScanAssignment));
      continue;
    }

    const assignedCount = Number(await redis.incr(assignedKey));
    if (quantity > 0 && assignedCount > quantity) {
      setRewardAssignment(rewardAssignmentResult, tier, {
        assigned: false,
        tier,
        displayTier: tier === "clipPlus" ? "Clip+" : tier === "clip" ? "Clip" : "OpenClip",
        exhausted: true,
        noReward: true,
        quantity,
        assignedCount,
        remaining: 0,
      });
      await redis.decr(assignedKey);
      continue;
    }

    const assignment = buildCodeClipRewardAssignment(tier, reward, assignedCount, quantity, unlimited);
    await redis.set(scanKey, JSON.stringify(assignment));
    setRewardAssignment(rewardAssignmentResult, tier, assignment);
  }

  const clipXtra = inventory.clipXtra;
  if (clipXtra?.active && clipXtra.quantity > 0 && (!redis || !eventCode || !scanId)) {
    setRewardAssignment(rewardAssignmentResult, "clipXtra", {
      ...clipXtra,
      assigned: false,
      status: REWARD_ASSIGNMENT_STATES.UNAVAILABLE,
      reason: CODECLIP_FAILURE_REASONS.REDIS_REQUIRED,
      requiresRedis: true,
    });
  }

  if (clipXtra?.active && clipXtra.quantity > 0 && redis && eventCode && scanId) {
    const assignedKey = `codeclip:clipXtra:assigned:${eventCode}`;
    const scanKey = `codeclip:clipXtra:scan:${eventCode}:${scanId}`;

    const storedClipXtra = await redis.get(scanKey);
    if (storedClipXtra) {
      setRewardAssignment(rewardAssignmentResult, "clipXtra", JSON.parse(storedClipXtra));
    } else {
      const assignedCount = Number(await redis.incr(assignedKey));
      if (assignedCount <= clipXtra.quantity) {
        const redemptionToken = await createCodeClipXtraToken(redis, {
          eventCode,
          scanId,
          tier: "clipXtra",
          displayTier: "ClipXtra",
          rewardType: "clip_xtra",
          status: REWARD_ASSIGNMENT_STATES.ASSIGNED,
          assignedCount,
          assignedAt: new Date().toISOString(),
        });

        const clipXtraAssignment = {
          ...clipXtra,
          assigned: true,
          redemptionToken,
          assignedCount,
          remaining: Math.max(0, clipXtra.quantity - assignedCount),
          assignedAt: new Date().toISOString(),
        };
        setRewardAssignment(rewardAssignmentResult, "clipXtra", clipXtraAssignment);
        await redis.set(scanKey, JSON.stringify(clipXtraAssignment));
      } else {
        await redis.decr(assignedKey);
      }
    }
  }

  return rewardAssignmentResult;
}

module.exports = {
  CODECLIP_REWARD_TIERS,
  assignCodeClipRewards,
  buildCodeClipRewardAssignment,
  calculateCodeClipRewardQuantity,
};
