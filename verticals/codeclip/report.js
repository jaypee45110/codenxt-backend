function normalizeEventCode(eventCode) {
  return String(eventCode || "").trim();
}

function normalizeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function parseRawPayload(row = {}) {
  const rawPayload = row.rawPayload || row.raw_payload;
  if (!rawPayload) return {};
  if (typeof rawPayload === "string") {
    try {
      return JSON.parse(rawPayload) || {};
    } catch {
      return {};
    }
  }
  if (typeof rawPayload === "object") return rawPayload;
  return {};
}

function isRoutingMatch(interaction = {}) {
  return getRoutingOutcome(interaction) === "MATCH";
}

function getRoutingOutcome(interaction = {}) {
  const rawPayload = parseRawPayload(interaction);
  return String(interaction.routingOutcome || interaction.routing_outcome || rawPayload.routingOutcome || "").trim();
}

function getPersistenceSeverity(interaction = {}) {
  const rawPayload = parseRawPayload(interaction);
  return String(
    interaction.persistenceSeverity ||
    interaction.persistence_severity ||
    interaction.persistenceGuaranteePolicy?.severity ||
    interaction.persistence_guarantee_policy?.severity ||
    rawPayload.persistenceGuaranteePolicy?.severity ||
    rawPayload.persistenceDecision?.severity ||
    ""
  ).trim().toLowerCase();
}

function buildRuntimeSummary(interactions = []) {
  const summary = {
    totalInteractions: interactions.length,
    matched: 0,
    noCampaignMatch: 0,
    routingConflict: 0,
    routingOutcomes: {
      MATCH: 0,
      NO_CAMPAIGN_MATCH: 0,
      ROUTING_CONFLICT: 0,
    },
    persistence: {
      ok: 0,
      degraded: 0,
      critical: 0,
    },
  };

  for (const interaction of interactions) {
    const routingOutcome = getRoutingOutcome(interaction);
    if (routingOutcome === "MATCH") {
      summary.matched += 1;
      summary.routingOutcomes.MATCH += 1;
    } else if (routingOutcome === "NO_CAMPAIGN_MATCH") {
      summary.noCampaignMatch += 1;
      summary.routingOutcomes.NO_CAMPAIGN_MATCH += 1;
    } else if (routingOutcome === "ROUTING_CONFLICT") {
      summary.routingConflict += 1;
      summary.routingOutcomes.ROUTING_CONFLICT += 1;
    }

    const persistenceSeverity = getPersistenceSeverity(interaction);
    if (Object.hasOwn(summary.persistence, persistenceSeverity)) {
      summary.persistence[persistenceSeverity] += 1;
    }
  }

  return summary;
}

function normalizeTimestamp(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function groupRewardAssignmentsByScanId(assignments = []) {
  return assignments.reduce((groups, assignment) => {
    const rawPayload = parseRawPayload(assignment);
    const scanId = String(assignment.scanId || assignment.scan_id || rawPayload.scanId || "").trim();
    if (!scanId) return groups;
    if (!groups.has(scanId)) groups.set(scanId, []);
    groups.get(scanId).push({ ...assignment, rawPayload });
    return groups;
  }, new Map());
}

function mapRegistrations(registrations = [], eventCode) {
  return registrations.map((registration, index) => ({
    eventCode: registration.eventCode || registration.event_code || eventCode,
    eventId: registration.eventId || registration.event_id || "",
    scanId: registration.scanId || registration.scan_id || `registration-${index + 1}`,
    phone: registration.phone || "",
    timestamp: normalizeTimestamp(registration.timestamp || registration.created_at),
    tier: registration.tier || "",
    displayTier: registration.displayTier || registration.display_tier || registration.tier || "",
    source: registration.source || "inside",
  }));
}

function findClipXtraAssignment(assignments = []) {
  return assignments.find((assignment) => {
    const tier = String(assignment.tier || assignment.rawPayload?.tier || assignment.rawPayload?.assignment?.tier || "").trim();
    return tier === "clipXtra" && assignment.assigned === true;
  }) || null;
}

function mapInteractionToReportRow(interaction, assignmentsByScanId, phoneByScanId, eventCode) {
  const rawPayload = parseRawPayload(interaction);
  const scanId = String(interaction.scanId || interaction.scan_id || rawPayload.scanId || "").trim();
  const assignments = assignmentsByScanId.get(scanId) || [];
  const clipXtra = findClipXtraAssignment(assignments);
  const redemptionToken = clipXtra?.redemptionToken || clipXtra?.redemption_token || clipXtra?.rawPayload?.redemptionToken || clipXtra?.rawPayload?.assignment?.redemptionToken || "";
  const tier = interaction.tier || rawPayload.tier || "";
  const displayTier = redemptionToken ? "ClipXtra" : (tier === "clipPlus" ? "Clip+" : tier);

  return {
    eventCode: interaction.eventCode || interaction.event_code || rawPayload.eventCode || eventCode,
    eventId: interaction.eventId || interaction.event_id || rawPayload.eventId || "",
    scanId,
    phone: phoneByScanId.get(scanId) || "",
    scanRank: interaction.scanRank ?? interaction.scan_rank ?? rawPayload.scanRank ?? null,
    timestamp: normalizeTimestamp(interaction.timestamp || interaction.created_at || rawPayload.timestamp),
    tier,
    digitalSouvenirTier: tier,
    displayTier,
    rewardType: redemptionToken ? (clipXtra?.rewardType || clipXtra?.reward_type || "clip_xtra") : "",
    goldXtraAssigned: Boolean(redemptionToken),
    redemptionToken,
    redemptionStatus: clipXtra?.redemptionStatus || clipXtra?.redemption_status || "",
    redeemedAt: clipXtra?.redeemedAt || clipXtra?.redeemed_at || null,
    alreadyRedeemedAttempts: normalizeNumber(clipXtra?.alreadyRedeemedAttempts || clipXtra?.already_redeemed_attempts),
    source: "qr",
  };
}

function createEmptyMetrics(scanSummary = {}, registrationCount = 0, rewardSummary = {}) {
  const scans = normalizeNumber(scanSummary.scans);
  const uniqueScans = normalizeNumber(scanSummary.uniqueScans || scanSummary.unique_scans);
  const joins = normalizeNumber(registrationCount);
  const clipXtraAssigned = normalizeNumber(rewardSummary.assignedByTier?.clipXtra || rewardSummary.clipXtraWithTokenCount);

  return {
    scans,
    uniqueScans,
    joins,
    registrations: joins,
    openClip: normalizeNumber(rewardSummary.assignedByTier?.openClip),
    clip: normalizeNumber(rewardSummary.assignedByTier?.clip),
    clipPlus: normalizeNumber(rewardSummary.assignedByTier?.clipPlus),
    clipXtraAssigned,
    gold: normalizeNumber(rewardSummary.assignedByTier?.openClip),
    silver: normalizeNumber(rewardSummary.assignedByTier?.clip),
    general: normalizeNumber(rewardSummary.assignedByTier?.clipPlus),
    goldXtraAssigned: clipXtraAssigned,
    alreadyRedeemedAttempts: 0,
  };
}

async function buildCodeClipReport(eventCode, deps = {}) {
  const code = normalizeEventCode(eventCode);
  const {
    getCodeClipInteractions = async () => [],
    getCodeClipRewardAssignments = async () => [],
    getCodeClipRewardAssignmentSummary = async () => ({}),
    getEventScanSummary = async () => ({ scans: 0, uniqueScans: 0 }),
    getEventRegistrations = async () => [],
    getEventRegistrationSummary = async () => ({ registrations: 0 }),
  } = deps;

  const [interactions, rewardAssignments, rewardSummary, scanSummary, registrations, registrationSummary] = await Promise.all([
    code ? getCodeClipInteractions(code, 500) : [],
    code ? getCodeClipRewardAssignments(code, 500) : [],
    code ? getCodeClipRewardAssignmentSummary(code) : {},
    code ? getEventScanSummary(code) : { scans: 0, uniqueScans: 0 },
    code ? getEventRegistrations(code, 1000) : [],
    code ? getEventRegistrationSummary(code) : { registrations: 0 },
  ]);

  const registrationRows = mapRegistrations(registrations, code);
  const phoneByScanId = new Map(
    registrationRows
      .filter((registration) => registration.scanId && registration.phone)
      .map((registration) => [String(registration.scanId), String(registration.phone)])
  );
  const assignmentsByScanId = groupRewardAssignmentsByScanId(rewardAssignments);
  const runtimeSummary = buildRuntimeSummary(interactions);
  const rows = interactions
    .filter(isRoutingMatch)
    .map((interaction) => mapInteractionToReportRow(interaction, assignmentsByScanId, phoneByScanId, code));

  const metrics = createEmptyMetrics(
    rows.length ? { scans: rows.length, uniqueScans: new Set(rows.map((row) => row.scanId).filter(Boolean)).size } : scanSummary,
    normalizeNumber(registrationSummary.registrations || registrationRows.length),
    rewardSummary
  );

  if (rows.length) {
    metrics.clipXtraAssigned = rows.filter((row) => row.goldXtraAssigned).length;
    metrics.goldXtraAssigned = metrics.clipXtraAssigned;
    metrics.alreadyRedeemedAttempts = rows.reduce((sum, row) => sum + normalizeNumber(row.alreadyRedeemedAttempts), 0);
  }

  return {
    ok: true,
    vertical: "codeclip",
    eventCode: code,
    event: { eventCode: code },
    totalScans: metrics.scans,
    uniqueScans: metrics.uniqueScans,
    joins: metrics.joins,
    registrationCount: metrics.registrations,
    rows,
    registrations: registrationRows,
    metrics,
    runtimeSummary,
    scans: rows,
  };
}

module.exports = {
  buildCodeClipReport,
  buildRuntimeSummary,
  groupRewardAssignmentsByScanId,
};
