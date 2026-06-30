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

async function getEventScanSummary(eventCode) {
  if (!pool || !eventCode) {
    return { scans: 0, uniqueScans: 0 };
  }

  await ensureEventScansTable();

  const result = await pool.query(
    `
      SELECT
        COUNT(*)::INTEGER AS scans,
        COUNT(DISTINCT NULLIF(scan_id, ''))::INTEGER AS unique_scans
      FROM event_scans
      WHERE event_code = $1
    `,
    [eventCode]
  );

  const row = result.rows[0] || {};
  return {
    scans: Number(row.scans || 0),
    uniqueScans: Number(row.unique_scans || 0),
  };
}

async function getEventRegistrationSummary(eventCode) {
  if (!pool || !eventCode) {
    return { registrations: 0 };
  }

  await ensureEventRegistrationsTable();

  const result = await pool.query(
    `
      SELECT COUNT(*)::INTEGER AS registrations
      FROM event_registrations
      WHERE event_code = $1
    `,
    [eventCode]
  );

  const row = result.rows[0] || {};
  return {
    registrations: Number(row.registrations || 0),
  };
}

async function getEventRegistrations(eventCode, limit = 50) {
  if (!pool || !eventCode) return [];

  await ensureEventRegistrationsTable();

  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 200));

  const result = await pool.query(
    `
      SELECT *
      FROM event_registrations
      WHERE event_code = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [eventCode, safeLimit]
  );

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
        tier,
        scan_rank,
        raw_scans,
        unique_scans,
        reward_assignments,
        raw_payload,
        occurred_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,COALESCE($12::timestamptz,NOW()),NOW())
      ON CONFLICT (event_code, scan_id)
      DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, codeclip_interactions.event_id),
        vertical = EXCLUDED.vertical,
        routing_outcome = EXCLUDED.routing_outcome,
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
  ensureCodeClipXtraRedemptionsTable,
  saveCodeClipXtraRedemption,
  ensureCodeClipInteractionsTable,
  saveCodeClipInteraction,
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
};
