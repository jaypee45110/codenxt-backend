/**
 * Production provider polling adapter registry factory.
 *
 * Foundation only: creates isolated registries and registers TikTok. No worker,
 * routes, env eager-load, poll-source creation, or global singleton.
 */

const {
  createCodeClipProviderPollAdapterRegistry,
} = require("./adapter-registry");
const {
  createCodeClipTikTokPollAdapter,
} = require("../tiktok/poll-adapter");

function createCodeClipProductionPollAdapterRegistry(options = {}) {
  const registry = createCodeClipProviderPollAdapterRegistry();
  registry.register(createCodeClipTikTokPollAdapter(options.tiktok || {}));
  return registry;
}

module.exports = {
  createCodeClipProductionPollAdapterRegistry,
};
