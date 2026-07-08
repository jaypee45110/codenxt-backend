const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { app } = require('./server');

const CODECLIP_SMS_TEST_SECRET = 'codeclip-sms-test-secret';
const CODECLIP_META_TEST_VERIFY_TOKEN = 'codeclip-meta-test-verify-token';

async function withTestServer(run) {
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function readBody(response) {
  const text = await response.text();

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function signCodeClipSmsBody(rawBody, secret = CODECLIP_SMS_TEST_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function withCodeClipSmsSecret(secret, run) {
  const previousSecret = process.env.CODECLIP_SMS_WEBHOOK_SECRET;

  if (secret == null) {
    delete process.env.CODECLIP_SMS_WEBHOOK_SECRET;
  } else {
    process.env.CODECLIP_SMS_WEBHOOK_SECRET = secret;
  }

  try {
    await run();
  } finally {
    if (previousSecret === undefined) {
      delete process.env.CODECLIP_SMS_WEBHOOK_SECRET;
    } else {
      process.env.CODECLIP_SMS_WEBHOOK_SECRET = previousSecret;
    }
  }
}

async function withCodeClipMetaVerifyToken(token, run) {
  const previousToken = process.env.CODECLIP_META_VERIFY_TOKEN;

  if (token == null) {
    delete process.env.CODECLIP_META_VERIFY_TOKEN;
  } else {
    process.env.CODECLIP_META_VERIFY_TOKEN = token;
  }

  try {
    await run();
  } finally {
    if (previousToken === undefined) {
      delete process.env.CODECLIP_META_VERIFY_TOKEN;
    } else {
      process.env.CODECLIP_META_VERIFY_TOKEN = previousToken;
    }
  }
}

async function withConsoleWarnSpy(run) {
  const originalWarn = console.warn;
  const entries = [];

  console.warn = (...args) => {
    entries.push(args);
  };

  try {
    await run(entries);
  } finally {
    console.warn = originalWarn;
  }
}

function codeClipSmsHeaders(rawBody, secret = CODECLIP_SMS_TEST_SECRET) {
  return {
    'content-type': 'application/json',
    'x-provider-signature': `sha256=${signCodeClipSmsBody(rawBody, secret)}`,
  };
}

function assertProviderChallengePublicFailure(response, text, forbiddenTerms = []) {
  assert.equal(response.status, 403);
  assert.equal(text, 'Invalid provider challenge');

  for (const term of forbiddenTerms) {
    assert.equal(text.includes(term), false);
  }
}

function assertProviderKeywordPublicFailure(response, body, forbiddenTerms = []) {
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Invalid provider keyword payload');
  assert.equal(Object.hasOwn(body, 'reason'), false);
  assertNoCodeClipProviderInternals(body);

  const serialized = JSON.stringify(body);
  for (const term of forbiddenTerms) {
    assert.equal(serialized.includes(term), false);
  }
}

function serializeWarnEntry(entry) {
  return JSON.stringify(entry);
}

function assertSafeProviderWarning(entries, {
  eventName,
  provider,
  reason,
  status,
  forbiddenTerms = [],
}) {
  const matchingEntry = entries.find((entry) => (
    entry[0] === eventName &&
    entry[1]?.provider === provider &&
    entry[1]?.reason === reason &&
    entry[1]?.status === status
  ));

  assert.ok(matchingEntry, `missing safe provider warning for ${eventName}:${reason}`);
  assert.equal(Object.hasOwn(matchingEntry[1], 'headers'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'body'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'rawBody'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'query'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'secret'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'signature'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'verification'), false);
  assert.equal(Object.hasOwn(matchingEntry[1], 'challengeVerification'), false);

  const serialized = serializeWarnEntry(matchingEntry);
  for (const term of forbiddenTerms) {
    assert.equal(serialized.includes(term), false);
  }
}

function isExpressRouteMissing(body) {
  return body.text.includes('Cannot GET ');
}

function assertApplicationMissingEventResponse(body) {
  if (!body.json) return;

  assert.equal(body.json.ok, false);
  assert.equal(typeof body.json.error, 'string');
  assert.notEqual(body.json.error.trim(), '');
  assert.notEqual(body.json.error, 'Cannot GET');
}

function assertNoCodeClipProviderInternals(payload) {
  assert.equal(Object.hasOwn(payload, 'audienceEntry'), false);
  assert.equal(Object.hasOwn(payload, 'audienceIntent'), false);
  assert.equal(Object.hasOwn(payload, 'audienceContext'), false);
  assert.equal(Object.hasOwn(payload, 'rewardAssignmentSnapshot'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceStatus'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceDecision'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceGuaranteePolicy'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceAction'), false);
  assert.equal(Object.hasOwn(payload, 'resolution'), false);
  assert.equal(Object.hasOwn(payload, 'verification'), false);
  assert.equal(Object.hasOwn(payload, 'envelope'), false);
  assert.equal(Object.hasOwn(payload, 'codeClipRawBody'), false);
  assert.equal(Object.hasOwn(payload, 'rawBody'), false);
  assert.equal(Object.hasOwn(payload, 'rawHeaders'), false);
  assert.equal(Object.hasOwn(payload, 'rawQuery'), false);
}

test('codeClip and codePod report routes are both available for missing events', async () => {
  await withTestServer(async (baseUrl) => {
    const codeClipResponse = await fetch(`${baseUrl}/codeclip/report/__missing_test_event__`);
    const codePodResponse = await fetch(`${baseUrl}/codepod/report/__missing_test_event__`);

    assert.ok(codeClipResponse);
    assert.ok(codePodResponse);
    assert.ok(codeClipResponse.status >= 100 && codeClipResponse.status <= 599);
    assert.ok(codePodResponse.status >= 100 && codePodResponse.status <= 599);

    const codeClipBody = await readBody(codeClipResponse);
    const codePodBody = await readBody(codePodResponse);

    assert.ok(codeClipBody.json || typeof codeClipBody.text === 'string');
    assert.ok(codePodBody.json || typeof codePodBody.text === 'string');

    assert.equal(isExpressRouteMissing(codeClipBody), false);
    assert.equal(isExpressRouteMissing(codePodBody), false);
    assertApplicationMissingEventResponse(codeClipBody);
    assertApplicationMissingEventResponse(codePodBody);
  });
});

test('GET /codepod/report returns a compatible empty report for a codePod event', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CP-REPORT-HAPPY-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codepod',
        code,
        name: 'codePod report happy path test',
        startAt: '2024-01-01T10:00:00.000Z',
        unlockAt: '2024-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.ok, true);
    assert.equal(created.event.vertical, 'codepod');

    const reportResponse = await fetch(`${baseUrl}/codepod/report/${code}`);
    const report = await reportResponse.json();

    assert.equal(reportResponse.ok, true);
    assert.equal(report.ok, true);
    assert.equal(report.vertical, 'codepod');
    assert.equal(report.eventCode, code);
    assert.equal(Array.isArray(report.rows), true);
    assert.equal(Array.isArray(report.scans), true);
    assert.ok(report.metrics && typeof report.metrics === 'object');
  });
});

test('GET /codeclip/report exposes runtimeSummary without changing rows or scans contract', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-RUNTIME-SUMMARY-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip runtime summary route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const reportResponse = await fetch(`${baseUrl}/codeclip/report/${code}`);
    const report = await reportResponse.json();

    assert.equal(reportResponse.ok, true);
    assert.equal(report.ok, true);
    assert.equal(report.vertical, 'codeclip');
    assert.equal(report.eventCode, code);
    assert.ok(report.event && typeof report.event === 'object');
    assert.ok(report.metrics && typeof report.metrics === 'object');
    assert.equal(Array.isArray(report.rows), true);
    assert.equal(Array.isArray(report.scans), true);
    assert.deepEqual(report.scans, report.rows);
    assert.ok(report.runtimeSummary && typeof report.runtimeSummary === 'object');
    assert.equal(typeof report.runtimeSummary.totalInteractions, 'number');
    assert.equal(typeof report.runtimeSummary.matched, 'number');
    assert.equal(typeof report.runtimeSummary.noCampaignMatch, 'number');
    assert.equal(typeof report.runtimeSummary.routingConflict, 'number');
    assert.ok(report.runtimeSummary.routingOutcomes && typeof report.runtimeSummary.routingOutcomes === 'object');
    assert.equal(typeof report.runtimeSummary.routingOutcomes.MATCH, 'number');
    assert.equal(typeof report.runtimeSummary.routingOutcomes.NO_CAMPAIGN_MATCH, 'number');
    assert.equal(typeof report.runtimeSummary.routingOutcomes.ROUTING_CONFLICT, 'number');
    assert.ok(report.runtimeSummary.persistence && typeof report.runtimeSummary.persistence === 'object');
    assert.equal(typeof report.runtimeSummary.persistence.ok, 'number');
    assert.equal(typeof report.runtimeSummary.persistence.degraded, 'number');
    assert.equal(typeof report.runtimeSummary.persistence.critical, 'number');
  });
});

test('POST /event defaults missing vertical to codeTone', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `CT-DEFAULT-${Date.now()}`,
        name: 'codeTone default vertical test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
      }),
    });

    const body = await response.json();

    assert.equal(response.ok, true);
    assert.equal(body.success, true);
    assert.ok(body.event);
    assert.equal(body.event.vertical, 'codetone');
  });
});

test('eventCode collisions stay isolated across codePod and codeClip event resolution', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `SHARED-VERTICAL-${Date.now()}`;
    const codePodCreateResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codepod',
        code,
        name: 'codePod collision event',
        startAt: '2024-01-01T10:00:00.000Z',
        unlockAt: '2024-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        digitalSouvenir: {
          general: {
            enabled: true,
            title: 'codePod souvenir',
          },
        },
      }),
    });
    const codeClipCreateResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip collision event',
        startAt: '2024-01-01T10:00:00.000Z',
        unlockAt: '2024-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(codePodCreateResponse.ok, true);
    assert.equal(codeClipCreateResponse.ok, true);

    const codePodEventResponse = await fetch(`${baseUrl}/event/${code}?vertical=codepod`);
    const codeClipEventResponse = await fetch(`${baseUrl}/event/${code}?vertical=codeclip`);
    const codePodEvent = await codePodEventResponse.json();
    const codeClipEvent = await codeClipEventResponse.json();

    assert.equal(codePodEventResponse.ok, true);
    assert.equal(codeClipEventResponse.ok, true);
    assert.equal(codePodEvent.name, 'codePod collision event');
    assert.equal(codeClipEvent.name, 'codeClip collision event');
    assert.ok(codePodEvent.digitalSouvenir && typeof codePodEvent.digitalSouvenir === 'object');
    assert.equal(Object.hasOwn(codePodEvent, 'openClip'), false);
    assert.equal(Object.hasOwn(codeClipEvent, 'digitalSouvenir'), false);

    const codePodScanId = `scan-codepod-${Date.now()}`;
    const codeClipScanId = `scan-codeclip-${Date.now()}`;

    const codePodScanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: codePodScanId,
        vertical: 'codepod',
      }),
    });
    const codePodScan = await codePodScanResponse.json();

    assert.equal(codePodScanResponse.ok, true);
    assert.equal(codePodScan.success, true);
    assert.ok(codePodScan.digitalSouvenir && typeof codePodScan.digitalSouvenir === 'object');
    assert.equal(Object.hasOwn(codePodScan, 'rewards'), false);
    assert.equal(Object.hasOwn(codePodScan, 'clipXtra'), false);

    const codeClipScanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: codeClipScanId,
        vertical: 'codeclip',
      }),
    });
    const codeClipScan = await codeClipScanResponse.json();

    assert.equal(codeClipScanResponse.ok, true);
    assert.equal(codeClipScan.success, true);
    assert.ok(codeClipScan.rewards && typeof codeClipScan.rewards === 'object');
    assert.equal(Object.hasOwn(codeClipScan, 'clipXtra'), true);
    assert.equal(Object.hasOwn(codeClipScan, 'digitalSouvenir'), false);
    assert.equal(Object.hasOwn(codeClipScan, 'partnerReward'), false);

    const codePodReportResponse = await fetch(`${baseUrl}/codepod/report/${code}`);
    const codeClipReportResponse = await fetch(`${baseUrl}/codeclip/report/${code}`);
    const codePodReport = await codePodReportResponse.json();
    const codeClipReport = await codeClipReportResponse.json();
    const codePodRows = Array.isArray(codePodReport.rows) ? codePodReport.rows : [];
    const codeClipRows = Array.isArray(codeClipReport.rows) ? codeClipReport.rows : [];

    assert.equal(codePodReportResponse.ok, true);
    assert.equal(codeClipReportResponse.ok, true);
    assert.equal(codePodReport.vertical, 'codepod');
    assert.equal(codeClipReport.vertical, 'codeclip');
    assert.equal(codePodRows.some((row) => row.scanId === codeClipScanId), false);
    assert.equal(codeClipRows.some((row) => row.scanId === codePodScanId), false);
  });
});

test('generic reward records do not override codeClip event rewards during scan', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-REWARD-SOURCE-${Date.now()}`;
    const nativeRewardTitle = 'Native OpenClip reward';
    const genericRewardTitle = 'Generic reward override';
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip reward source guardrail test',
        startAt: '2024-01-01T10:00:00.000Z',
        unlockAt: '2024-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        rewards: {
          openClip: {
            enabled: true,
            title: nativeRewardTitle,
            type: 'url',
            contentUrl: 'https://native.example/openclip',
          },
        },
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.ok, true);
    assert.ok(created.eventId);
    assert.equal(created.event.rewards.openClip.title, nativeRewardTitle);

    const genericRewardResponse = await fetch(`${baseUrl}/reward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: created.eventId,
        reward: {
          tier: 'openClip',
          title: genericRewardTitle,
          type: 'url',
          url: 'https://generic.example/openclip',
          vertical: 'codeclip',
        },
      }),
    });
    const genericRewardSaved = await genericRewardResponse.json();

    assert.equal(genericRewardResponse.ok, true);
    assert.equal(genericRewardSaved.success, true);

    const genericRewardReadResponse = await fetch(`${baseUrl}/reward/${created.eventId}?tier=openClip&vertical=codeclip`);
    const genericRewardRead = await genericRewardReadResponse.json();

    assert.equal(genericRewardReadResponse.ok, true);
    assert.equal(genericRewardRead.openClip.title, genericRewardTitle);

    const eventResponse = await fetch(`${baseUrl}/event/${code}?vertical=codeclip`);
    const event = await eventResponse.json();

    assert.equal(eventResponse.ok, true);
    assert.equal(event.rewards.openClip.title, nativeRewardTitle);
    assert.notEqual(event.rewards.openClip.title, genericRewardTitle);

    const scanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: `scan-${Date.now()}`,
        vertical: 'codeclip',
      }),
    });
    const scan = await scanResponse.json();

    assert.equal(scanResponse.ok, true);
    assert.equal(scan.success, true);
    assert.equal(scan.rewards.openClip.title, nativeRewardTitle);
    assert.notEqual(scan.rewards.openClip.title, genericRewardTitle);
    assert.equal(Object.hasOwn(scan, 'digitalSouvenir'), false);
    assert.equal(Object.hasOwn(scan, 'partnerReward'), false);
  });
});

test('POST /scan uses stored codeClip event vertical when request vertical is missing', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-STORED-VERTICAL-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip stored vertical route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.ok, true);
    assert.equal(created.event.vertical, 'codeclip');

    const scanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: `scan-${Date.now()}`,
      }),
    });
    const scan = await scanResponse.json();

    assert.equal(scanResponse.ok, true);
    assert.equal(scan.success, true);
    assert.equal(scan.eventCode, code);
    assert.ok(scan.rewards && typeof scan.rewards === 'object');
    assert.ok(Object.hasOwn(scan, 'clipXtra'));
  });
});

test('POST /scan does not expose codeClip COAS adapter internals', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-ADAPTER-INTERNALS-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip adapter internals route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const scanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: `scan-${Date.now()}`,
      }),
    });
    const scan = await scanResponse.json();

    assert.equal(scanResponse.ok, true);
    assert.equal(scan.success, true);
    assert.equal(scan.eventCode, code);
    assert.equal(Object.hasOwn(scan, 'audienceEntry'), false);
    assert.equal(Object.hasOwn(scan, 'audienceIntent'), false);
    assert.equal(Object.hasOwn(scan, 'warnings'), false);
    assert.equal(Object.hasOwn(scan, 'errors'), false);
  });
});

test('POST /codeclip/keyword-entry accepts internal keyword entry without exposing COAS internals', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-KEYWORD-ENTRY-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip keyword entry route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'GOLD',
        activationChannels: ['Instagram'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const keywordResponse = await fetch(`${baseUrl}/codeclip/keyword-entry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        keyword: ' GOLD ',
        messageId: `message-${Date.now()}`,
      }),
    });
    const keywordEntry = await keywordResponse.json();

    assert.equal(keywordResponse.ok, true);
    assert.equal(keywordEntry.success, true);
    assert.equal(keywordEntry.eventCode, code);
    assert.equal(typeof keywordEntry.messageId, 'string');
    assert.notEqual(keywordEntry.messageId.trim(), '');
    assert.equal(Object.hasOwn(keywordEntry, 'audienceEntry'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'audienceIntent'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'audienceContext'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'rewardAssignmentSnapshot'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'warnings'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'errors'), false);
  });
});

test('POST /codeclip/test-provider/keyword maps provider-like input without exposing COAS internals', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-TEST-PROVIDER-KEYWORD-${Date.now()}`;
    const providerEventId = `provider-event-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip test provider keyword route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'GOLD',
        activationChannels: ['Instagram'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const keywordResponse = await fetch(`${baseUrl}/codeclip/test-provider/keyword`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        text: ' GOLD ',
        providerEventId,
      }),
    });
    const keywordEntry = await keywordResponse.json();

    assert.equal(keywordResponse.ok, true);
    assert.equal(keywordEntry.success, true);
    assert.equal(keywordEntry.eventCode, code);
    assert.equal(keywordEntry.messageId, providerEventId);
    assert.equal(Object.hasOwn(keywordEntry, 'audienceEntry'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'audienceIntent'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'audienceContext'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'rewardAssignmentSnapshot'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'warnings'), false);
    assert.equal(Object.hasOwn(keywordEntry, 'errors'), false);
  });
});

test('POST /codeclip/provider/test/keyword accepts generic provider keyword input', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-GENERIC-PROVIDER-KEYWORD-${Date.now()}`;
    const providerEventId = `generic-provider-event-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip generic provider keyword route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'GOLD',
        activationChannels: ['Instagram'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codeclip-test-signature': 'valid',
      },
      body: JSON.stringify({
        eventCode: code,
        text: ' GOLD ',
        providerEventId,
      }),
    });
    const keywordEntry = await keywordResponse.json();

    assert.equal(keywordResponse.ok, true);
    assert.equal(keywordEntry.success, true);
    assert.equal(keywordEntry.eventCode, code);
    assert.equal(keywordEntry.messageId, providerEventId);
    assert.equal(Object.hasOwn(keywordEntry, 'resolution'), false);
    assertNoCodeClipProviderInternals(keywordEntry);
  });
});

test('GET /codeclip/provider/meta/keyword returns plain Meta challenge for valid verify token', async () => {
  await withTestServer(async (baseUrl) => {
    await withCodeClipMetaVerifyToken(CODECLIP_META_TEST_VERIFY_TOKEN, async () => {
      const response = await fetch(
        `${baseUrl}/codeclip/provider/meta/keyword?hub.mode=subscribe&hub.verify_token=${CODECLIP_META_TEST_VERIFY_TOKEN}&hub.challenge=meta-challenge-123`
      );
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/plain/);
      assert.equal(text, 'meta-challenge-123');
    });
  });
});

test('GET /codeclip/provider/meta/keyword rejects missing verify token configuration without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    await withCodeClipMetaVerifyToken(null, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(
          `${baseUrl}/codeclip/provider/meta/keyword?hub.mode=subscribe&hub.verify_token=${CODECLIP_META_TEST_VERIFY_TOKEN}&hub.challenge=meta-challenge-123`
        );
        const text = await response.text();

        assertProviderChallengePublicFailure(response, text, [
          'VERIFY_TOKEN_REQUIRED',
          CODECLIP_META_TEST_VERIFY_TOKEN,
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider challenge rejected',
          provider: 'meta',
          reason: 'VERIFY_TOKEN_REQUIRED',
          status: 403,
          forbiddenTerms: [
            CODECLIP_META_TEST_VERIFY_TOKEN,
            'meta-challenge-123',
          ],
        });
      });
    });
  });
});

test('GET /codeclip/provider/meta/keyword rejects wrong verify token without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    await withCodeClipMetaVerifyToken(CODECLIP_META_TEST_VERIFY_TOKEN, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(
          `${baseUrl}/codeclip/provider/meta/keyword?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=meta-challenge-123`
        );
        const text = await response.text();

        assertProviderChallengePublicFailure(response, text, [
          'VERIFY_TOKEN_MISMATCH',
          CODECLIP_META_TEST_VERIFY_TOKEN,
          'wrong-token',
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider challenge rejected',
          provider: 'meta',
          reason: 'VERIFY_TOKEN_MISMATCH',
          status: 403,
          forbiddenTerms: [
            CODECLIP_META_TEST_VERIFY_TOKEN,
            'wrong-token',
            'meta-challenge-123',
          ],
        });
      });
    });
  });
});

test('GET /codeclip/provider/meta/keyword rejects missing challenge without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    await withCodeClipMetaVerifyToken(CODECLIP_META_TEST_VERIFY_TOKEN, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(
          `${baseUrl}/codeclip/provider/meta/keyword?hub.mode=subscribe&hub.verify_token=${CODECLIP_META_TEST_VERIFY_TOKEN}`
        );
        const text = await response.text();

        assertProviderChallengePublicFailure(response, text, [
          'CHALLENGE_REQUIRED',
          CODECLIP_META_TEST_VERIFY_TOKEN,
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider challenge rejected',
          provider: 'meta',
          reason: 'CHALLENGE_REQUIRED',
          status: 403,
          forbiddenTerms: [
            CODECLIP_META_TEST_VERIFY_TOKEN,
          ],
        });
      });
    });
  });
});

test('GET /codeclip/provider/sms/keyword and test provider keyword remain unsupported', async () => {
  await withTestServer(async (baseUrl) => {
    const smsResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`);
    const smsBody = await readBody(smsResponse);
    const testResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`);
    const testBody = await readBody(testResponse);

    assert.equal(smsResponse.status, 404);
    assert.equal(testResponse.status, 404);
    assert.equal(isExpressRouteMissing(smsBody), true);
    assert.equal(isExpressRouteMissing(testBody), true);
  });
});

test('POST /codeclip/provider/test/keyword forwards captured raw body to verifier request builder without leaking it', async () => {
  const providerPolicy = require('./verticals/codeclip/provider-policy');
  const originalBuilder = providerPolicy.buildCodeClipProviderVerificationRequest;
  let observedRawBody = null;

  providerPolicy.buildCodeClipProviderVerificationRequest = (args) => {
    observedRawBody = args.rawBody;
    return originalBuilder(args);
  };

  try {
    await withTestServer(async (baseUrl) => {
      const code = `CC-PROVIDER-RAW-BODY-${Date.now()}`;
      const providerEventId = `provider-raw-body-${Date.now()}`;
      const createResponse = await fetch(`${baseUrl}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vertical: 'codeclip',
          code,
          name: 'codeClip provider raw body forwarding test',
          startAt: '2099-01-01T10:00:00.000Z',
          unlockAt: '2099-01-01T10:00:00.000Z',
          endAt: '2099-01-01T11:00:00.000Z',
          activationMethod: 'keyword',
          activationKeyword: 'RAWBODY',
          activationChannels: ['test'],
          providerAccountIds: ['test'],
          rewards: {
            openClip: {
              enabled: true,
              title: 'OpenClip',
            },
          },
        }),
      });

      assert.equal(createResponse.ok, true);

      const requestBody = JSON.stringify({
        eventCode: code,
        text: ' RAWBODY ',
        providerEventId,
      });
      const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeclip-test-signature': 'valid',
        },
        body: requestBody,
      });
      const keywordEntry = await keywordResponse.json();

      assert.equal(keywordResponse.ok, true);
      assert.equal(keywordEntry.success, true);
      assert.equal(keywordEntry.eventCode, code);
      assert.equal(keywordEntry.messageId, providerEventId);
      assert.ok(Buffer.isBuffer(observedRawBody));
      assert.equal(observedRawBody.toString(), requestBody);
      assertNoCodeClipProviderInternals(keywordEntry);
    });
  } finally {
    providerPolicy.buildCodeClipProviderVerificationRequest = originalBuilder;
  }
});

test('POST /codeclip/provider/:provider/keyword resolves codeClip event by provider activation keyword', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-PROVIDER-ACTIVATION-${Date.now()}`;
    const providerEventId = `provider-activation-event-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip provider activation route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'CLIP',
        activationChannels: ['sms'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      const requestBody = JSON.stringify({
        text: ' clip ',
        providerEventId,
      });
      const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
        method: 'POST',
        headers: codeClipSmsHeaders(requestBody),
        body: requestBody,
      });
      const keywordEntry = await keywordResponse.json();

      assert.equal(keywordResponse.ok, true);
      assert.equal(keywordEntry.success, true);
      assert.equal(keywordEntry.eventCode, code);
      assert.equal(keywordEntry.messageId, providerEventId);
      assertNoCodeClipProviderInternals(keywordEntry);
    });
  });
});

test('POST /codeclip/provider/:provider/keyword accepts test-provider style payload through envelope normalization', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-PROVIDER-ENVELOPE-TEST-${Date.now()}`;
    const providerEventId = `provider-envelope-test-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip provider envelope test route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'CLIP',
        activationChannels: ['test'],
        providerAccountIds: ['test'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codeclip-test-signature': 'valid',
      },
      body: JSON.stringify({
        keyword: ' clip ',
        providerEventId,
      }),
    });
    const keywordEntry = await keywordResponse.json();

    assert.equal(keywordResponse.ok, true);
    assert.equal(keywordEntry.success, true);
    assert.equal(keywordEntry.eventCode, code);
    assert.equal(keywordEntry.messageId, providerEventId);
    assertNoCodeClipProviderInternals(keywordEntry);
  });
});

test('POST /codeclip/provider/test/keyword requires test provider signature without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-PROVIDER-VERIFY-${Date.now()}`;
    const keyword = `VERIFY-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip provider verification route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: keyword,
        activationChannels: ['test'],
        providerAccountIds: ['test'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    await withConsoleWarnSpy(async (warnEntries) => {
      const missingSignatureBody = JSON.stringify({
        keyword,
        providerEventId: `missing-signature-${Date.now()}`,
      });
      const missingSignatureResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: missingSignatureBody,
      });
      const missingSignature = await missingSignatureResponse.json();

      assert.equal(missingSignatureResponse.status, 400);
      assert.equal(missingSignature.ok, false);
      assert.equal(missingSignature.error, 'Invalid provider keyword payload');
      assert.equal(Object.hasOwn(missingSignature, 'reason'), false);
      assertNoCodeClipProviderInternals(missingSignature);
      assertSafeProviderWarning(warnEntries, {
        eventName: 'codeClip provider verification rejected',
        provider: 'test',
        reason: 'SIGNATURE_REQUIRED',
        status: 400,
        forbiddenTerms: [
          missingSignatureBody,
          keyword,
        ],
      });
    });

    await withConsoleWarnSpy(async (warnEntries) => {
      const invalidSignatureBody = JSON.stringify({
        keyword,
        providerEventId: `invalid-signature-${Date.now()}`,
      });
      const invalidSignatureResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeclip-test-signature': 'invalid',
        },
        body: invalidSignatureBody,
      });
      const invalidSignature = await invalidSignatureResponse.json();

      assert.equal(invalidSignatureResponse.status, 400);
      assert.equal(invalidSignature.ok, false);
      assert.equal(invalidSignature.error, 'Invalid provider keyword payload');
      assert.equal(Object.hasOwn(invalidSignature, 'reason'), false);
      assertNoCodeClipProviderInternals(invalidSignature);
      assertSafeProviderWarning(warnEntries, {
        eventName: 'codeClip provider verification rejected',
        provider: 'test',
        reason: 'SIGNATURE_MISMATCH',
        status: 400,
        forbiddenTerms: [
          invalidSignatureBody,
          keyword,
          'invalid',
        ],
      });
    });

    const validSignatureResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codeclip-test-signature': 'valid',
      },
      body: JSON.stringify({
        keyword,
        providerEventId: `valid-signature-${Date.now()}`,
      }),
    });
    const validSignature = await validSignatureResponse.json();

    assert.equal(validSignatureResponse.ok, true);
    assert.equal(validSignature.success, true);
    assert.equal(validSignature.eventCode, code);
    assertNoCodeClipProviderInternals(validSignature);
  });
});

test('POST /codeclip/provider/:provider/keyword accepts SMS envelope payload', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-PROVIDER-ENVELOPE-SMS-${Date.now()}`;
    const messageId = `sms-envelope-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip provider envelope sms route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'OPEN',
        activationChannels: ['sms'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      const requestBody = JSON.stringify({
        MessageSid: messageId,
        Body: ' open ',
        To: '+15550000001',
        From: '+15550000002',
      });
      const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
        method: 'POST',
        headers: codeClipSmsHeaders(requestBody),
        body: requestBody,
      });
      const keywordEntry = await keywordResponse.json();

      assert.equal(keywordResponse.ok, true);
      assert.equal(keywordEntry.success, true);
      assert.equal(keywordEntry.eventCode, code);
      assert.equal(keywordEntry.messageId, messageId);
      assertNoCodeClipProviderInternals(keywordEntry);
    });
  });
});

test('POST /codeclip/provider/sms/keyword requires configured HMAC secret without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    const requestBody = JSON.stringify({
      MessageSid: `sms-missing-secret-${Date.now()}`,
      Body: ' open ',
      To: '+15550000001',
      From: '+15550000002',
    });

    await withCodeClipSmsSecret(null, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
          method: 'POST',
          headers: codeClipSmsHeaders(requestBody),
          body: requestBody,
        });
        const body = await response.json();

        assertProviderKeywordPublicFailure(response, body, [
          'SECRET_NOT_CONFIGURED',
          'SECRET_REQUIRED',
          CODECLIP_SMS_TEST_SECRET,
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider verification rejected',
          provider: 'sms',
          reason: 'SECRET_NOT_CONFIGURED',
          status: 400,
          forbiddenTerms: [
            requestBody,
            CODECLIP_SMS_TEST_SECRET,
            codeClipSmsHeaders(requestBody)['x-provider-signature'],
          ],
        });
      });
    });
  });
});

test('POST /codeclip/provider/sms/keyword requires HMAC signature without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    const requestBody = JSON.stringify({
      MessageSid: `sms-missing-signature-${Date.now()}`,
      Body: ' open ',
      To: '+15550000001',
      From: '+15550000002',
    });

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
        });
        const body = await response.json();

        assertProviderKeywordPublicFailure(response, body, [
          'SIGNATURE_REQUIRED',
          CODECLIP_SMS_TEST_SECRET,
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider verification rejected',
          provider: 'sms',
          reason: 'SIGNATURE_REQUIRED',
          status: 400,
          forbiddenTerms: [
            requestBody,
            CODECLIP_SMS_TEST_SECRET,
          ],
        });
      });
    });
  });
});

test('POST /codeclip/provider/sms/keyword rejects invalid HMAC signature without leaking internals', async () => {
  await withTestServer(async (baseUrl) => {
    const requestBody = JSON.stringify({
      MessageSid: `sms-invalid-signature-${Date.now()}`,
      Body: ' open ',
      To: '+15550000001',
      From: '+15550000002',
    });

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      await withConsoleWarnSpy(async (warnEntries) => {
        const response = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-provider-signature': 'sha256=0000',
          },
          body: requestBody,
        });
        const body = await response.json();

        assertProviderKeywordPublicFailure(response, body, [
          'SIGNATURE_MISMATCH',
          CODECLIP_SMS_TEST_SECRET,
        ]);
        assertSafeProviderWarning(warnEntries, {
          eventName: 'codeClip provider verification rejected',
          provider: 'sms',
          reason: 'SIGNATURE_MISMATCH',
          status: 400,
          forbiddenTerms: [
            requestBody,
            CODECLIP_SMS_TEST_SECRET,
            'sha256=0000',
          ],
        });
      });
    });
  });
});

test('POST /codeclip/provider/:provider/keyword accepts Meta Messenger envelope payload', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CC-PROVIDER-ENVELOPE-META-${Date.now()}`;
    const messageId = `meta-envelope-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codeclip',
        code,
        name: 'codeClip provider envelope meta route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: 'VIP',
        activationChannels: ['Messenger'],
        rewards: {
          openClip: {
            enabled: true,
            title: 'OpenClip',
          },
        },
      }),
    });

    assert.equal(createResponse.ok, true);

    const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/meta/keyword`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: [
          {
            id: 'page-1',
            messaging: [
              {
                sender: { id: 'sender-1' },
                recipient: { id: 'page-1' },
                message: {
                  mid: messageId,
                  text: ' vip ',
                },
              },
            ],
          },
        ],
      }),
    });
    const keywordEntry = await keywordResponse.json();

    assert.equal(keywordResponse.ok, true);
    assert.equal(keywordEntry.success, true);
    assert.equal(keywordEntry.eventCode, code);
    assert.equal(keywordEntry.messageId, messageId);
    assertNoCodeClipProviderInternals(keywordEntry);
  });
});

test('POST /codeclip/provider/:provider/keyword rejects invalid envelope payload without internals', async () => {
  await withTestServer(async (baseUrl) => {
    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      const missingTextBody = JSON.stringify({
        MessageSid: `sms-missing-text-${Date.now()}`,
      });
      const missingTextResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
        method: 'POST',
        headers: codeClipSmsHeaders(missingTextBody),
        body: missingTextBody,
      });
      const missingText = await missingTextResponse.json();

      assert.equal(missingTextResponse.status, 400);
      assert.equal(missingText.ok, false);
      assert.equal(missingText.error, 'Invalid provider keyword payload');
      assertNoCodeClipProviderInternals(missingText);
    });

    const unsupportedProviderResponse = await fetch(`${baseUrl}/codeclip/provider/unknown/keyword`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerEventId: `unknown-provider-event-${Date.now()}`,
        text: 'CLIP',
      }),
    });
    const unsupportedProvider = await unsupportedProviderResponse.json();

    assert.equal(unsupportedProviderResponse.status, 400);
    assert.equal(unsupportedProvider.ok, false);
    assert.equal(unsupportedProvider.error, 'Invalid provider keyword payload');
    assertNoCodeClipProviderInternals(unsupportedProvider);
  });
});

test('POST /codeclip/provider/:provider/keyword activation lookup never matches other verticals', async () => {
  await withTestServer(async (baseUrl) => {
    const keyword = `ISOLATE-${Date.now()}`;
    const providerEventId = `provider-activation-isolation-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codepod',
        code: `CP-PROVIDER-ACTIVATION-${Date.now()}`,
        name: 'codePod provider activation isolation test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        activationMethod: 'keyword',
        activationKeyword: keyword,
        activationChannels: ['sms'],
      }),
    });

    assert.equal(createResponse.ok, true);

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      const requestBody = JSON.stringify({
        text: keyword,
        providerEventId,
      });
      const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
        method: 'POST',
        headers: codeClipSmsHeaders(requestBody),
        body: requestBody,
      });
      const body = await keywordResponse.json();

      assert.equal(keywordResponse.status, 404);
      assert.equal(body.ok, false);
      assert.equal(body.reason, 'NO_MATCH');
      assertNoCodeClipProviderInternals(body);
    });
  });
});

test('POST /codeclip/provider/:provider/keyword rejects ambiguous provider activation matches', async () => {
  await withTestServer(async (baseUrl) => {
    const providerEventId = `provider-activation-ambiguous-${Date.now()}`;
    const eventBase = {
      vertical: 'codeclip',
      startAt: '2099-01-01T10:00:00.000Z',
      unlockAt: '2099-01-01T10:00:00.000Z',
      endAt: '2099-01-01T11:00:00.000Z',
      activationMethod: 'keyword',
      activationKeyword: 'VIP',
      activationChannels: ['sms'],
      rewards: {
        openClip: {
          enabled: true,
          title: 'OpenClip',
        },
      },
    };

    const firstCreateResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...eventBase,
        code: `CC-PROVIDER-ACTIVATION-A-${Date.now()}`,
        name: 'codeClip provider activation ambiguity test A',
      }),
    });
    const secondCreateResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...eventBase,
        code: `CC-PROVIDER-ACTIVATION-B-${Date.now()}`,
        name: 'codeClip provider activation ambiguity test B',
      }),
    });

    assert.equal(firstCreateResponse.ok, true);
    assert.equal(secondCreateResponse.ok, true);

    await withCodeClipSmsSecret(CODECLIP_SMS_TEST_SECRET, async () => {
      const requestBody = JSON.stringify({
        text: 'VIP',
        providerEventId,
      });
      const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/sms/keyword`, {
        method: 'POST',
        headers: codeClipSmsHeaders(requestBody),
        body: requestBody,
      });
      const body = await keywordResponse.json();

      assert.equal(keywordResponse.status, 409);
      assert.equal(body.ok, false);
      assert.equal(body.reason, 'AMBIGUOUS_MATCH');
      assertNoCodeClipProviderInternals(body);
    });
  });
});

test('POST /codeclip/provider/unknown/keyword rejects unknown providers without COAS internals', async () => {
  await withTestServer(async (baseUrl) => {
    const keywordResponse = await fetch(`${baseUrl}/codeclip/provider/unknown/keyword`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: `CC-UNKNOWN-PROVIDER-${Date.now()}`,
        text: ' GOLD ',
        providerEventId: `unknown-provider-event-${Date.now()}`,
      }),
    });
    const body = await keywordResponse.json();

    assert.equal(keywordResponse.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Invalid provider keyword payload');
    assertNoCodeClipProviderInternals(body);
  });
});

test('POST /codeclip/provider/:provider/keyword enforces optional provider token auth', async () => {
  const previousToken = process.env.CODECLIP_PROVIDER_WEBHOOK_TOKEN;
  process.env.CODECLIP_PROVIDER_WEBHOOK_TOKEN = 'provider-test-token';

  try {
    await withTestServer(async (baseUrl) => {
      const code = `CC-PROVIDER-AUTH-${Date.now()}`;
      const providerEventId = `provider-auth-event-${Date.now()}`;

      const missingAuthResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventCode: code,
          text: ' GOLD ',
          providerEventId,
        }),
      });
      const missingAuth = await missingAuthResponse.json();

      assert.equal(missingAuthResponse.status, 401);
      assert.equal(missingAuth.ok, false);
      assert.equal(missingAuth.error, 'Unauthorized');
      assertNoCodeClipProviderInternals(missingAuth);

      const wrongAuthResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeclip-provider-token': 'wrong-token',
        },
        body: JSON.stringify({
          eventCode: code,
          text: ' GOLD ',
          providerEventId,
        }),
      });
      const wrongAuth = await wrongAuthResponse.json();

      assert.equal(wrongAuthResponse.status, 401);
      assert.equal(wrongAuth.ok, false);
      assert.equal(wrongAuth.error, 'Unauthorized');
      assertNoCodeClipProviderInternals(wrongAuth);

      const createResponse = await fetch(`${baseUrl}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vertical: 'codeclip',
          code,
          name: 'codeClip provider auth route test',
          startAt: '2099-01-01T10:00:00.000Z',
          unlockAt: '2099-01-01T10:00:00.000Z',
          endAt: '2099-01-01T11:00:00.000Z',
          activationMethod: 'keyword',
          activationKeyword: 'GOLD',
          activationChannels: ['Instagram'],
          rewards: {
            openClip: {
              enabled: true,
              title: 'OpenClip',
            },
          },
        }),
      });

      assert.equal(createResponse.ok, true);

      const authorizedResponse = await fetch(`${baseUrl}/codeclip/provider/test/keyword`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeclip-provider-token': 'provider-test-token',
          'x-codeclip-test-signature': 'valid',
        },
        body: JSON.stringify({
          eventCode: code,
          text: ' GOLD ',
          providerEventId,
        }),
      });
      const authorized = await authorizedResponse.json();

      assert.equal(authorizedResponse.ok, true);
      assert.equal(authorized.success, true);
      assert.equal(authorized.eventCode, code);
      assert.equal(authorized.messageId, providerEventId);
      assertNoCodeClipProviderInternals(authorized);
    });
  } finally {
    if (previousToken === undefined) {
      delete process.env.CODECLIP_PROVIDER_WEBHOOK_TOKEN;
    } else {
      process.env.CODECLIP_PROVIDER_WEBHOOK_TOKEN = previousToken;
    }
  }
});

test('POST /scan uses stored codePod event vertical when request vertical is missing', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CP-STORED-VERTICAL-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codepod',
        code,
        name: 'codePod stored vertical route test',
        startAt: '2024-01-01T10:00:00.000Z',
        unlockAt: '2024-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        digitalSouvenir: {
          general: {
            enabled: true,
            title: 'General souvenir',
          },
        },
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.ok, true);
    assert.equal(created.event.vertical, 'codepod');

    const scanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: `scan-${Date.now()}`,
      }),
    });
    const scan = await scanResponse.json();

    assert.equal(scanResponse.ok, true);
    assert.equal(scan.success, true);
    assert.equal(scan.eventCode, code);
    assert.ok(scan.digitalSouvenir && typeof scan.digitalSouvenir === 'object');
    assert.equal(Object.hasOwn(scan, 'tierLimits'), false);
    assert.equal(Object.hasOwn(scan, 'audienceEntry'), false);
    assert.equal(Object.hasOwn(scan, 'audienceIntent'), false);
    assert.equal(Object.hasOwn(scan, 'audienceContext'), false);
    assert.equal(Object.hasOwn(scan, 'interaction'), false);
    assert.equal(Object.hasOwn(scan, 'stateTransitions'), false);
    assert.equal(Object.hasOwn(scan, 'routingOutcome'), false);
    assert.equal(Object.hasOwn(scan, 'rewardAssignmentSnapshot'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceStatus'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceDecision'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceGuaranteePolicy'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceAction'), false);
  });
});

test('POST /scan returns locked for codePod events before unlock', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CP-LOCKED-SCAN-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codepod',
        code,
        name: 'codePod locked scan route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
        digitalSouvenir: {
          general: {
            enabled: true,
            title: 'General souvenir',
          },
        },
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.ok, true);
    assert.equal(created.event.vertical, 'codepod');

    const scanResponse = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        scanId: `scan-${Date.now()}`,
      }),
    });
    const scan = await scanResponse.json();

    assert.equal(scanResponse.ok, true);
    assert.equal(scan.success, false);
    assert.equal(scan.status, 'locked');
    assert.equal(scan.error, 'bonus_window_locked');
    assert.equal(scan.unlockAt, '2099-01-01T10:00:00.000Z');
    assert.ok(scan.serverTime);
    assert.equal(Object.hasOwn(scan, 'audienceEntry'), false);
    assert.equal(Object.hasOwn(scan, 'audienceIntent'), false);
    assert.equal(Object.hasOwn(scan, 'audienceContext'), false);
    assert.equal(Object.hasOwn(scan, 'interaction'), false);
    assert.equal(Object.hasOwn(scan, 'stateTransitions'), false);
    assert.equal(Object.hasOwn(scan, 'routingOutcome'), false);
    assert.equal(Object.hasOwn(scan, 'rewardAssignmentSnapshot'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceStatus'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceDecision'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceGuaranteePolicy'), false);
    assert.equal(Object.hasOwn(scan, 'persistenceAction'), false);
  });
});

test('codeDemo handshake route resolves a stored codeDemo event', async () => {
  await withTestServer(async (baseUrl) => {
    const code = `CDM-HANDSHAKE-${Date.now()}`;
    const createResponse = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vertical: 'codedemo',
        code,
        name: 'codeDemo handshake route test',
        startAt: '2099-01-01T10:00:00.000Z',
        unlockAt: '2099-01-01T10:00:00.000Z',
        endAt: '2099-01-01T11:00:00.000Z',
      }),
    });

    assert.equal(createResponse.ok, true);

    const handshakeResponse = await fetch(`${baseUrl}/codedemo/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: code,
        relevance: 7,
        understanding: 7,
        trust: 7,
        safety: 7,
        insight: 7,
      }),
    });
    const handshakeBody = await handshakeResponse.json();

    assert.equal(handshakeResponse.ok, true);
    assert.ok(handshakeBody.handshake);
    assert.equal(handshakeBody.handshake.vertical, 'codedemo');
    assert.equal(handshakeBody.handshake.eventCode, code);
  });
});

test('legacy codePerks redemption token validates through unprefixed fallback', async () => {
  await withTestServer(async (baseUrl) => {
    const certificateId = `CERT-${Date.now()}`;
    const claimResponse = await fetch(`${baseUrl}/reward-claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventCode: 'CPK-LEGACY-TEST',
        certificateId,
        claimant: {
          fullName: 'Legacy Token Tester',
          email: 'legacy-token@example.com',
        },
      }),
    });
    const claimBody = await claimResponse.json();
    const token = claimBody.claim?.redemptionToken || '';

    assert.equal(claimResponse.ok, true);
    assert.ok(token);
    assert.equal(token.toUpperCase().startsWith('CX-'), false);
    assert.equal(token.toUpperCase().startsWith('GX-'), false);
    assert.equal(token.toUpperCase().startsWith('CPK-'), false);

    const redemptionResponse = await fetch(`${baseUrl}/redemption/${encodeURIComponent(token)}`);
    const redemption = await redemptionResponse.json();

    assert.equal(redemptionResponse.ok, true);
    assert.equal(redemption.ok, true);
    assert.equal(redemption.valid, true);
    assert.equal(redemption.certificateId, certificateId);
    assert.equal(redemption.claimId, claimBody.claim.id);
  });
});

test('unknown redemption tokens stay isolated by prefix routing', async () => {
  await withTestServer(async (baseUrl) => {
    const cxResponse = await fetch(`${baseUrl}/redemption/CX-UNKNOWN-${Date.now()}`);
    const gxResponse = await fetch(`${baseUrl}/redemption/GX-UNKNOWN-${Date.now()}`);
    const legacyResponse = await fetch(`${baseUrl}/redemption/unknownlegacy${Date.now()}`);

    const cx = await cxResponse.json();
    const gx = await gxResponse.json();
    const legacy = await legacyResponse.json();

    assert.equal(cxResponse.status, 404);
    assert.equal(cx.ok, false);
    assert.equal(cx.status, 'not_found');
    assert.equal(Object.hasOwn(cx, 'valid'), false);
    assert.equal(Object.hasOwn(cx, 'error'), false);

    assert.equal(gxResponse.status, 404);
    assert.equal(gx.ok, false);
    assert.equal(gx.status, 'not_found');
    assert.equal(Object.hasOwn(gx, 'valid'), false);
    assert.equal(Object.hasOwn(gx, 'error'), false);

    assert.equal(legacyResponse.status, 404);
    assert.equal(legacy.ok, false);
    assert.equal(legacy.valid, false);
    assert.equal(typeof legacy.error, 'string');
    assert.equal(Object.hasOwn(legacy, 'status'), false);
  });
});
