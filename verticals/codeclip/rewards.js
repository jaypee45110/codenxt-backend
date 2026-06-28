function normalizeCodeClipXtra(input = {}) {
  if (typeof input === "string") {
    try {
      return normalizeCodeClipXtra(JSON.parse(input));
    } catch {
      return normalizeCodeClipXtra({});
    }
  }

  const quantity = Math.max(0, Math.floor(Number(input.quantity || 0) || 0));

  return {
    active: input.active === true || input.active === "true",
    rewardType: "clip_xtra",
    tier: "clipXtra",
    displayTier: "ClipXtra",
    partnerName: String(input.partnerName || "").trim(),
    product: String(input.product || "").trim(),
    title: String(input.title || "").trim(),
    quantity,
    redemptionLocation: String(input.redemptionLocation || "").trim(),
    redemptionDeadline: String(input.redemptionDeadline || "").trim(),
    redemptionInstructions: String(input.redemptionInstructions || "").trim(),
    partnerLogo: String(input.partnerLogo || "").trim(),
    partnerLogoFileName: String(input.partnerLogoFileName || "").trim(),
  };
}

function normalizeCodeClipRewards(input = {}) {
  if (typeof input === "string") {
    try {
      return normalizeCodeClipRewards(JSON.parse(input));
    } catch {
      return normalizeCodeClipRewards({});
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
    openClip: normalizeTier(input.openClip || {}),
    clip: normalizeTier(input.clip || {}),
    clipPlus: normalizeTier(input.clipPlus || {}),
    clipXtra: normalizeCodeClipXtra(input.clipXtra || {}),
  };
}

module.exports = {
  normalizeCodeClipRewards,
  normalizeCodeClipXtra,
};
