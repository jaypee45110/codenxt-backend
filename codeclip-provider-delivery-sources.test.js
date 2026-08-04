const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES,
  isCodeClipProviderDeliveryInitialSource,
} = require("./verticals/codeclip/provider-delivery-sources");

test("codeClip delivery sources expose the canonical ledger allowlist", () => {
  assert.deepEqual(CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES, [
    "websub",
    "operator_reconciliation_recovery",
    "atom_reconciliation",
    "data_api_polling",
  ]);
  assert.equal(Object.isFrozen(CODECLIP_PROVIDER_DELIVERY_INITIAL_SOURCES), true);
});

test("codeClip delivery sources membership is fail-closed", () => {
  assert.equal(isCodeClipProviderDeliveryInitialSource("websub"), true);
  assert.equal(isCodeClipProviderDeliveryInitialSource(" atom_reconciliation "), true);
  assert.equal(isCodeClipProviderDeliveryInitialSource("DATA_API_POLLING"), true);
  assert.equal(isCodeClipProviderDeliveryInitialSource("provider_poll"), false);
  assert.equal(isCodeClipProviderDeliveryInitialSource("manual_bad_source"), false);
  assert.equal(isCodeClipProviderDeliveryInitialSource(""), false);
  assert.equal(isCodeClipProviderDeliveryInitialSource(null), false);
  assert.equal(isCodeClipProviderDeliveryInitialSource(123), false);
});
