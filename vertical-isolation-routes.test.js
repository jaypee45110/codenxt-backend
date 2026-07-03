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

function assertNoCodeClipProviderInternals(payload) {
  assert.equal(Object.hasOwn(payload, 'audienceEntry'), false);
  assert.equal(Object.hasOwn(payload, 'audienceIntent'), false);
  assert.equal(Object.hasOwn(payload, 'audienceContext'), false);
  assert.equal(Object.hasOwn(payload, 'rewardAssignmentSnapshot'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceStatus'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceDecision'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceGuaranteePolicy'), false);
  assert.equal(Object.hasOwn(payload, 'persistenceAction'), false);
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
    assertNoCodeClipProviderInternals(keywordEntry);
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
