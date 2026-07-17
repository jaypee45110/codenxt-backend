const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
    })
  : null;

async function testDbConnection() {
  if (!pool) {
    console.log('POSTGRES SKIPPED: DATABASE_URL not set');
    return;
  }

  const result = await pool.query('SELECT NOW() AS now');
  console.log('POSTGRES OK:', result.rows[0].now);
}

async function withCodeClipCorePersistenceTransaction(work, queryPool = pool) {
  if (!queryPool || typeof queryPool.connect !== 'function') {
    const error = new Error('codeClip core persistence transaction requires PostgreSQL pool');
    error.transactionPhase = 'connect';
    error.rollbackAttempted = false;
    error.rollbackSucceeded = false;
    throw error;
  }
  if (typeof work !== 'function') {
    const error = new Error('codeClip core persistence transaction requires work function');
    error.transactionPhase = 'work';
    error.rollbackAttempted = false;
    error.rollbackSucceeded = false;
    throw error;
  }

  let client = null;
  let transactionError = null;
  let committed = false;

  try {
    client = await queryPool.connect();
  } catch (error) {
    error.transactionPhase = 'connect';
    error.rollbackAttempted = false;
    error.rollbackSucceeded = false;
    throw error;
  }

  try {
    try {
      await client.query('BEGIN');
    } catch (error) {
      error.transactionPhase = 'begin';
      throw error;
    }

    let result;
    try {
      result = await work({ queryClient: client });
    } catch (error) {
      error.transactionPhase = 'work';
      throw error;
    }

    try {
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      error.transactionPhase = 'commit';
      throw error;
    }

    return result;
  } catch (error) {
    transactionError = error;
    transactionError.rollbackAttempted = true;
    try {
      await client.query('ROLLBACK');
      transactionError.rollbackSucceeded = true;
    } catch (rollbackError) {
      rollbackError.transactionPhase = 'rollback';
      transactionError.rollbackSucceeded = false;
      transactionError.rollbackError = rollbackError;
    }
    throw transactionError;
  } finally {
    try {
      client.release();
    } catch (releaseError) {
      releaseError.transactionPhase = 'release';

      if (transactionError) {
        transactionError.releaseError = releaseError;
      } else if (committed) {
        console.error(
          'codeClip PostgreSQL client release failed after committed transaction:',
          releaseError.message
        );
      } else {
        throw releaseError;
      }
    }
  }
}

async function ensureCampaignsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      vertical TEXT NOT NULL,
      event_code TEXT UNIQUE NOT NULL,
      name TEXT,
      venue TEXT,
      city TEXT,
      start_at TIMESTAMPTZ,
      unlock_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      status TEXT,
      dashboard_access_key TEXT,
      benefit_inventory JSONB,
      raw_event JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function saveCampaign(event) {
  if (!pool || !event?.id || !event?.code) return;

  await ensureCampaignsTable();

  await pool.query(
    `
      INSERT INTO campaigns (
        id,
        vertical,
        event_code,
        name,
        venue,
        city,
        start_at,
        unlock_at,
        end_at,
        status,
        dashboard_access_key,
        benefit_inventory,
        raw_event,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (event_code)
      DO UPDATE SET
        vertical = EXCLUDED.vertical,
        name = EXCLUDED.name,
        venue = EXCLUDED.venue,
        city = EXCLUDED.city,
        start_at = EXCLUDED.start_at,
        unlock_at = EXCLUDED.unlock_at,
        end_at = EXCLUDED.end_at,
        status = EXCLUDED.status,
        dashboard_access_key = EXCLUDED.dashboard_access_key,
        benefit_inventory = EXCLUDED.benefit_inventory,
        raw_event = EXCLUDED.raw_event,
        updated_at = NOW()
    `,
    [
      event.id,
      event.vertical || 'codeperks',
      event.code,
      event.name || '',
      event.venue || '',
      event.city || '',
      event.startAt || null,
      event.unlockAt || null,
      event.endAt || null,
      event.status || '',
      event.dashboardAccessKey || '',
      JSON.stringify(event.benefitInventory || {}),
      JSON.stringify(event),
    ]
  );
}

async function getCampaignByCode(eventCode) {
  if (!pool || !eventCode) return null;

  await ensureCampaignsTable();

  const result = await pool.query(
    'SELECT * FROM campaigns WHERE event_code = $1 LIMIT 1',
    [eventCode]
  );

  return result.rows[0] || null;
}

async function ensureEventScansTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_scans (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      vertical TEXT,
      scan_id TEXT,
      raw_scan_key TEXT NOT NULL,
      scan_rank INTEGER,
      tier TEXT,
      team_code TEXT,
      team_label TEXT,
      daily_demo_code TEXT,
      daily_demo_day_index INTEGER,
      daily_demo_team_index INTEGER,
      user_agent TEXT,
      ip_hash TEXT,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, raw_scan_key)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS event_scans_event_code_created_at_idx
    ON event_scans (event_code, created_at)
  `);
}

async function saveEventScan(scan = {}) {
  if (!pool || !scan.eventCode) return null;

  await ensureEventScansTable();

  const rawScanKey = String(scan.scanId || scan.requestId || `${Date.now()}-${Math.random()}`).trim();

  const result = await pool.query(
    `
      INSERT INTO event_scans (
        event_code,
        event_id,
        vertical,
        scan_id,
        raw_scan_key,
        scan_rank,
        tier,
        team_code,
        team_label,
        daily_demo_code,
        daily_demo_day_index,
        daily_demo_team_index,
        user_agent,
        ip_hash,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (event_code, raw_scan_key)
      DO UPDATE SET
        scan_rank = COALESCE(event_scans.scan_rank, EXCLUDED.scan_rank),
        tier = COALESCE(EXCLUDED.tier, event_scans.tier),
        raw_payload = EXCLUDED.raw_payload
      RETURNING *
    `,
    [
      scan.eventCode,
      scan.eventId || '',
      scan.vertical || '',
      scan.scanId || '',
      rawScanKey,
      scan.scanRank || null,
      scan.tier || '',
      scan.teamCode || '',
      scan.teamLabel || '',
      scan.dailyDemoCode || '',
      scan.dailyDemoDayIndex || null,
      scan.dailyDemoTeamIndex || null,
      scan.userAgent || '',
      scan.ipHash || '',
      JSON.stringify(scan.rawPayload || {}),
    ]
  );

  return result.rows[0] || null;
}

async function ensureEventRegistrationsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_registrations (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      vertical TEXT,
      registration_id TEXT,
      raw_registration_key TEXT NOT NULL,
      scan_id TEXT,
      tier TEXT,
      name TEXT,
      email TEXT,
      phone TEXT,
      team_code TEXT,
      team_label TEXT,
      daily_demo_code TEXT,
      daily_demo_day_index INTEGER,
      daily_demo_team_index INTEGER,
      user_agent TEXT,
      ip_hash TEXT,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, raw_registration_key)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS event_registrations_event_code_created_at_idx
    ON event_registrations (event_code, created_at)
  `);
}

async function saveEventRegistration(registration = {}) {
  if (!pool || !registration.eventCode) return null;

  await ensureEventRegistrationsTable();

  const rawRegistrationKey = String(
    registration.registrationId ||
    registration.email ||
    registration.phone ||
    registration.scanId ||
    registration.requestId ||
    `${Date.now()}-${Math.random()}`
  ).trim().toLowerCase();

  const result = await pool.query(
    `
      INSERT INTO event_registrations (
        event_code,
        event_id,
        vertical,
        registration_id,
        raw_registration_key,
        scan_id,
        tier,
        name,
        email,
        phone,
        team_code,
        team_label,
        daily_demo_code,
        daily_demo_day_index,
        daily_demo_team_index,
        user_agent,
        ip_hash,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (event_code, raw_registration_key)
      DO UPDATE SET
        registration_id = COALESCE(EXCLUDED.registration_id, event_registrations.registration_id),
        scan_id = COALESCE(EXCLUDED.scan_id, event_registrations.scan_id),
        tier = COALESCE(EXCLUDED.tier, event_registrations.tier),
        name = COALESCE(EXCLUDED.name, event_registrations.name),
        email = COALESCE(EXCLUDED.email, event_registrations.email),
        phone = COALESCE(EXCLUDED.phone, event_registrations.phone),
        raw_payload = EXCLUDED.raw_payload
      RETURNING *
    `,
    [
      registration.eventCode,
      registration.eventId || '',
      registration.vertical || '',
      registration.registrationId || '',
      rawRegistrationKey,
      registration.scanId || '',
      registration.tier || '',
      registration.name || '',
      registration.email || '',
      registration.phone || '',
      registration.teamCode || '',
      registration.teamLabel || '',
      registration.dailyDemoCode || '',
      registration.dailyDemoDayIndex || null,
      registration.dailyDemoTeamIndex || null,
      registration.userAgent || '',
      registration.ipHash || '',
      JSON.stringify(registration.rawPayload || {}),
    ]
  );

  return result.rows[0] || null;
}

function buildEventScanSummaryQuery(eventCode, vertical = '') {
  const normalizedVertical = String(vertical || '').trim().toLowerCase();
  return {
    text: `
      SELECT
        COUNT(*)::INTEGER AS scans,
        COUNT(DISTINCT NULLIF(scan_id, ''))::INTEGER AS unique_scans
      FROM event_scans
      WHERE event_code = $1
        AND ($2::text = '' OR vertical = $2)
    `,
    values: [eventCode, normalizedVertical],
  };
}

async function getEventScanSummary(eventCode, vertical = '') {
  if (!pool || !eventCode) {
    return { scans: 0, uniqueScans: 0 };
  }

  await ensureEventScansTable();
  const query = buildEventScanSummaryQuery(eventCode, vertical);
  const result = await pool.query(query.text, query.values);

  const row = result.rows[0] || {};
  return {
    scans: Number(row.scans || 0),
    uniqueScans: Number(row.unique_scans || 0),
  };
}

function buildEventRegistrationSummaryQuery(eventCode, vertical = '') {
  const normalizedVertical = String(vertical || '').trim().toLowerCase();
  return {
    text: `
      SELECT COUNT(*)::INTEGER AS registrations
      FROM event_registrations
      WHERE event_code = $1
        AND ($2::text = '' OR vertical = $2)
    `,
    values: [eventCode, normalizedVertical],
  };
}

async function getEventRegistrationSummary(eventCode, vertical = '') {
  if (!pool || !eventCode) {
    return { registrations: 0 };
  }

  await ensureEventRegistrationsTable();
  const query = buildEventRegistrationSummaryQuery(eventCode, vertical);
  const result = await pool.query(query.text, query.values);

  const row = result.rows[0] || {};
  return {
    registrations: Number(row.registrations || 0),
  };
}

function buildEventRegistrationsQuery(eventCode, limit = 50, vertical = '') {
  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 200));
  const normalizedVertical = String(vertical || '').trim().toLowerCase();
  return {
    text: `
      SELECT *
      FROM event_registrations
      WHERE event_code = $1
        AND ($3::text = '' OR vertical = $3)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    values: [eventCode, safeLimit, normalizedVertical],
  };
}

async function getEventRegistrations(eventCode, limit = 50, vertical = '') {
  if (!pool || !eventCode) return [];

  await ensureEventRegistrationsTable();
  const query = buildEventRegistrationsQuery(eventCode, limit, vertical);
  const result = await pool.query(query.text, query.values);

  return result.rows || [];
}

function buildCodePodReportRowsQuery(eventCode, vertical = 'codepod') {
  const normalizedVertical = String(vertical || 'codepod').trim().toLowerCase();
  return {
    text: `
      SELECT
        scans.event_code,
        scans.event_id,
        scans.scan_id,
        scans.scan_rank,
        scans.tier,
        scans.created_at,
        COALESCE(
          redemptions.display_tier,
          scans.raw_payload->'digitalSouvenir'->>'displayTier',
          scans.raw_payload->'digitalSouvenir'->>'tier',
          scans.tier
        ) AS display_tier,
        COALESCE(
          redemptions.reward_type,
          scans.raw_payload->'digitalSouvenir'->>'rewardType',
          CASE WHEN redemptions.token IS NOT NULL THEN 'partner_reward' ELSE 'digital_souvenir' END
        ) AS reward_type,
        redemptions.token AS redemption_token,
        redemptions.status AS redemption_status,
        redemptions.redeemed_at,
        redemptions.already_redeemed_attempts
      FROM event_scans scans
      LEFT JOIN codepod_goldxtra_redemptions redemptions
        ON redemptions.event_code = scans.event_code
       AND redemptions.scan_id = scans.scan_id
      WHERE scans.event_code = $1
        AND scans.vertical = $2
      ORDER BY scans.created_at DESC
    `,
    values: [eventCode, normalizedVertical],
  };
}

async function getCodePodReportRows(eventCode, vertical = 'codepod') {
  if (!pool || !eventCode) return [];

  await ensureEventScansTable();
  await ensureCodePodGoldXtraRedemptionsTable();
  const query = buildCodePodReportRowsQuery(eventCode, vertical);
  const result = await pool.query(query.text, query.values);

  return result.rows || [];
}

async function ensureCodeDemoHandshakesTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codedemo_handshakes (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      parent_event_code TEXT,
      vertical TEXT,
      demo_date TEXT,
      team_code TEXT,
      team_label TEXT,
      daily_demo_code TEXT,
      daily_demo_day_index INTEGER,
      daily_demo_team_index INTEGER,
      location_name TEXT,
      scan_score INTEGER,
      next_step_score INTEGER,
      interest INTEGER,
      product_understanding INTEGER,
      relevance INTEGER,
      understanding INTEGER,
      trust INTEGER,
      safety INTEGER,
      insight INTEGER,
      handshake_score NUMERIC(4,1),
      purchase_intent INTEGER,
      store_manager_score INTEGER,
      total_score NUMERIC(4,1),
      reported_by TEXT,
      reported_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      raw_payload JSONB,
      UNIQUE (event_code, demo_date, team_code)
    )
  `);

  await pool.query(`
    ALTER TABLE codedemo_handshakes
      ADD COLUMN IF NOT EXISTS understanding INTEGER,
      ADD COLUMN IF NOT EXISTS trust INTEGER,
      ADD COLUMN IF NOT EXISTS safety INTEGER,
      ADD COLUMN IF NOT EXISTS insight INTEGER,
      ADD COLUMN IF NOT EXISTS handshake_score NUMERIC(4,1),
      ALTER COLUMN total_score TYPE NUMERIC(4,1) USING total_score::NUMERIC(4,1)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codedemo_handshakes_parent_date_idx
    ON codedemo_handshakes (parent_event_code, demo_date)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codedemo_handshakes_event_code_idx
    ON codedemo_handshakes (event_code)
  `);
}

async function saveCodeDemoHandshakeReport(report = {}) {
  if (!pool || !report.eventCode) return null;

  await ensureCodeDemoHandshakesTable();

  const relevance = Number(report.relevance ?? 0);
  const understanding = Number(report.understanding ?? 0);
  const trust = Number(report.trust ?? 0);
  const safety = Number(report.safety ?? 0);
  const insight = Number(report.insight ?? 0);
  const handshakeScore = Number(
    report.handshakeScore ??
    report.totalScore ??
    (
      Math.round(((relevance + understanding + trust + safety + insight) / 5) * 10) / 10
    )
  );

  const scanScore = Number(report.scanScore ?? 0);
  const nextStepScore = Number(report.nextStepScore ?? 0);
  const interest = Number(report.interest ?? 0);
  const productUnderstanding = Number(report.productUnderstanding ?? understanding);
  const purchaseIntent = Number(report.purchaseIntent ?? 0);
  const storeManagerScore = Number(report.storeManagerScore ?? 0);
  const totalScore = handshakeScore;

  const result = await pool.query(
    `
      INSERT INTO codedemo_handshakes (
        event_code,
        event_id,
        parent_event_code,
        vertical,
        demo_date,
        team_code,
        team_label,
        daily_demo_code,
        daily_demo_day_index,
        daily_demo_team_index,
        location_name,
        scan_score,
        next_step_score,
        interest,
        product_understanding,
        relevance,
        understanding,
        trust,
        safety,
        insight,
        handshake_score,
        purchase_intent,
        store_manager_score,
        total_score,
        reported_by,
        raw_payload,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())
      ON CONFLICT (event_code, demo_date, team_code)
      DO UPDATE SET
        event_id = EXCLUDED.event_id,
        parent_event_code = EXCLUDED.parent_event_code,
        vertical = EXCLUDED.vertical,
        team_label = EXCLUDED.team_label,
        daily_demo_code = EXCLUDED.daily_demo_code,
        daily_demo_day_index = EXCLUDED.daily_demo_day_index,
        daily_demo_team_index = EXCLUDED.daily_demo_team_index,
        location_name = EXCLUDED.location_name,
        scan_score = EXCLUDED.scan_score,
        next_step_score = EXCLUDED.next_step_score,
        interest = EXCLUDED.interest,
        product_understanding = EXCLUDED.product_understanding,
        relevance = EXCLUDED.relevance,
        understanding = EXCLUDED.understanding,
        trust = EXCLUDED.trust,
        safety = EXCLUDED.safety,
        insight = EXCLUDED.insight,
        handshake_score = EXCLUDED.handshake_score,
        purchase_intent = EXCLUDED.purchase_intent,
        store_manager_score = EXCLUDED.store_manager_score,
        total_score = EXCLUDED.total_score,
        reported_by = EXCLUDED.reported_by,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
      RETURNING *
    `,
    [
      report.eventCode,
      report.eventId || '',
      report.parentEventCode || '',
      report.vertical || 'codedemo',
      report.demoDate || '',
      report.teamCode || '',
      report.teamLabel || '',
      report.dailyDemoCode || report.eventCode,
      report.dailyDemoDayIndex || null,
      report.dailyDemoTeamIndex || null,
      report.locationName || '',
      scanScore,
      nextStepScore,
      interest,
      productUnderstanding,
      relevance,
      understanding,
      trust,
      safety,
      insight,
      handshakeScore,
      purchaseIntent,
      storeManagerScore,
      totalScore,
      report.reportedBy || '',
      JSON.stringify(report.rawPayload || report),
    ]
  );

  return result.rows[0] || null;
}

async function getCodeDemoHandshakeReports(filters = {}) {
  if (!pool) return [];

  await ensureCodeDemoHandshakesTable();

  const values = [];
  const where = [];

  if (filters.eventCode) {
    values.push(filters.eventCode);
    where.push(`event_code = $${values.length}`);
  }

  if (filters.parentEventCode) {
    values.push(filters.parentEventCode);
    where.push(`parent_event_code = $${values.length}`);
  }

  if (filters.demoDate) {
    values.push(filters.demoDate);
    where.push(`demo_date = $${values.length}`);
  }

  const sql = `
    SELECT *
    FROM codedemo_handshakes
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY demo_date ASC, daily_demo_team_index ASC, team_code ASC, updated_at DESC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

async function ensureCodeDemoExceptionsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codedemo_exceptions (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      parent_event_code TEXT,
      activity_id TEXT,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'open',
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codedemo_exceptions_event_code_idx
    ON codedemo_exceptions (event_code)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codedemo_exceptions_status_idx
    ON codedemo_exceptions (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codedemo_exceptions_created_at_idx
    ON codedemo_exceptions (created_at DESC)
  `);
}

async function saveCodeDemoException(exception = {}) {
  if (!pool || !exception.eventCode) return null;

  await ensureCodeDemoExceptionsTable();

  const details = exception.details || {};
  const dedupeTier = details.tier ? String(details.tier) : "";

  const existing = await pool.query(
    `
      SELECT *
      FROM codedemo_exceptions
      WHERE event_code = $1
        AND category = $2
        AND exception_type = $3
        AND status = $4
        AND COALESCE(details->>'tier', '') = $5
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [
      exception.eventCode,
      exception.category || 'system',
      exception.type || exception.exceptionType || 'unknown_exception',
      exception.status || 'open',
      dedupeTier,
    ]
  );

  if (existing.rows[0]) {
    // existing_exception_tier_dedupe
    return existing.rows[0];
  }

  const result = await pool.query(
    `
      INSERT INTO codedemo_exceptions (
        event_code,
        event_id,
        parent_event_code,
        activity_id,
        severity,
        category,
        exception_type,
        message,
        status,
        details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      exception.eventCode,
      exception.eventId || '',
      exception.parentEventCode || '',
      exception.activityId || '',
      exception.severity || 'yellow',
      exception.category || 'system',
      exception.type || exception.exceptionType || 'unknown_exception',
      exception.message || '',
      exception.status || 'open',
      JSON.stringify(details),
    ]
  );

  return result.rows[0] || null;
}

async function getLatestCodeDemoExceptions(limit = 50) {
  if (!pool) return [];

  await ensureCodeDemoExceptionsTable();

  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 200));

  const result = await pool.query(
    `
      SELECT *
      FROM codedemo_exceptions
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows || [];
}

async function getCodeDemoExceptions(filters = {}) {
  if (!pool || !filters.eventCode) return [];

  await ensureCodeDemoExceptionsTable();

  const values = [filters.eventCode];
  const where = ['event_code = $1'];

  if (filters.status) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }

  const limit = Math.max(1, Math.min(Number(filters.limit || 50), 200));
  values.push(limit);

  const result = await pool.query(
    `
      SELECT *
      FROM codedemo_exceptions
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return result.rows || [];
}



async function updateCodeDemoExceptionStatus({ id, status, note = "", updatedBy = "" } = {}) {
  if (!pool || !id) return null;

  await ensureCodeDemoExceptionsTable();

  const allowedStatuses = new Set(["open", "in_progress", "resolved", "unresolved"]);
  const safeStatus = String(status || "").trim().toLowerCase();

  if (!allowedStatuses.has(safeStatus)) {
    throw new Error("Invalid exception status");
  }

  const result = await pool.query(
    `
      UPDATE codedemo_exceptions
      SET
        status = $2,
        resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
        details = COALESCE(details, '{}'::jsonb) || jsonb_build_object(
          'lastStatusNote', $3::text,
          'lastStatusUpdatedBy', $4::text,
          'lastStatusUpdatedAt', NOW(),
          'timeline',
          COALESCE(details->'timeline', '[]'::jsonb) || jsonb_build_array(
            jsonb_build_object(
              'status', $2::text,
              'updatedBy', $4::text,
              'note', $3::text,
              'updatedAt', NOW()
            )
          )
        )
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      safeStatus,
      String(note || "").trim().slice(0, 1000),
      String(updatedBy || "").trim().slice(0, 160),
    ]
  );

  return result.rows[0] || null;
}

async function ensureCodePodGoldXtraRedemptionsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codepod_goldxtra_redemptions (
      id BIGSERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      event_code TEXT NOT NULL,
      event_id TEXT,
      scan_id TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'codepod',
      reward_type TEXT NOT NULL DEFAULT 'partner_reward',
      tier TEXT NOT NULL DEFAULT 'gold',
      display_tier TEXT NOT NULL DEFAULT 'GoldXtra',
      partner_name TEXT,
      reward_title TEXT,
      redemption_location TEXT,
      redemption_deadline TEXT,
      redemption_instructions TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      downloaded_at TIMESTAMPTZ,
      redeemed_at TIMESTAMPTZ,
      redeemed_by TEXT,
      already_redeemed_attempts INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, scan_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codepod_goldxtra_redemptions_event_code_idx
    ON codepod_goldxtra_redemptions (event_code)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codepod_goldxtra_redemptions_status_idx
    ON codepod_goldxtra_redemptions (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codepod_goldxtra_redemptions_assigned_at_idx
    ON codepod_goldxtra_redemptions (assigned_at DESC)
  `);
}

async function saveCodePodGoldXtraRedemption(record = {}) {
  if (!pool || !record.eventCode || !record.scanId || !record.token) return null;

  await ensureCodePodGoldXtraRedemptionsTable();

  const result = await pool.query(
    `
      INSERT INTO codepod_goldxtra_redemptions (
        token,
        event_code,
        event_id,
        scan_id,
        vertical,
        reward_type,
        tier,
        display_tier,
        partner_name,
        reward_title,
        redemption_location,
        redemption_deadline,
        redemption_instructions,
        status,
        assigned_at,
        raw_payload,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::timestamptz,NOW()),$16,NOW())
      ON CONFLICT (event_code, scan_id)
      DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, codepod_goldxtra_redemptions.event_id),
        vertical = EXCLUDED.vertical,
        reward_type = EXCLUDED.reward_type,
        tier = EXCLUDED.tier,
        display_tier = EXCLUDED.display_tier,
        partner_name = EXCLUDED.partner_name,
        reward_title = EXCLUDED.reward_title,
        redemption_location = EXCLUDED.redemption_location,
        redemption_deadline = EXCLUDED.redemption_deadline,
        redemption_instructions = EXCLUDED.redemption_instructions,
        status = CASE
          WHEN codepod_goldxtra_redemptions.redeemed_at IS NOT NULL THEN codepod_goldxtra_redemptions.status
          ELSE EXCLUDED.status
        END,
        assigned_at = COALESCE(codepod_goldxtra_redemptions.assigned_at, EXCLUDED.assigned_at),
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
      RETURNING *
    `,
    [
      record.token,
      record.eventCode,
      record.eventId || '',
      record.scanId,
      record.vertical || 'codepod',
      record.rewardType || 'partner_reward',
      record.tier || 'gold',
      record.displayTier || 'GoldXtra',
      record.partnerName || '',
      record.rewardTitle || record.title || '',
      record.redemptionLocation || '',
      record.redemptionDeadline || '',
      record.redemptionInstructions || '',
      record.status || 'assigned',
      record.assignedAt || null,
      JSON.stringify(record.rawPayload || record),
    ]
  );

  return result.rows[0] || null;
}

function normalizeCodeClipProviderDeliveryIdentity(input = {}) {
  return {
    provider: String(input.provider || "").trim().toLowerCase(),
    providerAccountId: String(input.providerAccountId || input.provider_account_id || "").trim(),
    eventCode: String(input.eventCode || input.event_code || "").trim(),
    externalMessageId: String(input.externalMessageId || input.external_message_id || "").trim(),
  };
}

function hasCodeClipProviderDeliveryIdentity(input = {}) {
  const identity = normalizeCodeClipProviderDeliveryIdentity(input);
  return Boolean(
    identity.provider &&
    identity.providerAccountId &&
    identity.eventCode &&
    identity.externalMessageId
  );
}

function mapCodeClipProviderDeliveryRow(row = null) {
  if (!row) return null;

  return {
    ...row,
    providerAccountId: row.provider_account_id,
    eventCode: row.event_code,
    eventId: row.event_id,
    externalMessageId: row.external_message_id,
    idempotencyKey: row.idempotency_key,
    payloadFingerprint: row.payload_fingerprint,
    verificationState: row.verification_state,
    processingState: row.processing_state,
    attemptCount: row.attempt_count,
    corePersistenceState: row.core_persistence_state,
    completionState: row.completion_state,
    responseStatus: row.response_status,
    publicResponseJson: row.public_response_json,
    errorClass: row.error_class,
    retryEligible: row.retry_eligible,
    terminalState: row.terminal_state,
    receivedAt: row.received_at,
    lastAttemptAt: row.last_attempt_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasCodeClipProviderDeliveryReplayInvariants(delivery = null) {
  if (!delivery) return false;

  const publicResponseJson =
    delivery.publicResponseJson !== undefined
      ? delivery.publicResponseJson
      : delivery.public_response_json;
  const responseStatus =
    delivery.responseStatus !== undefined
      ? delivery.responseStatus
      : delivery.response_status;

  if ((delivery.corePersistenceState || delivery.core_persistence_state) !== 'committed') return false;
  if ((delivery.completionState || delivery.completion_state) !== 'completed') return false;
  if ((delivery.processingState || delivery.processing_state) !== 'completed') return false;
  if ((delivery.terminalState ?? delivery.terminal_state) !== true) return false;
  if ((delivery.retryEligible ?? delivery.retry_eligible) !== false) return false;
  if (
    !publicResponseJson ||
    typeof publicResponseJson !== 'object' ||
    Array.isArray(publicResponseJson)
  ) {
    return false;
  }
  if (!Number.isInteger(responseStatus)) return false;
  return responseStatus >= 200 && responseStatus <= 299;
}

function classifyCodeClipProviderDeliveryOperationalState(delivery = null) {
  if (!delivery) return 'unknown';
  if (hasCodeClipProviderDeliveryReplayInvariants(delivery)) return 'completed';

  const corePersistenceState = delivery.corePersistenceState || delivery.core_persistence_state;
  const processingState = delivery.processingState || delivery.processing_state;
  const completionState = delivery.completionState || delivery.completion_state;

  if (corePersistenceState === 'committed') return 'committed_incomplete';
  if (processingState === 'processing' && corePersistenceState !== 'committed') return 'processing';
  if (
    processingState === 'failed' &&
    corePersistenceState !== 'committed' &&
    completionState !== 'completed'
  ) {
    return 'failed_precommit';
  }
  return 'unknown';
}

function normalizeCodeClipProviderDeliveryOperationalCount(value) {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function normalizeCodeClipProviderDeliveryOperationalSummaryRow(row = {}) {
  const summary = {
    total: normalizeCodeClipProviderDeliveryOperationalCount(row.total),
    completed: normalizeCodeClipProviderDeliveryOperationalCount(row.completed),
    committedIncomplete: normalizeCodeClipProviderDeliveryOperationalCount(row.committed_incomplete),
    processing: normalizeCodeClipProviderDeliveryOperationalCount(row.processing),
    failedPrecommit: normalizeCodeClipProviderDeliveryOperationalCount(row.failed_precommit),
    unknown: normalizeCodeClipProviderDeliveryOperationalCount(row.unknown),
    oldestCommittedIncompleteAt: row.oldest_committed_incomplete_at || null,
    oldestProcessingAt: row.oldest_processing_at || null,
    latestCompletedAt: row.latest_completed_at || null,
    attentionRequired: false,
    attentionReasons: [],
  };

  if (summary.committedIncomplete > 0) {
    summary.attentionRequired = true;
    summary.attentionReasons.push('committed_incomplete');
  }

  return summary;
}

async function getCodeClipProviderDeliveryOperationalSummary(queryClient = pool) {
  if (!queryClient) return normalizeCodeClipProviderDeliveryOperationalSummaryRow();

  if (queryClient === pool) {
    await ensureCodeClipProviderDeliveriesTable(queryClient);
  }

  const completedPredicate = `
    core_persistence_state = 'committed'
    AND completion_state = 'completed'
    AND processing_state = 'completed'
    AND terminal_state IS TRUE
    AND retry_eligible IS FALSE
    AND public_response_json IS NOT NULL
    AND jsonb_typeof(public_response_json) = 'object'
    AND response_status BETWEEN 200 AND 299
  `;
  const committedIncompletePredicate = `
    core_persistence_state = 'committed'
    AND NOT COALESCE((${completedPredicate}), FALSE)
  `;
  const processingPredicate = `
    processing_state = 'processing'
    AND core_persistence_state IS DISTINCT FROM 'committed'
  `;
  const failedPrecommitPredicate = `
    processing_state = 'failed'
    AND core_persistence_state IS DISTINCT FROM 'committed'
    AND completion_state IS DISTINCT FROM 'completed'
  `;

  const result = await queryClient.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ${completedPredicate}) AS completed,
      COUNT(*) FILTER (WHERE ${committedIncompletePredicate}) AS committed_incomplete,
      COUNT(*) FILTER (WHERE ${processingPredicate}) AS processing,
      COUNT(*) FILTER (WHERE ${failedPrecommitPredicate}) AS failed_precommit,
      COUNT(*) FILTER (
        WHERE NOT COALESCE((${completedPredicate}), FALSE)
          AND NOT COALESCE((${committedIncompletePredicate}), FALSE)
          AND NOT COALESCE((${processingPredicate}), FALSE)
          AND NOT COALESCE((${failedPrecommitPredicate}), FALSE)
      ) AS unknown,
      MIN(COALESCE(updated_at, last_attempt_at, created_at))
        FILTER (WHERE ${committedIncompletePredicate}) AS oldest_committed_incomplete_at,
      MIN(COALESCE(last_attempt_at, received_at, created_at))
        FILTER (WHERE ${processingPredicate}) AS oldest_processing_at,
      MAX(COALESCE(completed_at, updated_at, created_at))
        FILTER (WHERE ${completedPredicate}) AS latest_completed_at
    FROM codeclip_provider_deliveries
  `);

  return normalizeCodeClipProviderDeliveryOperationalSummaryRow(result.rows?.[0] || {});
}

async function ensureCodeClipProviderAccountBindingsTable(queryClient = pool) {
  if (!queryClient) return;

  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS codeclip_provider_account_bindings (
      id BIGSERIAL PRIMARY KEY,
      vertical TEXT NOT NULL,
      event_code TEXT NOT NULL,
      provider TEXT NOT NULL,
      channel TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      display_name TEXT,
      created_by TEXT NOT NULL DEFAULT 'operator',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      disabled_at TIMESTAMPTZ,
      CHECK (vertical = 'codeclip'),
      CHECK (status IN ('active', 'disabled')),
      CHECK (provider IN ('meta', 'sms')),
      CHECK (
        (provider = 'meta' AND channel IN ('instagram', 'messenger', 'whatsapp'))
        OR (provider = 'sms' AND channel = 'sms')
      )
    )
  `);

  await queryClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS codeclip_provider_account_bindings_active_identity_idx
    ON codeclip_provider_account_bindings (vertical, provider, provider_account_id)
    WHERE status = 'active'
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_bindings_event_code_idx
    ON codeclip_provider_account_bindings (event_code)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_bindings_status_idx
    ON codeclip_provider_account_bindings (status)
  `);
}

async function ensureCodeClipProviderAccountBindingAuditTable(queryClient = pool) {
  if (!queryClient) return;

  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS codeclip_provider_account_binding_audit (
      id BIGSERIAL PRIMARY KEY,
      vertical TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      event_code TEXT NOT NULL,
      provider TEXT NOT NULL,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      before_state JSONB,
      after_state JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (vertical = 'codeclip'),
      CHECK (action IN ('created', 'display_name_updated', 'disabled', 'reactivated'))
    )
  `);

  await queryClient.query(`
    ALTER TABLE codeclip_provider_account_binding_audit
    ALTER COLUMN actor_id DROP NOT NULL
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_binding_audit_binding_id_idx
    ON codeclip_provider_account_binding_audit (binding_id)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_binding_audit_event_code_idx
    ON codeclip_provider_account_binding_audit (event_code)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_binding_audit_created_at_idx
    ON codeclip_provider_account_binding_audit (created_at)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_account_binding_audit_vertical_event_created_idx
    ON codeclip_provider_account_binding_audit (vertical, event_code, created_at)
  `);
}

async function ensureCodeClipProviderDeliveriesTable(queryClient = pool) {
  if (!queryClient) return;

  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS codeclip_provider_deliveries (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      event_code TEXT NOT NULL,
      event_id TEXT,
      external_message_id TEXT NOT NULL,
      idempotency_key TEXT,
      payload_fingerprint TEXT,
      verification_state TEXT NOT NULL DEFAULT 'verified',
      processing_state TEXT NOT NULL DEFAULT 'received',
      attempt_count INTEGER NOT NULL DEFAULT 1,
      core_persistence_state TEXT NOT NULL DEFAULT 'not_started',
      completion_state TEXT NOT NULL DEFAULT 'not_completed',
      response_status INTEGER,
      public_response_json JSONB,
      error_class TEXT,
      retry_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      terminal_state BOOLEAN NOT NULL DEFAULT FALSE,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_account_id, event_code, external_message_id),
      CHECK (attempt_count >= 1)
    )
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_deliveries_event_code_idx
    ON codeclip_provider_deliveries (event_code)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_deliveries_completion_state_idx
    ON codeclip_provider_deliveries (completion_state)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_deliveries_processing_state_idx
    ON codeclip_provider_deliveries (processing_state)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_provider_deliveries_received_at_idx
    ON codeclip_provider_deliveries (received_at DESC)
  `);
}

async function getCodeClipProviderDeliveryByIdentity(identity = {}, queryClient = pool) {
  if (!queryClient) return null;
  if (!hasCodeClipProviderDeliveryIdentity(identity)) return null;

  const normalized = normalizeCodeClipProviderDeliveryIdentity(identity);

  if (queryClient === pool) {
    await ensureCodeClipProviderDeliveriesTable(queryClient);
  }

  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_provider_deliveries
      WHERE provider = $1
        AND provider_account_id = $2
        AND event_code = $3
        AND external_message_id = $4
      LIMIT 1
    `,
    [
      normalized.provider,
      normalized.providerAccountId,
      normalized.eventCode,
      normalized.externalMessageId,
    ]
  );

  return mapCodeClipProviderDeliveryRow(result.rows?.[0] || null);
}

async function findCodeClipProviderDeliveryForReplayIdentity({
  provider,
  providerAccountId,
  externalMessageId,
  queryClient,
} = {}) {
  if (!queryClient || typeof queryClient.query !== 'function') {
    return { status: 'unavailable', row: null };
  }

  const normalized = {
    provider: String(provider || '').trim().toLowerCase(),
    providerAccountId: String(providerAccountId || '').trim(),
    externalMessageId: String(externalMessageId || '').trim(),
  };
  if (!normalized.provider || !normalized.providerAccountId || !normalized.externalMessageId) {
    return { status: 'not_found', row: null };
  }

  try {
    const result = await queryClient.query(
      `
        SELECT *
        FROM codeclip_provider_deliveries
        WHERE provider = $1
          AND provider_account_id = $2
          AND external_message_id = $3
        ORDER BY received_at DESC, id DESC
        LIMIT 2
      `,
      [
        normalized.provider,
        normalized.providerAccountId,
        normalized.externalMessageId,
      ]
    );
    const rows = result.rows || [];
    if (!rows.length) return { status: 'not_found', row: null };
    if (rows.length > 1) return { status: 'ambiguous', row: null };
    return { status: 'found', row: mapCodeClipProviderDeliveryRow(rows[0]) };
  } catch (error) {
    return { status: 'unavailable', row: null, error };
  }
}

function optionalCodeClipProviderDeliveryString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

async function createCodeClipProviderDelivery(delivery = {}, queryClient = pool) {
  if (!queryClient) {
    return {
      status: 'failed',
      created: false,
      existing: false,
      row: null,
      error: new Error('codeClip provider delivery ledger requires PostgreSQL pool'),
    };
  }
  if (!hasCodeClipProviderDeliveryIdentity(delivery)) {
    return {
      status: 'failed',
      created: false,
      existing: false,
      row: null,
      error: new Error('codeClip provider delivery identity is incomplete'),
    };
  }

  const normalized = normalizeCodeClipProviderDeliveryIdentity(delivery);

  try {
    if (queryClient === pool) {
      await ensureCodeClipProviderDeliveriesTable(queryClient);
    }

    const result = await queryClient.query(
      `
        INSERT INTO codeclip_provider_deliveries (
          provider,
          provider_account_id,
          event_code,
          event_id,
          external_message_id,
          idempotency_key,
          payload_fingerprint,
          verification_state,
          processing_state,
          attempt_count,
          core_persistence_state,
          completion_state,
          retry_eligible,
          terminal_state,
          received_at,
          last_attempt_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,COALESCE($14::timestamptz,NOW()),NOW(),NOW())
        ON CONFLICT (provider, provider_account_id, event_code, external_message_id)
        DO NOTHING
        RETURNING *
      `,
      [
        normalized.provider,
        normalized.providerAccountId,
        normalized.eventCode,
        optionalCodeClipProviderDeliveryString(delivery.eventId || delivery.event_id),
        normalized.externalMessageId,
        optionalCodeClipProviderDeliveryString(delivery.idempotencyKey || delivery.idempotency_key),
        optionalCodeClipProviderDeliveryString(delivery.payloadFingerprint || delivery.payload_fingerprint),
        delivery.verificationState || delivery.verification_state || 'verified',
        delivery.processingState || delivery.processing_state || 'processing',
        delivery.corePersistenceState || delivery.core_persistence_state || 'not_started',
        delivery.completionState || delivery.completion_state || 'not_completed',
        delivery.retryEligible ?? delivery.retry_eligible ?? false,
        delivery.terminalState ?? delivery.terminal_state ?? false,
        delivery.receivedAt || delivery.received_at || null,
      ]
    );

    if (result.rows?.[0]) {
      return {
        status: 'created',
        created: true,
        existing: false,
        row: mapCodeClipProviderDeliveryRow(result.rows[0]),
      };
    }

    const existing = await getCodeClipProviderDeliveryByIdentity(normalized, queryClient);
    if (existing) {
      return {
        status: 'existing',
        created: false,
        existing: true,
        row: existing,
      };
    }

    return {
      status: 'failed',
      created: false,
      existing: false,
      row: null,
      error: new Error('codeClip provider delivery conflict row could not be loaded'),
    };
  } catch (error) {
    return {
      status: 'failed',
      created: false,
      existing: false,
      row: null,
      error,
    };
  }
}

const CODECLIP_PROVIDER_DELIVERY_UPDATE_COLUMNS = {
  processingState: 'processing_state',
  processing_state: 'processing_state',
  attemptCount: 'attempt_count',
  attempt_count: 'attempt_count',
  corePersistenceState: 'core_persistence_state',
  core_persistence_state: 'core_persistence_state',
  completionState: 'completion_state',
  completion_state: 'completion_state',
  responseStatus: 'response_status',
  response_status: 'response_status',
  publicResponseJson: 'public_response_json',
  public_response_json: 'public_response_json',
  errorClass: 'error_class',
  error_class: 'error_class',
  retryEligible: 'retry_eligible',
  retry_eligible: 'retry_eligible',
  terminalState: 'terminal_state',
  terminal_state: 'terminal_state',
  lastAttemptAt: 'last_attempt_at',
  last_attempt_at: 'last_attempt_at',
  completedAt: 'completed_at',
  completed_at: 'completed_at',
};

function normalizeCodeClipProviderDeliveryUpdateValue(column, value) {
  if (column === 'public_response_json') {
    return {
      ok: true,
      value: value === null ? null : JSON.stringify(value),
    };
  }
  if (column === 'attempt_count') {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        ok: false,
        error: new Error(
          'codeClip provider delivery attempt_count must be an integer greater than or equal to 1'
        ),
      };
    }
    return { ok: true, value: parsed };
  }
  return { ok: true, value };
}

function buildCodeClipProviderDeliveryStateUpdates(updates = {}) {
  const normalized = new Map();
  let sawInput = false;

  for (const [key, value] of Object.entries(updates || {})) {
    sawInput = true;
    const column = CODECLIP_PROVIDER_DELIVERY_UPDATE_COLUMNS[key];
    if (!column) continue;

    const normalizedValue = normalizeCodeClipProviderDeliveryUpdateValue(column, value);
    if (!normalizedValue.ok) return normalizedValue;
    normalized.set(column, normalizedValue.value);
  }

  return { ok: true, sawInput, values: normalized };
}

async function updateCodeClipProviderDeliveryState(identity = {}, updates = {}, queryClient = pool) {
  if (!queryClient) {
    return {
      status: 'failed',
      row: null,
      error: new Error('codeClip provider delivery ledger requires PostgreSQL pool'),
    };
  }
  if (!hasCodeClipProviderDeliveryIdentity(identity)) {
    return {
      status: 'failed',
      row: null,
      error: new Error('codeClip provider delivery identity is incomplete'),
    };
  }

  const normalized = normalizeCodeClipProviderDeliveryIdentity(identity);
  const stateUpdates = buildCodeClipProviderDeliveryStateUpdates(updates);
  if (!stateUpdates.ok) {
    return {
      status: 'failed',
      row: null,
      error: stateUpdates.error,
    };
  }

  try {
    if (!stateUpdates.values.size) {
      if (stateUpdates.sawInput) {
        return {
          status: 'failed',
          row: null,
          error: new Error('codeClip provider delivery update contains no allowed fields'),
        };
      }

      return {
        status: 'unchanged',
        row: await getCodeClipProviderDeliveryByIdentity(normalized, queryClient),
      };
    }

    if (queryClient === pool) {
      await ensureCodeClipProviderDeliveriesTable(queryClient);
    }

    const assignments = [];
    const values = [];
    for (const [column, value] of stateUpdates.values.entries()) {
      values.push(value);
      const cast = column === 'public_response_json' ? '::jsonb' : '';
      assignments.push(`${column} = $${values.length}${cast}`);
    }

    assignments.push('updated_at = NOW()');
    values.push(
      normalized.provider,
      normalized.providerAccountId,
      normalized.eventCode,
      normalized.externalMessageId
    );
    const whereStart = values.length - 3;

    const result = await queryClient.query(
      `
        UPDATE codeclip_provider_deliveries
        SET ${assignments.join(', ')}
        WHERE provider = $${whereStart}
          AND provider_account_id = $${whereStart + 1}
          AND event_code = $${whereStart + 2}
          AND external_message_id = $${whereStart + 3}
        RETURNING *
      `,
      values
    );

    return {
      status: result.rows?.[0] ? 'updated' : 'not_found',
      row: mapCodeClipProviderDeliveryRow(result.rows?.[0] || null),
    };
  } catch (error) {
    return {
      status: 'failed',
      row: null,
      error,
    };
  }
}

async function ensureCodeClipXtraRedemptionsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codeclip_clipxtra_redemptions (
      id BIGSERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      event_code TEXT NOT NULL,
      event_id TEXT,
      scan_id TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'codeclip',
      reward_type TEXT NOT NULL DEFAULT 'clip_xtra',
      tier TEXT NOT NULL DEFAULT 'clipXtra',
      display_tier TEXT NOT NULL DEFAULT 'ClipXtra',
      partner_name TEXT,
      reward_title TEXT,
      redemption_location TEXT,
      redemption_deadline TEXT,
      redemption_instructions TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      downloaded_at TIMESTAMPTZ,
      redeemed_at TIMESTAMPTZ,
      redeemed_by TEXT,
      already_redeemed_attempts INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, scan_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_clipxtra_redemptions_event_code_idx
    ON codeclip_clipxtra_redemptions (event_code)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_clipxtra_redemptions_status_idx
    ON codeclip_clipxtra_redemptions (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_clipxtra_redemptions_assigned_at_idx
    ON codeclip_clipxtra_redemptions (assigned_at DESC)
  `);
}

async function saveCodeClipXtraRedemption(record = {}, queryClient = pool) {
  if (!queryClient || !record.eventCode || !record.scanId || !record.token) return null;

  if (queryClient === pool) {
    await ensureCodeClipXtraRedemptionsTable();
  }

  const result = await queryClient.query(
    `
      INSERT INTO codeclip_clipxtra_redemptions (
        token,
        event_code,
        event_id,
        scan_id,
        vertical,
        reward_type,
        tier,
        display_tier,
        partner_name,
        reward_title,
        redemption_location,
        redemption_deadline,
        redemption_instructions,
        status,
        assigned_at,
        raw_payload,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::timestamptz,NOW()),$16,NOW())
      ON CONFLICT (event_code, scan_id)
      DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, codeclip_clipxtra_redemptions.event_id),
        vertical = EXCLUDED.vertical,
        reward_type = EXCLUDED.reward_type,
        tier = EXCLUDED.tier,
        display_tier = EXCLUDED.display_tier,
        partner_name = EXCLUDED.partner_name,
        reward_title = EXCLUDED.reward_title,
        redemption_location = EXCLUDED.redemption_location,
        redemption_deadline = EXCLUDED.redemption_deadline,
        redemption_instructions = EXCLUDED.redemption_instructions,
        status = CASE
          WHEN codeclip_clipxtra_redemptions.redeemed_at IS NOT NULL THEN codeclip_clipxtra_redemptions.status
          ELSE EXCLUDED.status
        END,
        assigned_at = COALESCE(codeclip_clipxtra_redemptions.assigned_at, EXCLUDED.assigned_at),
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
      RETURNING *
    `,
    [
      record.token,
      record.eventCode,
      record.eventId || '',
      record.scanId,
      record.vertical || 'codeclip',
      record.rewardType || 'clip_xtra',
      record.tier || 'clipXtra',
      record.displayTier || 'ClipXtra',
      record.partnerName || '',
      record.rewardTitle || record.title || '',
      record.redemptionLocation || '',
      record.redemptionDeadline || '',
      record.redemptionInstructions || '',
      record.status || 'assigned',
      record.assignedAt || null,
      JSON.stringify(record.rawPayload || record),
    ]
  );

  return result.rows[0] || null;
}

async function ensureCodeClipInteractionsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codeclip_interactions (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      scan_id TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'codeclip',
      routing_outcome TEXT NOT NULL DEFAULT 'MATCH',
      interaction_state TEXT NOT NULL DEFAULT 'processed',
      tier TEXT,
      scan_rank INTEGER,
      raw_scans INTEGER,
      unique_scans INTEGER,
      reward_assignments JSONB,
      raw_payload JSONB,
      occurred_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, scan_id)
    )
  `);

  await pool.query(`
    ALTER TABLE codeclip_interactions
    ADD COLUMN IF NOT EXISTS interaction_state TEXT NOT NULL DEFAULT 'processed'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_interactions_event_code_created_at_idx
    ON codeclip_interactions (event_code, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_interactions_routing_outcome_idx
    ON codeclip_interactions (routing_outcome)
  `);
}

async function saveCodeClipInteraction(interaction = {}, queryClient = pool) {
  if (!queryClient || !interaction.eventCode || !interaction.scanId) return null;

  if (queryClient === pool) {
    await ensureCodeClipInteractionsTable();
  }

  const routingOutcome =
    typeof interaction.routingOutcome === 'string'
      ? interaction.routingOutcome
      : interaction.routingOutcome?.status || interaction.routingOutcome?.type || 'MATCH';
  const rewardAssignmentsPayload = interaction.rewardAssignments || {};
  const rawInteractionPayload = interaction;

  const result = await queryClient.query(
    `
      INSERT INTO codeclip_interactions (
        event_code,
        event_id,
        scan_id,
        vertical,
        routing_outcome,
        interaction_state,
        tier,
        scan_rank,
        raw_scans,
        unique_scans,
        reward_assignments,
        raw_payload,
        occurred_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,COALESCE($13::timestamptz,NOW()),NOW())
      ON CONFLICT (event_code, scan_id)
      DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, codeclip_interactions.event_id),
        vertical = EXCLUDED.vertical,
        routing_outcome = EXCLUDED.routing_outcome,
        interaction_state = EXCLUDED.interaction_state,
        tier = EXCLUDED.tier,
        scan_rank = EXCLUDED.scan_rank,
        raw_scans = EXCLUDED.raw_scans,
        unique_scans = EXCLUDED.unique_scans,
        reward_assignments = EXCLUDED.reward_assignments,
        raw_payload = EXCLUDED.raw_payload,
        occurred_at = COALESCE(codeclip_interactions.occurred_at, EXCLUDED.occurred_at),
        updated_at = NOW()
      RETURNING *
    `,
    [
      interaction.eventCode,
      interaction.eventId ?? null,
      interaction.scanId,
      interaction.vertical || 'codeclip',
      routingOutcome,
      interaction.state || 'processed',
      interaction.tier ?? null,
      interaction.scanRank ?? null,
      interaction.rawScans ?? null,
      interaction.uniqueScans ?? null,
      JSON.stringify(rewardAssignmentsPayload),
      JSON.stringify(rawInteractionPayload),
      interaction.timestamp || null,
    ]
  );

  return result.rows[0] || null;
}

function parseJsonPayload(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function ensureCodePodKeywordInteractionsTable(queryClient = pool) {
  if (!queryClient) return;

  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS codepod_keyword_interactions (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      message_id TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'codepod',
      source TEXT NOT NULL DEFAULT 'keyword',
      interaction_type TEXT NOT NULL DEFAULT 'keyword',
      keyword TEXT NOT NULL,
      routing_outcome TEXT NOT NULL DEFAULT 'MATCH',
      tier TEXT,
      assignment_status TEXT,
      interaction JSONB,
      reward_assignment JSONB,
      occurred_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, message_id)
    )
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codepod_keyword_interactions_event_code_created_at_idx
    ON codepod_keyword_interactions (event_code, created_at DESC)
  `);
}

function formatCodePodKeywordInteractionRow(row = {}) {
  const rewardAssignment = parseJsonPayload(
    row.reward_assignment,
    row.reward_assignment || null
  );

  return {
    ...row,
    interaction: parseJsonPayload(row.interaction, row.interaction || null),
    reward_assignment: rewardAssignment,
    rewardAssignment,
  };
}

async function insertCodePodKeywordInteraction(record = {}, queryClient = pool) {
  if (!queryClient || !record.eventCode || !record.messageId) return null;

  const result = await queryClient.query(
    `
      INSERT INTO codepod_keyword_interactions (
        event_code,
        event_id,
        message_id,
        vertical,
        source,
        interaction_type,
        keyword,
        routing_outcome,
        tier,
        assignment_status,
        interaction,
        reward_assignment,
        occurred_at,
        updated_at
      )
      VALUES ($1,$2,$3,'codepod','keyword','keyword',$4,$5,$6,$7,$8::jsonb,$9::jsonb,COALESCE($10::timestamptz,NOW()),NOW())
      ON CONFLICT (event_code, message_id) DO NOTHING
      RETURNING *
    `,
    [
      record.eventCode,
      record.eventId || null,
      record.messageId,
      record.keyword || "",
      record.routingOutcome || "MATCH",
      record.tier || null,
      record.assignmentStatus || null,
      JSON.stringify(record.interaction || {}),
      JSON.stringify(record.rewardAssignment || {}),
      record.occurredAt || null,
    ]
  );

  return result.rows?.[0]
    ? formatCodePodKeywordInteractionRow(result.rows[0])
    : null;
}

async function getCodePodKeywordInteraction(eventCode, messageId, queryClient = pool) {
  if (!queryClient || !eventCode || !messageId) return null;

  const result = await queryClient.query(
    `
      SELECT *
      FROM codepod_keyword_interactions
      WHERE event_code = $1
        AND message_id = $2
      LIMIT 1
    `,
    [eventCode, messageId]
  );

  return result.rows?.[0]
    ? formatCodePodKeywordInteractionRow(result.rows[0])
    : null;
}

function emptyCodePodKeywordInteractionSummary() {
  return {
    totalInteractions: 0,
    assigned: 0,
    noReward: 0,
    exhausted: 0,
    tiers: {
      gold: 0,
      silver: 0,
      general: 0,
    },
  };
}

async function getCodePodKeywordInteractionSummary(eventCode, queryClient = pool) {
  if (!queryClient || !eventCode) {
    return emptyCodePodKeywordInteractionSummary();
  }

  const result = await queryClient.query(
    `
      SELECT
        COUNT(*) AS total_interactions,
        COUNT(*) FILTER (WHERE assignment_status = 'assigned') AS assigned,
        COUNT(*) FILTER (
          WHERE reward_assignment @> '{"noReward":true}'::jsonb
        ) AS no_reward,
        COUNT(*) FILTER (
          WHERE reward_assignment @> '{"exhausted":true}'::jsonb
        ) AS exhausted,
        COUNT(*) FILTER (WHERE LOWER(tier) = 'gold') AS tier_gold,
        COUNT(*) FILTER (WHERE LOWER(tier) = 'silver') AS tier_silver,
        COUNT(*) FILTER (WHERE LOWER(tier) = 'general') AS tier_general
      FROM codepod_keyword_interactions
      WHERE event_code = $1
        AND vertical = 'codepod'
        AND source = 'keyword'
        AND interaction_type = 'keyword'
    `,
    [eventCode]
  );

  const row = result.rows?.[0] || {};

  return {
    totalInteractions: Number(row.total_interactions || 0),
    assigned: Number(row.assigned || 0),
    noReward: Number(row.no_reward || 0),
    exhausted: Number(row.exhausted || 0),
    tiers: {
      gold: Number(row.tier_gold || 0),
      silver: Number(row.tier_silver || 0),
      general: Number(row.tier_general || 0),
    },
  };
}

function normalizeCodeClipInteractionLimit(limit = 100) {
  const parsed = Number.parseInt(String(limit || 100), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function formatCodeClipInteractionRow(row = {}) {
  const rawPayload = parseJsonPayload(row.raw_payload, row.raw_payload || null);

  return {
    ...row,
    raw_payload: rawPayload,
    rawPayload,
  };
}

async function getCodeClipInteractions(eventCode, limit = 100, queryClient = pool) {
  if (!queryClient || !eventCode) return [];

  const safeLimit = normalizeCodeClipInteractionLimit(limit);

  if (queryClient === pool) {
    await ensureCodeClipInteractionsTable();
  }

  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_interactions
      WHERE event_code = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [eventCode, safeLimit]
  );

  return (result.rows || []).map(formatCodeClipInteractionRow);
}

async function getCodeClipInteractionSummary(eventCode, queryClient = pool) {
  if (!queryClient || !eventCode) {
    return {
      routingOutcomes: { MATCH: 0, NO_CAMPAIGN_MATCH: 0 },
      interactionStates: { processed: 0, unmatched: 0 },
      latestInteractionAt: null,
    };
  }

  if (queryClient === pool) {
    await ensureCodeClipInteractionsTable();
  }

  const result = await queryClient.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE routing_outcome = 'MATCH')::INTEGER AS match_count,
        COUNT(*) FILTER (WHERE routing_outcome = 'NO_CAMPAIGN_MATCH')::INTEGER AS no_campaign_match_count,
        COUNT(*) FILTER (WHERE interaction_state = 'processed')::INTEGER AS processed_count,
        COUNT(*) FILTER (WHERE interaction_state = 'unmatched')::INTEGER AS unmatched_count,
        MAX(created_at) AS latest_interaction_at
      FROM codeclip_interactions
      WHERE event_code = $1
    `,
    [eventCode]
  );
  const row = result.rows?.[0] || {};

  return {
    routingOutcomes: {
      MATCH: Number(row.match_count || 0),
      NO_CAMPAIGN_MATCH: Number(row.no_campaign_match_count || 0),
    },
    interactionStates: {
      processed: Number(row.processed_count || 0),
      unmatched: Number(row.unmatched_count || 0),
    },
    latestInteractionAt: row.latest_interaction_at || null,
  };
}

async function ensureCodeClipRewardAssignmentsTable() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS codeclip_reward_assignments (
      id BIGSERIAL PRIMARY KEY,
      event_code TEXT NOT NULL,
      event_id TEXT,
      scan_id TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'codeclip',
      interaction_state TEXT,
      routing_outcome TEXT,
      tier TEXT NOT NULL,
      display_tier TEXT,
      assigned BOOLEAN,
      status TEXT,
      reason TEXT,
      reward_type TEXT,
      title TEXT,
      type TEXT,
      content_url TEXT,
      content_file_name TEXT,
      quantity INTEGER,
      assigned_count INTEGER,
      remaining INTEGER,
      unlimited BOOLEAN,
      exhausted BOOLEAN,
      no_reward BOOLEAN,
      redemption_token TEXT,
      partner_name TEXT,
      product TEXT,
      redemption_location TEXT,
      redemption_deadline TEXT,
      redemption_instructions TEXT,
      partner_logo TEXT,
      partner_logo_file_name TEXT,
      assigned_at TIMESTAMPTZ,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_code, scan_id, tier)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_reward_assignments_event_code_created_at_idx
    ON codeclip_reward_assignments (event_code, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_reward_assignments_tier_idx
    ON codeclip_reward_assignments (tier)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS codeclip_reward_assignments_redemption_token_idx
    ON codeclip_reward_assignments (redemption_token)
  `);
}

async function saveCodeClipRewardAssignments(snapshot = {}, queryClient = pool) {
  if (!queryClient || !snapshot.eventCode || !snapshot.scanId) return [];

  const assignments = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  if (!assignments.length) return [];

  if (queryClient === pool) {
    await ensureCodeClipRewardAssignmentsTable();
  }

  const rows = [];
  for (const assignment of assignments) {
    if (!assignment?.tier) continue;

    const rawPayload = {
      eventCode: snapshot.eventCode,
      eventId: snapshot.eventId ?? null,
      scanId: snapshot.scanId,
      interactionState: snapshot.interactionState,
      routingOutcome: snapshot.routingOutcome,
      audienceContext: snapshot.audienceContext || null,
      assignment,
    };

    const result = await queryClient.query(
      `
        INSERT INTO codeclip_reward_assignments (
          event_code,
          event_id,
          scan_id,
          vertical,
          interaction_state,
          routing_outcome,
          tier,
          display_tier,
          assigned,
          status,
          reason,
          reward_type,
          title,
          type,
          content_url,
          content_file_name,
          quantity,
          assigned_count,
          remaining,
          unlimited,
          exhausted,
          no_reward,
          redemption_token,
          partner_name,
          product,
          redemption_location,
          redemption_deadline,
          redemption_instructions,
          partner_logo,
          partner_logo_file_name,
          assigned_at,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::timestamptz,$32::jsonb,NOW())
        ON CONFLICT (event_code, scan_id, tier)
        DO UPDATE SET
          event_id = COALESCE(EXCLUDED.event_id, codeclip_reward_assignments.event_id),
          vertical = EXCLUDED.vertical,
          interaction_state = EXCLUDED.interaction_state,
          routing_outcome = EXCLUDED.routing_outcome,
          display_tier = EXCLUDED.display_tier,
          assigned = EXCLUDED.assigned,
          status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          reward_type = EXCLUDED.reward_type,
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          content_url = EXCLUDED.content_url,
          content_file_name = EXCLUDED.content_file_name,
          quantity = EXCLUDED.quantity,
          assigned_count = EXCLUDED.assigned_count,
          remaining = EXCLUDED.remaining,
          unlimited = EXCLUDED.unlimited,
          exhausted = EXCLUDED.exhausted,
          no_reward = EXCLUDED.no_reward,
          redemption_token = EXCLUDED.redemption_token,
          partner_name = EXCLUDED.partner_name,
          product = EXCLUDED.product,
          redemption_location = EXCLUDED.redemption_location,
          redemption_deadline = EXCLUDED.redemption_deadline,
          redemption_instructions = EXCLUDED.redemption_instructions,
          partner_logo = EXCLUDED.partner_logo,
          partner_logo_file_name = EXCLUDED.partner_logo_file_name,
          assigned_at = COALESCE(codeclip_reward_assignments.assigned_at, EXCLUDED.assigned_at),
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
        RETURNING *
      `,
      [
        snapshot.eventCode,
        snapshot.eventId ?? null,
        snapshot.scanId,
        'codeclip',
        snapshot.interactionState || null,
        snapshot.routingOutcome || null,
        assignment.tier,
        assignment.displayTier || null,
        assignment.assigned ?? null,
        assignment.status || null,
        assignment.reason || null,
        assignment.rewardType || null,
        assignment.title || null,
        assignment.type || null,
        assignment.contentUrl || null,
        assignment.contentFileName || null,
        assignment.quantity ?? null,
        assignment.assignedCount ?? null,
        assignment.remaining ?? null,
        assignment.unlimited ?? null,
        assignment.exhausted ?? null,
        assignment.noReward ?? null,
        assignment.redemptionToken || null,
        assignment.partnerName || null,
        assignment.product || null,
        assignment.redemptionLocation || null,
        assignment.redemptionDeadline || null,
        assignment.redemptionInstructions || null,
        assignment.partnerLogo || null,
        assignment.partnerLogoFileName || null,
        assignment.assignedAt || null,
        JSON.stringify(rawPayload),
      ]
    );

    if (result.rows?.[0]) rows.push(result.rows[0]);
  }

  return rows;
}

function normalizeCodeClipRewardAssignmentLimit(limit = 100) {
  return normalizeCodeClipInteractionLimit(limit);
}

function formatCodeClipRewardAssignmentRow(row = {}) {
  const rawPayload = parseJsonPayload(row.raw_payload, row.raw_payload || null);

  return {
    ...row,
    raw_payload: rawPayload,
    rawPayload,
  };
}

async function getCodeClipRewardAssignments(eventCode, limit = 100, queryClient = pool) {
  if (!queryClient || !eventCode) return [];

  const safeLimit = normalizeCodeClipRewardAssignmentLimit(limit);

  if (queryClient === pool) {
    await ensureCodeClipRewardAssignmentsTable();
  }

  const result = await queryClient.query(
    `
      SELECT *
      FROM codeclip_reward_assignments
      WHERE event_code = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [eventCode, safeLimit]
  );

  return (result.rows || []).map(formatCodeClipRewardAssignmentRow);
}

function createEmptyCodeClipRewardAssignmentSummary() {
  return {
    totalAssignments: 0,
    assignedCount: 0,
    unassignedCount: 0,
    exhaustedCount: 0,
    noRewardCount: 0,
    tiers: {
      openClip: 0,
      clip: 0,
      clipPlus: 0,
      clipXtra: 0,
    },
    assignedByTier: {
      openClip: 0,
      clip: 0,
      clipPlus: 0,
      clipXtra: 0,
    },
    clipXtraWithTokenCount: 0,
    latestAssignmentAt: null,
  };
}

async function getCodeClipRewardAssignmentSummary(eventCode, queryClient = pool) {
  if (!queryClient || !eventCode) {
    return createEmptyCodeClipRewardAssignmentSummary();
  }

  if (queryClient === pool) {
    await ensureCodeClipRewardAssignmentsTable();
  }

  const result = await queryClient.query(
    `
      SELECT
        COUNT(*)::INTEGER AS total_count,
        COUNT(*) FILTER (WHERE assigned = TRUE)::INTEGER AS assigned_count,
        COUNT(*) FILTER (WHERE assigned = FALSE)::INTEGER AS unassigned_count,
        COUNT(*) FILTER (WHERE exhausted = TRUE)::INTEGER AS exhausted_count,
        COUNT(*) FILTER (WHERE no_reward = TRUE)::INTEGER AS no_reward_count,
        COUNT(*) FILTER (WHERE tier = 'openClip')::INTEGER AS open_clip_count,
        COUNT(*) FILTER (WHERE tier = 'clip')::INTEGER AS clip_count,
        COUNT(*) FILTER (WHERE tier = 'clipPlus')::INTEGER AS clip_plus_count,
        COUNT(*) FILTER (WHERE tier = 'clipXtra')::INTEGER AS clip_xtra_count,
        COUNT(*) FILTER (WHERE tier = 'openClip' AND assigned = TRUE)::INTEGER AS open_clip_assigned_count,
        COUNT(*) FILTER (WHERE tier = 'clip' AND assigned = TRUE)::INTEGER AS clip_assigned_count,
        COUNT(*) FILTER (WHERE tier = 'clipPlus' AND assigned = TRUE)::INTEGER AS clip_plus_assigned_count,
        COUNT(*) FILTER (WHERE tier = 'clipXtra' AND assigned = TRUE)::INTEGER AS clip_xtra_assigned_count,
        COUNT(*) FILTER (WHERE tier = 'clipXtra' AND redemption_token IS NOT NULL)::INTEGER AS clip_xtra_with_token_count,
        MAX(created_at) AS latest_assignment_at
      FROM codeclip_reward_assignments
      WHERE event_code = $1
    `,
    [eventCode]
  );
  const row = result.rows?.[0] || {};

  return {
    totalAssignments: Number(row.total_count || 0),
    assignedCount: Number(row.assigned_count || 0),
    unassignedCount: Number(row.unassigned_count || 0),
    exhaustedCount: Number(row.exhausted_count || 0),
    noRewardCount: Number(row.no_reward_count || 0),
    tiers: {
      openClip: Number(row.open_clip_count || 0),
      clip: Number(row.clip_count || 0),
      clipPlus: Number(row.clip_plus_count || 0),
      clipXtra: Number(row.clip_xtra_count || 0),
    },
    assignedByTier: {
      openClip: Number(row.open_clip_assigned_count || 0),
      clip: Number(row.clip_assigned_count || 0),
      clipPlus: Number(row.clip_plus_assigned_count || 0),
      clipXtra: Number(row.clip_xtra_assigned_count || 0),
    },
    clipXtraWithTokenCount: Number(row.clip_xtra_with_token_count || 0),
    latestAssignmentAt: row.latest_assignment_at || null,
  };
}

async function ensureCodeClipOutboxEventsTable(queryClient = pool) {
  if (!queryClient) return;

  await queryClient.query(`
    CREATE TABLE IF NOT EXISTS codeclip_outbox_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      event_code TEXT,
      event_id TEXT,
      scan_id TEXT,
      message_id TEXT,
      routing_outcome TEXT,
      interaction_state TEXT,
      severity TEXT,
      action TEXT,
      retry BOOLEAN DEFAULT FALSE,
      escalate BOOLEAN DEFAULT FALSE,
      reason TEXT,
      payload JSONB,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_outbox_events_status_available_at_idx
    ON codeclip_outbox_events (status, available_at)
  `);

  await queryClient.query(`
    CREATE INDEX IF NOT EXISTS codeclip_outbox_events_event_code_created_at_idx
    ON codeclip_outbox_events (event_code, created_at DESC)
  `);
}

async function saveCodeClipOutboxEvent(event = {}, queryClient = pool) {
  if (!queryClient || !event.eventType) return null;

  await ensureCodeClipOutboxEventsTable(queryClient);

  const result = await queryClient.query(
    `
      INSERT INTO codeclip_outbox_events (
        event_type,
        status,
        event_code,
        event_id,
        scan_id,
        message_id,
        routing_outcome,
        interaction_state,
        severity,
        action,
        retry,
        escalate,
        reason,
        payload,
        available_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,COALESCE($15::timestamptz,NOW()),NOW())
      RETURNING *
    `,
    [
      event.eventType,
      event.status || 'pending',
      event.eventCode || null,
      event.eventId || null,
      event.scanId || null,
      event.messageId || null,
      event.routingOutcome || null,
      event.interactionState || null,
      event.severity || null,
      event.action || null,
      event.retry ?? false,
      event.escalate ?? false,
      event.reason || null,
      JSON.stringify(event.payload || {}),
      event.availableAt || null,
    ]
  );

  return result.rows?.[0] || null;
}

function normalizeCodeClipOutboxLimit(limit = 10) {
  const parsed = Number.parseInt(String(limit || 10), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 100);
}

async function claimCodeClipOutboxEvents({ limit = 10, now = null } = {}, queryClient = pool) {
  if (!queryClient) return [];

  await ensureCodeClipOutboxEventsTable(queryClient);

  const safeLimit = normalizeCodeClipOutboxLimit(limit);
  const result = await queryClient.query(
    `
      WITH candidates AS (
        SELECT id
        FROM codeclip_outbox_events
        WHERE status = 'pending'
          AND available_at <= COALESCE($2::timestamptz, NOW())
        ORDER BY available_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE codeclip_outbox_events
      SET
        status = 'processing',
        attempt_count = attempt_count + 1,
        updated_at = NOW()
      WHERE id IN (SELECT id FROM candidates)
      RETURNING *
    `,
    [safeLimit, now]
  );

  return result.rows || [];
}

async function markCodeClipOutboxEventSucceeded(id, queryClient = pool) {
  if (!queryClient || !id) return null;

  await ensureCodeClipOutboxEventsTable(queryClient);

  const result = await queryClient.query(
    `
      UPDATE codeclip_outbox_events
      SET
        status = 'succeeded',
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id]
  );

  return result.rows?.[0] || null;
}

async function markCodeClipOutboxEventFailed({ id, error = "", availableAt = null } = {}, queryClient = pool) {
  if (!queryClient || !id) return null;

  await ensureCodeClipOutboxEventsTable(queryClient);

  const result = await queryClient.query(
    `
      UPDATE codeclip_outbox_events
      SET
        status = 'pending',
        available_at = COALESCE($2::timestamptz, NOW()),
        payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
          'lastError', $3::text,
          'lastFailedAt', NOW()
        ),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id, availableAt, String(error || "")]
  );

  return result.rows?.[0] || null;
}

async function markCodeClipOutboxEventDeadLetter({ id, error = "" } = {}, queryClient = pool) {
  if (!queryClient || !id) return null;

  await ensureCodeClipOutboxEventsTable(queryClient);

  const result = await queryClient.query(
    `
      UPDATE codeclip_outbox_events
      SET
        status = 'dead_letter',
        payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
          'deadLetterReason', $2::text,
          'deadLetterAt', NOW()
        ),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [id, String(error || "")]
  );

  return result.rows?.[0] || null;
}

async function getCodeClipXtraRedemptionByToken(token) {
  if (!pool || !token) return null;

  await ensureCodeClipXtraRedemptionsTable();

  const result = await pool.query(
    `
      SELECT *
      FROM codeclip_clipxtra_redemptions
      WHERE token = $1
      LIMIT 1
    `,
    [token]
  );

  return result.rows[0] || null;
}

async function redeemCodeClipXtraRedemption(token, redeemedBy = "partner") {
  if (!pool || !token) return { status: "not_found", row: null };

  await ensureCodeClipXtraRedemptionsTable();

  const redeemed = await pool.query(
    `
      UPDATE codeclip_clipxtra_redemptions
      SET
        status = 'redeemed',
        redeemed_at = NOW(),
        redeemed_by = $2,
        updated_at = NOW()
      WHERE token = $1
        AND redeemed_at IS NULL
      RETURNING *
    `,
    [token, String(redeemedBy || "partner").trim() || "partner"]
  );

  if (redeemed.rows[0]) {
    return { status: "redeemed", row: redeemed.rows[0] };
  }

  const alreadyRedeemed = await pool.query(
    `
      UPDATE codeclip_clipxtra_redemptions
      SET
        already_redeemed_attempts = already_redeemed_attempts + 1,
        updated_at = NOW()
      WHERE token = $1
        AND redeemed_at IS NOT NULL
      RETURNING *
    `,
    [token]
  );

  if (alreadyRedeemed.rows[0]) {
    return { status: "already_redeemed", row: alreadyRedeemed.rows[0] };
  }

  return { status: "not_found", row: null };
}

async function getCodePodGoldXtraRedemptionByToken(token) {
  if (!pool || !token) return null;

  await ensureCodePodGoldXtraRedemptionsTable();

  const result = await pool.query(
    `
      SELECT *
      FROM codepod_goldxtra_redemptions
      WHERE token = $1
      LIMIT 1
    `,
    [token]
  );

  return result.rows[0] || null;
}

async function redeemCodePodGoldXtraRedemption(token, redeemedBy = "partner") {
  if (!pool || !token) return { status: "not_found", row: null };

  await ensureCodePodGoldXtraRedemptionsTable();

  const redeemed = await pool.query(
    `
      UPDATE codepod_goldxtra_redemptions
      SET
        status = 'redeemed',
        redeemed_at = NOW(),
        redeemed_by = $2,
        updated_at = NOW()
      WHERE token = $1
        AND redeemed_at IS NULL
      RETURNING *
    `,
    [token, String(redeemedBy || "partner").trim() || "partner"]
  );

  if (redeemed.rows[0]) {
    return { status: "redeemed", row: redeemed.rows[0] };
  }

  const alreadyRedeemed = await pool.query(
    `
      UPDATE codepod_goldxtra_redemptions
      SET
        already_redeemed_attempts = already_redeemed_attempts + 1,
        updated_at = NOW()
      WHERE token = $1
        AND redeemed_at IS NOT NULL
      RETURNING *
    `,
    [token]
  );

  if (alreadyRedeemed.rows[0]) {
    return { status: "already_redeemed", row: alreadyRedeemed.rows[0] };
  }

  return { status: "not_found", row: null };
}


module.exports = {
  getLatestCodeDemoExceptions,
  getCodeDemoExceptions,
  saveCodeDemoException,
  updateCodeDemoExceptionStatus,
  ensureCodeDemoExceptionsTable,
  withCodeClipCorePersistenceTransaction,
  ensureCodePodGoldXtraRedemptionsTable,
  saveCodePodGoldXtraRedemption,
  ensureCodePodKeywordInteractionsTable,
  insertCodePodKeywordInteraction,
  getCodePodKeywordInteraction,
  getCodePodKeywordInteractionSummary,
  ensureCodeClipProviderAccountBindingsTable,
  ensureCodeClipProviderAccountBindingAuditTable,
  ensureCodeClipProviderDeliveriesTable,
  createCodeClipProviderDelivery,
  getCodeClipProviderDeliveryByIdentity,
  findCodeClipProviderDeliveryForReplayIdentity,
  updateCodeClipProviderDeliveryState,
  hasCodeClipProviderDeliveryReplayInvariants,
  classifyCodeClipProviderDeliveryOperationalState,
  getCodeClipProviderDeliveryOperationalSummary,
  ensureCodeClipXtraRedemptionsTable,
  saveCodeClipXtraRedemption,
  ensureCodeClipInteractionsTable,
  saveCodeClipInteraction,
  getCodeClipInteractions,
  getCodeClipInteractionSummary,
  ensureCodeClipRewardAssignmentsTable,
  saveCodeClipRewardAssignments,
  getCodeClipRewardAssignments,
  getCodeClipRewardAssignmentSummary,
  ensureCodeClipOutboxEventsTable,
  saveCodeClipOutboxEvent,
  claimCodeClipOutboxEvents,
  markCodeClipOutboxEventSucceeded,
  markCodeClipOutboxEventFailed,
  markCodeClipOutboxEventDeadLetter,
  getCodeClipXtraRedemptionByToken,
  redeemCodeClipXtraRedemption,
  getCodePodGoldXtraRedemptionByToken,
  redeemCodePodGoldXtraRedemption,
  getCodeDemoHandshakeReports,
  saveCodeDemoHandshakeReport,
  pool,
  testDbConnection,
  ensureCampaignsTable,
  saveCampaign,
  getCampaignByCode,
  ensureEventScansTable,
  saveEventScan,
  getEventScanSummary,
  getEventRegistrationSummary,
  ensureEventRegistrationsTable,
  saveEventRegistration,
  getEventRegistrations,
  getCodePodReportRows,
  buildEventScanSummaryQuery,
  buildEventRegistrationSummaryQuery,
  buildEventRegistrationsQuery,
  buildCodePodReportRowsQuery,
};
