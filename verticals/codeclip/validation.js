const { buildCodeClipXtraTokenKey } = require("./tokens");

function buildCodeClipXtraValidationPayload(clipXtra = {}) {
  return {
    ok: true,
    valid: true,
    vertical: "codeclip",
    rewardType: "clip_xtra",
    tier: "clipXtra",
    displayTier: "ClipXtra",
    token: clipXtra.token || "",
    eventCode: clipXtra.eventCode || "",
    scanId: clipXtra.scanId || "",
    status: clipXtra.status || "assigned",
    assignedAt: clipXtra.assignedAt || "",
    assignedCount: Number(clipXtra.assignedCount || 0),
    partnerName: clipXtra.partnerName || "",
    product: clipXtra.product || "",
    title: clipXtra.title || "",
    redemptionLocation: clipXtra.redemptionLocation || "",
    redemptionDeadline: clipXtra.redemptionDeadline || "",
    redemptionInstructions: clipXtra.redemptionInstructions || "",
    partnerLogo: clipXtra.partnerLogo || "",
    partnerLogoFileName: clipXtra.partnerLogoFileName || "",
  };
}

async function readCodeClipXtraToken(redis, token) {
  if (!redis || !token) return null;

  const raw = await redis.get(buildCodeClipXtraTokenKey(token));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function validateCodeClipXtraToken(redis, token) {
  const clipXtra = await readCodeClipXtraToken(redis, token);
  if (!clipXtra) {
    return {
      valid: false,
      vertical: "codeclip",
      rewardType: "clip_xtra",
      tier: "clipXtra",
      displayTier: "ClipXtra",
      token: token || "",
      status: "missing",
    };
  }

  return buildCodeClipXtraValidationPayload(clipXtra);
}

module.exports = {
  buildCodeClipXtraValidationPayload,
  readCodeClipXtraToken,
  validateCodeClipXtraToken,
};
