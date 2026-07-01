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
