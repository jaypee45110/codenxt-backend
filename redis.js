const Redis = require("ioredis");

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);

  redis.on("connect", () => {
    console.log("Redis connected");
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err.message);
  });
} else {
  console.log("No Redis URL – running without Redis");
}

module.exports = redis;