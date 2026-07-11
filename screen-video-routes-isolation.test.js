const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRedisStub } = require('./test-helpers/redis-stub');

const generatorStub = createScreenVideoGeneratorStub();
const previousPythonBin = process.env.PYTHON_BIN;
process.env.PYTHON_BIN = generatorStub.generatorPath;

const redis = createRedisStub();
const redisModulePath = require.resolve('./redis');
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: redis,
};

const { app } = require('./server');

after(() => {
  if (previousPythonBin === undefined) {
    delete process.env.PYTHON_BIN;
  } else {
    process.env.PYTHON_BIN = previousPythonBin;
  }
  fs.rmSync(generatorStub.tempDir, { recursive: true, force: true });
});

function createScreenVideoGeneratorStub() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-video-generator-'));
  const markerPath = path.join(tempDir, 'calls.log');
  const generatorPath = path.join(tempDir, 'generator.sh');

  fs.writeFileSync(
    generatorPath,
    [
      '#!/bin/sh',
      `printf "%s\\n" "$*" >> ${JSON.stringify(markerPath)}`,
      'output_path="$7"',
      'mkdir -p "$(dirname "$output_path")"',
      'printf "stub screen video" > "$output_path"',
      '',
    ].join('\n')
  );
  fs.chmodSync(generatorPath, 0o755);

  return {
    tempDir,
    markerPath,
    generatorPath,
  };
}

async function withTestServer(run) {
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.on('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function uniqueCode(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`.toUpperCase();
}

function screenVideoPath(eventCode) {
  const safeEventCode = String(eventCode).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(__dirname, 'public', 'screen-videos', `${safeEventCode}_screen.mp4`);
}

async function createEvent(baseUrl, { code, vertical }) {
  const response = await fetch(`${baseUrl}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      vertical,
      name: `${vertical} screen video isolation test`,
      startAt: '2026-01-01T10:00:00.000Z',
      unlockAt: '2026-01-01T09:00:00.000Z',
      endAt: '2026-01-01T12:00:00.000Z',
      venue: 'Test venue',
    }),
  });

  assert.equal(response.status, 200);
  return readJson(response);
}

async function withScreenVideoGeneratorStub(run) {
  fs.rmSync(generatorStub.markerPath, { force: true });

  const helper = {
    wasCalled() {
      return fs.existsSync(generatorStub.markerPath);
    },
  };

  await run(helper);
}

async function withRedisEvent(meta, run) {
  const previousRedisUrl = process.env.REDIS_URL;
  const originalRedis = {
    get: redis.get,
    hgetall: redis.hgetall,
    hset: redis.hset,
    set: redis.set,
    del: redis.del,
  };
  const writes = [];

  process.env.REDIS_URL = 'redis://screen-video-isolation-test';
  redis.get = async (key) => {
    if (key === `eventcode:${meta.code}`) return meta.id;
    if (key === `event:${meta.id}:video:lock`) return null;
    return null;
  };
  redis.hgetall = async (key) => (key === `event:${meta.id}:meta` ? { ...meta } : {});
  redis.hset = async (...args) => {
    writes.push(args);
    return 1;
  };
  redis.set = async () => 'OK';
  redis.del = async () => 1;

  try {
    await run({ writes });
  } finally {
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
    Object.assign(redis, originalRedis);
  }
}

test('POST /generate-screen-video allows codeTone events', async () => {
  await withTestServer(async (baseUrl) => {
    const eventCode = uniqueCode('CT-SCREEN');
    await createEvent(baseUrl, { code: eventCode, vertical: 'codetone' });

    await withScreenVideoGeneratorStub(async (generator) => {
      try {
        const response = await fetch(`${baseUrl}/generate-screen-video`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventCode }),
        });
        const body = await readJson(response);

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.eventCode, eventCode);
        assert.equal(body.videoUrl, `/screen-video/${eventCode}`);
        assert.equal(generator.wasCalled(), true);
      } finally {
        fs.rmSync(screenVideoPath(eventCode), { force: true });
      }
    });
  });
});

test('POST /generate-screen-video rejects non-codeTone events before generator calls', async () => {
  await withTestServer(async (baseUrl) => {
    const eventCode = uniqueCode('CC-SCREEN');
    await createEvent(baseUrl, { code: eventCode, vertical: 'codeclip' });

    await withScreenVideoGeneratorStub(async (generator) => {
      const response = await fetch(`${baseUrl}/generate-screen-video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventCode }),
      });
      const body = await readJson(response);

      assert.equal(response.status, 403);
      assert.equal(body.ok, false);
      assert.equal(generator.wasCalled(), false);
    });
  });
});

test('GET /screen-video/:eventCode rejects non-codeTone events even when MP4 exists', async () => {
  await withTestServer(async (baseUrl) => {
    const eventCode = uniqueCode('CC-SCREEN-FILE');
    const existingVideoPath = screenVideoPath(eventCode);
    await createEvent(baseUrl, { code: eventCode, vertical: 'codeclip' });
    fs.mkdirSync(path.dirname(existingVideoPath), { recursive: true });
    fs.writeFileSync(existingVideoPath, 'existing non-codeTone video must not be served');

    await withScreenVideoGeneratorStub(async (generator) => {
      try {
        const response = await fetch(`${baseUrl}/screen-video/${eventCode}`);
        const body = await readJson(response);

        assert.equal(response.status, 403);
        assert.equal(body.ok, false);
        assert.equal(generator.wasCalled(), false);
      } finally {
        fs.rmSync(existingVideoPath, { force: true });
      }
    });
  });
});

test('Screen Video routes return 404 for unknown events without generator calls', async () => {
  await withTestServer(async (baseUrl) => {
    const eventCode = uniqueCode('UNKNOWN-SCREEN');

    await withScreenVideoGeneratorStub(async (generator) => {
      const postResponse = await fetch(`${baseUrl}/generate-screen-video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventCode }),
      });
      const postBody = await readJson(postResponse);

      assert.equal(postResponse.status, 404);
      assert.equal(postBody.ok, false);
      assert.equal(generator.wasCalled(), false);

      const getResponse = await fetch(`${baseUrl}/screen-video/${eventCode}`);
      const getBody = await readJson(getResponse);

      assert.equal(getResponse.status, 404);
      assert.equal(getBody.ok, false);
      assert.equal(generator.wasCalled(), false);
    });
  });
});

test('POST /generate-screen-video allows codeTone Redis events and persists video metadata', async () => {
  const eventCode = uniqueCode('REDIS-CT-SCREEN');
  const meta = {
    id: `redis-${eventCode}`,
    code: eventCode,
    vertical: 'codetone',
    name: 'Redis codeTone screen video test',
    startAt: '2026-01-01T10:00:00.000Z',
    badgeConfig: JSON.stringify({ template: 'americana' }),
  };

  await withTestServer(async (baseUrl) => {
    await withRedisEvent(meta, async ({ writes }) => {
      await withScreenVideoGeneratorStub(async (generator) => {
        try {
          const response = await fetch(`${baseUrl}/generate-screen-video`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ eventCode }),
          });
          const body = await readJson(response);

          assert.equal(response.status, 200);
          assert.equal(body.ok, true);
          assert.equal(body.videoUrl, `/screen-video/${eventCode}`);
          assert.equal(generator.wasCalled(), true);
          assert.ok(writes.some(([key, field]) => (
            key === `event:${meta.id}:meta` && field === 'screenVideoUrl'
          )));
          assert.ok(writes.some(([key, field]) => (
            key === `event:${meta.id}:meta` && field === 'badgeConfig'
          )));
        } finally {
          fs.rmSync(screenVideoPath(eventCode), { force: true });
        }
      });
    });
  });
});

test('POST /generate-screen-video rejects non-codeTone Redis events without metadata writes', async () => {
  const eventCode = uniqueCode('REDIS-CC-SCREEN');
  const meta = {
    id: `redis-${eventCode}`,
    code: eventCode,
    vertical: 'codeclip',
    name: 'Redis codeClip screen video test',
    startAt: '2026-01-01T10:00:00.000Z',
  };

  await withTestServer(async (baseUrl) => {
    await withRedisEvent(meta, async ({ writes }) => {
      await withScreenVideoGeneratorStub(async (generator) => {
        const response = await fetch(`${baseUrl}/generate-screen-video`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventCode }),
        });
        const body = await readJson(response);

        assert.equal(response.status, 403);
        assert.equal(body.ok, false);
        assert.equal(generator.wasCalled(), false);
        assert.deepEqual(writes, []);
      });
    });
  });
});

test('POST /generate-screen-video fails closed for Redis events without vertical', async () => {
  const eventCode = uniqueCode('REDIS-LEGACY-SCREEN');
  const meta = {
    id: `redis-${eventCode}`,
    code: eventCode,
    name: 'Redis legacy screen video test',
    startAt: '2026-01-01T10:00:00.000Z',
  };

  await withTestServer(async (baseUrl) => {
    await withRedisEvent(meta, async ({ writes }) => {
      await withScreenVideoGeneratorStub(async (generator) => {
        const response = await fetch(`${baseUrl}/generate-screen-video`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventCode }),
        });
        const body = await readJson(response);

        assert.equal(response.status, 403);
        assert.equal(body.ok, false);
        assert.equal(generator.wasCalled(), false);
        assert.deepEqual(writes, []);
      });
    });
  });
});
