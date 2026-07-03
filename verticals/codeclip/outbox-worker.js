function createZeroSummary(extra = {}) {
  return {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    failed: 0,
    ...extra,
  };
}

function normalizeOutboxLimit(limit = 10) {
  const parsed = Number.parseInt(String(limit || 10), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return parsed;
}

function normalizeMaxAttempts(maxAttempts = 5) {
  const parsed = Number.parseInt(String(maxAttempts || 5), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}

function resolveAvailableAt(now = null, retryDelayMs = 60000) {
  const baseTime = now ? new Date(now).getTime() : Date.now();
  const safeBaseTime = Number.isFinite(baseTime) ? baseTime : Date.now();
  const delay = Number.isFinite(Number(retryDelayMs)) ? Number(retryDelayMs) : 60000;
  return new Date(safeBaseTime + delay).toISOString();
}

function getOutboxEventType(event = {}) {
  return String(event.event_type || event.eventType || "").trim();
}

function getAttemptCount(event = {}) {
  const parsed = Number.parseInt(String(event.attempt_count ?? event.attemptCount ?? 0), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

async function recoverPersistenceActionEvent(event = {}, {
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
} = {}) {
  const failedSteps = Array.isArray(event.payload?.persistenceDecision?.failedSteps)
    ? event.payload.persistenceDecision.failedSteps
    : [];
  const recovery = event.payload?.recovery || {};

  if (!failedSteps.length) return;

  for (const step of failedSteps) {
    if (step === "interaction") {
      if (!saveCodeClipInteraction) {
        throw new Error("codeClip outbox recovery missing saveCodeClipInteraction");
      }
      if (!recovery.interaction) {
        throw new Error("codeClip outbox recovery missing interaction payload");
      }
      await saveCodeClipInteraction(recovery.interaction);
      continue;
    }

    if (step === "rewardAssignments") {
      if (!saveCodeClipRewardAssignments) {
        throw new Error("codeClip outbox recovery missing saveCodeClipRewardAssignments");
      }
      if (!recovery.rewardAssignmentSnapshot) {
        throw new Error("codeClip outbox recovery missing reward assignment payload");
      }
      await saveCodeClipRewardAssignments(recovery.rewardAssignmentSnapshot);
      continue;
    }

    if (step === "clipXtraRedemption") {
      if (!saveCodeClipXtraRedemption) {
        throw new Error("codeClip outbox recovery missing saveCodeClipXtraRedemption");
      }
      if (!recovery.clipXtraRedemption) {
        throw new Error("codeClip outbox recovery missing ClipXtra redemption payload");
      }
      await saveCodeClipXtraRedemption(recovery.clipXtraRedemption);
      continue;
    }

    throw new Error(`Unsupported codeClip persistence recovery step: ${step}`);
  }
}

async function processCodeClipOutboxBatch({
  limit = 10,
  now = null,
  maxAttempts = 5,
  retryDelayMs = 60000,
  claimCodeClipOutboxEvents,
  markCodeClipOutboxEventSucceeded,
  markCodeClipOutboxEventFailed,
  markCodeClipOutboxEventDeadLetter,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  saveCodeClipXtraRedemption,
  logger = console,
} = {}) {
  if (!claimCodeClipOutboxEvents) return createZeroSummary();

  const summary = createZeroSummary();
  const safeLimit = normalizeOutboxLimit(limit);
  const safeMaxAttempts = normalizeMaxAttempts(maxAttempts);

  let events = [];
  try {
    events = await claimCodeClipOutboxEvents({ limit: safeLimit, now });
  } catch (error) {
    summary.failed += 1;
    if (logger?.warn) {
      logger.warn("codeClip outbox claim failed", { error: error.message });
    }
    return summary;
  }

  const claimedEvents = Array.isArray(events) ? events : [];
  summary.claimed = claimedEvents.length;

  async function retryOrDeadLetter(event, error) {
    const attemptCount = getAttemptCount(event);
    const id = event?.id;

    if (attemptCount >= safeMaxAttempts) {
      if (!markCodeClipOutboxEventDeadLetter) {
        summary.failed += 1;
        return;
      }
      try {
        await markCodeClipOutboxEventDeadLetter({
          id,
          error: error?.message || String(error || "unknown outbox failure"),
        });
        summary.deadLettered += 1;
      } catch (markError) {
        summary.failed += 1;
        if (logger?.warn) {
          logger.warn("codeClip outbox dead-letter mark failed", { id, error: markError.message });
        }
      }
      return;
    }

    if (!markCodeClipOutboxEventFailed) {
      summary.failed += 1;
      return;
    }

    try {
      await markCodeClipOutboxEventFailed({
        id,
        error: error?.message || String(error || "unknown outbox failure"),
        availableAt: resolveAvailableAt(now, retryDelayMs),
      });
      summary.retried += 1;
    } catch (markError) {
      summary.failed += 1;
      if (logger?.warn) {
        logger.warn("codeClip outbox failed mark failed", { id, error: markError.message });
      }
    }
  }

  for (const event of claimedEvents) {
    try {
      if (getOutboxEventType(event) === "codeclip.persistence_action") {
        if (!markCodeClipOutboxEventSucceeded) {
          summary.failed += 1;
          continue;
        }
        await recoverPersistenceActionEvent(event, {
          saveCodeClipInteraction,
          saveCodeClipRewardAssignments,
          saveCodeClipXtraRedemption,
        });
        await markCodeClipOutboxEventSucceeded(event.id);
        summary.succeeded += 1;
        continue;
      }

      await retryOrDeadLetter(event, new Error(`Unsupported codeClip outbox event type: ${getOutboxEventType(event) || "unknown"}`));
    } catch (error) {
      if (logger?.warn) {
        logger.warn("codeClip outbox event processing failed", { id: event?.id, error: error.message });
      }
      await retryOrDeadLetter(event, error);
    }
  }

  return summary;
}

module.exports = {
  recoverPersistenceActionEvent,
  processCodeClipOutboxBatch,
};
