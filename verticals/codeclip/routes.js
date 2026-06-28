const { normalizeCodeClipRewards } = require("./rewards");

function normalizeCodeClipEventRewards(rewards = {}) {
  return normalizeCodeClipRewards(rewards || {});
}

function attachCodeClipRewardsToEvent(event, rewards = {}) {
  const normalizedRewards = normalizeCodeClipEventRewards(rewards);
  return {
    ...event,
    rewards: normalizedRewards,
  };
}

function attachCodeClipRewardsToEventMeta(eventMeta, rewards = {}) {
  const normalizedRewards = normalizeCodeClipEventRewards(rewards);
  return {
    ...eventMeta,
    rewards: JSON.stringify(normalizedRewards),
  };
}

function parseCodeClipRewardsMeta(meta = {}) {
  if (!meta || typeof meta.rewards !== "string") return meta;

  try {
    return {
      ...meta,
      rewards: JSON.parse(meta.rewards),
    };
  } catch {
    return {
      ...meta,
      rewards: {},
    };
  }
}

function attachCodeClipRewardsToNormalizedMeta(normalizedMeta, meta = {}) {
  return {
    ...normalizedMeta,
    rewards: normalizeCodeClipEventRewards(meta?.rewards || {}),
  };
}

module.exports = {
  attachCodeClipRewardsToEvent,
  attachCodeClipRewardsToEventMeta,
  attachCodeClipRewardsToNormalizedMeta,
  normalizeCodeClipEventRewards,
  parseCodeClipRewardsMeta,
};
