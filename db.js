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

async function saveCodeClipXtraRedemption(record = {}) {
  if (!pool || !record.eventCode || !record.scanId || !record.token) return null;

  await ensureCodeClipXtraRedemptionsTable();

  const result = await pool.query(
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

async function saveCodeClipInteraction(interaction = {}) {
  if (!pool || !interaction.eventCode || !interaction.scanId) return null;

  await ensureCodeClipInteractionsTable();

  const routingOutcome =
    typeof interaction.routingOutcome === 'string'
      ? interaction.routingOutcome
      : interaction.routingOutcome?.status || interaction.routingOutcome?.type || 'MATCH';
  const rewardAssignmentsPayload = interaction.rewardAssignments || {};
  const rawInteractionPayload = interaction;

  const result = await pool.query(
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
  ensureCodePodGoldXtraRedemptionsTable,
  saveCodePodGoldXtraRedemption,
  ensureCodePodKeywordInteractionsTable,
  insertCodePodKeywordInteraction,
  getCodePodKeywordInteraction,
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
