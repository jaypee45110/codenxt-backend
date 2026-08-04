/**
 * Platform-canonical codeClip provider delivery ledger sources.
 * Authoritative allowlist for initial_delivery_source values.
 * Must stay aligned with db.js CHECK on codeclip_provider_deliveries.
 * F1B: validation helper only — db.js does not consume this module yet.
 */

const CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES = Object.freeze([
  "websub",
  "operator_reconciliation_recovery",
  "atom_reconciliation",
  "data_api_polling",
]);

const CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCE_SET = new Set(
  CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES
);

/**
 * Returns true when value is a known canonical delivery source.
 * Membership only — not a competing normalizer for ledger writes.
 */
function isCodeClipProviderDeliveryInitialSource(value) {
  if (typeof value !== "string") return false;
  return CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCE_SET.has(value.trim().toLowerCase());
}

module.exports = {
  CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES,
  isCodeClipProviderDeliveryInitialSource,
};
