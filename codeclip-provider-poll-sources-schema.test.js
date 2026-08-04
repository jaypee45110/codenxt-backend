const test = require("node:test");
const assert = require("node:assert/strict");

const database = require("./db");

function createRecordingClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

test("codeClip provider poll sources ensure export exists", () => {
  assert.equal(typeof database.ensureCodeClipProviderPollSourcesTable, "function");
});

test("codeClip provider poll sources schema defines required columns and constraints", async () => {
  const client = createRecordingClient();
  await database.ensureCodeClipProviderPollSourcesTable(client);

  const createSql = client.calls
    .map((call) => call.sql)
    .find((sql) => /CREATE TABLE IF NOT EXISTS codeclip_provider_poll_sources/.test(sql));
  assert.ok(createSql);

  assert.match(createSql, /id BIGSERIAL PRIMARY KEY/);
  assert.match(createSql, /vertical TEXT NOT NULL/);
  assert.match(createSql, /provider TEXT NOT NULL/);
  assert.match(createSql, /environment TEXT NOT NULL/);
  assert.match(createSql, /account_lookup_key TEXT NOT NULL/);
  assert.match(createSql, /provider_account_id TEXT NOT NULL/);
  assert.match(createSql, /status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(createSql, /poll_interval_ms BIGINT NOT NULL/);
  assert.match(createSql, /next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(createSql, /last_polled_at TIMESTAMPTZ/);
  assert.match(createSql, /checkpoint JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(createSql, /poll_claim_owner TEXT/);
  assert.match(createSql, /poll_claimed_at TIMESTAMPTZ/);
  assert.match(createSql, /poll_claim_expires_at TIMESTAMPTZ/);
  assert.match(createSql, /poll_claim_version BIGINT NOT NULL DEFAULT 0/);
  assert.match(createSql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(createSql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(createSql, /disabled_at TIMESTAMPTZ/);

  assert.match(createSql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(createSql, /CHECK \(environment IN \('sandbox', 'production'\)\)/);
  assert.match(createSql, /CHECK \(status IN \('active', 'disabled'\)\)/);
  assert.match(createSql, /char_length\(provider\) BETWEEN 1 AND 64/);
  assert.match(createSql, /char_length\(account_lookup_key\) BETWEEN 1 AND 512/);
  assert.match(createSql, /char_length\(provider_account_id\) BETWEEN 1 AND 256/);
  assert.match(createSql, /poll_interval_ms >= 30000 AND poll_interval_ms <= 86400000/);
  assert.match(createSql, /jsonb_typeof\(checkpoint\) = 'object'/);
  assert.match(createSql, /poll_claim_version >= 0/);
  assert.match(createSql, /UNIQUE \(vertical, provider, environment, account_lookup_key\)/);

  // Claim triplet: all-null or all-set
  assert.match(createSql, /poll_claim_owner IS NULL/);
  assert.match(createSql, /poll_claimed_at IS NULL/);
  assert.match(createSql, /poll_claim_expires_at IS NULL/);
  assert.match(createSql, /poll_claim_owner IS NOT NULL/);
  assert.match(createSql, /poll_claimed_at IS NOT NULL/);
  assert.match(createSql, /poll_claim_expires_at IS NOT NULL/);
  assert.match(createSql, /poll_claim_expires_at > poll_claimed_at/);
  assert.match(createSql, /char_length\(poll_claim_owner\) BETWEEN 1 AND 128/);

  // No defaults for required identity fields
  assert.equal(/provider TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/environment TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/account_lookup_key TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/provider_account_id TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/poll_interval_ms BIGINT NOT NULL DEFAULT/.test(createSql), false);

  // No ledger / adapter / YouTube coupling columns
  assert.equal(/delivery_id/.test(createSql), false);
  assert.equal(/websub/.test(createSql), false);
  assert.equal(/adapter/.test(createSql), false);
  assert.equal(/youtube/.test(createSql), false);

  const indexSql = client.calls.map((call) => call.sql).join("\n");
  assert.match(indexSql, /codeclip_provider_poll_sources_due_idx/);
  assert.match(indexSql, /ON codeclip_provider_poll_sources \(next_poll_at, id\)/);
  assert.match(indexSql, /WHERE status = 'active'/);
  assert.match(indexSql, /codeclip_provider_poll_sources_provider_env_status_idx/);
  assert.match(indexSql, /codeclip_provider_poll_sources_claim_expires_idx/);
});

test("codeClip provider poll sources ensure is null-safe and idempotent", async () => {
  await database.ensureCodeClipProviderPollSourcesTable(null);
  const client = createRecordingClient();
  await database.ensureCodeClipProviderPollSourcesTable(client);
  await database.ensureCodeClipProviderPollSourcesTable(client);
  assert.ok(client.calls.length >= 2);
});
