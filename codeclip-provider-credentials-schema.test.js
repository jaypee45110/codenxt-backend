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

  // No defaults for required identity/crypto fields
  assert.equal(/provider TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/environment TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/account_lookup_key TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/provider_account_id TEXT NOT NULL DEFAULT/.test(createSql), false);
  assert.equal(/encryption_key_version INTEGER NOT NULL DEFAULT/.test(createSql), false);

  // No refresh claim or expired or fingerprint columns
  assert.equal(/refresh_claim_owner/.test(createSql), false);
  assert.equal(/refresh_claimed_at/.test(createSql), false);
  assert.equal(/refresh_claim_expires_at/.test(createSql), false);
  assert.equal(/\bexpired\b/.test(createSql), false);
  assert.equal(/account_fingerprint/.test(createSql), false);

  const indexSql = client.calls.map((call) => call.sql).join("\n");
  assert.match(
    indexSql,
    /codeclip_provider_credentials_provider_env_status_idx/
  );
  assert.match(indexSql, /codeclip_provider_credentials_expires_at_idx/);
  assert.match(indexSql, /WHERE status = 'active'/);
  assert.match(indexSql, /access_token_expires_at IS NOT NULL/);
  assert.equal(/refresh_claim/.test(indexSql), false);
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
    /CHECK \(action IN \(\s*'created',\s*'token_updated',\s*'reauthorization_required',\s*'revoked',\s*'disabled',\s*'reactivated'\s*\)\)/
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

  // No refresh audit actions yet
  assert.equal(/refresh_claimed/.test(auditSql), false);
  assert.equal(/key_rotated/.test(auditSql), false);

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
