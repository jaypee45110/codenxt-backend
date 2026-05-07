require("dotenv").config();

const REDIS_ENABLED = !!process.env.REDIS_URL;
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const redis = require("./redis");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options(/.*/, cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

const PORT = process.env.PORT || 3001;
const JWT_SECRET = "codenxt-dev-secret-change-later";

let events = {};
let rewards = {};
function getRewardForTier(storedReward, tier) {
  if (!storedReward) {
    return {
      title: "codeNXT Reward",
      type: "text",
      content: "Reward granted",
      tier: tier || "general",
    };
  }

  const isTieredReward =
storedReward.gold || storedReward.silver || storedReward.general;
  if (!isTieredReward) {
    return {
      ...storedReward,
      tier: tier || "general",
    };
  }

  return (
    storedReward[tier] ||
storedReward.general ||
    storedReward.gold || {
      title: "codeNXT Reward",
      type: "text",
      content: "Reward granted",
      tier: tier || "general",
    }
  );
}
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const VIDEO_DIR = path.join(__dirname, "public", "screen-videos");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
fs.mkdirSync(VIDEO_DIR, { recursive: true });
app.use("/screen-videos", express.static(VIDEO_DIR));
app.post("/upload-reward-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No file uploaded",
      });
    }

    const safeEventCode = String(req.body.eventCode || "general").replace(/[^A-Za-z0-9_-]/g, "");
    const originalName = String(req.file.originalname || "reward-file").replace(/[^A-Za-z0-9._-]/g, "_");
    const objectKey = `rewards/${safeEventCode}/${Date.now()}-${uuidv4()}-${originalName}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: objectKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || "application/octet-stream",
      })
    );

    const publicBase = String(process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const url = `${publicBase}/${objectKey}`;

    return res.json({
      ok: true,
      url,
      key: objectKey,
      contentType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (error) {
    console.error("R2 upload failed:", error);
    return res.status(500).json({
      ok: false,
      error: "R2 upload failed",
      details: error.message,
    });
  }
});
app.get("/screen-video/:eventCode", async (req, res) => {
    const safeEventCode = String(req.params.eventCode).replace(/[^A-Za-z0-9_-]/g, "");
  const filePath = path.join(VIDEO_DIR, `${safeEventCode}_screen.mp4`);

if (!fs.existsSync(filePath)) {
  console.log("Video missing, auto-generating:", safeEventCode);

  try {
    // kall samme generator som /generate-screen-video bruker
await runScreenVideoGenerator({
  eventCode: safeEventCode,
  artistName: "Event",
});
  } catch (err) {
    console.error("Auto-generate failed:", err.message);
    return res.status(404).json({
      ok: false,
      error: "Screen video not found",
      eventCode: safeEventCode,
      expectedPath: filePath,
    });
  }
}

  res.sendFile(filePath);
});

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
  badgeFile = "americana.png",
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
  String(badgeFile),
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
  const text = data.toString();
  stdout += text;
  console.log("PYTHON STDOUT:", text);
});

child.stderr.on("data", (data) => {
  const text = data.toString();
  stderr += text;
  console.error("PYTHON STDERR:", text);
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
console.log("VIDEO EXISTS AFTER GENERATION:", fs.existsSync(outputPath), outputPath);
const videoPath = `/screen-video/${safeEventCode}`;      const videoUrl = PUBLIC_BASE_URL
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
  artistLogo,
  badgeConfig,
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
  maxClaims,
  status
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
  artistLogo,
  badgeConfig,
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
maxClaims,
  status,
  momentOpen: false,
};
    events[id] = event;

if (process.env.REDIS_URL) {
await redis.hset(`event:${id}:meta`, {
  id,
  code: code || id,
  name,
artistLogo: artistLogo || "",
  badgeConfig: JSON.stringify(badgeConfig || { template: "americana" }),
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
  maxClaims: String(maxClaims),
  status,
  momentOpen: "false",
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
if (process.env.DEBUG_EVENT_LOOKUP === "1") {
  console.log("RESOLVED EVENT ID:", eventId);
}
}
// Check in-memory first

// Fallback: find by code in memory when Redis is unavailable
const inMemoryEvent = Object.values(events).find(
  (event) => event.code === eventId
);


  let meta = null;

  if (process.env.REDIS_URL) {
    meta = await redis.hgetall(`event:${eventId}:meta`);
    if (meta && meta.badgeConfig) {
  try {
    meta.badgeConfig = JSON.parse(meta.badgeConfig);
  } catch {
    meta.badgeConfig = { template: "americana" };
  }
}
    if ((!meta || !meta.id) && events[eventId]) {
  meta = events[eventId];
}

if ((!meta || !meta.id) && inMemoryEvent) {
  meta = inMemoryEvent;
}
  }
let rawScans = 0;
let uniqueScans = 0;
let innerCircleJoinCount = 0;

if (process.env.REDIS_URL) {
  rawScans = Number(await redis.get(`event:${eventId}:rawScans`) || 0);
  uniqueScans = Number(await redis.get(`event:${eventId}:uniqueScans`) || 0);
  innerCircleJoinCount = Number(await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0);
} else if (meta) {
  rawScans = Number(meta.rawScans || 0);
  uniqueScans = Number(meta.uniqueScans || 0);
  innerCircleJoinCount = Number(meta.innerCircleJoinCount || 0);
}

const normalizedMeta = {
  id: meta?.id,
  code: meta?.code,
  name: meta?.name,
  artistLogo: meta?.artistLogo || "",
  badgeConfig: meta?.badgeConfig,
  venue: meta?.venue || "",
  city: meta?.city || "",
  startAt: meta?.startAt,
  unlockAt: meta?.unlockAt,
  endAt: meta?.endAt,
  maxClaims: Number(meta?.maxClaims || 0),
  status: meta?.status,
screenVideoUrl: meta?.screenVideoUrl || "",
momentOpen: meta?.momentOpen === true || meta?.momentOpen === "true",
rawScans,
  uniqueScans,
  innerCircleJoinCount,
};

  events[eventId] = normalizedMeta;
  return res.json(normalizedMeta);

} catch (err) {
  console.error("Get event failed:", err.message);
  return res.status(500).json({ error: "Failed to get event" });
}
});
app.post("/event/:eventCode/moment-open", async (req, res) => {
  try {
    let { eventCode } = req.params;
    let eventId = null;

    if (process.env.REDIS_URL) {
      eventId = await redis.get(`eventcode:${eventCode}`);
    }

    if (!eventId) {
      for (const id in events) {
        if (events[id]?.code === eventCode) {
          eventId = id;
          break;
        }
      }
    }

    if (!eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (process.env.REDIS_URL) {
      await redis.hset(`event:${eventId}:meta`, {
        momentOpen: "true",
      });
    }

    if (events[eventId]) {
      events[eventId].momentOpen = true;
    }

    return res.json({
      success: true,
      eventCode,
      eventId,
      momentOpen: true,
    });
  } catch (err) {
    console.error("Moment open failed:", err.message);
    res.status(500).json({ error: "Failed to open moment" });
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

if (process.env.REDIS_URL) {
  await redis.incr(`event:${eventId}:rawScans`);

  const fpKey = `event:${eventId}:fp:${fingerprint}`;
  const isNew = await redis.set(fpKey, "1", "NX", "EX", 86400);

  if (isNew) {
    await redis.incr(`event:${eventId}:uniqueScans`);
  }
} else if (meta) {
  meta.rawScans = Number(meta.rawScans || 0) + 1;
  meta._fingerprints = meta._fingerprints || {};

  if (!meta._fingerprints[fingerprint]) {
    meta._fingerprints[fingerprint] = true;
    meta.uniqueScans = Number(meta.uniqueScans || 0) + 1;
  }
}

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

if (process.env.REDIS_URL) {
  await redis.incr(`event:${eventId}:innerCircleJoinCount`);
} else if (meta) {
  meta.innerCircleJoinCount = Number(meta.innerCircleJoinCount || 0) + 1;
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
const tier = req.body?.tier || "general";
let reward = getRewardForTier(rewards[eventId], tier);

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

const tier = reward.tier || "general";

rewards[eventId] = {
  ...(rewards[eventId] || {}),
  [tier]: reward,
};
if (process.env.REDIS_URL) {
await redis.set(
  `reward:${eventId}:json`,
  JSON.stringify(rewards[eventId])
);
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
const tier = req.query.tier || "general";

if (rewards[eventId]) {
  return res.json(
    getRewardForTier(rewards[eventId], tier)
  );
}

let cachedReward = null;

if (process.env.REDIS_URL) {
  cachedReward = await redis.get(`reward:${eventId}:json`);
}

if (cachedReward) {
  const parsed = JSON.parse(cachedReward);
  rewards[eventId] = parsed;

  return res.json(
    getRewardForTier(parsed, tier)
  );
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
  artistLogo: meta.artistLogo || "",
  startAt: meta.startAt,
  unlockAt: meta.unlockAt,
  endAt: meta.endAt,
  maxClaims: Number(meta.maxClaims || 0),
  status: meta.status,
  screenVideoUrl: meta.screenVideoUrl || "",
  screenVideoUrl: meta.screenVideoUrl || "",
};
        }
      }
    }

    if (!event || !eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

    const rawScans = Number(
      process.env.REDIS_URL
        ? await redis.get(`event:${eventId}:rawScans`) || 0
        : event.rawScans || 0
    );

    const uniqueScans = Number(
      process.env.REDIS_URL
        ? await redis.get(`event:${eventId}:uniqueScans`) || 0
        : event.uniqueScans || 0
    );

    const joins = Number(
      process.env.REDIS_URL
        ? await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0
        : event.innerCircleJoinCount || 0
    );
const audienceSize = Number(event.audienceSize || 0);
    const conversionRate =
      audienceSize > 0 ? Number(((uniqueScans / audienceSize) * 100).toFixed(1)) : 0;

let innerCircle = [];

if (process.env.REDIS_URL) {
  const storedPhones = await redis.lrange(`event:${eventId}:phones`, 0, -1);
  innerCircle = storedPhones
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
} else {
  innerCircle = event.innerCircle || [];
}

return res.json({
  event: {
    id: event.id,
    eventCode: event.code,
    artistName: event.name || "Artist / Event Name",
    venue: event.venue || "Venue Name",
    date: event.startAt ? event.startAt.slice(0, 10) : "",
  },
  metrics: {
    scans: rawScans,
    uniqueScans,
    joins,
    conversionRate,
  },
  innerCircle,
});
  } catch (err) {
    console.error("Get report failed:", err.message);
    res.status(500).json({ error: "Failed to get report" });
  }
});
app.post("/inner-circle", async (req, res) => {
  try {
    const { eventCode } = req.body || {};

    if (!eventCode) {
      return res.status(400).json({ error: "eventCode is required" });
    }

    let eventId = null;
    let event = null;

    for (const id in events) {
      if (events[id]?.code === eventCode) {
        eventId = id;
        event = events[id];
        break;
      }
    }

    if (!eventId && process.env.REDIS_URL) {
      const resolvedId = await redis.get(`eventcode:${eventCode}`);
      if (resolvedId) {
        eventId = resolvedId;

        const meta = await redis.hgetall(`event:${eventId}:meta`);
        if (meta && meta.id) {
          event = {
            id: meta.id,
            code: meta.code,
            name: meta.name,
            artistLogo: meta.artistLogo || "",
            startAt: meta.startAt,
            unlockAt: meta.unlockAt,
            endAt: meta.endAt,
            maxClaims: Number(meta.maxClaims || 0),
            status: meta.status,
            screenVideoUrl: meta.screenVideoUrl || "",
            innerCircleJoinCount: Number(meta.innerCircleJoinCount || 0),
          };
        }
      }
    }

    if (!event || !eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

const phone = req.body.phone || "";

let joins = 0;

if (process.env.REDIS_URL) {
  if (phone) {
    const added = await redis.sadd(`event:${eventId}:uniquePhones`, phone);
    if (added === 1) {
      joins = await redis.incr(`event:${eventId}:innerCircleJoinCount`);
    } else {
      joins = Number(await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0);
    }
  } else {
    joins = Number(await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0);
  }
} else {
  // fallback uten redis
  event._uniquePhones = event._uniquePhones || new Set();

  if (phone && !event._uniquePhones.has(phone)) {
    event._uniquePhones.add(phone);
    event.innerCircleJoinCount = Number(event.innerCircleJoinCount || 0) + 1;
  }

  joins = event.innerCircleJoinCount || 0;
}

if (phone && process.env.REDIS_URL) {
  const entry = {
    type: "web_join",
    timestamp: new Date().toISOString(),
    eventCode,
    phone,
    source: "web",
    scanId: "",
  };

  await redis.rpush(`event:${eventId}:phones`, JSON.stringify(entry));
}
    return res.json({
      success: true,
      eventCode,
      eventId,
      innerCircleJoinCount: Number(joins || 0),
    });
  } catch (err) {
    console.error("InnerCircle increment failed:", err.message);
    res.status(500).json({ error: "Failed to increment InnerCircle count" });
  }
});
app.post("/sms-inbound", async (req, res) => {
  try {
    const phone = req.body.From || req.body.from || req.body.phone || "";
    const message = req.body.Body || req.body.body || "";

    const match = message.match(/CT-\d+/i);
    const eventCode = match ? match[0].toUpperCase() : "";

    if (!phone || !eventCode) {
      return res.status(400).json({ error: "phone and eventCode are required" });
    }

    let eventId = null;

    if (process.env.REDIS_URL) {
      eventId = await redis.get(`eventcode:${eventCode}`);
    }

    if (!eventId) {
      for (const id in events) {
        if (events[id]?.code === eventCode) {
          eventId = id;
          break;
        }
      }
    }

    if (!eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

    const entry = {
      type: "sms_join",
      timestamp: new Date().toISOString(),
      eventCode,
      phone,
      source: "sms",
      scanId: "",
    };

    if (process.env.REDIS_URL) {
      await redis.rpush(`event:${eventId}:phones`, JSON.stringify(entry));
    }

    return res.json({ success: true, entry });
  } catch (err) {
    console.error("SMS inbound failed:", err.message);
    res.status(500).json({ error: "Failed to store SMS join" });
  }
});
app.post("/scan", async (req, res) => {
  try {
    const { eventCode, scanId } = req.body || {};

    if (!eventCode) {
      return res.status(400).json({ error: "eventCode is required" });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    if (process.env.REDIS_URL) {
      const rateKey = `ratelimit:scan:${ip}`;
      const hits = await redis.incr(rateKey);

      if (hits === 1) {
        await redis.expire(rateKey, 60);
      }

      if (hits > 30) {
        return res.status(429).json({
          error: "Too many scan attempts. Please try again shortly.",
        });
      }
    }
    let eventId = null;
    let event = null;

    for (const id in events) {
      if (events[id]?.code === eventCode) {
        eventId = id;
        event = events[id];
        break;
      }
    }

    if (!eventId && process.env.REDIS_URL) {
      const resolvedId = await redis.get(`eventcode:${eventCode}`);
      if (resolvedId) {
        eventId = resolvedId;
        const meta = await redis.hgetall(`event:${eventId}:meta`);
        if (meta && meta.id) event = meta;
      }
    }

    if (!event || !eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

let rawScans = 0;
let uniqueScans = 0;
let scanRank = null;
let tier = "standard";

if (process.env.REDIS_URL) {
  rawScans = await redis.incr(`event:${eventId}:rawScans`);

  if (scanId) {
    const isNewScan = await redis.sadd(`event:${eventId}:uniqueScanIds`, scanId);
    uniqueScans = await redis.scard(`event:${eventId}:uniqueScanIds`);
    await redis.set(`event:${eventId}:uniqueScans`, uniqueScans);

    if (isNewScan === 1) {
      scanRank = await redis.incr(`event:${eventId}:scanRankCounter`);
      await redis.set(`event:${eventId}:scanRank:${scanId}`, scanRank);
    } else {
      scanRank = Number(await redis.get(`event:${eventId}:scanRank:${scanId}`) || uniqueScans);
    }
  } else {
    uniqueScans = Number(await redis.get(`event:${eventId}:uniqueScans`) || 0);
  }
} else {
  if (!event.scanRanks) event.scanRanks = {};
  if (!event.scanRankCounter) event.scanRankCounter = 0;

  event.rawScans = Number(event.rawScans || 0) + 1;
  rawScans = event.rawScans;

  if (scanId) {
    if (!event.scanRanks[scanId]) {
      event.scanRankCounter += 1;
      event.scanRanks[scanId] = event.scanRankCounter;
    }

    scanRank = event.scanRanks[scanId];
    uniqueScans = Object.keys(event.scanRanks).length;
    event.uniqueScans = uniqueScans;
  } else {
    event.uniqueScans = Number(event.uniqueScans || 0) + 1;
    uniqueScans = event.uniqueScans;
  }
}

const audienceSize = Number(event.audienceSize || event.maxClaims || 1000);
const goldLimit = Math.max(1, Math.round(audienceSize * 0.01));
const silverLimit = Math.max(goldLimit + 1, Math.round(audienceSize * 0.05));

if (scanRank && scanRank <= goldLimit) {
  tier = "gold";
} else if (scanRank && scanRank <= silverLimit) {
  tier = "silver";
}

return res.json({
  success: true,
  eventCode,
  eventId,
  rawScans: Number(rawScans || 0),
  uniqueScans: Number(uniqueScans || 0),
  scanRank,
  tier,
  tierLimits: {
    audienceSize,
    goldLimit,
    silverLimit,
  },
});
  } catch (err) {
    console.error("Scan register failed:", err.message);
    res.status(500).json({ error: "Failed to register scan" });
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
const lockKey = `event:${eventId}:video:lock`;

const isLocked = process.env.REDIS_URL
  ? await redis.get(lockKey)
  : false;

if (isLocked) {
  return res.json({
    ok: true,
    message: "Video already generating or ready",
    videoUrl: `/screen-video/${eventCode}`,
  });
}

if (process.env.REDIS_URL) {
  await redis.set(lockKey, "1", "EX", 30);
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
const incomingBadgeConfig = req.body.badgeConfig;

const badgeConfig = incomingBadgeConfig
  ? incomingBadgeConfig
  : event?.badgeConfig
    ? typeof event.badgeConfig === "string"
      ? JSON.parse(event.badgeConfig)
      : event.badgeConfig
    : { template: "americana" };

    const badgeMap = {
      americana: "americana.png",
      rock: "rock.png",
      blues: "blues.png",
      hiphop: "rap.png",
      folk: "folk:acoustic.png",
      punk: "punk:grunge.png",
      pop: "pop.png",
      heavymetal: "heavymetal.png",
    };
    const badgeFile = badgeMap[badgeConfig.template] || "americana.png";

    const result = await runScreenVideoGenerator({
      eventCode,
      lang,
      artistName: finalArtistName,
      venue: finalVenue,
      eventDate: finalEventDate,
      badgeFile,
    });

    if (eventId && redis) {
      await redis.hset(`event:${eventId}:meta`, "screenVideoUrl", result.videoUrl);
      await redis.hset(`event:${eventId}:meta`, "badgeConfig", JSON.stringify(badgeConfig));
      if (process.env.REDIS_URL) {
  await redis.del(lockKey);
}
    }

    if (eventId && events[eventId]) {
if (events[eventId]) {
  events[eventId].screenVideoUrl = result.videoUrl;
}
    }

    return res.json({
  ok: true,
  eventCode: result.eventCode,
  videoUrl: result.videoUrl,
  outputPath: result.outputPath,
  stdout: result.stdout,
  fileExists: fs.existsSync(result.outputPath),
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