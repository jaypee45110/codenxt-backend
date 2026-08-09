/**
 * Production provider credential refresh registry for polling.
 *
 * Provider-specific refresh orchestration is kept out of the generic polling
 * service. This module wires production providers into a small provider keyed
 * registry, mirroring the production poll adapter registry.
 */

const {
  refreshCodeClipTikTokCredential,
} = require("../tiktok/credential-refresh");

function normalizeProvider(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) return "";
  return normalized;
}

function createCodeClipProductionCredentialRefreshRegistry(options = {}) {
  const refreshers = new Map();
  const tiktokOptions =
    options.tiktok && typeof options.tiktok === "object" ? options.tiktok : {};

  refreshers.set("tiktok", async (input, runtimeOptions = {}) =>
    refreshCodeClipTikTokCredential(input, {
      ...runtimeOptions,
      ...tiktokOptions,
    })
  );

  return Object.freeze({
    get(provider) {
      const normalized = normalizeProvider(provider);
      if (!normalized) return null;
      return refreshers.get(normalized) || null;
    },
    list() {
      return Array.from(refreshers.keys()).map((provider) =>
        Object.freeze({ provider })
      );
    },
  });
}

module.exports = {
  createCodeClipProductionCredentialRefreshRegistry,
};
