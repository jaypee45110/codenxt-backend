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

test("codeClip provider credentials ensure exports exist", () => {
  assert.equal(typeof database.ensureCodeClipProviderCredentialsTable, "function");
  assert.equal(typeof database.ensureCodeClipProviderCredentialAuditTable, "function");
});

test("codeClip provider credentials schema defines required columns and constraints", async () => {
  const client = createRecordingClient();
  await database.ensureCodeClipProviderCredentialsTable(client);

  const createSql = client.calls
    .map((call) => call.sql)
    .find((sql) => /CREATE TABLE IF NOT EXISTS codeclip_provider_credentials/.test(sql));
  assert.ok(createSql);

  assert.match(createSql, /id BIGSERIAL PRIMARY KEY/);
  assert.match(createSql, /vertical TEXT NOT NULL/);
  assert.match(createSql, /provider TEXT NOT NULL/);
  assert.match(createSql, /environment TEXT NOT NULL/);
  assert.match(createSql, /account_lookup_key TEXT NOT NULL/);
  assert.match(createSql, /provider_account_id TEXT NOT NULL/);
  assert.match(createSql, /status TEXT NOT NULL DEFAULT 'active'/);
  assert.match(createSql, /access_token_envelope TEXT/);
  assert.match(createSql, /refresh_token_envelope TEXT/);
  assert.match(createSql, /access_token_expires_at TIMESTAMPTZ/);
  assert.match(createSql, /token_type TEXT/);
  assert.match(createSql, /scopes TEXT\[] NOT NULL DEFAULT '\{\}'::text\[]/);
  assert.match(createSql, /encryption_key_version INTEGER NOT NULL/);
  assert.match(createSql, /has_access_token BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(createSql, /has_refresh_token BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(createSql, /reauthorization_reason TEXT/);
  assert.match(createSql, /metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(createSql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(createSql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(createSql, /disabled_at TIMESTAMPTZ/);
  assert.match(createSql, /revoked_at TIMESTAMPTZ/);
  assert.match(createSql, /last_refreshed_at TIMESTAMPTZ/);
  assert.match(createSql, /refresh_claim_owner TEXT/);
  assert.match(createSql, /refresh_claimed_at TIMESTAMPTZ/);
  assert.match(createSql, /refresh_claim_expires_at TIMESTAMPTZ/);

  assert.match(createSql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(createSql, /CHECK \(environment IN \('sandbox', 'production'\)\)/);
  assert.match(
    createSql,
    /CHECK \(status IN \('active', 'reauthorization_required', 'revoked', 'disabled'\)\)/
  );
  assert.match(createSql, /char_length\(provider\) BETWEEN 1 AND 64/);
  assert.match(createSql, /char_length\(account_lookup_key\) BETWEEN 1 AND 512/);
  assert.match(createSql, /char_length\(provider_account_id\) BETWEEN 1 AND 256/);
  assert.match(createSql, /encryption_key_version >= 1/);
  assert.match(createSql, /jsonb_typeof\(metadata\) = 'object'/);
  assert.match(
    createSql,
    /UNIQUE \(vertical, provider, environment, account_lookup_key\)/
  );

  // Bidirectional token/envelope consistency
  assert.match(
    createSql,
    /has_access_token = FALSE AND access_token_envelope IS NULL/
  );
  assert.match(
    createSql,
    /has_access_token = TRUE AND access_token_envelope IS NOT NULL/
  );
  assert.match(
    createSql,
    /has_refresh_token = FALSE AND refresh_token_envelope IS NULL/
  );
  assert.match(
    createSql,
    /has_refresh_token = TRUE AND refresh_token_envelope IS NOT NULL/
  );

  // Refresh claim triplet: all-null or all-set
  assert.match(createSql, /refresh_claim_owner IS NULL/);
  assert.match(createSql, /refresh_claimed_at IS NULL/);
  assert.match(createSql, /refresh_claim_expires_at IS NULL/);
  assert.match(createSql, /refresh_claim_owner IS NOT NULL/);
  assert.match(createSql, /refresh_claimed_at IS NOT NULL/);
  assert.match(createSql, /refresh_claim_expires_at IS NOT NULL/);
  // expiry > claimed
  assert.match(
    createSql,
    /refresh_claim_expires_at > refresh_claimed_at/
  );
  // owner length 1..128
  assert.match(
    createSql,
    /char_length\(refresh_claim_owner\) BETWEEN 1 AND 128/
  );

  // No defaults for required identity/crypto fields or claim fields
  assert.equal(/provider TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/environment TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/account_lookup_key TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/provider_account_id TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/encryption_key_version INTEGER NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/refresh_claim_owner TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/refresh_claimed_at TIMESTAMPTZ NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(
    /refresh_claim_expires_at TIMESTAMPTZ NOT NULL DEFAULT/.test(createSql),
    false
  );

  // No expired status column or fingerprint columns
  assert.equal(/\bexpired\b/.test(createSql), false);
  assert.equal(/account_fingerprint/.test(createSql), false);
  assert.equal(/refresh_attempt_number/.test(createSql), false);
  assert.equal(/last_refresh_error_code/.test(createSql), false);

  const indexSql = client.calls.map((call) => call.sql).join("\n");
  assert.match(
    indexSql,
    /codeclip_provider_credentials_provider_env_status_idx/
  );
  assert.match(indexSql, /codeclip_provider_credentials_expires_at_idx/);
  assert.match(indexSql, /WHERE status = 'active'/);
  assert.match(indexSql, /access_token_expires_at IS NOT NULL/);
  assert.match(
    indexSql,
    /codeclip_provider_credentials_refresh_claim_expires_idx/
  );
  assert.match(
    indexSql,
    /ON codeclip_provider_credentials \(refresh_claim_expires_at\)/
  );
  assert.match(indexSql, /WHERE refresh_claim_expires_at IS NOT NULL/);

  // Idempotent ALTER / named constraint ensure paths are present
  assert.match(indexSql, /ADD COLUMN IF NOT EXISTS refresh_claim_owner/);
  assert.match(indexSql, /ADD COLUMN IF NOT EXISTS refresh_claimed_at/);
  assert.match(indexSql, /ADD COLUMN IF NOT EXISTS refresh_claim_expires_at/);
  assert.match(
    indexSql,
    /codeclip_provider_credentials_refresh_claim_triplet_chk/
  );
});

test("codeClip provider credential audit schema defines FK restrict and action enums", async () => {
  const client = createRecordingClient();
  await database.ensureCodeClipProviderCredentialAuditTable(client);

  const sqlJoined = client.calls.map((call) => call.sql).join("\n");

  // Credentials table ensured first
  assert.match(sqlJoined, /CREATE TABLE IF NOT EXISTS codeclip_provider_credentials/);
  assert.match(sqlJoined, /CREATE TABLE IF NOT EXISTS codeclip_provider_credential_audit/);

  const auditSql = client.calls
    .map((call) => call.sql)
    .find((sql) => /CREATE TABLE IF NOT EXISTS codeclip_provider_credential_audit/.test(sql));
  assert.ok(auditSql);

  assert.match(auditSql, /credential_id BIGINT NOT NULL/);
  assert.match(
    auditSql,
    /REFERENCES codeclip_provider_credentials \(id\)\s+ON DELETE RESTRICT/
  );
  assert.match(auditSql, /vertical TEXT NOT NULL/);
  assert.match(auditSql, /provider TEXT NOT NULL/);
  assert.match(auditSql, /environment TEXT NOT NULL/);
  assert.match(auditSql, /action TEXT NOT NULL/);
  assert.match(auditSql, /actor_type TEXT NOT NULL/);
  assert.match(auditSql, /actor_id TEXT/);
  assert.match(auditSql, /reason_code TEXT/);
  assert.match(auditSql, /before_state JSONB/);
  assert.match(auditSql, /after_state JSONB/);
  assert.match(auditSql, /metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(auditSql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);

  assert.match(auditSql, /CHECK \(vertical = 'codeclip'\)/);
  assert.match(auditSql, /CHECK \(environment IN \('sandbox', 'production'\)\)/);
  assert.match(
    auditSql,
    /CHECK \(action IN \(\s*'created',\s*'token_updated',\s*'reauthorization_required',\s*'revoked',\s*'disabled',\s*'reactivated',\s*'refresh_claimed'\s*\)\)/
  );
  assert.match(
    auditSql,
    /CHECK \(actor_type IN \('operator', 'operator_key', 'system'\)\)/
  );
  assert.match(auditSql, /jsonb_typeof\(metadata\) = 'object'/);
  assert.match(
    auditSql,
    /before_state IS NULL OR jsonb_typeof\(before_state\) = 'object'/
  );
  assert.match(
    auditSql,
    /after_state IS NULL OR jsonb_typeof\(after_state\) = 'object'/
  );

  // F1C3A: only refresh_claimed among refresh_* actions
  assert.match(auditSql, /refresh_claimed/);
  assert.equal(/refresh_succeeded/.test(auditSql), false);
  assert.equal(/refresh_failed/.test(auditSql), false);
  assert.equal(/refresh_released/.test(auditSql), false);
  assert.equal(/refresh_reclaimed/.test(auditSql), false);
  assert.equal(/key_rotated/.test(auditSql), false);

  // Existing actions retained
  assert.match(auditSql, /'created'/);
  assert.match(auditSql, /'token_updated'/);
  assert.match(auditSql, /'reauthorization_required'/);
  assert.match(auditSql, /'revoked'/);
  assert.match(auditSql, /'disabled'/);
  assert.match(auditSql, /'reactivated'/);

  assert.match(sqlJoined, /codeclip_provider_credential_audit_credential_created_idx/);
  assert.match(sqlJoined, /codeclip_provider_credential_audit_provider_env_created_idx/);
});

test("codeClip provider credentials ensure is no-op without query client and ignores encryption env", async () => {
  const previousKeys = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  const previousActive = process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;

  try {
    await database.ensureCodeClipProviderCredentialsTable(null);
    await database.ensureCodeClipProviderCredentialAuditTable(undefined);
    const client = createRecordingClient();
    await database.ensureCodeClipProviderCredentialsTable(client);
    assert.ok(client.calls.length >= 1);
  } finally {
    if (previousKeys === undefined) delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS;
    else process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = previousKeys;
    if (previousActive === undefined) {
      delete process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = previousActive;
    }
  }
});
