const Redis = require("ioredis");

const redis =
  process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new Redis({
        host: "127.0.0.1",
        port: 6379,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

module.exports = redis;