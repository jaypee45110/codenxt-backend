const REDIS_ENABLED = !!process.env.REDIS_URL;
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const redis = require("./redis");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = "codenxt-dev-secret-change-later";

let events = {};
let rewards = {};
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const VIDEO_DIR = path.join(__dirname, "public", "screen-videos");

fs.mkdirSync(VIDEO_DIR, { recursive: true });
app.use("/screen-videos", express.static(VIDEO_DIR));

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

function runScreenVideoGenerator({
  eventCode,
  lang = "en",
  artistName = "ARTIST NAME",
  venue = "VENUE",
  eventDate = "DATE",
}) {
  return new Promise((resolve, reject) => {
    const safeEventCode = String(eventCode).replace(/[^A-Za-z0-9_-]/g, "");
    const outputPath = path.join(VIDEO_DIR, `${safeEventCode}_screen.mp4`);

    const args = [
      "pete_qr_video.py",
      safeEventCode,
      String(lang),
      String(artistName),
      String(venue),
      String(eventDate),
      outputPath,
    ];

    const child = spawn(PYTHON_BIN, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(stderr || stdout || `Video process exited with code ${code}`)
        );
      }

      const videoPath = `/screen-videos/${safeEventCode}_screen.mp4`;
      const videoUrl = PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}${videoPath}`
        : videoPath;

      resolve({
        eventCode: safeEventCode,
        outputPath,
        videoPath,
        videoUrl,
        stdout,
      });
    });
  });
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

if (process.env.REDIS_URL) {
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
if (process.env.REDIS_URL) {
  const resolvedId = await redis.get(`eventcode:${eventId}`);
  if (resolvedId) {
    eventId = resolvedId;
  }
}

if (process.env.DEBUG_EVENT_LOOKUP === "1") {
  console.log("RESOLVED EVENT ID:", eventId);
}
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
if (process.env.REDIS_URL) {
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
if (process.env.REDIS_URL) {
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
if (!meta && process.env.REDIS_URL) {
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
if (process.env.REDIS_URL) {
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

if (process.env.REDIS_URL) {
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

if (!meta && process.env.REDIS_URL) {
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

if (process.env.REDIS_URL) {
    await redis.set(`reward:${eventId}:json`, JSON.stringify(reward));
}
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

let cachedReward = null;

if (process.env.REDIS_URL) {
  cachedReward = await redis.get(`reward:${eventId}:json`);
}

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
// GET REPORT
app.get("/report/:eventCode", async (req, res) => {
  try {
    let { eventCode } = req.params;
    let event = null;
    let eventId = null;

    // 1) Finn event i minne via code
    event = Object.values(events).find((item) => item.code === eventCode);

    if (event) {
      eventId = event.id;
    }

    // 2) Fallback til Redis hvis tilgjengelig
if (!event && process.env.REDIS_URL) {
        const resolvedId = await redis.get(`eventcode:${eventCode}`);
      if (resolvedId) {
        eventId = resolvedId;

        const meta = await redis.hgetall(`event:${eventId}:meta`);
        if (meta && meta.id) {
          event = {
            id: meta.id,
            code: meta.code,
            name: meta.name,
            startAt: meta.startAt,
            unlockAt: meta.unlockAt,
            endAt: meta.endAt,
            maxClaims: Number(meta.maxClaims || 0),
            status: meta.status,
          };
        }
      }
    }

    if (!event || !eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

    // 3) Hent joins fra minnebasert report-struktur finnes ikke på backend,
    // så vi simulerer foreløpig et rapportgrunnlag
    const simulatedScans = 7286;
    const simulatedJoins = 2184;
    const simulatedConversionRate = 39.6;

    // 4) Lag simulerte telefonnumre i ønsket format
    const innerCircle = Array.from({ length: 25 }, (_, i) => {
      const suffix = String(10000 + i).padStart(5, "0");
      return `+47900${suffix}`;
    });

    return res.json({
      event: {
        id: event.id,
        eventCode: event.code,
        artistName: event.name || "Artist / Event Name",
        venue: "Venue Name",
        date: event.startAt ? event.startAt.slice(0, 10) : "",
      },
      metrics: {
        scans: simulatedScans,
        joins: simulatedJoins,
        conversionRate: simulatedConversionRate,
      },
      innerCircle,
    });
  } catch (err) {
    console.error("Get report failed:", err.message);
    res.status(500).json({ error: "Failed to get report" });
  }
});
app.post("/generate-screen-video", async (req, res) => {
  try {
    const {
      eventCode,
      lang = "en",
      artistName,
      venue,
      eventDate,
    } = req.body || {};

    if (!eventCode) {
      return res.status(400).json({
        ok: false,
        error: "eventCode is required",
      });
    }

    let event = null;
    let eventId = null;

    event = Object.values(events).find((item) => item.code === eventCode);

    if (event) {
      eventId = event.id;
    }

if (!event && process.env.REDIS_URL) {
        const resolvedId = await redis.get(`eventcode:${eventCode}`);
      if (resolvedId) {
        eventId = resolvedId;

        const meta = await redis.hgetall(`event:${eventId}:meta`);
        if (meta && meta.id) {
          event = {
            id: meta.id,
            code: meta.code,
            name: meta.name,
            startAt: meta.startAt,
            unlockAt: meta.unlockAt,
            endAt: meta.endAt,
            maxClaims: Number(meta.maxClaims || 0),
            status: meta.status,
          };
        }
      }
    }

    const finalArtistName =
      artistName ||
      (event && event.name) ||
      "ARTIST NAME";

    const finalVenue =
      venue ||
      (event && event.venue) ||
      "VENUE";

    const finalEventDate =
      eventDate ||
      (event && event.startAt ? event.startAt.slice(0, 10) : "DATE");

    const result = await runScreenVideoGenerator({
      eventCode,
      lang,
      artistName: finalArtistName,
      venue: finalVenue,
      eventDate: finalEventDate,
    });

    if (eventId && redis) {
      await redis.hset(`event:${eventId}:meta`, {
        screenVideoUrl: result.videoUrl,
      });
    }

    if (eventId && events[eventId]) {
      events[eventId].screenVideoUrl = result.videoUrl;
    }

    return res.json({
      ok: true,
      eventCode: result.eventCode,
      videoUrl: result.videoUrl,
    });
  } catch (err) {
    console.error("Generate screen video failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate screen video",
      details: err.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);

  if (process.env.REDIS_URL) {
    testRedisConnection().catch((err) => {
      console.error("Redis test failed:", err.message);
    });
  } else {
    console.log("Redis disabled - running in memory mode");
  }
});