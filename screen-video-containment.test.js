const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const codeClipVerticalSource = readDirectorySources(path.join(__dirname, 'verticals', 'codeclip'));
const codePodVerticalSource = readDirectorySources(path.join(__dirname, 'verticals', 'codepod'));
const coasPolicySource = fs.readFileSync(
  path.join(__dirname, 'docs', 'architecture', 'COAS-vertical-isolation-policy.md'),
  'utf8'
);

function readDirectorySources(dir) {
  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => fs.readFileSync(path.join(dir, fileName), 'utf8'))
    .join('\n');
}

test('Screen Video remains classified as legacy generic backend containment risk', () => {
  assert.match(serverSource, /app\.post\("\/generate-screen-video"/);
  assert.match(serverSource, /app\.get\("\/screen-video\/:eventCode"/);
  assert.match(serverSource, /function runScreenVideoGenerator\(/);
  assert.match(serverSource, /screenVideoUrl/);
});

test('codeClip vertical modules do not depend on Screen Video runtime', () => {
  assert.equal(codeClipVerticalSource.includes('generate-screen-video'), false);
  assert.equal(codeClipVerticalSource.includes('/screen-video'), false);
  assert.equal(codeClipVerticalSource.includes('screenVideoUrl'), false);
  assert.equal(codeClipVerticalSource.includes('runScreenVideoGenerator'), false);
});

test('codePod vertical modules do not depend on Screen Video runtime', () => {
  assert.equal(codePodVerticalSource.includes('generate-screen-video'), false);
  assert.equal(codePodVerticalSource.includes('/screen-video'), false);
  assert.equal(codePodVerticalSource.includes('screenVideoUrl'), false);
  assert.equal(codePodVerticalSource.includes('runScreenVideoGenerator'), false);
});

test('Screen Video is not documented as a COAS platform function', () => {
  const normalizedPolicy = coasPolicySource.toLowerCase();

  assert.equal(normalizedPolicy.includes('screen video'), false);
  assert.equal(normalizedPolicy.includes('screenvideo'), false);
  assert.equal(normalizedPolicy.includes('generate-screen-video'), false);
});
