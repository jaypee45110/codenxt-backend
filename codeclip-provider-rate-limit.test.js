const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCodeClipProviderRateLimitKey,
  enforceCodeClipProviderRateLimit,
  getCodeClipProviderPeerIdentity,
  hashCodeClipProviderRateLimitIdentity,
  incrementCodeClipProviderRateLimit,
  resolveCodeClipProviderRateLimitPolicy,
} = require("./verticals/codeclip/provider-rate-limit");

function createFallbackRedis() {
  const store = new Map();
  const expirations = new Map();

  return {
    store,
    expirations,
    async incr(key) {
      const next = Number(store.get(key) || 0) + 1;
      store.set(key, next);
      return next;
    },
    async ttl(key) {
      return expirations.has(key) ? expirations.get(key) : -1;
    },
    async expire(key, seconds) {
      expirations.set(key, seconds);
      return 1;
    },
  };
}

function createEvalRedis() {
  const hits = new Map();
  const calls = [];

  return {
    calls,
    async eval(script, keyCount, key, windowSeconds) {
      calls.push({ keyCount, key, windowSeconds, script });
      const next = Number(hits.get(key) || 0) + 1;
      hits.set(key, next);
      return next;
    },
  };
}

test("codeClip provider rate-limit keys are provider-scoped, phase-scoped and hashed", () => {
  const first = buildCodeClipProviderRateLimitKey({
    provider: "meta",
    phase: "post-verification",
    identity: "page-1",
  });
  const second = buildCodeClipProviderRateLimitKey({
    provider: "sms",
    phase: "post-verification",
    identity: "page-1",
  });

  assert.notEqual(first, second);
  assert.equal(first.startsWith("ratelimit:codeclip-provider:meta:post-verification:"), true);
  assert.equal(first.includes("page-1"), false);
  assert.equal(first.includes("ratelimit:scan"), false);
});

test("codeClip provider rate-limit identity hashing handles untrusted input", () => {
  const identity = "2001:db8::1, spoofed-forwarded-for\nwith-control-text";
  const hashed = hashCodeClipProviderRateLimitIdentity(identity);

  assert.match(hashed, /^[a-f0-9]{64}$/);
  assert.equal(hashed.includes(identity), false);
});

test("codeClip provider peer identity uses socket identity before forwarded headers", () => {
  const identity = getCodeClipProviderPeerIdentity({
    socket: { remoteAddress: "10.0.0.5" },
    headers: { "x-forwarded-for": "198.51.100.9" },
    ip: "127.0.0.1",
  });

  assert.equal(identity, "10.0.0.5");
});

test("codeClip provider rate-limit policy keeps pre-verification limit much higher than post-verification", () => {
  const pre = resolveCodeClipProviderRateLimitPolicy({ provider: "meta", phase: "pre-verification", env: {} });
  const post = resolveCodeClipProviderRateLimitPolicy({ provider: "meta", phase: "post-verification", env: {} });

  assert.equal(pre.limit > post.limit, true);
  assert.equal(pre.phase, "pre-verification");
  assert.equal(post.phase, "post-verification");
});

test("codeClip provider rate limiter allows permitted requests and sets TTL without eval", async () => {
  const redis = createFallbackRedis();
  const key = "ratelimit:codeclip-provider:meta:post-verification:test";

  const hits = await incrementCodeClipProviderRateLimit({
    redis,
    key,
    windowSeconds: 60,
  });

  assert.equal(hits, 1);
  assert.equal(redis.expirations.get(key), 60);
});

test("codeClip provider rate limiter uses atomic eval when available", async () => {
  const redis = createEvalRedis();

  const result = await enforceCodeClipProviderRateLimit({
    redis,
    redisEnabled: true,
    provider: "meta",
    phase: "post-verification",
    identity: "page-1",
    liveProvider: true,
    requireStore: true,
    env: { CODECLIP_META_PROVIDER_POST_RATE_LIMIT: "2" },
  });

  assert.equal(result.ok, true);
  assert.equal(redis.calls.length, 1);
  assert.equal(redis.calls[0].windowSeconds, "60");
});

test("codeClip provider rate limiter returns 429 after configured limit", async () => {
  const redis = createFallbackRedis();
  const input = {
    redis,
    redisEnabled: true,
    provider: "meta",
    phase: "post-verification",
    identity: "page-1",
    liveProvider: true,
    requireStore: true,
    env: { CODECLIP_META_PROVIDER_POST_RATE_LIMIT: "1" },
  };

  assert.equal((await enforceCodeClipProviderRateLimit(input)).ok, true);
  assert.deepEqual(await enforceCodeClipProviderRateLimit(input), {
    ok: false,
    status: 429,
    error: "Too many requests. Please try again shortly.",
  });
});

test("codeClip provider rate limiter keeps provider counters separate", async () => {
  const redis = createFallbackRedis();
  const env = { CODECLIP_PROVIDER_POST_RATE_LIMIT: "1" };

  assert.equal((await enforceCodeClipProviderRateLimit({
    redis,
    redisEnabled: true,
    provider: "meta",
    phase: "post-verification",
    identity: "shared-account",
    env,
  })).ok, true);
  assert.equal((await enforceCodeClipProviderRateLimit({
    redis,
    redisEnabled: true,
    provider: "sms",
    phase: "post-verification",
    identity: "shared-account",
    env,
  })).ok, true);
});

test("codeClip provider rate limiter fails closed for live providers without Redis", async () => {
  assert.deepEqual(
    await enforceCodeClipProviderRateLimit({
      redis: null,
      redisEnabled: false,
      provider: "meta",
      phase: "post-verification",
      identity: "page-1",
      liveProvider: true,
      requireStore: true,
    }),
    { ok: false, status: 503, error: "Provider keyword processing unavailable" }
  );
});

test("codeClip provider rate limiter fails open for non-live providers without Redis", async () => {
  assert.deepEqual(
    await enforceCodeClipProviderRateLimit({
      redis: null,
      redisEnabled: false,
      provider: "test",
      phase: "post-verification",
      identity: "test",
      liveProvider: false,
      requireStore: false,
    }),
    { ok: true, skipped: true }
  );
});

test("codeClip provider rate limiter fails closed for live Redis errors", async () => {
  const redis = {
    async eval() {
      throw new Error("redis down");
    },
  };

  assert.deepEqual(
    await enforceCodeClipProviderRateLimit({
      redis,
      redisEnabled: true,
      provider: "meta",
      phase: "post-verification",
      identity: "page-1",
      liveProvider: true,
      requireStore: true,
    }),
    { ok: false, status: 503, error: "Provider keyword processing unavailable" }
  );
});
