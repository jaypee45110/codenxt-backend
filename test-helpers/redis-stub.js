function createRedisStub() {
  const strings = new Map();
  const hashes = new Map();
  const expirations = new Map();
  const sets = new Map();
  const calls = [];

  function hashFor(key) {
    if (!hashes.has(key)) hashes.set(key, {});
    return hashes.get(key);
  }

  return {
    calls,
    strings,
    hashes,
    expirations,
    sets,
    async get(key) {
      calls.push({ method: "get", key });
      return strings.get(key) || null;
    },
    async set(key, value, ...args) {
      calls.push({ method: "set", key, value, args });
      if (args.includes("NX") && strings.has(key)) return null;
      strings.set(key, value);
      return "OK";
    },
    async hgetall(key) {
      calls.push({ method: "hgetall", key });
      return hashes.get(key) || {};
    },
    async hset(key, fieldOrObject, value) {
      calls.push({ method: "hset", key, fieldOrObject, value });
      const hash = hashFor(key);

      if (typeof fieldOrObject === "object" && fieldOrObject !== null) {
        Object.assign(hash, fieldOrObject);
      } else {
        hash[fieldOrObject] = value;
      }

      return 1;
    },
    async incr(key) {
      calls.push({ method: "incr", key });
      const next = Number(strings.get(key) || 0) + 1;
      strings.set(key, next);
      return next;
    },
    async ttl(key) {
      calls.push({ method: "ttl", key });
      return expirations.has(key) ? expirations.get(key) : -1;
    },
    async expire(key, seconds) {
      calls.push({ method: "expire", key, seconds });
      expirations.set(key, seconds);
      return 1;
    },
    async sadd(key, value) {
      calls.push({ method: "sadd", key, value });
      if (!sets.has(key)) sets.set(key, new Set());
      const set = sets.get(key);
      const existed = set.has(value);
      set.add(value);
      return existed ? 0 : 1;
    },
    async del(key) {
      calls.push({ method: "del", key });
      strings.delete(key);
      hashes.delete(key);
      expirations.delete(key);
      sets.delete(key);
      return 1;
    },
    on() {},
  };
}

module.exports = {
  createRedisStub,
};
