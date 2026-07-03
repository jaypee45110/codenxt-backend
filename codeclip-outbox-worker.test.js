const test = require('node:test');
const assert = require('node:assert/strict');

const {
  processCodeClipOutboxBatch,
} = require('./verticals/codeclip/outbox-worker');

test('codeClip outbox worker returns zero summary without claim helper', async () => {
  const summary = await processCodeClipOutboxBatch();

  assert.deepEqual(summary, {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
});

test('codeClip outbox worker marks known persistence action events succeeded', async () => {
  const calls = [];
  const summary = await processCodeClipOutboxBatch({
    limit: 3,
    now: '2026-07-01T00:00:00.000Z',
    async claimCodeClipOutboxEvents(args) {
      calls.push({ method: 'claim', args });
      return [
        {
          id: 101,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
        },
      ];
    },
    async markCodeClipOutboxEventSucceeded(id) {
      calls.push({ method: 'succeeded', id });
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 1,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
  assert.deepEqual(calls, [
    { method: 'claim', args: { limit: 3, now: '2026-07-01T00:00:00.000Z' } },
    { method: 'succeeded', id: 101 },
  ]);
});

test('codeClip outbox worker recovers failed interaction persistence before succeeding', async () => {
  const savedInteractions = [];
  const succeeded = [];
  const recoveryInteraction = {
    eventCode: 'CC-RECOVER-INTERACTION',
    scanId: 'scan-recover-interaction',
    state: 'processed',
  };

  const summary = await processCodeClipOutboxBatch({
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 111,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['interaction'] },
            recovery: { interaction: recoveryInteraction },
          },
        },
      ];
    },
    async saveCodeClipInteraction(interaction) {
      savedInteractions.push(interaction);
    },
    async markCodeClipOutboxEventSucceeded(id) {
      succeeded.push(id);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 1,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
  assert.deepEqual(savedInteractions, [recoveryInteraction]);
  assert.deepEqual(succeeded, [111]);
});

test('codeClip outbox worker recovers failed reward assignment persistence before succeeding', async () => {
  const savedSnapshots = [];
  const succeeded = [];
  const rewardAssignmentSnapshot = {
    eventCode: 'CC-RECOVER-REWARDS',
    scanId: 'scan-recover-rewards',
    assignments: [{ tier: 'openClip', assigned: true }],
  };

  const summary = await processCodeClipOutboxBatch({
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 112,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['rewardAssignments'] },
            recovery: { rewardAssignmentSnapshot },
          },
        },
      ];
    },
    async saveCodeClipRewardAssignments(snapshot) {
      savedSnapshots.push(snapshot);
    },
    async markCodeClipOutboxEventSucceeded(id) {
      succeeded.push(id);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 1,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
  assert.deepEqual(savedSnapshots, [rewardAssignmentSnapshot]);
  assert.deepEqual(succeeded, [112]);
});

test('codeClip outbox worker recovers interaction and reward assignment failures before succeeding', async () => {
  const calls = [];
  const recoveryInteraction = {
    eventCode: 'CC-RECOVER-BOTH',
    scanId: 'scan-recover-both',
  };
  const rewardAssignmentSnapshot = {
    eventCode: 'CC-RECOVER-BOTH',
    scanId: 'scan-recover-both',
    assignments: [{ tier: 'clipPlus', assigned: true }],
  };

  const summary = await processCodeClipOutboxBatch({
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 113,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['interaction', 'rewardAssignments'] },
            recovery: {
              interaction: recoveryInteraction,
              rewardAssignmentSnapshot,
            },
          },
        },
      ];
    },
    async saveCodeClipInteraction(interaction) {
      calls.push({ method: 'interaction', interaction });
    },
    async saveCodeClipRewardAssignments(snapshot) {
      calls.push({ method: 'rewardAssignments', snapshot });
    },
    async markCodeClipOutboxEventSucceeded(id) {
      calls.push({ method: 'succeeded', id });
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 1,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
  assert.deepEqual(calls, [
    { method: 'interaction', interaction: recoveryInteraction },
    { method: 'rewardAssignments', snapshot: rewardAssignmentSnapshot },
    { method: 'succeeded', id: 113 },
  ]);
});

test('codeClip outbox worker reschedules persistence action when recovery interaction is missing', async () => {
  const failedCalls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 60000,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 114,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['interaction'] },
            recovery: {},
          },
        },
      ];
    },
    async saveCodeClipInteraction() {
      throw new Error('should not be called without recovery interaction');
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('should not succeed without recovery interaction');
    },
    async markCodeClipOutboxEventFailed(args) {
      failedCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 114);
  assert.equal(failedCalls[0].availableAt, '2026-07-01T00:01:00.000Z');
  assert.match(failedCalls[0].error, /missing interaction payload/);
});

test('codeClip outbox worker recovers failed ClipXtra redemption persistence before succeeding', async () => {
  const savedRedemptions = [];
  const succeeded = [];
  const clipXtraRedemption = {
    token: 'CX-RECOVER-CLIPXTRA',
    eventCode: 'CC-RECOVER-CLIPXTRA',
    scanId: 'scan-recover-clipxtra',
    tier: 'clipXtra',
  };

  const summary = await processCodeClipOutboxBatch({
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 115,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['clipXtraRedemption'] },
            recovery: { clipXtraRedemption },
          },
        },
      ];
    },
    async saveCodeClipXtraRedemption(record) {
      savedRedemptions.push(record);
    },
    async markCodeClipOutboxEventSucceeded(id) {
      succeeded.push(id);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 1,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  });
  assert.deepEqual(savedRedemptions, [clipXtraRedemption]);
  assert.deepEqual(succeeded, [115]);
});

test('codeClip outbox worker reschedules ClipXtra recovery when redemption payload is missing', async () => {
  const failedCalls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 60000,
    maxAttempts: 5,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 115,
          event_type: 'codeclip.persistence_action',
          attempt_count: 2,
          payload: {
            persistenceDecision: { failedSteps: ['clipXtraRedemption'] },
            recovery: {},
          },
        },
      ];
    },
    async saveCodeClipXtraRedemption() {
      throw new Error('should not be called without ClipXtra redemption payload');
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('should not succeed without ClipXtra redemption payload');
    },
    async markCodeClipOutboxEventFailed(args) {
      failedCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 115);
  assert.match(failedCalls[0].error, /missing ClipXtra redemption payload/);
});

test('codeClip outbox worker reschedules when ClipXtra recovery save fails', async () => {
  const failedCalls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 60000,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 116,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['clipXtraRedemption'] },
            recovery: {
              clipXtraRedemption: {
                token: 'CX-RECOVERY-SAVE-FAIL',
                eventCode: 'CC-RECOVERY-SAVE-FAIL',
                scanId: 'scan-recovery-save-fail',
              },
            },
          },
        },
      ];
    },
    async saveCodeClipXtraRedemption() {
      throw new Error('ClipXtra recovery save failed');
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('should not succeed when ClipXtra recovery save fails');
    },
    async markCodeClipOutboxEventFailed(args) {
      failedCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 116);
  assert.equal(failedCalls[0].availableAt, '2026-07-01T00:01:00.000Z');
  assert.equal(failedCalls[0].error, 'ClipXtra recovery save failed');
});

test('codeClip outbox worker dead-letters ClipXtra recovery when payload is missing at max attempts', async () => {
  const deadLetterCalls = [];
  const summary = await processCodeClipOutboxBatch({
    maxAttempts: 5,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 118,
          event_type: 'codeclip.persistence_action',
          attempt_count: 5,
          payload: {
            persistenceDecision: { failedSteps: ['clipXtraRedemption'] },
            recovery: {},
          },
        },
      ];
    },
    async saveCodeClipXtraRedemption() {
      throw new Error('should not be called without ClipXtra redemption payload');
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('should not succeed without ClipXtra redemption payload');
    },
    async markCodeClipOutboxEventDeadLetter(args) {
      deadLetterCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 0,
    deadLettered: 1,
    failed: 0,
  });
  assert.equal(deadLetterCalls.length, 1);
  assert.equal(deadLetterCalls[0].id, 118);
  assert.match(deadLetterCalls[0].error, /missing ClipXtra redemption payload/);
});

test('codeClip outbox worker reschedules when persistence recovery save fails', async () => {
  const failedCalls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 60000,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 117,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
          payload: {
            persistenceDecision: { failedSteps: ['interaction'] },
            recovery: {
              interaction: {
                eventCode: 'CC-RECOVERY-SAVE-FAIL',
                scanId: 'scan-recovery-save-fail',
              },
            },
          },
        },
      ];
    },
    async saveCodeClipInteraction() {
      throw new Error('interaction recovery save failed');
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('should not succeed when recovery save fails');
    },
    async markCodeClipOutboxEventFailed(args) {
      failedCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 117);
  assert.equal(failedCalls[0].availableAt, '2026-07-01T00:01:00.000Z');
  assert.equal(failedCalls[0].error, 'interaction recovery save failed');
});

test('codeClip outbox worker reschedules unknown events below max attempts', async () => {
  const calls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 120000,
    maxAttempts: 5,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 201,
          event_type: 'codeclip.unknown_event',
          attempt_count: 2,
        },
      ];
    },
    async markCodeClipOutboxEventFailed(args) {
      calls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 201);
  assert.equal(calls[0].availableAt, '2026-07-01T00:02:00.000Z');
  assert.match(calls[0].error, /Unsupported codeClip outbox event type/);
});

test('codeClip outbox worker dead-letters unknown events at max attempts', async () => {
  const calls = [];
  const summary = await processCodeClipOutboxBatch({
    maxAttempts: 5,
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 301,
          event_type: 'codeclip.unknown_event',
          attempt_count: 5,
        },
      ];
    },
    async markCodeClipOutboxEventDeadLetter(args) {
      calls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 0,
    deadLettered: 1,
    failed: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 301);
  assert.match(calls[0].error, /Unsupported codeClip outbox event type/);
});

test('codeClip outbox worker reschedules processing exceptions below max attempts', async () => {
  const warnings = [];
  const failedCalls = [];
  const summary = await processCodeClipOutboxBatch({
    now: '2026-07-01T00:00:00.000Z',
    retryDelayMs: 60000,
    maxAttempts: 5,
    logger: {
      warn(message, context) {
        warnings.push({ message, context });
      },
    },
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 401,
          event_type: 'codeclip.persistence_action',
          attempt_count: 1,
        },
      ];
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('temporary processing failure');
    },
    async markCodeClipOutboxEventFailed(args) {
      failedCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 1,
    deadLettered: 0,
    failed: 0,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'codeClip outbox event processing failed');
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 401);
  assert.equal(failedCalls[0].availableAt, '2026-07-01T00:01:00.000Z');
  assert.equal(failedCalls[0].error, 'temporary processing failure');
});

test('codeClip outbox worker dead-letters processing exceptions at max attempts', async () => {
  const deadLetterCalls = [];
  const summary = await processCodeClipOutboxBatch({
    maxAttempts: 5,
    logger: { warn() {} },
    async claimCodeClipOutboxEvents() {
      return [
        {
          id: 501,
          event_type: 'codeclip.persistence_action',
          attempt_count: 5,
        },
      ];
    },
    async markCodeClipOutboxEventSucceeded() {
      throw new Error('permanent processing failure');
    },
    async markCodeClipOutboxEventDeadLetter(args) {
      deadLetterCalls.push(args);
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    succeeded: 0,
    retried: 0,
    deadLettered: 1,
    failed: 0,
  });
  assert.equal(deadLetterCalls.length, 1);
  assert.equal(deadLetterCalls[0].id, 501);
  assert.equal(deadLetterCalls[0].error, 'permanent processing failure');
});

test('codeClip outbox worker does not throw when claim fails', async () => {
  const warnings = [];
  const summary = await processCodeClipOutboxBatch({
    logger: {
      warn(message, context) {
        warnings.push({ message, context });
      },
    },
    async claimCodeClipOutboxEvents() {
      throw new Error('claim failed');
    },
  });

  assert.deepEqual(summary, {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    failed: 1,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'codeClip outbox claim failed');
});
