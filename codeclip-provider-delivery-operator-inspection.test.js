const test = require("node:test");
const assert = require("node:assert/strict");

const dbModulePath = require.resolve("./db");
const originalDb = require(dbModulePath);

const defaultSummary = Object.freeze({
  total: 0,
  completed: 0,
  committedIncomplete: 0,
  processing: 0,
  failedPrecommit: 0,
  unknown: 0,
  oldestCommittedIncompleteAt: null,
  oldestProcessingAt: null,
  latestCompletedAt: null,
  attentionRequired: false,
  attentionReasons: [],
});

const summaryStub = {
  calls: [],
  fail: false,
  response: { ...defaultSummary },
};

async function getCodeClipProviderDeliveryOperationalSummaryStub() {
  summaryStub.calls.push({ at: new Date().toISOString() });
  if (summaryStub.fail) {
    throw new Error("forced codeClip provider delivery summary database failure");
  }
  return summaryStub.response;
}

require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    ...originalDb,
    getCodeClipProviderDeliveryOperationalSummary:
      getCodeClipProviderDeliveryOperationalSummaryStub,
  },
};

const { app } = require("./server");

function resetSummaryStub() {
  summaryStub.calls.length = 0;
  summaryStub.fail = false;
  summaryStub.response = { ...defaultSummary };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withEnv(env, run) {
  const originals = {};
  for (const name of Object.keys(env)) {
    originals[name] = process.env[name];
    const value = env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      restoreEnv(name, value);
    }
  }
}

async function withTestServer(run) {
  resetSummaryStub();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
    listeningServer.on("error", reject);
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
  return {
    status: response.status,
    body: await response.json(),
  };
}

test("codeClip operator inspection fails closed when admin secret is not configured", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: undefined }, async () => {
    await withTestServer(async (baseUrl) => {
      const { status, body } = await readJson(
        await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`)
      );

      assert.equal(status, 503);
      assert.deepEqual(body, {
        ok: false,
        error: "Operator inspection unavailable",
      });
      assert.equal(summaryStub.calls.length, 0);
    });
  });
});

test("codeClip operator inspection fails closed when admin secret is whitespace", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "   " }, async () => {
    await withTestServer(async (baseUrl) => {
      const { status, body } = await readJson(
        await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
          headers: { "x-admin-key": "anything" },
        })
      );

      assert.equal(status, 503);
      assert.equal(body.error, "Operator inspection unavailable");
      assert.equal(summaryStub.calls.length, 0);
    });
  });
});

test("codeClip operator inspection rejects missing, wrong, and different-length keys", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret" }, async () => {
    await withTestServer(async (baseUrl) => {
      const route = `${baseUrl}/internal/codeclip/provider-deliveries/summary`;
      const missing = await readJson(await fetch(route));
      const wrong = await readJson(await fetch(route, {
        headers: { "x-admin-key": "wrong-admin-secret!" },
      }));
      const differentLength = await readJson(await fetch(route, {
        headers: { "x-admin-key": "short" },
      }));

      assert.equal(missing.status, 401);
      assert.deepEqual(missing.body, { ok: false, error: "Unauthorized" });
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.body, { ok: false, error: "Unauthorized" });
      assert.equal(differentLength.status, 401);
      assert.deepEqual(differentLength.body, { ok: false, error: "Unauthorized" });
      assert.equal(summaryStub.calls.length, 0);
    });
  });
});

test("codeClip operator inspection returns authorized summary contract", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret", REDIS_URL: undefined }, async () => {
    await withTestServer(async (baseUrl) => {
      const summary = {
        total: 4,
        completed: 1,
        committedIncomplete: 2,
        processing: 1,
        failedPrecommit: 0,
        unknown: 0,
        oldestCommittedIncompleteAt: "2026-07-11T01:00:00.000Z",
        oldestProcessingAt: "2026-07-11T02:00:00.000Z",
        latestCompletedAt: "2026-07-11T03:00:00.000Z",
        attentionRequired: true,
        attentionReasons: ["committed_incomplete"],
      };
      const beforeSummary = JSON.stringify(summary);
      summaryStub.response = summary;

      const { status, body } = await readJson(
        await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
          headers: { "x-admin-key": "codeclip-admin-secret" },
        })
      );

      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.vertical, "codeclip");
      assert.equal(new Date(body.generatedAt).toISOString(), body.generatedAt);
      assert.deepEqual(body.providerDeliveries, summary);
      assert.equal(typeof body.providerDeliveries.total, "number");
      assert.equal(typeof body.providerDeliveries.committedIncomplete, "number");
      assert.equal(body.providerDeliveries.attentionRequired, true);
      assert.equal(JSON.stringify(summaryStub.response), beforeSummary);
      assert.equal(summaryStub.calls.length, 1);

      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /providerAccount|externalMessage|deliveryId|eventCode/i);
      assert.doesNotMatch(serialized, /raw|signature|token|stack|SELECT/i);
    });
  });
});

test("codeClip operator inspection returns empty ledger summary", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret" }, async () => {
    await withTestServer(async (baseUrl) => {
      const { status, body } = await readJson(
        await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
          headers: { "x-admin-key": "codeclip-admin-secret" },
        })
      );

      assert.equal(status, 200);
      assert.deepEqual(body.providerDeliveries, defaultSummary);
    });
  });
});

test("codeClip operator inspection handles summary database failure without leaking internals", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret" }, async () => {
    await withTestServer(async (baseUrl) => {
      const originalWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args);
      summaryStub.fail = true;

      try {
        const { status, body } = await readJson(
          await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
            headers: { "x-admin-key": "codeclip-admin-secret" },
          })
        );

        assert.equal(status, 503);
        assert.deepEqual(body, {
          ok: false,
          error: "Operator inspection unavailable",
        });
        assert.equal(summaryStub.calls.length, 1);
      } finally {
        console.warn = originalWarn;
      }

      const warningText = JSON.stringify(warnings);
      assert.match(warningText, /operator_summary_read_failed/);
      assert.doesNotMatch(warningText, /codeclip-admin-secret|x-admin-key|forced codeClip|SELECT|stack/i);
    });
  });
});

test("codeClip operator inspection rejects other vertical admin keys", async () => {
  await withEnv({
    CODECLIP_ADMIN_KEY: "codeclip-admin-secret",
    CODEPERKS_ADMIN_KEY: "codeperks-admin-secret",
  }, async () => {
    await withTestServer(async (baseUrl) => {
      const response = await readJson(
        await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
          headers: { "x-admin-key": "codeperks-admin-secret" },
        })
      );

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        ok: false,
        error: "Unauthorized",
      });
      assert.equal(summaryStub.calls.length, 0);
    });
  });
});

test("codeClip operator inspection does not expose secrets or headers in auth responses", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret" }, async () => {
    await withTestServer(async (baseUrl) => {
      const originalWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args);

      try {
        const { body } = await readJson(
          await fetch(`${baseUrl}/internal/codeclip/provider-deliveries/summary`, {
            headers: { "x-admin-key": "bad-codeclip-admin-secret" },
          })
        );

        assert.deepEqual(body, { ok: false, error: "Unauthorized" });
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(warnings.length, 0);
      assert.doesNotMatch(JSON.stringify(warnings), /codeclip-admin-secret|bad-codeclip|x-admin-key/i);
    });
  });
});

test("codeClip operator inspection only implements GET", async () => {
  await withEnv({ CODECLIP_ADMIN_KEY: "codeclip-admin-secret" }, async () => {
    await withTestServer(async (baseUrl) => {
      const route = `${baseUrl}/internal/codeclip/provider-deliveries/summary`;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(route, {
          method,
          headers: { "x-admin-key": "codeclip-admin-secret" },
        });
        assert.notEqual(response.status, 200);
      }
      assert.equal(summaryStub.calls.length, 0);
    });
  });
});
