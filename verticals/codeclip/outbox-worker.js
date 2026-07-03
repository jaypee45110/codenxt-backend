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

async function processCodeClipOutboxBatch({
  limit = 10,
  now = null,
  maxAttempts = 5,
  retryDelayMs = 60000,
  claimCodeClipOutboxEvents,
  markCodeClipOutboxEventSucceeded,
  markCodeClipOutboxEventFailed,
  markCodeClipOutboxEventDeadLetter,
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
  processCodeClipOutboxBatch,
};
