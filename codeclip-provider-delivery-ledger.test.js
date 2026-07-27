const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureCodeClipProviderDeliveriesTable,
  createCodeClipProviderDelivery,
  getCodeClipProviderDeliveryByIdentity,
  updateCodeClipProviderDeliveryState,
  hasCodeClipProviderDeliveryReplayInvariants,
  classifyCodeClipProviderDeliveryOperationalState,
  getCodeClipProviderDeliveryOperationalSummary,
} = require('./db');

function createDeliveryRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    provider: overrides.provider || 'meta',
    provider_account_id: overrides.provider_account_id || 'page-1',
    event_code: overrides.event_code || 'CC-LEDGER-1',
    event_id: overrides.event_id ?? 'event-1',
    external_message_id: overrides.external_message_id || 'message-1',
    idempotency_key: overrides.idempotency_key ?? 'redis-key-1',
    payload_fingerprint: overrides.payload_fingerprint ?? 'fingerprint-1',
    initial_delivery_source: overrides.initial_delivery_source || 'websub',
    verification_state: overrides.verification_state || 'verified',
    processing_state: Object.hasOwn(overrides, 'processing_state')
      ? overrides.processing_state
      : 'processing',
    attempt_count: overrides.attempt_count || 1,
    core_persistence_state: Object.hasOwn(overrides, 'core_persistence_state')
      ? overrides.core_persistence_state
      : 'not_started',
    completion_state: Object.hasOwn(overrides, 'completion_state')
      ? overrides.completion_state
      : 'not_completed',
    response_status: overrides.response_status ?? null,
    public_response_json: overrides.public_response_json ?? null,
    error_class: overrides.error_class ?? null,
    retry_eligible: overrides.retry_eligible ?? false,
    terminal_state: overrides.terminal_state ?? false,
    received_at: overrides.received_at || '2026-07-11T00:00:00.000Z',
    last_attempt_at: overrides.last_attempt_at || '2026-07-11T00:00:00.000Z',
    completed_at: overrides.completed_at ?? null,
    created_at: overrides.created_at || '2026-07-11T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-11T00:00:00.000Z',
  };
}

function createStatefulDeliveryClient({ throwOn = null } = {}) {
  const calls = [];
  const rows = [];
  let nextId = 1;

  function deliveryKey({ provider, provider_account_id, event_code, external_message_id }) {
    return [provider, provider_account_id, event_code, external_message_id].join('|');
  }

  function findByParams(params) {
    const [provider, providerAccountId, eventCode, externalMessageId] = params;
    const key = [provider, providerAccountId, eventCode, externalMessageId].join('|');
    return rows.find((row) => deliveryKey(row) === key) || null;
  }

  function earlierTimestamp(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;
    return new Date(candidate).getTime() < new Date(current).getTime()
      ? candidate
      : current;
  }

  function laterTimestamp(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;
    return new Date(candidate).getTime() > new Date(current).getTime()
      ? candidate
      : current;
  }

  return {
    calls,
    rows,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (throwOn && sql.includes(throwOn)) throw new Error(`forced ${throwOn} failure`);

      if (/INSERT INTO codeclip_provider_deliveries/.test(sql)) {
        const row = createDeliveryRow({
          id: nextId++,
          provider: params[0],
          provider_account_id: params[1],
          event_code: params[2],
          event_id: params[3],
          external_message_id: params[4],
          idempotency_key: params[5],
          payload_fingerprint: params[6],
          initial_delivery_source: params[7],
          verification_state: params[8],
          processing_state: params[9],
          core_persistence_state: params[10],
          completion_state: params[11],
          retry_eligible: params[12],
          terminal_state: params[13],
          received_at: params[14] || '2026-07-11T00:00:00.000Z',
        });
        const key = deliveryKey(row);
        const existing = rows.find((item) => deliveryKey(item) === key);
        if (existing) return { rows: [] };
        rows.push(row);
        return { rows: [row] };
      }

      if (/SELECT \*/.test(sql)) {
        const row = findByParams(params);
        return { rows: row ? [row] : [] };
      }

      if (/UPDATE codeclip_provider_deliveries/.test(sql)) {
        const identityParams = params.slice(-4);
        const row = findByParams(identityParams);
        if (!row) return { rows: [] };

        const assignmentSql = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
        const columns = [...assignmentSql.matchAll(/([a-z_]+) = \$/g)].map((match) => match[1]);
        columns.forEach((column, index) => {
          row[column] = params[index];
        });
        row.updated_at = 'updated-by-helper';
        return { rows: [row] };
      }

      if (/COUNT\(\*\) AS total/.test(sql)) {
        const summary = {
          total: rows.length,
          completed: 0,
          committed_incomplete: 0,
          processing: 0,
          failed_precommit: 0,
          unknown: 0,
          oldest_committed_incomplete_at: null,
          oldest_processing_at: null,
          latest_completed_at: null,
        };

        for (const row of rows) {
          const state = classifyCodeClipProviderDeliveryOperationalState(row);
          if (state === 'completed') {
            summary.completed += 1;
            summary.latest_completed_at = laterTimestamp(
              summary.latest_completed_at,
              row.completed_at || row.updated_at || row.created_at
            );
          } else if (state === 'committed_incomplete') {
            summary.committed_incomplete += 1;
            summary.oldest_committed_incomplete_at = earlierTimestamp(
              summary.oldest_committed_incomplete_at,
              row.updated_at || row.last_attempt_at || row.created_at
            );
          } else if (state === 'processing') {
            summary.processing += 1;
            summary.oldest_processing_at = earlierTimestamp(
              summary.oldest_processing_at,
              row.last_attempt_at || row.received_at || row.created_at
            );
          } else if (state === 'failed_precommit') {
            summary.failed_precommit += 1;
          } else {
            summary.unknown += 1;
          }
        }

        return { rows: [summary] };
      }

      return { rows: [] };
    },
  };
}

test('codeClip provider delivery schema defines durable identity and indexes', async () => {
  const client = createStatefulDeliveryClient();

  await ensureCodeClipProviderDeliveriesTable(client);

  assert.equal(client.calls.length, 7);
  assert.match(client.calls[0].sql, /CREATE TABLE IF NOT EXISTS codeclip_provider_deliveries/);
  assert.match(
    client.calls[0].sql,
    /UNIQUE \(provider, provider_account_id, event_code, external_message_id\)/
  );
  assert.match(client.calls[0].sql, /CHECK \(attempt_count >= 1\)/);
  assert.match(client.calls[0].sql, /initial_delivery_source TEXT NOT NULL DEFAULT 'websub'/);
  assert.match(client.calls[0].sql, /CHECK \(initial_delivery_source IN \('websub', 'operator_reconciliation_recovery', 'atom_reconciliation', 'data_api_polling'\)\)/);
  assert.match(client.calls[0].sql, /received_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(client.calls[0].sql, /last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(client.calls[0].sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(client.calls[0].sql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(client.calls[1].sql, /ADD COLUMN IF NOT EXISTS initial_delivery_source/);
  assert.match(client.calls[2].sql, /codeclip_provider_deliveries_initial_source_chk/);
  assert.match(client.calls[3].sql, /codeclip_provider_deliveries_event_code_idx/);
  assert.match(client.calls[4].sql, /codeclip_provider_deliveries_completion_state_idx/);
  assert.match(client.calls[5].sql, /codeclip_provider_deliveries_processing_state_idx/);
  assert.match(client.calls[6].sql, /codeclip_provider_deliveries_received_at_idx/);
});

test('codeClip provider delivery create distinguishes created and existing rows', async () => {
  const client = createStatefulDeliveryClient();
  const delivery = {
    provider: ' Meta ',
    providerAccountId: ' page-1 ',
    eventCode: ' CC-LEDGER-1 ',
    eventId: ' event-1 ',
    externalMessageId: ' message-1 ',
    idempotencyKey: ' redis-key-1 ',
    payloadFingerprint: ' fingerprint-1 ',
  };

  const created = await createCodeClipProviderDelivery(delivery, client);
  const existing = await createCodeClipProviderDelivery(delivery, client);

  assert.equal(created.status, 'created');
  assert.equal(created.created, true);
  assert.equal(created.row.provider, 'meta');
  assert.equal(created.row.providerAccountId, 'page-1');
  assert.equal(created.row.eventCode, 'CC-LEDGER-1');
  assert.equal(created.row.eventId, 'event-1');
  assert.equal(created.row.idempotencyKey, 'redis-key-1');
  assert.equal(created.row.payloadFingerprint, 'fingerprint-1');
  assert.equal(created.row.initialDeliverySource, 'websub');
  assert.equal(existing.status, 'existing');
  assert.equal(existing.existing, true);
  assert.equal(existing.row.id, created.row.id);
  assert.match(client.calls[0].sql, /ON CONFLICT \(provider, provider_account_id, event_code, external_message_id\)/);
});

test('codeClip provider delivery initial source is validated and never overwritten by duplicates', async () => {
  const client = createStatefulDeliveryClient();
  const identity = {
    provider: 'youtube',
    providerAccountId: 'UCvwiNkgNuGuizjo33NZhzPg',
    eventCode: 'CC-INITIAL-SOURCE',
    externalMessageId: 'youtube:UCvwiNkgNuGuizjo33NZhzPg:video1:published',
    initialDeliverySource: 'atom_reconciliation',
  };

  const created = await createCodeClipProviderDelivery(identity, client);
  const duplicate = await createCodeClipProviderDelivery({
    ...identity,
    initialDeliverySource: 'websub',
  }, client);
  const invalid = await createCodeClipProviderDelivery({
    ...identity,
    externalMessageId: 'youtube:UCvwiNkgNuGuizjo33NZhzPg:video2:published',
    initialDeliverySource: 'manual_bad_source',
  }, client);

  assert.equal(created.status, 'created');
  assert.equal(created.row.initialDeliverySource, 'atom_reconciliation');
  assert.equal(duplicate.status, 'existing');
  assert.equal(duplicate.row.initialDeliverySource, 'atom_reconciliation');
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.error.message, /initial_delivery_source/);
});

test('codeClip provider delivery accepts Data API polling as an initial source', async () => {
  const client = createStatefulDeliveryClient();
  const created = await createCodeClipProviderDelivery({
    provider: 'youtube',
    providerAccountId: 'UCvwiNkgNuGuizjo33NZhzPg',
    eventCode: 'CC-DATA-API-SOURCE',
    externalMessageId: 'youtube:UCvwiNkgNuGuizjo33NZhzPg:video1:published',
    initialDeliverySource: 'data_api_polling',
  }, client);

  assert.equal(created.status, 'created');
  assert.equal(created.row.initialDeliverySource, 'data_api_polling');
});

test('codeClip provider delivery identity is account scoped', async () => {
  const client = createStatefulDeliveryClient();
  const base = {
    provider: 'meta',
    eventCode: 'CC-LEDGER-ACCOUNT',
    externalMessageId: 'same-message',
  };

  const first = await createCodeClipProviderDelivery({ ...base, providerAccountId: 'page-1' }, client);
  const second = await createCodeClipProviderDelivery({ ...base, providerAccountId: 'page-2' }, client);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'created');
  assert.equal(client.rows.length, 2);
});

test('codeClip provider delivery create fails if conflict row cannot be loaded', async () => {
  // Simulates an inconsistent database/driver state: INSERT returns no row as if
  // a conflict occurred, but the follow-up SELECT cannot load the conflicting row.
  const client = {
    calls: [],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      if (/INSERT INTO codeclip_provider_deliveries/.test(sql)) return { rows: [] };
      if (/SELECT \*/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const result = await createCodeClipProviderDelivery({
    provider: 'meta',
    providerAccountId: 'page-1',
    eventCode: 'CC-CONFLICT',
    externalMessageId: 'message-1',
  }, client);

  assert.equal(result.status, 'failed');
  assert.equal(result.existing, false);
  assert.equal(result.row, null);
  assert.match(result.error.message, /conflict row could not be loaded/);
});

test('codeClip provider delivery lookup returns mapped delivery row', async () => {
  const client = createStatefulDeliveryClient();
  await createCodeClipProviderDelivery({
    provider: 'meta',
    providerAccountId: 'page-lookup',
    eventCode: 'CC-LOOKUP',
    externalMessageId: 'message-lookup',
  }, client);

  const row = await getCodeClipProviderDeliveryByIdentity({
    provider: 'meta',
    providerAccountId: 'page-lookup',
    eventCode: 'CC-LOOKUP',
    externalMessageId: 'message-lookup',
  }, client);

  assert.equal(row.providerAccountId, 'page-lookup');
  assert.equal(row.eventCode, 'CC-LOOKUP');
  assert.equal(row.externalMessageId, 'message-lookup');
});

test('codeClip provider delivery state update allowlists and deduplicates columns', async () => {
  const client = createStatefulDeliveryClient();
  const identity = {
    provider: 'meta',
    providerAccountId: 'page-update',
    eventCode: 'CC-UPDATE',
    externalMessageId: 'message-update',
  };
  await createCodeClipProviderDelivery(identity, client);

  const result = await updateCodeClipProviderDeliveryState(identity, {
    processingState: 'processing',
    processing_state: 'completed',
    attemptCount: '2',
    publicResponseJson: null,
    updatedAt: 'caller-must-not-control-this',
  }, client);
  const updateCall = client.calls.find((call) => /UPDATE codeclip_provider_deliveries/.test(call.sql));

  assert.equal(result.status, 'updated');
  assert.equal(result.row.processing_state, 'completed');
  assert.equal(result.row.attempt_count, 2);
  assert.equal(result.row.public_response_json, null);
  assert.equal((updateCall.sql.match(/processing_state = \$/g) || []).length, 1);
  assert.equal(updateCall.params.includes(null), true);
  assert.equal(updateCall.params.includes('null'), false);
  assert.equal(updateCall.params.includes('{}'), false);
  assert.doesNotMatch(updateCall.sql, /updated_at = \$|caller-must-not-control-this/);
  assert.match(updateCall.sql, /updated_at = NOW\(\)/);
});

test('codeClip provider delivery state update returns not_found for missing identity', async () => {
  const client = createStatefulDeliveryClient();
  const result = await updateCodeClipProviderDeliveryState({
    provider: 'meta',
    providerAccountId: 'page-missing',
    eventCode: 'CC-MISSING',
    externalMessageId: 'message-missing',
  }, {
    processingState: 'completed',
  }, client);

  assert.equal(result.status, 'not_found');
  assert.equal(result.row, null);
});

test('codeClip provider delivery state update validates input before SQL', async () => {
  const client = createStatefulDeliveryClient();
  const identity = {
    provider: 'meta',
    providerAccountId: 'page-invalid',
    eventCode: 'CC-INVALID',
    externalMessageId: 'message-invalid',
  };

  const invalidAttempt = await updateCodeClipProviderDeliveryState(identity, {
    attemptCount: '2abc',
  }, client);
  const unknownOnly = await updateCodeClipProviderDeliveryState(identity, {
    unknownField: 'value',
  }, client);

  assert.equal(invalidAttempt.status, 'failed');
  assert.match(invalidAttempt.error.message, /attempt_count/);
  assert.equal(unknownOnly.status, 'failed');
  assert.match(unknownOnly.error.message, /no allowed fields/);
  assert.equal(client.calls.length, 0);
});

test('codeClip provider delivery state update supports unchanged lookup and database failure', async () => {
  const client = createStatefulDeliveryClient();
  const identity = {
    provider: 'meta',
    providerAccountId: 'page-unchanged',
    eventCode: 'CC-UNCHANGED',
    externalMessageId: 'message-unchanged',
  };
  await createCodeClipProviderDelivery(identity, client);

  const unchanged = await updateCodeClipProviderDeliveryState(identity, {}, client);
  const failing = await updateCodeClipProviderDeliveryState(identity, {
    processingState: 'completed',
  }, createStatefulDeliveryClient({ throwOn: 'UPDATE codeclip_provider_deliveries' }));

  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.row.providerAccountId, 'page-unchanged');
  assert.equal(failing.status, 'failed');
  assert.match(failing.error.message, /forced UPDATE/);
});

test('codeClip provider delivery replay invariant rejects array public response payloads', () => {
  const completed = createDeliveryRow({
    core_persistence_state: 'committed',
    completion_state: 'completed',
    processing_state: 'completed',
    terminal_state: true,
    retry_eligible: false,
    response_status: 200,
    public_response_json: { ok: true },
  });
  const arrayPayload = createDeliveryRow({
    core_persistence_state: 'committed',
    completion_state: 'completed',
    processing_state: 'completed',
    terminal_state: true,
    retry_eligible: false,
    response_status: 200,
    public_response_json: [],
  });

  assert.equal(hasCodeClipProviderDeliveryReplayInvariants(completed), true);
  assert.equal(classifyCodeClipProviderDeliveryOperationalState(completed), 'completed');
  assert.equal(hasCodeClipProviderDeliveryReplayInvariants(arrayPayload), false);
  assert.equal(
    classifyCodeClipProviderDeliveryOperationalState(arrayPayload),
    'committed_incomplete'
  );
});

test('codeClip provider delivery operational summary aggregates ledger states read-only', async () => {
  const client = createStatefulDeliveryClient();
  client.rows.push(
    createDeliveryRow({
      id: 1,
      external_message_id: 'completed-old',
      core_persistence_state: 'committed',
      completion_state: 'completed',
      processing_state: 'completed',
      terminal_state: true,
      retry_eligible: false,
      response_status: 200,
      public_response_json: { ok: true, old: true },
      completed_at: '2026-07-11T05:00:00.000Z',
      updated_at: '2026-07-11T05:00:00.000Z',
    }),
    createDeliveryRow({
      id: 2,
      external_message_id: 'committed-late',
      core_persistence_state: 'committed',
      completion_state: 'not_completed',
      processing_state: 'completed',
      terminal_state: false,
      retry_eligible: true,
      public_response_json: { ok: true },
      updated_at: '2026-07-11T04:00:00.000Z',
    }),
    createDeliveryRow({
      id: 3,
      external_message_id: 'processing-late',
      core_persistence_state: 'processing',
      processing_state: 'processing',
      last_attempt_at: '2026-07-11T03:00:00.000Z',
    }),
    createDeliveryRow({
      id: 4,
      external_message_id: 'failed',
      core_persistence_state: 'failed',
      processing_state: 'failed',
      completion_state: 'not_completed',
    }),
    createDeliveryRow({
      id: 5,
      external_message_id: 'unknown-null',
      core_persistence_state: null,
      processing_state: null,
      completion_state: null,
    }),
    createDeliveryRow({
      id: 6,
      external_message_id: 'completed-new',
      core_persistence_state: 'committed',
      completion_state: 'completed',
      processing_state: 'completed',
      terminal_state: true,
      retry_eligible: false,
      response_status: 202,
      public_response_json: { accepted: true },
      completed_at: '2026-07-11T09:00:00.000Z',
      updated_at: '2026-07-11T09:00:00.000Z',
    }),
    createDeliveryRow({
      id: 7,
      external_message_id: 'committed-earlier',
      core_persistence_state: 'committed',
      completion_state: 'completed',
      processing_state: 'completed',
      terminal_state: true,
      retry_eligible: false,
      response_status: 200,
      public_response_json: [],
      updated_at: '2026-07-11T01:00:00.000Z',
    }),
    createDeliveryRow({
      id: 8,
      external_message_id: 'processing-earlier',
      core_persistence_state: 'not_started',
      processing_state: 'processing',
      last_attempt_at: '2026-07-11T00:30:00.000Z',
    })
  );

  const beforeRows = JSON.stringify(client.rows);
  const summary = await getCodeClipProviderDeliveryOperationalSummary(client);
  const aggregateCall = client.calls.find((call) => /COUNT\(\*\) AS total/.test(call.sql));

  assert.equal(summary.total, 8);
  assert.equal(summary.completed, 2);
  assert.equal(summary.committedIncomplete, 2);
  assert.equal(summary.processing, 2);
  assert.equal(summary.failedPrecommit, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(
    summary.total,
    summary.completed +
      summary.committedIncomplete +
      summary.processing +
      summary.failedPrecommit +
      summary.unknown
  );
  assert.equal(summary.oldestCommittedIncompleteAt, '2026-07-11T01:00:00.000Z');
  assert.equal(summary.oldestProcessingAt, '2026-07-11T00:30:00.000Z');
  assert.equal(summary.latestCompletedAt, '2026-07-11T09:00:00.000Z');
  assert.equal(summary.attentionRequired, true);
  assert.deepEqual(summary.attentionReasons, ['committed_incomplete']);
  assert.equal(JSON.stringify(client.rows), beforeRows);

  assert.ok(aggregateCall);
  assert.match(aggregateCall.sql, /COUNT\(\*\) FILTER/);
  assert.match(aggregateCall.sql, /IS DISTINCT FROM/);
  assert.match(aggregateCall.sql, /jsonb_typeof\(public_response_json\) = 'object'/);
  assert.match(aggregateCall.sql, /MIN\(/);
  assert.match(aggregateCall.sql, /MAX\(/);
  assert.doesNotMatch(aggregateCall.sql, /SELECT\s+\*/i);
});

test('codeClip provider delivery operational summary normalizes aggregate count strings', async () => {
  const client = {
    calls: [],
    async query(sql) {
      this.calls.push({ sql });
      return {
        rows: [
          {
            total: '5',
            completed: '1',
            committed_incomplete: '1',
            processing: '1',
            failed_precommit: '1',
            unknown: '1',
            oldest_committed_incomplete_at: null,
            oldest_processing_at: null,
            latest_completed_at: null,
          },
        ],
      };
    },
  };

  const summary = await getCodeClipProviderDeliveryOperationalSummary(client);

  for (const key of [
    'total',
    'completed',
    'committedIncomplete',
    'processing',
    'failedPrecommit',
    'unknown',
  ]) {
    assert.equal(typeof summary[key], 'number');
  }
  assert.equal(summary.total, 5);
  assert.equal(summary.completed, 1);
  assert.equal(summary.committedIncomplete, 1);
  assert.equal(summary.processing, 1);
  assert.equal(summary.failedPrecommit, 1);
  assert.equal(summary.unknown, 1);
});

test('codeClip provider delivery operational summary returns zero counts for empty ledger', async () => {
  const client = createStatefulDeliveryClient();
  const summary = await getCodeClipProviderDeliveryOperationalSummary(client);

  assert.deepEqual(summary, {
    total: 0,
    completed: 0,
    committedIncomplete: 0,
    processing: 0,
    failedPrecommit: 0,
    unknown: 0,
    oldestCommittedIncompleteAt: null,
    oldestProcessingAt: null,
    latestCompletedAt: null,
    attentionRequired: false,
    attentionReasons: [],
  });
});
