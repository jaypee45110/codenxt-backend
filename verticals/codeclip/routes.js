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

module.exports = {
  attachCodeClipRewardsToEvent,
  attachCodeClipRewardsToEventMeta,
  normalizeCodeClipEventRewards,
};
