const test = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('./server');

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
    assert.equal(scan.success, true);
    assert.equal(scan.eventCode, code);
    assert.ok(scan.digitalSouvenir && typeof scan.digitalSouvenir === 'object');
    assert.equal(Object.hasOwn(scan, 'tierLimits'), false);
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
