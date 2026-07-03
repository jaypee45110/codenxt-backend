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
