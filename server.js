const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const redis = require("./redis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = "codenxt-dev-secret-change-later";

let events = {};
let rewards = {};

async function testRedisConnection() {
  try {
    await redis.connect();
    await redis.set("test:key", "hello-nxt");
    const value = await redis.get("test:key");
    console.log("Redis test value:", value);
    return true;
  } catch (err) {
    console.error("Redis test failed:", err.message);
    return false;
  }
}

function makeFingerprint(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string" && forwarded.split(",")[0].trim()) ||
    req.socket.remoteAddress ||
    "unknown-ip";

  const userAgent = req.headers["user-agent"] || "unknown-ua";
  return `${ip}__${userAgent}`;
}

async function consumeTokenAtomically(tokenKey) {
  const lua = `
    local current = redis.call("GET", KEYS[1])
    if not current then
      return "missing"
    end
    if current ~= "fresh" then
      return current
    end
    redis.call("SET", KEYS[1], "used", "EX", 120)
    return "used_now"
  `;

  return redis.eval(lua, 1, tokenKey);
}

// CREATE EVENT
app.post("/event", async (req, res) => {
  try {
    const {
        code,
  name,
  startAt,
  unlockAt,
  endAt,
  maxClaims = 5000,
  status = "active",
} = req.body;
    if (!name || !startAt || !unlockAt || !endAt) {
      return res.status(400).json({
        error: "name, startAt, unlockAt and endAt are required",
      });
    }

    const id = uuidv4();

    const event = {
  id,
  code: code || id,
  name,
  startAt,
  unlockAt,
  endAt,
  maxClaims,
  status,
};
    events[id] = event;

if (redis) {
  await redis.hset(`event:${id}:meta`, {
    id,
    code: code || id,
    name,
    startAt,
    unlockAt,
    endAt,
    maxClaims: String(maxClaims),
    status,
  });

  await redis.set(`eventcode:${code || id}`, id);
  await redis.set(`event:${id}:claims`, "0");
}
    res.json({
      success: true,
      eventId: id,
      event,
    });
  } catch (err) {
    console.error("Create event failed:", err.message);
    res.status(500).json({ error: "Failed to create event" });
  }
});
// GET EVENT META
app.get("/event/:eventId", async (req, res) => {
  try {
    let { eventId } = req.params;

// Try Redis lookup if available
if (redis) {
  const resolvedId = await redis.get(`eventcode:${eventId}`);
  if (resolvedId) {
    eventId = resolvedId;
  }
}

console.log("RESOLVED EVENT ID:", eventId);

// Check in-memory first
if (events[eventId]) {
  return res.json(events[eventId]);
}

// Fallback: find by code in memory when Redis is unavailable
const inMemoryEvent = Object.values(events).find(
  (event) => event.code === eventId
);

if (inMemoryEvent) {
  return res.json(inMemoryEvent);
}
let meta = null;

// Try Redis meta if available
if (redis) {
  meta = await redis.hgetall(`event:${eventId}:meta`);
  console.log("EVENT META FROM REDIS:", meta);
}

if (!meta || !meta.id) {
  return res.status(404).json({ error: "Event not found" });
}
    const normalizedMeta = {
      id: meta.id,
      code: meta.code,
      name: meta.name,
      startAt: meta.startAt,
      unlockAt: meta.unlockAt,
      endAt: meta.endAt,
      maxClaims: Number(meta.maxClaims || 0),
      status: meta.status,
    };

    events[eventId] = normalizedMeta;
    return res.json(normalizedMeta);
  } catch (err) {
    console.error("Get event failed:", err.message);
    return res.status(500).json({ error: "Failed to get event" });
  }
});
// ACCESS STATUS + SHORT-LIVED TOKEN
app.get("/access/:eventId", async (req, res) => {
  try {
    let { eventId } = req.params;

    // Try Redis lookup if available
    if (redis) {
      const resolvedId = await redis.get(`eventcode:${eventId}`);
      if (resolvedId) {
        eventId = resolvedId;
      }
    }

    let meta = null;

    // In-memory lookup by id
    if (events[eventId]) {
      meta = events[eventId];
    }

    // In-memory lookup by code
    if (!meta) {
      meta = Object.values(events).find((event) => event.code === eventId);
      if (meta) {
        eventId = meta.id;
      }
    }

    // Redis lookup if available
    if (!meta && redis) {
      meta = await redis.hgetall(`event:${eventId}:meta`);
    }

    if (!meta || !meta.id) {
      return res.status(404).json({ error: "Event not found" });
    }

    const now = Date.now();
    const startMs = Date.parse(meta.startAt);
    const unlockMs = Date.parse(meta.unlockAt);
    const endMs = Date.parse(meta.endAt);

    let accessStatus = "inactive";

    if (meta.status !== "active") {
      accessStatus = "inactive";
    } else if (now < startMs) {
      accessStatus = "pending";
    } else if (now >= startMs && now < unlockMs) {
      accessStatus = "locked";
    } else if (now >= unlockMs && now <= endMs) {
      accessStatus = "open";
    } else if (now > endMs) {
      accessStatus = "closed";
    }

    let claims = "0";
    if (redis) {
      claims = await redis.get(`event:${eventId}:claims`);
    }

    const fingerprint = makeFingerprint(req);
    const jti = uuidv4();

    const tokenPayload = {
      sub: "access",
      eventId,
      jti,
      unlockAt: Math.floor(unlockMs / 1000),
      fp: fingerprint,
    };

    const accessToken = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: "10m",
    });

    if (redis) {
      await redis.set(`event:${eventId}:token:${jti}`, "fresh", "EX", 600);
    }

    res.json({
      success: true,
      eventId,
      eventName: meta.name,
      status: accessStatus,
      serverTime: new Date(now).toISOString(),
      startAt: meta.startAt,
      unlockAt: meta.unlockAt,
      endAt: meta.endAt,
      maxClaims: Number(meta.maxClaims || 0),
      claims: Number(claims || 0),
      accessToken,
      expiresIn: 600,
    });
  } catch (err) {
    console.error("Access check failed:", err.message);
    res.status(500).json({ error: "Failed to check access" });
  }
});

// CLAIM REWARD
app.post("/claim", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: "accessToken is required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(accessToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        status: "invalid_token",
        error: "Token invalid or expired",
      });
    }

    const { eventId, jti, unlockAt, fp } = decoded;

    if (!eventId || !jti || !unlockAt) {
      return res.status(400).json({
        success: false,
        status: "invalid_token_payload",
        error: "Token payload incomplete",
      });
    }

let meta = null;

if (events[eventId]) {
  meta = events[eventId];
}

if (!meta && redis) {
  meta = await redis.hgetall(`event:${eventId}:meta`);
}

if (!meta || !meta.id) {
  return res.status(404).json({
    success: false,
    status: "event_not_found",
    error: "Event not found",
  });
}
    const now = Date.now();

    if (meta.status !== "active") {
      return res.status(403).json({
        success: false,
        status: "inactive",
        error: "Event is not active",
      });
    }

    if (now < unlockAt * 1000) {
      return res.status(403).json({
        success: false,
        status: "locked",
        error: "Reward not unlocked yet",
        unlockAt: meta.unlockAt,
        serverTime: new Date(now).toISOString(),
      });
    }

    if (now > Date.parse(meta.endAt)) {
      return res.status(403).json({
        success: false,
        status: "closed",
        error: "Event has ended",
      });
    }

    const currentFingerprint = makeFingerprint(req);
    if (fp !== currentFingerprint) {
      return res.status(403).json({
        success: false,
        status: "fingerprint_mismatch",
        error: "Client fingerprint mismatch",
      });
    }

const maxClaims = Number(meta.maxClaims || 0);
const claimNumber = 1;

let reward = rewards[eventId] || {
  title: "codeNXT Reward",
  type: "text",
  content: "Reward granted"
};

    return res.json({
      success: true,
      status: "granted",
      eventId,
      claimNumber,
      maxClaims,
      reward,
    });
  } catch (err) {
    console.error("Claim failed:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to claim reward",
    });
  }
});

// UPLOAD REWARD
app.post("/reward", async (req, res) => {
  try {
    const { eventId, reward } = req.body;

    if (!eventId || !reward) {
      return res.status(400).json({ error: "eventId and reward are required" });
    }

    rewards[eventId] = reward;
    await redis.set(`reward:${eventId}:json`, JSON.stringify(reward));

    res.json({ success: true });
  } catch (err) {
    console.error("Upload reward failed:", err.message);
    res.status(500).json({ error: "Failed to upload reward" });
  }
});

// GET REWARD
app.get("/reward/:eventId", async (req, res) => {
  try {
    const eventId = req.params.eventId;

    if (rewards[eventId]) {
      return res.json(rewards[eventId]);
    }

    const cachedReward = await redis.get(`reward:${eventId}:json`);

    if (cachedReward) {
      const parsed = JSON.parse(cachedReward);
      rewards[eventId] = parsed;
      return res.json(parsed);
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error("Get reward failed:", err.message);
    res.status(500).json({ error: "Failed to get reward" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  testRedisConnection().catch((err) => {
    console.error("Redis test failed:", err.message);
  });
});