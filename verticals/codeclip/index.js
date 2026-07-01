const { normalizeCodeClipRewards, normalizeCodeClipXtra } = require("./rewards");
const codeClipRoutes = require("./routes");
const codeClipReport = require("./report");
const codeClipService = require("./service");
const {
  CODECLIP_CLIP_XTRA_TOKEN_KEY_PREFIX,
  buildCodeClipXtraTokenKey,
  createCodeClipXtraToken,
  createCodeClipXtraTokenValue,
} = require("./tokens");
const {
  CODECLIP_REWARD_TIERS,
  assignCodeClipRewards,
  buildCodeClipRewardAssignment,
  calculateCodeClipRewardQuantity,
} = require("./assignment");
const {
  buildCodeClipXtraValidationPayload,
  readCodeClipXtraToken,
  validateCodeClipXtraToken,
} = require("./validation");

module.exports = {
  rewards: {
    normalizeCodeClipRewards,
    normalizeCodeClipXtra,
  },
  tokens: {
    CODECLIP_CLIP_XTRA_TOKEN_KEY_PREFIX,
    buildCodeClipXtraTokenKey,
    createCodeClipXtraToken,
    createCodeClipXtraTokenValue,
  },
  assignment: {
    CODECLIP_REWARD_TIERS,
    assignCodeClipRewards,
    buildCodeClipRewardAssignment,
    calculateCodeClipRewardQuantity,
  },
  validation: {
    buildCodeClipXtraValidationPayload,
    readCodeClipXtraToken,
    validateCodeClipXtraToken,
  },
  routes: codeClipRoutes,
  report: codeClipReport,
  service: codeClipService,
};
