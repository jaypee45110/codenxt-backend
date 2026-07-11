const crypto = require("node:crypto");

const RATE_LIMIT_SCRIPT = `
local hits = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return hits
`;

const DEFAULT_LIMITS = {
  preVerification: {
    limit: 10000,
    windowSeconds: 60,
  },
  postVerification: {
    limit: 120,
    windowSeconds: 60,
  },
};

function normalizeProviderToken(value) {
  return String(value || "unknown").trim().toLowerCase() || "unknown";
}

function normalizePhase(value) {
  return value === "post-verification" ? "post-verification" : "pre-verification";
}

function envNumber(env, names, fallback) {
  for (const name of names) {
    const value = Number(env?.[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function resolveCodeClipProviderRateLimitPolicy({
  provider,
  phase,
  env = process.env,
} = {}) {
  const normalizedProvider = normalizeProviderToken(provider).toUpperCase();
  const normalizedPhase = normalizePhase(phase);
  const defaults = normalizedPhase === "post-verification"
    ? DEFAULT_LIMITS.postVerification
    : DEFAULT_LIMITS.preVerification;
  const phaseToken = normalizedPhase === "post-verification" ? "POST" : "PRE";

  return {
    phase: normalizedPhase,
    limit: envNumber(
      env,
      [
        `CODECLIP_${normalizedProvider}_PROVIDER_${phaseToken}_RATE_LIMIT`,
        `CODECLIP_PROVIDER_${phaseToken}_RATE_LIMIT`,
      ],
      defaults.limit
    ),
    windowSeconds: envNumber(
      env,
      [
        `CODECLIP_${normalizedProvider}_PROVIDER_${phaseToken}_RATE_WINDOW_SECONDS`,
        `CODECLIP_PROVIDER_${phaseToken}_RATE_WINDOW_SECONDS`,
      ],
      defaults.windowSeconds
    ),
  };
}

function hashCodeClipProviderRateLimitIdentity(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "unknown"))
    .digest("hex");
}

function buildCodeClipProviderRateLimitKey({ provider, phase, identity } = {}) {
  return [
    "ratelimit",
    "codeclip-provider",
    normalizeProviderToken(provider),
    normalizePhase(phase),
    hashCodeClipProviderRateLimitIdentity(identity),
  ].join(":");
}

function getCodeClipProviderPeerIdentity(req) {
  return String(
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    req?.ip ||
    "unknown"
  );
}

async function incrementCodeClipProviderRateLimit({ redis, key, windowSeconds } = {}) {
  if (!redis) throw new Error("REDIS_REQUIRED");
  if (!key) throw new Error("RATE_LIMIT_KEY_REQUIRED");

  if (typeof redis.eval === "function") {
    return Number(await redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowSeconds)));
  }

  const hits = Number(await redis.incr(key));
  const ttl = typeof redis.ttl === "function" ? Number(await redis.ttl(key)) : -1;

  if (ttl < 0) {
    await redis.expire(key, windowSeconds);
  }

  return hits;
}

async function enforceCodeClipProviderRateLimit({
  redis,
  redisEnabled,
  provider,
  phase,
  identity,
  liveProvider = false,
  requireStore = false,
  env = process.env,
} = {}) {
  const policy = resolveCodeClipProviderRateLimitPolicy({ provider, phase, env });

  if (!redisEnabled || !redis) {
    if (liveProvider && requireStore) {
      return { ok: false, status: 503, error: "Provider keyword processing unavailable" };
    }

    return { ok: true, skipped: true };
  }

  try {
    const key = buildCodeClipProviderRateLimitKey({
      provider,
      phase: policy.phase,
      identity,
    });
    const hits = await incrementCodeClipProviderRateLimit({
      redis,
      key,
      windowSeconds: policy.windowSeconds,
    });

    if (hits > policy.limit) {
      return {
        ok: false,
        status: 429,
        error: "Too many requests. Please try again shortly.",
      };
    }

    return { ok: true, hits, key };
  } catch (error) {
    if (liveProvider && requireStore) {
      return { ok: false, status: 503, error: "Provider keyword processing unavailable" };
    }

    return { ok: true, skipped: true, warning: "RATE_LIMIT_UNAVAILABLE" };
  }
}

module.exports = {
  buildCodeClipProviderRateLimitKey,
  enforceCodeClipProviderRateLimit,
  getCodeClipProviderPeerIdentity,
  hashCodeClipProviderRateLimitIdentity,
  incrementCodeClipProviderRateLimit,
  resolveCodeClipProviderRateLimitPolicy,
};
