require("dotenv").config();

const REDIS_ENABLED = !!process.env.REDIS_URL;
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const redis = require("./redis");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { testDbConnection } = require("./db");
const app = express();

testDbConnection().catch((error) => {
  console.error("POSTGRES STARTUP CHECK FAILED:", error.message);
});

function normalizeRewardDelivery(input = {}) {
  return {
    company: String(input.company || "").trim(),
    responsiblePerson: String(input.responsiblePerson || "").trim(),
    address1: String(input.address1 || "").trim(),
    address2: String(input.address2 || "").trim(),
    postalCode: String(input.postalCode || "").trim(),
    country: String(input.country || "").trim(),
    phone: String(input.phone || "").trim(),
    email: String(input.email || "").trim(),
  };
}

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"]
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

function normalizeBenefitInventory(input = {}) {
  const goldTotal = Math.max(0, Number(input.goldTotal || input.gold || 0));
  const silverTotal = Math.max(0, Number(input.silverTotal || input.silver || 0));

  return {
    mode: "progressive_scarcity",
    goldTotal,
    silverTotal,
    standardUnlimited: true,
    campaignStart: String(input.campaignStart || "").trim(),
    campaignEnd: String(input.campaignEnd || "").trim(),
  };
}

function generateDashboardAccessKey() {
  return `KP-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// CREATE EVENT
app.post("/event", async (req, res) => {
  try {
const {
  vertical,
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
  status,
  benefitInventory
} = req.body;

const normalizedVertical = String(vertical || "codetone").trim().toLowerCase();
const normalizedBenefitInventory = normalizeBenefitInventory(benefitInventory || {});
const dashboardAccessKey = String(req.body.dashboardAccessKey || generateDashboardAccessKey()).trim();

    if (!name || !startAt || !unlockAt || !endAt) {
      return res.status(400).json({
        error: "name, startAt, unlockAt and endAt are required",
      });
    }

    const id = uuidv4();

const event = {
  id,
  vertical: normalizedVertical,
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
  benefitInventory: normalizedBenefitInventory,
  dashboardAccessKey,
  momentOpen: false,
};
    events[id] = event;

if (process.env.REDIS_URL) {
await redis.hset(`event:${id}:meta`, {
  id,
  vertical: normalizedVertical,
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
  benefitInventory: JSON.stringify(normalizedBenefitInventory),
  dashboardAccessKey,
  momentOpen: "false",
});

  await redis.set(`eventcode:${code || id}`, id);
  await redis.set(`eventcode:${normalizedVertical}:${code || id}`, id);
  await redis.set(`event:${id}:claims`, "0");
}
    try {
      await sendSentInnerCircleMessage(
        "+4794433450",
        `${event.vertical || "codenxt"} ${event.code}`
      );
      console.log("Event notification SMS sent", {
        to: "+4794433450",
        vertical: event.vertical || "codenxt",
        eventCode: event.code,
      });
    } catch (smsErr) {
      console.error("Event notification SMS failed:", smsErr.message);
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
  const vertical = String(req.query?.vertical || "codetone").trim().toLowerCase();
  let resolvedId = await redis.get(`eventcode:${vertical}:${eventId}`);
  if (!resolvedId) {
    resolvedId = await redis.get(`eventcode:${eventId}`);
  }
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
if (meta && meta.benefitInventory) {
  try {
    meta.benefitInventory = JSON.parse(meta.benefitInventory);
  } catch {
    meta.benefitInventory = {
      mode: "progressive_scarcity",
      goldTotal: 0,
      silverTotal: 0,
      standardUnlimited: true,
    };
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
  benefitInventory: meta?.benefitInventory || null,
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
const shouldClearReward =
  reward.clear === true ||
  reward.status === "empty" ||
  (!reward.url && !reward.fileUrl && !reward.fileName && !reward.content);

rewards[eventId] = {
  ...(rewards[eventId] || {}),
};

if (shouldClearReward) {
  delete rewards[eventId][tier];
} else {
  rewards[eventId][tier] = reward;
}

if (process.env.REDIS_URL) {
  await redis.set(
    `reward:${eventId}:json`,
    JSON.stringify(rewards[eventId])
  );
}

    res.json({ success: true, cleared: shouldClearReward, tier });
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
app.get("/report/:eventCode", requireCodePerksAdmin, async (req, res) => {
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
        const vertical = String(req.query?.vertical || "codetone").trim().toLowerCase();
        let resolvedId = await redis.get(`eventcode:${vertical}:${eventCode}`);
        if (!resolvedId) {
          resolvedId = await redis.get(`eventcode:${eventCode}`);
        }
      if (resolvedId) {
        eventId = resolvedId;

        meta = await redis.hgetall(`event:${eventId}:meta`);
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

let ownershipCertificates = [];

if (process.env.REDIS_URL) {
  const storedOwnership =
    await redis.lrange(`event:${eventId}:ownership`, 0, -1);

  ownershipCertificates = storedOwnership
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

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
    ownershipCertificates: ownershipCertificates.length,
    conversionRate,
  },
  innerCircle,
  ownershipCertificates,
});
  } catch (err) {
    console.error("Get report failed:", err.message);
    res.status(500).json({ error: "Failed to get report" });
  }
});

app.get("/verify/:certificateId", async (req, res) => {
  try {
    const certificateId = String(req.params.certificateId || "").trim();

    const match = certificateId.match(/^CP-DOC-(.+)-(\d{6})$/);
    if (!match) {
      return res.status(400).send("Invalid certificate format");
    }

    const eventCode = match[1];
    let eventId = null;
    let event = null;
    let meta = null;

    if (process.env.REDIS_URL) {
      eventId =
        await redis.get(`eventcode:codeperks:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (eventId) {
        const meta = await redis.hgetall(`event:${eventId}:meta`);
        if (meta && meta.benefitInventory && typeof meta.benefitInventory === "string") {
          try {
            meta.benefitInventory = JSON.parse(meta.benefitInventory);
          } catch {
            meta.benefitInventory = null;
          }
        }

        if (meta && meta.id) {
          event = {
            id: meta.id,
            code: meta.code,
            name: meta.name || meta.pageName || "codePerks campaign",
            startAt: meta.startAt || "",
            vertical: meta.vertical || "codeperks",
          };
        }
      }
    }

    if (!eventId) {
      event = Object.values(events).find((item) => item.code === eventCode);
      eventId = event?.id || null;
    }

    if (!eventId) {
      return res.status(404).send("Certificate not found");
    }

    let ownershipCertificates = [];

    if (process.env.REDIS_URL) {
      const storedOwnership = await redis.lrange(`event:${eventId}:ownership`, 0, -1);
      ownershipCertificates = storedOwnership
        .map((item) => {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    const certificate = ownershipCertificates.find(
      (item) => item.certificateId === certificateId
    );

    if (!certificate) {
      return res.status(404).send("Certificate not found");
    }

    const phone = String(certificate.phone || "");
    const maskedPhone = phone.length > 4
      ? `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`
      : "";

    const payload = {
      valid: true,
      certificateId: certificate.certificateId,
      status: certificate.status || "active",
      eventCode: certificate.eventCode,
      campaignName: event?.name || certificate.campaignName || "codePerks campaign",
      tier: certificate.tier || "general",
      issuedAt: certificate.issuedAt,
      issuedBy: certificate.issuedBy || "codePerks by codeNXT",
      owner: maskedPhone,
      verification: "server-verified",
    };

    if (req.query.format === "json" || String(req.headers.accept || "").includes("application/json")) {
      return res.json(payload);
    }

    const esc = (value) => String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

    return res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Verified Member Benefit — codePerks</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 28px;
    background:
      radial-gradient(circle at 50% 0%, rgba(226,196,122,.16), transparent 34rem),
      linear-gradient(180deg,#050505 0%,#0b0906 55%,#050505 100%);
    color: #e2c47a;
    font-family: Arial, Helvetica, sans-serif;
  }
  .card {
    width: min(680px, 100%);
    border: 1px solid rgba(226,196,122,.34);
    border-radius: 28px;
    padding: 30px;
    text-align: center;
    background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.018));
    box-shadow: 0 28px 70px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,255,255,.07);
  }
  img {
    width: 220px;
    max-width: 72%;
    margin-bottom: 20px;
    filter: drop-shadow(0 0 18px rgba(226,196,122,.18));
  }
  .verified {
    display: inline-block;
    margin: 0 auto 18px;
    padding: 8px 14px;
    border-radius: 999px;
    background: linear-gradient(135deg,#f3e4bf 0%,#d8bd78 52%,#b88d43 100%);
    color: #2f1f13;
    font-weight: 900;
    font-size: 12px;
    letter-spacing: .14em;
  }
  h1 {
    margin: 0 0 14px;
    font-size: clamp(28px, 7vw, 48px);
    line-height: 1.05;
  }
  .id {
    margin: 18px auto;
    padding: 14px;
    border-radius: 16px;
    background: rgba(0,0,0,.28);
    border: 1px solid rgba(226,196,122,.24);
    font-weight: 900;
    word-break: break-word;
  }
  .grid {
    display: grid;
    gap: 10px;
    margin-top: 20px;
    text-align: left;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid rgba(226,196,122,.16);
    padding: 10px 0;
  }
  .label {
    color: rgba(243,228,191,.72);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .value {
    color: #f3e4bf;
    font-weight: 800;
    text-align: right;
  }
  .footer {
    margin-top: 24px;
    font-size: 12px;
    color: rgba(243,228,191,.70);
  }
</style>
</head>
<body>
  <main class="card">
    <img src="https://codeperks.codenxt.global/codePerks-logo.png?v=3" alt="codePerks" />
    <div class="verified">SERVER VERIFIED</div>
    <h1>Verified Member Benefit</h1>
    <div class="id">${esc(payload.certificateId)}</div>

    <div class="grid">
      <div class="row"><div class="label">Status</div><div class="value">${esc(payload.status)}</div></div>
      <div class="row"><div class="label">Campaign</div><div class="value">${esc(payload.campaignName)}</div></div>
      <div class="row"><div class="label">Event code</div><div class="value">${esc(payload.eventCode)}</div></div>
      <div class="row"><div class="label">Tier</div><div class="value">${esc(payload.tier)}</div></div>
      <div class="row"><div class="label">Owner</div><div class="value">${esc(payload.owner)}</div></div>
      <div class="row"><div class="label">Issued</div><div class="value">${esc(String(payload.issuedAt || "").slice(0,10))}</div></div>
      <div class="row"><div class="label">Issued by</div><div class="value">${esc(payload.issuedBy)}</div></div>
    </div>

    <div class="footer">
      This certificate is verified directly against the codePerks ownership registry.
    </div>
  </main>
</body>
</html>`);
  } catch (err) {
    console.error("Verify certificate failed:", err.message);
    return res.status(500).send("Verification failed");
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
    let meta = null;

    for (const id in events) {
      if (events[id]?.code === eventCode) {
        eventId = id;
        event = events[id];
        break;
      }
    }

    if (!eventId && process.env.REDIS_URL) {
      const vertical = String(req.body?.vertical || req.query?.vertical || "codetone").trim().toLowerCase();
      let resolvedId = await redis.get(`eventcode:${vertical}:${eventCode}`);
      if (!resolvedId) {
        resolvedId = await redis.get(`eventcode:${eventCode}`);
      }
      if (resolvedId) {
        eventId = resolvedId;

        meta = await redis.hgetall(`event:${eventId}:meta`);
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
let shouldSendWelcomeMessage = false;
let ownershipCertificate = null;

if (process.env.REDIS_URL) {
  if (phone) {
    const added = await redis.sadd(`event:${eventId}:uniquePhones`, phone);

    if (added === 1) {
      joins = await redis.incr(`event:${eventId}:innerCircleJoinCount`);
      shouldSendWelcomeMessage = true;

      const certificateId =
        `CP-DOC-${eventCode}-${String(joins).padStart(6, "0")}`;

      const benefitAssignment = await assignCodePerksBenefitTier(eventId, meta || {});

      ownershipCertificate = {
        certificateId,
        phone,
        eventCode,
        eventId,
        tier: benefitAssignment.tier,
        benefitTier: benefitAssignment.tier,
        benefitInventory: benefitAssignment.inventoryStatus,
        status: "active",
        issuedAt: new Date().toISOString(),
        issuedBy: "codePerks by codeNXT",
        source: "QR Scan",
      };

      await redis.rpush(
        `event:${eventId}:ownership`,
        JSON.stringify(ownershipCertificate)
      );
    } else {
      joins = Number(await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0);

      const storedOwnership = await redis.lrange(`event:${eventId}:ownership`, 0, -1);
      ownershipCertificate = storedOwnership
        .map((item) => {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((item) => item.phone === phone) || null;
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
    shouldSendWelcomeMessage = true;
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

if (phone) {
  scheduleInnerCircleFollowUp(phone, eventCode);
}
    return res.json({
      success: true,
      eventCode,
      eventId,
      innerCircleJoinCount: Number(joins || 0),
      ownershipCertificate,
    });
  } catch (err) {
    console.error("InnerCircle increment failed:", err.message);
    res.status(500).json({ error: "Failed to increment InnerCircle count" });
  }
});

function normalizePhoneForSent(phone) {
  const raw = String(phone || "").trim().replace(/\s+/g, "");

  if (!raw) return "";

  if (raw.startsWith("+")) return raw;

  if (raw.startsWith("00")) {
    return `+${raw.slice(2)}`;
  }

  if (raw.startsWith("0")) {
    return `+66${raw.slice(1)}`;
  }

  return raw;
}

function scheduleInnerCircleFollowUp(phone, eventCode) {
  const delayMs = 15 * 60 * 1000;

  setTimeout(async () => {
    try {
      if (!process.env.SENT_INNERCIRCLE_TEMPLATE_ID) {
        console.log("Skipped InnerCircle follow-up: SENT_INNERCIRCLE_TEMPLATE_ID is missing");
        return;
      }

      const normalizedPhone = normalizePhoneForSent(phone);

      await sendSentTemplateMessage(
        normalizedPhone,
        process.env.SENT_INNERCIRCLE_TEMPLATE_ID,
        {}
      );
      console.log("InnerCircle follow-up sent", { phone, normalizedPhone, eventCode });
    } catch (err) {
      console.error("InnerCircle follow-up failed:", err.message);
    }
  }, delayMs);
}

async function sendSentTemplateMessage(to, templateId, parameters = {}) {
  if (!process.env.SENT_API_KEY) {
    throw new Error("SENT_API_KEY is missing");
  }

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.SENT_API_KEY,
    },
    body: JSON.stringify({
      channels: ["sms"],
      to: [to],
      template: {
        id: templateId,
        parameters,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Sent failed ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendSentInnerCircleMessage(to, code) {
  if (!process.env.SENT_API_KEY) {
    throw new Error("SENT_API_KEY is missing");
  }

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.SENT_API_KEY,
    },
    body: JSON.stringify({
channels: ["sms"],
      to: [to],
      template: {
        id: "f6acfd25-c0b3-4047-bbf9-030bf1fc3edb",
        parameters: {
          var_1: code || "codeTone",
        },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Sent failed ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

app.post("/test-sent-message", async (req, res) => {
  try {
    const to = req.body.to || "";
    const code = req.body.code || "codeTone";

    if (!to) {
      return res.status(400).json({ error: "to is required" });
    }

    const sent = await sendSentInnerCircleMessage(to, code);

    return res.json({
      ok: true,
      to,
      sent,
    });
  } catch (err) {
    console.error("Sent test message failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});


app.post("/send-innercircle-sms", async (req, res) => {
  try {
    const eventCode = String(req.body.eventCode || "").trim().toUpperCase();
    const code = String(req.body.code || eventCode || "codeTone").trim();

    if (!eventCode) {
      return res.status(400).json({
        ok: false,
        error: "eventCode is required",
      });
    }

    let event = Object.values(events).find((item) => item.code === eventCode);
    let eventId = event ? event.id : null;

    if (!eventId && process.env.REDIS_URL) {
      eventId = await redis.get(`eventcode:${eventCode}`);
    }

    if (!eventId) {
      return res.status(404).json({
        ok: false,
        error: "Event not found",
      });
    }

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
      innerCircle = event?.innerCircle || [];
    }

    const phones = [
      ...new Set(
        innerCircle
          .map((entry) => String(entry.phone || "").trim())
          .filter(Boolean)
      ),
    ];

    if (!phones.length) {
      return res.json({
        ok: true,
        eventCode,
        sentCount: 0,
        failedCount: 0,
        message: "No phone numbers found",
        results: [],
      });
    }

    const results = [];

    for (const phone of phones) {
      try {
        const sent = await sendSentInnerCircleMessage(phone, code);
        results.push({
          phone,
          ok: true,
          sent,
        });
      } catch (err) {
        results.push({
          phone,
          ok: false,
          error: err.message,
        });
      }
    }

    const sentCount = results.filter((item) => item.ok).length;
    const failedCount = results.length - sentCount;

    return res.json({
      ok: failedCount === 0,
      eventCode,
      total: results.length,
      sentCount,
      failedCount,
      results,
    });
  } catch (err) {
    console.error("Send InnerCircle SMS failed:", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
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
      const vertical = String(req.body?.vertical || req.query?.vertical || "codetone").trim().toLowerCase();
      let resolvedId = await redis.get(`eventcode:${vertical}:${eventCode}`);
      if (!resolvedId) {
        resolvedId = await redis.get(`eventcode:${eventCode}`);
      }
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
let tier = "general";

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


function getClientIp(req) {
  return String(
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  ).split(",")[0].trim();
}

function createRedisRateLimiter({ namespace, limit = 30, windowSeconds = 60 }) {
  return async function redisRateLimiter(req, res, next) {
    try {
      if (!process.env.REDIS_URL) return next();

      const ip = getClientIp(req);
      const key = `ratelimit:${namespace}:${ip}`;
      const hits = await redis.incr(key);

      if (hits === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (hits > limit) {
        return res.status(429).json({
          ok: false,
          error: "Too many requests. Please try again shortly.",
          rateLimited: true,
        });
      }

      return next();
    } catch (error) {
      console.warn("Rate limiter failed open:", error.message);
      return next();
    }
  };
}

const limitRewardClaim = createRedisRateLimiter({
  namespace: "reward-claim",
  limit: 5,
  windowSeconds: 60,
});

const limitCertificateValidate = createRedisRateLimiter({
  namespace: "certificate-validate",
  limit: 30,
  windowSeconds: 60,
});

const limitClaimStatus = createRedisRateLimiter({
  namespace: "claim-status",
  limit: 20,
  windowSeconds: 60,
});

const limitRewardClaimsRead = createRedisRateLimiter({
  namespace: "reward-claims-read",
  limit: 30,
  windowSeconds: 60,
});

async function requireCodePerksAdmin(req, res, next) {
  const configuredKey = process.env.CODEPERKS_ADMIN_KEY;
  const providedKey = String(req.headers["x-admin-key"] || "").trim();

  if (!configuredKey && !providedKey) {
    return next();
  }

  if (configuredKey && providedKey && providedKey === configuredKey) {
    return next();
  }

  const eventCode = String(req.params?.eventCode || req.query?.eventCode || req.body?.eventCode || "").trim();
  const vertical = String(req.query?.vertical || req.body?.vertical || "codeperks").trim().toLowerCase();

  if (providedKey && eventCode && process.env.REDIS_URL) {
    try {
      const eventId =
        await redis.get(`eventcode:${vertical}:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (eventId) {
        const meta = await redis.hgetall(`event:${eventId}:meta`);
        const campaignKey = String(meta?.dashboardAccessKey || "").trim();

        if (campaignKey && providedKey === campaignKey) {
          return next();
        }
      }
    } catch (error) {
      console.warn("Campaign dashboard key check failed:", error.message);
    }
  }

  return res.status(401).json({
    ok: false,
    error: "Unauthorized",
  });
}



function parseBenefitInventoryFromMeta(meta = {}) {
  let benefitInventory = meta.benefitInventory || null;

  if (typeof benefitInventory === "string") {
    try {
      benefitInventory = JSON.parse(benefitInventory);
    } catch {
      benefitInventory = null;
    }
  }

  return {
    mode: "progressive_scarcity",
    goldTotal: Math.max(0, Number(benefitInventory?.goldTotal || 0)),
    silverTotal: Math.max(0, Number(benefitInventory?.silverTotal || 0)),
    standardUnlimited: true,
    campaignStart: String(benefitInventory?.campaignStart || meta.startAt || "").trim(),
    campaignEnd: String(benefitInventory?.campaignEnd || meta.endAt || "").trim(),
  };
}

async function getCodePerksBenefitInventoryStatus(eventId, meta = {}) {
  const inventory = parseBenefitInventoryFromMeta(meta);

  const goldAssigned = process.env.REDIS_URL
    ? Number(await redis.get(`event:${eventId}:benefit:goldAssigned`) || 0)
    : 0;

  const silverAssigned = process.env.REDIS_URL
    ? Number(await redis.get(`event:${eventId}:benefit:silverAssigned`) || 0)
    : 0;

  const standardAssigned = process.env.REDIS_URL
    ? Number(await redis.get(`event:${eventId}:benefit:standardAssigned`) || 0)
    : 0;

  return {
    ...inventory,
    goldAssigned,
    silverAssigned,
    standardAssigned,
    goldRemaining: Math.max(0, inventory.goldTotal - goldAssigned),
    silverRemaining: Math.max(0, inventory.silverTotal - silverAssigned),
  };
}

async function assignCodePerksBenefitTier(eventId, meta = {}) {
  let freshMeta = meta || {};

  if (process.env.REDIS_URL && eventId) {
    try {
      const redisMeta = await redis.hgetall(`event:${eventId}:meta`);
      if (redisMeta && redisMeta.id) {
        freshMeta = redisMeta;
      }
    } catch (error) {
      console.warn("Could not refresh benefit inventory meta:", error.message);
    }
  }

  const inventory = parseBenefitInventoryFromMeta(freshMeta);

  if (!process.env.REDIS_URL) {
    return {
      tier: "standard",
      inventoryStatus: {
        ...inventory,
        goldAssigned: 0,
        silverAssigned: 0,
        standardAssigned: 1,
        goldRemaining: inventory.goldTotal,
        silverRemaining: inventory.silverTotal,
      },
    };
  }

  if (inventory.goldTotal > 0) {
    const goldAssigned = await redis.incr(`event:${eventId}:benefit:goldAssigned`);

    if (goldAssigned <= inventory.goldTotal) {
      const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, freshMeta);
      return { tier: "gold", inventoryStatus };
    }

    await redis.decr(`event:${eventId}:benefit:goldAssigned`);
  }

  if (inventory.silverTotal > 0) {
    const silverAssigned = await redis.incr(`event:${eventId}:benefit:silverAssigned`);

    if (silverAssigned <= inventory.silverTotal) {
      const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, freshMeta);
      return { tier: "silver", inventoryStatus };
    }

    await redis.decr(`event:${eventId}:benefit:silverAssigned`);
  }

  await redis.incr(`event:${eventId}:benefit:standardAssigned`);
  const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, freshMeta);

  return { tier: "standard", inventoryStatus };
}


app.get("/benefit-inventory/:eventCode", limitCertificateValidate, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const vertical = String(req.query?.vertical || "codeperks").trim().toLowerCase();

    if (!eventCode) {
      return res.status(400).json({
        ok: false,
        error: "eventCode is required",
      });
    }

    if (!process.env.REDIS_URL) {
      return res.json({
        ok: false,
        error: "Redis unavailable",
      });
    }

    let eventId =
      await redis.get(`eventcode:${vertical}:${eventCode}`) ||
      await redis.get(`eventcode:${eventCode}`);

    if (!eventId) {
      return res.status(404).json({
        ok: false,
        error: "Event not found",
      });
    }

    const meta = await redis.hgetall(`event:${eventId}:meta`);
    const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, meta || {});

    return res.json({
      ok: true,
      eventCode,
      eventId,
      benefitInventory: inventoryStatus,
    });
  } catch (error) {
    console.error("benefit inventory error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not load benefit inventory",
    });
  }
});

app.get("/certificate/validate/:eventCode/:certificateId", limitCertificateValidate, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const certificateId = String(req.params.certificateId || "").trim();

    if (!eventCode || !certificateId) {
      return res.status(400).json({
        ok: false,
        valid: false,
        error: "Missing certificate validation fields",
      });
    }

    if (!process.env.REDIS_URL) {
      return res.json({
        ok: true,
        valid: false,
        status: "unverified",
        eventCode,
        certificateId,
        reason: "Redis unavailable",
      });
    }

    let eventId =
      await redis.get(`eventcode:codeperks:${eventCode}`) ||
      await redis.get(`eventcode:${eventCode}`);

    if (!eventId) {
      return res.json({
        ok: true,
        valid: false,
        status: "not_found",
        eventCode,
        certificateId,
        reason: "Event not found",
      });
    }

    const meta = await redis.hgetall(`event:${eventId}:meta`);
    const ownershipRaw = await redis.lrange(`event:${eventId}:ownership`, 0, -1);

    let certificate = null;

    for (const raw of ownershipRaw || []) {
      try {
        const parsed = JSON.parse(raw);
        const parsedCertificateId =
          parsed.certificateId ||
          parsed.ownershipCertificate?.certificateId ||
          parsed.id ||
          "";

        if (String(parsedCertificateId).trim() === certificateId) {
          certificate = parsed;
          break;
        }
      } catch {}
    }

    if (!certificate) {
      return res.json({
        ok: true,
        valid: false,
        status: "not_found",
        eventCode,
        certificateId,
        eventId,
        reason: "Certificate not found for this event",
      });
    }

    return res.json({
      ok: true,
      valid: true,
      status: "active",
      eventCode,
      certificateId,
      eventId,
      issuedAt: certificate.issuedAt || certificate.createdAt || "",
      event: {
        id: eventId,
        code: meta.code || eventCode,
        name: meta.name || meta.pageName || meta.releaseTitle || "",
      },
    });
  } catch (error) {
    console.error("certificate validation error", error);
    return res.status(500).json({
      ok: false,
      valid: false,
      error: "Could not validate certificate",
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT });
});


// codePerks reward claim registration
globalThis.__CODEPERKS_REWARD_CLAIMS = globalThis.__CODEPERKS_REWARD_CLAIMS || [];

function buildCodePerksRewardClaim(body = {}) {
  return {
    id: `RC-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type: body.type === "post" ? "post" : "email",
    status: "pending",
    eventCode: String(body.eventCode || "").trim(),
    certificateId: String(body.certificateId || "").trim(),
    claimant: {
      fullName: String(body.claimant?.fullName || "").trim(),
      address: String(body.claimant?.address || "").trim(),
      postalCode: String(body.claimant?.postalCode || "").trim(),
      country: String(body.claimant?.country || "").trim(),
      phone: String(body.claimant?.phone || "").trim(),
      email: String(body.claimant?.email || "").trim(),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "codePerks certificate",
  };
}

function validateCodePerksRewardClaim(claim) {
  return Boolean(
    claim.eventCode &&
    claim.certificateId &&
    claim.claimant.fullName &&
    claim.claimant.address &&
    claim.claimant.postalCode &&
    claim.claimant.country &&
    claim.claimant.phone &&
    claim.claimant.email
  );
}

app.post("/reward-claim", limitRewardClaim, async (req, res) => {
  try {
    const claim = buildCodePerksRewardClaim(req.body || {});

    if (!validateCodePerksRewardClaim(claim)) {
      return res.status(400).json({
        ok: false,
        error: "Missing required reward claim fields",
      });
    }

    if (process.env.REDIS_URL) {
      const duplicateKey = `codeperks:claim:certificate:${claim.certificateId}`;
      const eventClaimsKey = `codeperks:claims:event:${claim.eventCode}`;
      const claimKey = `codeperks:claim:${claim.id}`;

      const firstClaim = await redis.set(duplicateKey, claim.id, "NX");
      if (!firstClaim) {
        const existingClaimId = await redis.get(duplicateKey);
        const existingRaw = existingClaimId ? await redis.get(`codeperks:claim:${existingClaimId}`) : null;
        const existingClaim = existingRaw ? JSON.parse(existingRaw) : null;

        return res.status(409).json({
          ok: false,
          duplicate: true,
          error: "A claim has already been registered for this certificate.",
          claim: existingClaim,
        });
      }

      await redis.set(claimKey, JSON.stringify(claim));
      await redis.rpush(eventClaimsKey, claim.id);

      console.log("CODEPERKS_REWARD_CLAIM_REDIS", claim);

      return res.json({
        ok: true,
        claim,
      });
    }

    const duplicate = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).find(
      (existing) => existing.certificateId === claim.certificateId
    );

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        duplicate: true,
        error: "A claim has already been registered for this certificate.",
        claim: duplicate,
      });
    }

    globalThis.__CODEPERKS_REWARD_CLAIMS.push(claim);

    console.log("CODEPERKS_REWARD_CLAIM_MEMORY", claim);

    return res.json({
      ok: true,
      claim,
    });
  } catch (error) {
    console.error("reward-claim error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not register reward claim",
    });
  }
});


app.post("/reward-claim/:claimId/status", requireCodePerksAdmin, limitClaimStatus, async (req, res) => {
  try {
    const claimId = String(req.params.claimId || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();

    const allowed = new Set(["pending", "approved", "fulfilled", "rejected"]);

    if (!claimId || !allowed.has(status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid claim status update",
      });
    }

    if (process.env.REDIS_URL) {
      const claimKey = `codeperks:claim:${claimId}`;
      const raw = await redis.get(claimKey);

      if (!raw) {
        return res.status(404).json({
          ok: false,
          error: "Reward claim not found",
        });
      }

      const claim = JSON.parse(raw);
      claim.status = status;
      claim.updatedAt = new Date().toISOString();

      await redis.set(claimKey, JSON.stringify(claim));

      return res.json({
        ok: true,
        claim,
      });
    }

    const claim = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).find(
      (entry) => entry.id === claimId
    );

    if (!claim) {
      return res.status(404).json({
        ok: false,
        error: "Reward claim not found",
      });
    }

    claim.status = status;
    claim.updatedAt = new Date().toISOString();

    return res.json({
      ok: true,
      claim,
    });
  } catch (error) {
    console.error("reward-claim status error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not update reward claim status",
    });
  }
});

app.get("/reward-claims/:eventCode", requireCodePerksAdmin, limitRewardClaimsRead, async (req, res) => {
  const eventCode = String(req.params.eventCode || "").trim();

  try {
    if (process.env.REDIS_URL) {
      const eventClaimsKey = `codeperks:claims:event:${eventCode}`;
      const claimIds = await redis.lrange(eventClaimsKey, 0, -1);
      const claims = [];

      for (const claimId of claimIds) {
        const raw = await redis.get(`codeperks:claim:${claimId}`);
        if (raw) claims.push(JSON.parse(raw));
      }

      return res.json({
        ok: true,
        storage: "redis",
        eventCode,
        claims,
        count: claims.length,
      });
    }

    const claims = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).filter(
      (claim) => claim.eventCode === eventCode
    );

    return res.json({
      ok: true,
      storage: "memory",
      eventCode,
      claims,
      count: claims.length,
    });
  } catch (error) {
    console.error("reward-claims error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not load reward claims",
    });
  }
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