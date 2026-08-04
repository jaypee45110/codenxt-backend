const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodeClipProviderPollAdapterRegistryError,
  createCodeClipProviderPollAdapterRegistry,
} = require("./verticals/codeclip/provider-polling/adapter-registry");

function fakePoll() {
  return { ok: true, detections: [], nextCheckpoint: {}, page: { complete: true } };
}

test("poll adapter registry exports only public factory surface", () => {
  const mod = require("./verticals/codeclip/provider-polling/adapter-registry");
  assert.deepEqual(Object.keys(mod).sort(), [
    "CodeClipProviderPollAdapterRegistryError",
    "createCodeClipProviderPollAdapterRegistry",
  ]);
});

test("poll adapter registry instances are isolated", () => {
  const a = createCodeClipProviderPollAdapterRegistry();
  const b = createCodeClipProviderPollAdapterRegistry();
  a.register({ provider: "youtube", poll: fakePoll });
  assert.equal(a.list().length, 1);
  assert.equal(b.list().length, 0);
  assert.throws(
    () => b.get("youtube"),
    (error) => {
      assert.ok(error instanceof CodeClipProviderPollAdapterRegistryError);
      assert.equal(error.code, "ADAPTER_NOT_FOUND");
      return true;
    }
  );
});

test("poll adapter registry accepts polling-capable provider", () => {
  const registry = createCodeClipProviderPollAdapterRegistry();
  const registered = registry.register({
    provider: " YouTube ",
    poll: fakePoll,
  });
  assert.equal(registered.provider, "youtube");
  assert.equal(typeof registered.poll, "function");
  assert.equal(Object.isFrozen(registered), true);

  const got = registry.get("YOUTUBE");
  assert.equal(got.provider, "youtube");
  assert.equal(got.poll, fakePoll);

  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].provider, "youtube");
  listed.push({ provider: "mutated", poll: () => {} });
  assert.equal(registry.list().length, 1);
});

test("poll adapter registry rejects unknown and push-only providers", () => {
  const registry = createCodeClipProviderPollAdapterRegistry();

  assert.throws(
    () => registry.register({ provider: "not-a-provider", poll: fakePoll }),
    (error) => {
      assert.equal(error.code, "INVALID_ADAPTER");
      return true;
    }
  );

  for (const provider of ["meta", "sms", "test"]) {
    assert.throws(
      () => registry.register({ provider, poll: fakePoll }),
      (error) => {
        assert.equal(error.code, "POLLING_NOT_SUPPORTED");
        return true;
      }
    );
  }
});

test("poll adapter registry rejects duplicate registration and bad descriptors", () => {
  const registry = createCodeClipProviderPollAdapterRegistry();
  registry.register({ provider: "youtube", poll: fakePoll });

  assert.throws(
    () => registry.register({ provider: "youtube", poll: fakePoll }),
    (error) => {
      assert.equal(error.code, "ADAPTER_ALREADY_REGISTERED");
      return true;
    }
  );

  assert.throws(
    () => registry.register({ provider: "youtube", poll: "nope" }),
    (error) => {
      assert.equal(error.code, "INVALID_ADAPTER");
      return true;
    }
  );

  assert.throws(
    () =>
      registry.register({
        provider: "youtube",
        poll: fakePoll,
        extra: true,
      }),
    (error) => {
      assert.equal(error.code, "INVALID_ADAPTER");
      return true;
    }
  );
});

test("poll adapter registry get fails closed for missing adapter", () => {
  const registry = createCodeClipProviderPollAdapterRegistry();
  assert.throws(
    () => registry.get("youtube"),
    (error) => {
      assert.equal(error.code, "ADAPTER_NOT_FOUND");
      return true;
    }
  );
  assert.throws(
    () => registry.get("meta"),
    (error) => {
      assert.equal(error.code, "ADAPTER_NOT_FOUND");
      return true;
    }
  );
});

test("poll adapter registry has no module-level shared adapter state", () => {
  const first = createCodeClipProviderPollAdapterRegistry();
  first.register({ provider: "youtube", poll: fakePoll });
  const second = createCodeClipProviderPollAdapterRegistry();
  assert.equal(second.list().length, 0);
});

test("poll adapter registry descriptors never carry tokens or call context", () => {
  const registry = createCodeClipProviderPollAdapterRegistry();
  const token = "secret-access-token-value-do-not-leak";
  registry.register({ provider: "youtube", poll: fakePoll });

  const listed = registry.list();
  const got = registry.get("youtube");
  for (const descriptor of [listed[0], got]) {
    assert.deepEqual(Object.keys(descriptor).sort(), ["poll", "provider"]);
    assert.equal(Object.hasOwn(descriptor, "accessToken"), false);
    assert.equal(Object.hasOwn(descriptor, "checkpoint"), false);
    assert.equal(Object.hasOwn(descriptor, "credentials"), false);
    assert.equal(Object.hasOwn(descriptor, "environment"), false);
    assert.equal(Object.hasOwn(descriptor, "providerAccountId"), false);
    const serialized = JSON.stringify(descriptor, (_k, v) =>
      typeof v === "function" ? "[Function]" : v
    );
    assert.equal(serialized.includes(token), false);
  }
});
