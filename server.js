const codeClipVertical = require("./verticals/codeclip");
const codePodVertical = require("./verticals/codepod");
const { processCodeClipOutboxBatch } = require("./verticals/codeclip/outbox-worker");
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
const database = require("./db");
const {
  testDbConnection,
  saveCampaign,
  getCampaignByCode,
  saveEventScan,
  saveEventRegistration,
  getEventRegistrations,
  getEventScanSummary,
  getCodePodReportRows,
  getEventRegistrationSummary,
  saveCodeDemoHandshakeReport,
  getCodeDemoHandshakeReports,
  saveCodeDemoException,
  updateCodeDemoExceptionStatus,
  getCodeDemoExceptions,
  getLatestCodeDemoExceptions,
  ensureCodePodGoldXtraRedemptionsTable,
  saveCodePodGoldXtraRedemption,
  saveCodeClipXtraRedemption,
  saveCodeClipInteraction,
  saveCodeClipRewardAssignments,
  withCodeClipCorePersistenceTransaction,
  saveCodeClipOutboxEvent,
  createCodeClipProviderDelivery,
  updateCodeClipProviderDeliveryState,
  claimCodeClipOutboxEvents,
  markCodeClipOutboxEventSucceeded,
  markCodeClipOutboxEventFailed,
  markCodeClipOutboxEventDeadLetter,
  getCodeClipInteractions,
  getCodeClipRewardAssignments,
  getCodeClipRewardAssignmentSummary,
  getCodeClipXtraRedemptionByToken,
  redeemCodeClipXtraRedemption,
  getCodePodGoldXtraRedemptionByToken,
  redeemCodePodGoldXtraRedemption
} = database;
const { sendEmail } = require("./mailer");
const QRCode = require("qrcode");
const app = express();

testDbConnection().catch((error) => {
  console.error("POSTGRES STARTUP CHECK FAILED:", error.message);
});

ensureCodePodGoldXtraRedemptionsTable().catch((error) => {
  console.error("CODEPOD GOLDXTRA TABLE INIT FAILED:", error.message);
});

database.ensureCodePodKeywordInteractionsTable().catch((error) => {
  console.error("CODEPOD KEYWORD INTERACTIONS TABLE INIT FAILED:", error.message);
});

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function startCodeClipOutboxWorker() {
  if (process.env.CODECLIP_OUTBOX_WORKER_ENABLED !== "1") return null;

  const intervalMs = parsePositiveInteger(process.env.CODECLIP_OUTBOX_WORKER_INTERVAL_MS, 30000);
  const limit = parsePositiveInteger(process.env.CODECLIP_OUTBOX_WORKER_LIMIT, 10);
  let isRunning = false;

  const runBatch = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const summary = await processCodeClipOutboxBatch({
        limit,
        claimCodeClipOutboxEvents,
        markCodeClipOutboxEventSucceeded,
        markCodeClipOutboxEventFailed,
        markCodeClipOutboxEventDeadLetter,
        saveCodeClipInteraction,
        saveCodeClipRewardAssignments,
        saveCodeClipXtraRedemption,
      });

      if (summary.claimed > 0 || summary.failed > 0) {
        console.log("codeClip outbox worker summary", summary);
      }
    } catch (error) {
      console.warn("codeClip outbox worker failed:", error.message);
    } finally {
      isRunning = false;
    }
  };

  const interval = setInterval(runBatch, intervalMs);
  console.log(`codeClip outbox worker enabled intervalMs=${intervalMs} limit=${limit}`);
  return interval;
}

function normalizeRewardDelivery(input = {}) {
  return {
    responsiblePerson: String(input.responsiblePerson || input.name || "").trim(),
    email: String(input.email || "").trim(),
  };
}

function normalizeBonusDetails(input = {}) {
  const normalizeTier = (tier = {}) => ({
    reward: String(tier.reward || tier.title || "").trim(),
    redemptionLocation: String(tier.redemptionLocation || tier.location || "").trim(),
    instructions: String(tier.instructions || "Vis tilsendt QR-kode").trim(),
    redemptionDeadline: String(tier.redemptionDeadline || "").trim(),
    redemptionDeadlineTime: String(tier.redemptionDeadlineTime || "23:59").trim(),
  });

  return {
    gold: normalizeTier(input.gold || {}),
    silver: normalizeTier(input.silver || {}),
    standard: normalizeTier(input.standard || input.general || {}),
  };
}

function normalizeCodePodPartnerReward(input = {}) {
  return codePodVertical.service.normalizeCodePodPartnerReward(input);
}

function parseCodePodPartnerReward(input = {}) {
  return codePodVertical.service.parseCodePodPartnerReward(input);
}

function normalizeCodePodDigitalSouvenir(input = {}) {
  return codePodVertical.service.normalizeCodePodDigitalSouvenir(input);
}

async function assignCodePodDigitalSouvenirTier(eventCode, scanId, digitalSouvenir, event = {}) {
  return codePodVertical.service.assignCodePodDigitalSouvenirTier(
    eventCode,
    scanId,
    digitalSouvenir,
    event,
    {
      redis,
      redisEnabled: Boolean(process.env.REDIS_URL),
    }
  );
}

async function createCodePodGoldXtraToken(payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = `GX-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
    const tokenKey = `codepod:partnerReward:token:${token}`;
    const stored = await redis.set(tokenKey, JSON.stringify({ ...payload, token }), "NX");
    if (stored) return token;
  }

  const token = `GX-${uuidv4().replace(/-/g, "").toUpperCase()}`;
  await redis.set(`codepod:partnerReward:token:${token}`, JSON.stringify({ ...payload, token }), "NX");
  return token;
}

async function assignCodePodGoldXtra(eventCode, scanId, partnerReward) {
  return codePodVertical.service.assignCodePodGoldXtra(eventCode, scanId, partnerReward, {
    redis,
    redisEnabled: Boolean(process.env.REDIS_URL),
    createGoldXtraToken: createCodePodGoldXtraToken,
  });
}

function buildCodePodGoldXtraValidationPayload(source = {}) {
  const reward = source.reward || {};
  const redeemedAt = source.redeemed_at || source.redeemedAt || null;
  const isRedeemed = Boolean(redeemedAt) || source.status === "redeemed";

  return {
    ok: true,
    vertical: "codepod",
    rewardType: "partner_reward",
    tier: "gold",
    displayTier: "GoldXtra",
    status: isRedeemed ? "redeemed" : "valid",
    redeemed: isRedeemed,
    redeemedAt,
    redeemedBy: source.redeemed_by || source.redeemedBy || "",
    alreadyRedeemedAttempts: Number(source.already_redeemed_attempts || source.alreadyRedeemedAttempts || 0),
    partnerReward: {
      title: reward.title || source.reward_title || source.rewardTitle || "",
      partnerName: reward.partnerName || source.partner_name || source.partnerName || "",
      product: reward.product || source.product || "",
      redemptionLocation: reward.redemptionLocation || source.redemption_location || source.redemptionLocation || "",
      redemptionDeadline: reward.redemptionDeadline || source.redemption_deadline || source.redemptionDeadline || "",
      redemptionInstructions: reward.redemptionInstructions || source.redemption_instructions || source.redemptionInstructions || "",
    },
  };
}

function normalizeVerticalName(value) {
  return String(value || "").trim().toLowerCase();
}

function eventMatchesVertical(event = {}, vertical = "") {
  const normalizedVertical = normalizeVerticalName(vertical);
  return !normalizedVertical || normalizeVerticalName(event.vertical) === normalizedVertical;
}

function normalizeActivationMethod(value) {
  const method = String(value || "").trim().toLowerCase();
  return ["keyword", "qr", "both"].includes(method) ? method : "keyword";
}

function normalizeActivationChannels(value) {
  if (Array.isArray(value)) {
    return value.map((channel) => String(channel || "").trim()).filter(Boolean);
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((channel) => String(channel || "").trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return raw.split(",").map((channel) => channel.trim()).filter(Boolean);
}

function findInMemoryEventByCode(eventCode, vertical = "") {
  const code = String(eventCode || "").trim();
  if (!code) return null;

  for (const id in events) {
    const event = events[id];
    if (event?.code === code && eventMatchesVertical(event, vertical)) {
      return { eventId: id, event };
    }
  }

  return null;
}

async function resolveEventReference(eventCode, { requestedVertical = "", explicitVertical = false } = {}) {
  const code = String(eventCode || "").trim();
  const vertical = normalizeVerticalName(requestedVertical);
  if (!code) return { eventId: null, event: null };

  const directEvent = events[code];
  if (directEvent && eventMatchesVertical(directEvent, explicitVertical ? vertical : "")) {
    return { eventId: code, event: directEvent };
  }

  const inMemoryMatch = findInMemoryEventByCode(code, explicitVertical ? vertical : "");
  if (inMemoryMatch) return inMemoryMatch;

  if (process.env.REDIS_URL) {
    let resolvedId = null;

    if (vertical) {
      resolvedId = await redis.get(`eventcode:${vertical}:${code}`);
    }

    if (!resolvedId && !explicitVertical) {
      resolvedId = await redis.get(`eventcode:${code}`);
    }

    if (resolvedId) {
      const meta = await redis.hgetall(`event:${resolvedId}:meta`);
      if (meta && meta.id && eventMatchesVertical(meta, explicitVertical ? vertical : "")) {
        return { eventId: resolvedId, event: meta };
      }
    }
  }

  return { eventId: null, event: null };
}

function isCodeToneEvent(event = {}) {
  return normalizeVerticalName(event.vertical) === "codetone";
}

async function resolveScreenVideoEvent(eventCode) {
  const resolved = await resolveEventReference(eventCode);

  if (!resolved.event) {
    return {
      ok: false,
      status: 404,
      body: {
        ok: false,
        error: "Event not found",
      },
    };
  }

  if (!isCodeToneEvent(resolved.event)) {
    return {
      ok: false,
      status: 403,
      body: {
        ok: false,
        error: "Screen Video is only available for codeTone events",
      },
    };
  }

  return {
    ok: true,
    eventId: resolved.eventId,
    event: resolved.event,
  };
}

async function resolveCodePodKeywordEvent(eventCode) {
  const resolved = await resolveEventReference(eventCode, {
    requestedVertical: "codepod",
    explicitVertical: true,
  });

  if (resolved.event && eventMatchesVertical(resolved.event, "codepod")) {
    return resolved;
  }

  if (getCampaignByCode) {
    const campaign = await getCampaignByCode(String(eventCode || "").trim());
    const rawEvent = campaign?.raw_event || null;
    const campaignVertical = normalizeVerticalName(campaign?.vertical || rawEvent?.vertical);

    if (campaign && campaignVertical === "codepod") {
      return {
        eventId: rawEvent?.id || campaign.id || null,
        event: rawEvent?.vertical
          ? rawEvent
          : { ...(rawEvent || campaign), vertical: "codepod" },
      };
    }
  }

  return { eventId: null, event: null };
}

async function refreshCodePodGoldXtraRedisToken(token, row) {
  if (!process.env.REDIS_URL || !token || !row) return;

  const tokenKey = `codepod:partnerReward:token:${token}`;

  try {
    const rawGoldXtra = await redis.get(tokenKey);
    if (!rawGoldXtra) return;

    const goldXtra = JSON.parse(rawGoldXtra);
    await redis.set(tokenKey, JSON.stringify({
      ...goldXtra,
      status: row.status || goldXtra.status || "assigned",
      redeemedAt: row.redeemed_at || null,
      redeemedBy: row.redeemed_by || "",
      alreadyRedeemedAttempts: Number(row.already_redeemed_attempts || 0),
    }));
  } catch (redisError) {
    console.warn("codePod GoldXtra Redis redeem cache update failed:", redisError.message);
  }
}

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"]
}));
app.options(/.*/, cors());

const {
  captureCodeClipProviderRawBody,
  isCodeClipProviderWebhookPath,
} = require("./verticals/codeclip/provider-raw-body");

function captureCodeClipProviderWebhookRawBody(req, res, buf) {
  if (isCodeClipProviderWebhookPath(req)) {
    captureCodeClipProviderRawBody(req, buf);
  }
}

const codeClipProviderJsonParser = express.json({
  limit: '20mb',
  verify: captureCodeClipProviderWebhookRawBody,
});
const codeClipProviderUrlencodedParser = express.urlencoded({
  limit: '20mb',
  extended: true,
  verify: captureCodeClipProviderWebhookRawBody,
});
const globalJsonParser = express.json({ limit: '20mb' });
const globalUrlencodedParser = express.urlencoded({ limit: '20mb', extended: true });

app.use((req, res, next) => {
  if (!isCodeClipProviderWebhookPath(req)) return next();
  return codeClipProviderJsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (!isCodeClipProviderWebhookPath(req)) return next();
  return codeClipProviderUrlencodedParser(req, res, next);
});
app.use((req, res, next) => {
  if (isCodeClipProviderWebhookPath(req)) return next();
  return globalJsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (isCodeClipProviderWebhookPath(req)) return next();
  return globalUrlencodedParser(req, res, next);
});

const PORT = process.env.PORT || 3001;
const JWT_SECRET = "codenxt-dev-secret-change-later";

let events = {};
let rewards = {};
let codeDemoHandshakeReports = {};
function getRewardForTier(storedReward, tier) {
  const requestedTier = tier || "general";

  if (!storedReward) {
    return null;
  }

  const isTieredReward =
    storedReward.gold || storedReward.silver || storedReward.general || storedReward.standard;

  if (!isTieredReward) {
    return {
      ...storedReward,
      tier: requestedTier,
    };
  }

  if (requestedTier === "standard") {
    if (storedReward.standard) return { ...storedReward.standard, tier: "standard" };
    if (storedReward.general) return { ...storedReward.general, tier: "standard" };
  }

  if (requestedTier === "general") {
    if (storedReward.general) return { ...storedReward.general, tier: "general" };
    if (storedReward.standard) return { ...storedReward.standard, tier: "general" };
  }

  if (storedReward[requestedTier]) {
    return { ...storedReward[requestedTier], tier: requestedTier };
  }

  return null;
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
  const screenVideoEvent = await resolveScreenVideoEvent(safeEventCode);

  if (!screenVideoEvent.ok) {
    return res.status(screenVideoEvent.status).json(screenVideoEvent.body);
  }

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
  const claimWindowHours = Math.max(0, Number(input.claimWindowHours || 24));

  return {
    mode: "progressive_scarcity",
    goldTotal,
    silverTotal,
    standardUnlimited: true,
    campaignStart: String(input.campaignStart || "").trim(),
    campaignEnd: String(input.campaignEnd || "").trim(),
    claimWindowHours,
  };
}

function generateDashboardAccessKey() {
  return `KP-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildCodeDemoDailyDemoEvents(parentEvent, body = {}) {
  const locations = Array.isArray(body.demoLocations) ? body.demoLocations : [];
  const parentCode = String(parentEvent.code || body.code || "").trim();
  const maxTeamsPerDay = Math.min(5, Math.max(1, Number(body.maxTeamsPerDay || 5)));
  const teamCodes = ["A", "B", "C", "D", "E"];

  if (!parentCode || String(body.locationMode || "").toLowerCase() !== "tour") {
    return [];
  }

  const fullscaleLocations = locations.filter(
    (location) => String(location.demoType || "").toLowerCase() === "fullscale"
  );

  const uniqueDates = [];
  const dateToDayIndex = new Map();

  fullscaleLocations.forEach((location) => {
    const dateKey = String(location.date || "").trim() || "undated";
    if (!dateToDayIndex.has(dateKey)) {
      const nextDayIndex = uniqueDates.length + 1;
      uniqueDates.push(dateKey);
      dateToDayIndex.set(dateKey, nextDayIndex);
    }
  });

  const perDayCounts = new Map();

  return fullscaleLocations
    .map((location) => {
      const dateKey = String(location.date || "").trim() || "undated";
      const dayIndex = dateToDayIndex.get(dateKey) || 1;
      const nextTeamIndex = (perDayCounts.get(dateKey) || 0) + 1;
      perDayCounts.set(dateKey, nextTeamIndex);

      if (nextTeamIndex > maxTeamsPerDay) {
        return null;
      }

      const dayNumber = String(dayIndex).padStart(2, "0");
      const teamCode = String(location.teamCode || teamCodes[nextTeamIndex - 1] || "A").trim().toUpperCase().slice(0, 1);
      const safeTeamCode = teamCodes.includes(teamCode) ? teamCode : teamCodes[nextTeamIndex - 1] || "A";
      const teamLabel = String(location.teamLabel || `Team ${safeTeamCode}`).trim();
      const code = `${parentCode}-D${dayNumber}-${safeTeamCode}`;
      const dashboardAccessKey = generateDashboardAccessKey();
      const demoDate = String(location.date || "").trim();
      const startTime = String(location.startTime || "").trim();
      const endTime = String(location.endTime || "").trim();

      return {
        id: uuidv4(),
        vertical: parentEvent.vertical || "codedemo",
        type: "dailyDemo",
        parentEventId: parentEvent.id,
        parentEventCode: parentCode,
        code,
        name: `${parentEvent.name || parentCode} / D${dayNumber}-${safeTeamCode} / ${location.name || `Demo ${dayNumber}`}`,
        companyName: parentEvent.companyName || "",
        artistLogo: parentEvent.artistLogo || "",
        badgeConfig: parentEvent.badgeConfig || { template: "codedemo" },
        venue: location.name || parentEvent.venue || "",
        city: location.city || "",
        startAt: demoDate && startTime ? `${demoDate}T${startTime}:00` : parentEvent.startAt,
        unlockAt: demoDate && startTime ? `${demoDate}T${startTime}:00` : parentEvent.unlockAt,
        endAt: demoDate && endTime ? `${demoDate}T${endTime}:00` : parentEvent.endAt,
        maxClaims: parentEvent.maxClaims,
        status: "scheduled",
        benefitInventory: parentEvent.benefitInventory || {},
        rewardDelivery: parentEvent.rewardDelivery || {},
        redemptionLocation: location.name || parentEvent.redemptionLocation || "",
        bonusDetails: parentEvent.bonusDetails || "{}",
        defaultLang: parentEvent.defaultLang || "en",
        lang: parentEvent.lang || parentEvent.defaultLang || "en",
        language: parentEvent.language || parentEvent.defaultLang || "en",
        dashboardAccessKey,
        momentOpen: false,
        dailyDemoIndex: dayIndex,
        dailyDemoDayIndex: dayIndex,
        dailyDemoTeamIndex: nextTeamIndex,
        teamCode: safeTeamCode,
        teamLabel,
        dailyDemoCode: code,
        demoLocation: {
          ...location,
          teamCode: safeTeamCode,
          teamLabel,
        },
        demoDate,
        demoStartTime: startTime,
        demoEndTime: endTime,
        demoTimeZone: body.demoTimeZone || body.timeZone || "Europe/Oslo",
        dashboardWindow: {
          opensHoursBeforeStart: 2,
          closesHoursAfterEnd: 6,
          handshakeOpensAfterEnd: true,
        },
        joinUrl: `/join/${code}`,
        dashboardUrl: `/dashboard?event=${code}`,
        qrTarget: `/join/${code}`,
      };
    })
    .filter(Boolean);
}

// CREATE EVENT
app.post("/event", async (req, res) => {
  try {
const {
  vertical,
  code,
  name,
  companyName,
  artistLogo,
  badgeConfig,
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
  bonusWindow,
  maxClaims,
  status,
  benefitInventory,
  rewardDelivery,
  redemptionLocation,
	  bonusDetails,
	  partnerReward,
	  digitalSouvenir,
	  rewards,
	  defaultLang,
  lang,
  language,
  demoLocations,
  locationMode,
  tourCsvImportReady,
  tourGeoReady,
  campaignFocus,
  campaignRiskProfile,
  termsAccepted,
  termsAcceptedAt,
  termsVersion,
  termsLanguage,
  termsAcceptedByName,
  termsAcceptedByEmail,
  paymentAccepted,
  activationMethod,
  activationKeyword,
  activationChannels
} = req.body;

const normalizedVertical = String(vertical || "codetone").trim().toLowerCase();
const normalizedCompanyName = String(companyName || req.body.companyName || "").trim();
const normalizedBonusWindow = String(bonusWindow || "").trim();
const normalizedBenefitInventory = normalizeBenefitInventory(benefitInventory || {});
const normalizedRewardDelivery = normalizeRewardDelivery(rewardDelivery || {});
const normalizedRedemptionLocation = String(redemptionLocation || "").trim();
const normalizedBonusDetails = normalizeBonusDetails(bonusDetails || {});
const isCodePodEvent = normalizedVertical === "codepod";
const isCodeClipEvent = normalizedVertical === "codeclip";

const normalizedPartnerReward = isCodePodEvent
  ? normalizeCodePodPartnerReward(partnerReward || {})
  : null;
const normalizedDigitalSouvenir = isCodePodEvent
  ? normalizeCodePodDigitalSouvenir(digitalSouvenir || {})
  : null;
const normalizedCodeClipRewards = isCodeClipEvent
  ? codeClipVertical.rewards.normalizeCodeClipRewards(rewards || {})
  : null;
const dashboardAccessKey = String(req.body.dashboardAccessKey || generateDashboardAccessKey()).trim();
const normalizedDefaultLang = String(defaultLang || lang || language || "en").trim().toLowerCase();
const rawActivationMethod = String(activationMethod || "").trim().toLowerCase();
const normalizedActivationMethod = ["keyword", "qr", "both"].includes(rawActivationMethod)
  ? rawActivationMethod
  : "keyword";
const normalizedActivationKeyword = String(activationKeyword || "").trim();
const normalizedActivationChannels = Array.isArray(activationChannels)
  ? activationChannels.map((channel) => String(channel || "").trim()).filter(Boolean)
  : [];

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
  companyName: normalizedCompanyName,
  artistLogo,
  badgeConfig,
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
  bonusWindow: normalizedBonusWindow,
maxClaims,
  status,
  benefitInventory: normalizedBenefitInventory,
  rewardDelivery: normalizedRewardDelivery,
  redemptionLocation: normalizedRedemptionLocation,
  bonusDetails: JSON.stringify(normalizedBonusDetails),
  defaultLang: normalizedDefaultLang,
  lang: normalizedDefaultLang,
  language: normalizedDefaultLang,
  dashboardAccessKey,
  momentOpen: false,
  locationMode: String(locationMode || "").trim(),
  demoLocations: Array.isArray(demoLocations) ? demoLocations : [],
  tourCsvImportReady: !!tourCsvImportReady,
  tourGeoReady: !!tourGeoReady,
  campaignFocus: Array.isArray(campaignFocus) ? campaignFocus : [],
  campaignRiskProfile: campaignRiskProfile && typeof campaignRiskProfile === "object"
    ? campaignRiskProfile
    : {},
  termsAccepted: !!termsAccepted,
  termsAcceptedAt: termsAcceptedAt || "",
  termsVersion: termsVersion || "",
  termsLanguage: termsLanguage || normalizedDefaultLang,
  termsAcceptedByName: termsAcceptedByName || "",
  termsAcceptedByEmail: termsAcceptedByEmail || "",
  paymentAccepted: !!paymentAccepted,
  activationMethod: normalizedActivationMethod,
  activationKeyword: normalizedActivationKeyword,
  activationChannels: normalizedActivationChannels,
};
if (normalizedPartnerReward) {
  event.partnerReward = normalizedPartnerReward;
}
if (normalizedDigitalSouvenir) {
  event.digitalSouvenir = normalizedDigitalSouvenir;
}
if (isCodeClipEvent) {
  Object.assign(event, codeClipVertical.routes.attachCodeClipRewardsToEvent(event, rewards || {}));
}
    const dailyDemoEvents = buildCodeDemoDailyDemoEvents(event, req.body);
    event.dailyDemoEvents = dailyDemoEvents;
    events[id] = event;
    dailyDemoEvents.forEach((dailyEvent) => {
      events[dailyEvent.id] = dailyEvent;
    });

if (process.env.REDIS_URL) {
const eventMeta = {
  id,
  vertical: normalizedVertical,
  code: code || id,
  name,
  companyName: normalizedCompanyName,
artistLogo: artistLogo || "",
  badgeConfig: JSON.stringify(badgeConfig || { template: "americana" }),
  venue,
  city,
  startAt,
  unlockAt,
  endAt,
  bonusWindow: normalizedBonusWindow,
  maxClaims: String(maxClaims),
  status,
  benefitInventory: JSON.stringify(normalizedBenefitInventory),
  rewardDelivery: JSON.stringify(normalizedRewardDelivery),
  redemptionLocation: normalizedRedemptionLocation,
  bonusDetails: JSON.stringify(normalizedBonusDetails),
  defaultLang: normalizedDefaultLang,
  lang: normalizedDefaultLang,
  language: normalizedDefaultLang,
  dashboardAccessKey,
  momentOpen: "false",
  locationMode: String(event.locationMode || ""),
  demoLocations: JSON.stringify(event.demoLocations || []),
  dailyDemoEvents: JSON.stringify(event.dailyDemoEvents || []),
  tourCsvImportReady: String(!!event.tourCsvImportReady),
  tourGeoReady: String(!!event.tourGeoReady),
  termsAccepted: String(!!termsAccepted),
  termsAcceptedAt: termsAcceptedAt || "",
  termsVersion: termsVersion || "",
  termsLanguage: termsLanguage || normalizedDefaultLang,
  termsAcceptedByName: termsAcceptedByName || "",
  termsAcceptedByEmail: termsAcceptedByEmail || "",
  paymentAccepted: String(!!paymentAccepted),
  activationMethod: normalizedActivationMethod,
  activationKeyword: normalizedActivationKeyword,
  activationChannels: JSON.stringify(normalizedActivationChannels),
};
if (normalizedPartnerReward) {
  eventMeta.partnerReward = JSON.stringify(normalizedPartnerReward);
}
if (normalizedDigitalSouvenir) {
  eventMeta.digitalSouvenir = JSON.stringify(normalizedDigitalSouvenir);
}
if (isCodeClipEvent) {
  Object.assign(eventMeta, codeClipVertical.routes.attachCodeClipRewardsToEventMeta(eventMeta, rewards || {}));
}
await redis.hset(`event:${id}:meta`, eventMeta);

  await redis.set(`eventcode:${code || id}`, id);
  await redis.set(`eventcode:${normalizedVertical}:${code || id}`, id);
  await redis.set(`event:${id}:claims`, "0");

  for (const dailyEvent of dailyDemoEvents) {
    await redis.hset(`event:${dailyEvent.id}:meta`, {
      id: dailyEvent.id,
      vertical: dailyEvent.vertical,
      type: dailyEvent.type,
      parentEventId: dailyEvent.parentEventId,
      parentEventCode: dailyEvent.parentEventCode,
      code: dailyEvent.code,
      name: dailyEvent.name,
      companyName: dailyEvent.companyName || "",
      artistLogo: dailyEvent.artistLogo || "",
      badgeConfig: JSON.stringify(dailyEvent.badgeConfig || { template: "codedemo" }),
      venue: dailyEvent.venue || "",
      city: dailyEvent.city || "",
      startAt: dailyEvent.startAt || "",
      unlockAt: dailyEvent.unlockAt || "",
      endAt: dailyEvent.endAt || "",
      maxClaims: String(dailyEvent.maxClaims || ""),
      status: dailyEvent.status || "scheduled",
      benefitInventory: JSON.stringify(dailyEvent.benefitInventory || {}),
      rewardDelivery: JSON.stringify(dailyEvent.rewardDelivery || {}),
      redemptionLocation: dailyEvent.redemptionLocation || "",
      bonusDetails: typeof dailyEvent.bonusDetails === "string" ? dailyEvent.bonusDetails : JSON.stringify(dailyEvent.bonusDetails || {}),
      defaultLang: dailyEvent.defaultLang || "en",
      lang: dailyEvent.lang || dailyEvent.defaultLang || "en",
      language: dailyEvent.language || dailyEvent.defaultLang || "en",
      dashboardAccessKey: dailyEvent.dashboardAccessKey,
      momentOpen: "false",
      dailyDemoIndex: String(dailyEvent.dailyDemoIndex),
      dailyDemoDayIndex: String(dailyEvent.dailyDemoDayIndex || dailyEvent.dailyDemoIndex || ""),
      dailyDemoTeamIndex: String(dailyEvent.dailyDemoTeamIndex || ""),
      teamCode: dailyEvent.teamCode || "",
      teamLabel: dailyEvent.teamLabel || "",
      dailyDemoCode: dailyEvent.dailyDemoCode,
      demoLocation: JSON.stringify(dailyEvent.demoLocation || {}),
      demoDate: dailyEvent.demoDate || "",
      demoStartTime: dailyEvent.demoStartTime || "",
      demoEndTime: dailyEvent.demoEndTime || "",
      demoTimeZone: dailyEvent.demoTimeZone || "Europe/Oslo",
      dashboardWindow: JSON.stringify(dailyEvent.dashboardWindow || {}),
      joinUrl: dailyEvent.joinUrl || "",
      dashboardUrl: dailyEvent.dashboardUrl || "",
      qrTarget: dailyEvent.qrTarget || "",
    });

    await redis.set(`eventcode:${dailyEvent.code}`, dailyEvent.id);
    await redis.set(`eventcode:${dailyEvent.vertical}:${dailyEvent.code}`, dailyEvent.id);
    await redis.set(`event:${dailyEvent.id}:claims`, "0");
  }
}

try {
  await saveCampaign(event);
  for (const dailyEvent of dailyDemoEvents) {
    await saveCampaign(dailyEvent);
  }
  console.log("POSTGRES CAMPAIGN SAVED:", event.code, "dailyDemoEvents:", dailyDemoEvents.length);
} catch (dbError) {
  console.error("POSTGRES CAMPAIGN SAVE FAILED:", dbError.message);
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
      dailyDemoEvents,
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
    const requestedEventId = eventId;
    const requestedVertical = String(req.query?.vertical || "").trim().toLowerCase();
    const hasExplicitVertical = !!requestedVertical;
    const resolvedEvent = await resolveEventReference(eventId, {
      requestedVertical,
      explicitVertical: hasExplicitVertical,
    });
    const inMemoryEvent = resolvedEvent.event;

if (resolvedEvent.eventId) {
  eventId = resolvedEvent.eventId;
}

if (process.env.DEBUG_EVENT_LOOKUP === "1") {
if (process.env.DEBUG_EVENT_LOOKUP === "1") {
  console.log("RESOLVED EVENT ID:", eventId);
}
}
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

if (meta && meta.rewardDelivery) {
  try {
    meta.rewardDelivery = JSON.parse(meta.rewardDelivery);
  } catch {
    meta.rewardDelivery = null;
  }
}

if (meta && meta.bonusDetails) {
  try {
    meta.bonusDetails = JSON.parse(meta.bonusDetails);
  } catch {
    meta.bonusDetails = normalizeBonusDetails({});
  }
}

if (meta && meta.partnerReward && typeof meta.partnerReward === "string") {
  try {
    meta.partnerReward = JSON.parse(meta.partnerReward);
  } catch {
    meta.partnerReward = normalizeCodePodPartnerReward({});
  }
}

if (meta && meta.digitalSouvenir && typeof meta.digitalSouvenir === "string") {
  try {
    meta.digitalSouvenir = JSON.parse(meta.digitalSouvenir);
  } catch {
    meta.digitalSouvenir = normalizeCodePodDigitalSouvenir({});
  }
}

if (String(meta?.vertical || "").trim().toLowerCase() === "codeclip") {
  meta = codeClipVertical.routes.parseCodeClipRewardsMeta(meta);
}

if (meta && meta.demoLocations) {
  try {
    meta.demoLocations = JSON.parse(meta.demoLocations);
  } catch {
    meta.demoLocations = [];
  }
}

if (meta && meta.dailyDemoEvents) {
  try {
    meta.dailyDemoEvents = JSON.parse(meta.dailyDemoEvents);
  } catch {
    meta.dailyDemoEvents = [];
  }
}

if (meta && meta.demoLocation) {
  try {
    meta.demoLocation = JSON.parse(meta.demoLocation);
  } catch {
    meta.demoLocation = {};
  }
}

if (meta && meta.dashboardWindow) {
  try {
    meta.dashboardWindow = JSON.parse(meta.dashboardWindow);
  } catch {
    meta.dashboardWindow = {};
  }
}
    if ((!meta || !meta.id) && events[eventId]) {
  meta = events[eventId];
}

if ((!meta || !meta.id) && inMemoryEvent) {
  meta = inMemoryEvent;
}
  }

if ((!meta || !meta.id) && events[eventId]) {
  meta = events[eventId];
}

if ((!meta || !meta.id) && inMemoryEvent) {
  meta = inMemoryEvent;
}

if (!meta || !meta.id) {
  const campaign = await getCampaignByCode(requestedEventId);
  const campaignEvent = campaign?.raw_event || null;
  if (campaignEvent && eventMatchesVertical(campaignEvent, hasExplicitVertical ? requestedVertical : "")) {
    meta = campaign.raw_event;
    eventId = meta.id || campaign.id || eventId;
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
  companyName: meta?.companyName || "",
  artistLogo: meta?.artistLogo || "",
  badgeConfig: meta?.badgeConfig,
  venue: meta?.venue || "",
  city: meta?.city || "",
  startAt: meta?.startAt,
  unlockAt: meta?.unlockAt,
  endAt: meta?.endAt,
  bonusWindow: meta?.bonusWindow || "",
  termsAccepted: meta?.termsAccepted === "true" || meta?.termsAccepted === true,
  termsAcceptedAt: meta?.termsAcceptedAt || "",
  termsVersion: meta?.termsVersion || "",
  termsLanguage: meta?.termsLanguage || "",
  termsAcceptedByName: meta?.termsAcceptedByName || "",
  termsAcceptedByEmail: meta?.termsAcceptedByEmail || "",
  paymentAccepted: meta?.paymentAccepted === "true" || meta?.paymentAccepted === true,
  activationMethod: normalizeActivationMethod(meta?.activationMethod),
  activationKeyword: String(meta?.activationKeyword || "").trim(),
  activationChannels: normalizeActivationChannels(meta?.activationChannels),
  maxClaims: Number(meta?.maxClaims || 0),
  status: meta?.status,
  defaultLang: meta?.defaultLang || meta?.lang || meta?.language || "en",
  lang: meta?.defaultLang || meta?.lang || meta?.language || "en",
  language: meta?.defaultLang || meta?.lang || meta?.language || "en",
  benefitInventory: meta?.benefitInventory || null,
  rewardDelivery: meta?.rewardDelivery || null,
  redemptionLocation: meta?.redemptionLocation || "",
  bonusDetails: meta?.bonusDetails || null,
  type: meta?.type || "",
  parentEventId: meta?.parentEventId || "",
  parentEventCode: meta?.parentEventCode || "",
  locationMode: meta?.locationMode || "",
  demoLocations: Array.isArray(meta?.demoLocations) ? meta.demoLocations : [],
  dailyDemoEvents: Array.isArray(meta?.dailyDemoEvents) ? meta.dailyDemoEvents : [],
  dailyDemoIndex: Number(meta?.dailyDemoIndex || 0),
  dailyDemoDayIndex: Number(meta?.dailyDemoDayIndex || meta?.dailyDemoIndex || 0),
  dailyDemoTeamIndex: Number(meta?.dailyDemoTeamIndex || 0),
  teamCode: meta?.teamCode || "",
  teamLabel: meta?.teamLabel || "",
  dailyDemoCode: meta?.dailyDemoCode || "",
  demoLocation: meta?.demoLocation || {},
  demoDate: meta?.demoDate || "",
  demoStartTime: meta?.demoStartTime || "",
  demoEndTime: meta?.demoEndTime || "",
  demoTimeZone: meta?.demoTimeZone || "Europe/Oslo",
  dashboardWindow: meta?.dashboardWindow || {},
  joinUrl: meta?.joinUrl || "",
  dashboardUrl: meta?.dashboardUrl || "",
  qrTarget: meta?.qrTarget || "",
  tourCsvImportReady: meta?.tourCsvImportReady === true || meta?.tourCsvImportReady === "true",
  tourGeoReady: meta?.tourGeoReady === true || meta?.tourGeoReady === "true",
screenVideoUrl: meta?.screenVideoUrl || "",
momentOpen: meta?.momentOpen === true || meta?.momentOpen === "true",
rawScans,
  uniqueScans,
  innerCircleJoinCount,
};

if (String(meta?.vertical || "").trim().toLowerCase() === "codepod") {
  normalizedMeta.partnerReward = normalizeCodePodPartnerReward(meta?.partnerReward || {});
  normalizedMeta.digitalSouvenir = normalizeCodePodDigitalSouvenir(meta?.digitalSouvenir || {});
}

if (String(meta?.vertical || "").trim().toLowerCase() === "codeclip") {
  Object.assign(normalizedMeta, codeClipVertical.routes.attachCodeClipRewardsToNormalizedMeta(normalizedMeta, meta));
}

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
  (
    !reward.url &&
    !reward.fileUrl &&
    !reward.fileName &&
    !reward.content &&
    !String(reward.title || "").trim()
  );

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

function normalizeCodeDemoScore(value, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(10, Math.round(number)));
}

function getCodeDemoHandshakeDeadline(meta = {}, input = {}) {
  const demoDate = String(input.demoDate || meta.demoDate || meta.startAt || "").slice(0, 10);
  const demoEndTime = String(input.demoEndTime || meta.demoEndTime || "").trim();

  let endAt = "";

  if (demoDate && demoEndTime) {
    endAt = `${demoDate}T${demoEndTime}:00`;
  } else {
    endAt = input.endAt || meta.endAt || "";
  }

  const endMs = Date.parse(endAt);
  if (!Number.isFinite(endMs)) {
    return { ok: true, endAt: "", deadlineAt: "", expired: false };
  }

  const deadlineMs = endMs + 15 * 60 * 1000;
  const nowMs = Date.now();

  return {
    ok: nowMs <= deadlineMs,
    endAt: new Date(endMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    expired: nowMs > deadlineMs,
  };
}

function buildCodeDemoHandshakePayload(input = {}, meta = {}, eventCode = "") {
  const relevance = normalizeCodeDemoScore(input.relevance ?? input.relevans, 0);
  const understanding = normalizeCodeDemoScore(input.understanding ?? input.forstaelse ?? input.productUnderstanding, 0);
  const trust = normalizeCodeDemoScore(input.trust ?? input.tillit, 0);
  const safety = normalizeCodeDemoScore(input.safety ?? input.trygghet, 0);
  const insight = normalizeCodeDemoScore(input.insight ?? input.innsikt, 0);

  const handshakeScore =
    Math.round(((relevance + understanding + trust + safety + insight) / 5) * 10) / 10;

  const firstDemoLocation = Array.isArray(meta.demoLocations) ? meta.demoLocations[0] || {} : {};
  const demoLocation = input.demoLocation || meta.demoLocation || firstDemoLocation || {};

  const resolvedTeamLabel =
    input.teamLabel ||
    meta.teamLabel ||
    demoLocation.teamLabel ||
    demoLocation.teamLeaderName ||
    firstDemoLocation.teamLeaderName ||
    "";

  const resolvedReportedBy =
    input.reportedBy ||
    input.teamLeader ||
    demoLocation.teamLeaderName ||
    firstDemoLocation.teamLeaderName ||
    resolvedTeamLabel ||
    "";

  return {
    eventCode,
    eventId: input.eventId || meta.id || "",
    parentEventCode: input.parentEventCode || meta.parentEventCode || meta.parentCode || "",
    vertical: "codedemo",
    demoDate: String(input.demoDate || meta.demoDate || meta.startAt || "").slice(0, 10),
    teamCode: String(input.teamCode || meta.teamCode || demoLocation.teamCode || firstDemoLocation.teamCode || "").trim().toUpperCase(),
    teamLabel: String(resolvedTeamLabel).trim(),
    dailyDemoCode: String(input.dailyDemoCode || meta.dailyDemoCode || eventCode).trim(),
    dailyDemoDayIndex: Number(input.dailyDemoDayIndex || meta.dailyDemoDayIndex || meta.dailyDemoIndex || 0) || null,
    dailyDemoTeamIndex: Number(input.dailyDemoTeamIndex || meta.dailyDemoTeamIndex || 0) || null,
    locationName: String(
      input.locationName ||
      demoLocation.name ||
      demoLocation.storeName ||
      demoLocation.locationName ||
      firstDemoLocation.name ||
      firstDemoLocation.storeName ||
      firstDemoLocation.locationName ||
      meta.venue ||
      meta.city ||
      ""
    ).trim(),
    relevance,
    understanding,
    trust,
    safety,
    insight,
    handshakeScore,
    totalScore: handshakeScore,
    reportedBy: String(resolvedReportedBy).trim(),
    rawPayload: input,
  };
}

function toCodeDemoNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundCodeDemoMetric(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function getCodeDemoHandshakeScore(report = {}) {
  const explicit = toCodeDemoNumber(report.handshakeScore ?? report.handshake_score ?? report.totalScore ?? report.total_score, 0);
  if (explicit > 0) return explicit;

  const values = ["relevance", "understanding", "trust", "safety", "insight"]
    .map((key) => toCodeDemoNumber(report[key], 0))
    .filter((value) => value > 0);

  if (!values.length) return 0;
  return roundCodeDemoMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function getCodeDemoExceptionType(exception = {}) {
  return String(exception.exception_type || exception.type || exception.exceptionType || "unknown_exception").trim();
}

function getCodeDemoExceptionCategory(exception = {}) {
  return String(exception.category || "system").trim();
}

function getCodeDemoExceptionSeverity(exception = {}) {
  const value = String(exception.severity || "yellow").trim().toLowerCase();
  if (["red", "critical", "high", "error"].includes(value)) return "red";
  if (["info", "green", "resolved", "ok"].includes(value)) return value === "info" ? "info" : "green";
  return "yellow";
}

function getCodeDemoExceptionSeverityRank(exception = {}) {
  const severity = getCodeDemoExceptionSeverity(exception);
  if (severity === "red") return 3;
  if (severity === "yellow") return 2;
  if (severity === "info") return 1;
  return 0;
}

function getCodeDemoExceptionTeamKey(exception = {}) {
  const details = exception.details || {};
  return String(
    exception.teamCode ||
    exception.team_code ||
    exception.teamLabel ||
    exception.team ||
    details.teamCode ||
    details.teamLabel ||
    details.team ||
    ""
  ).trim();
}

function getCodeDemoExceptionActivityKey(exception = {}) {
  const details = exception.details || {};
  const date = String(exception.demoDate || exception.demo_date || exception.activityDate || details.activityDate || "").trim();
  const location = String(exception.locationName || exception.location || details.locationName || details.location || "").trim();
  const team = getCodeDemoExceptionTeamKey(exception);
  return [date, location, team].filter(Boolean).join("|");
}

function summarizeCodeDemoExceptions(exceptions = []) {
  const openExceptions = exceptions.filter((item) => String(item.status || "open").toLowerCase() === "open");
  const redExceptions = openExceptions.filter((item) => getCodeDemoExceptionSeverity(item) === "red");
  const yellowExceptions = openExceptions.filter((item) => getCodeDemoExceptionSeverity(item) === "yellow");
  const infoExceptions = openExceptions.filter((item) => getCodeDemoExceptionSeverity(item) === "info");
  const exceptionTypes = {};
  const exceptionCategories = {};

  for (const exception of openExceptions) {
    const type = getCodeDemoExceptionType(exception);
    const category = getCodeDemoExceptionCategory(exception);
    exceptionTypes[type] = (exceptionTypes[type] || 0) + 1;
    exceptionCategories[category] = (exceptionCategories[category] || 0) + 1;
  }

  return {
    openExceptions,
    redExceptions,
    yellowExceptions,
    infoExceptions,
    exceptionTypes,
    exceptionCategories,
    topExceptionType: Object.entries(exceptionTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    topExceptionCategory: Object.entries(exceptionCategories).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    worstSeverity: openExceptions.reduce((worst, item) => Math.max(worst, getCodeDemoExceptionSeverityRank(item)), 0),
  };
}

function selectCodeDemoSignal(averages = {}, direction = "strongest") {
  const labels = {
    relevance: "Relevance",
    understanding: "Understanding",
    trust: "Trust",
    safety: "Safety",
    insight: "Insight",
  };

  const entries = Object.entries(labels)
    .map(([key, label]) => ({ key, label, value: toCodeDemoNumber(averages[key], 0) }))
    .filter((item) => item.value > 0);

  if (!entries.length) return null;

  return entries.reduce((selected, item) => {
    if (direction === "weakest") return item.value < selected.value ? item : selected;
    return item.value > selected.value ? item : selected;
  }, entries[0]);
}

function aggregateCodeDemoHandshakes(reports = []) {
  const signalKeys = ["relevance", "understanding", "trust", "safety", "insight"];
  const submitted = Array.isArray(reports) ? reports : [];
  const averages = {};

  for (const key of signalKeys) {
    const values = submitted.map((report) => toCodeDemoNumber(report[key], 0)).filter((value) => value > 0);
    averages[key] = values.length ? roundCodeDemoMetric(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  }

  const scores = submitted.map(getCodeDemoHandshakeScore).filter((value) => value > 0);
  const handshakeScore = scores.length ? roundCodeDemoMetric(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0;
  const strongestSignal = selectCodeDemoSignal(averages, "strongest");
  const weakestSignal = selectCodeDemoSignal(averages, "weakest");

  return {
    submittedCount: submitted.length,
    handshakeScore,
    ...averages,
    strongestSignal,
    weakestSignal,
    worstHandshakeScore: scores.length ? roundCodeDemoMetric(Math.min(...scores)) : 0,
    bestHandshakeScore: scores.length ? roundCodeDemoMetric(Math.max(...scores)) : 0,
  };
}

function groupCodeDemoReports(reports = [], keyFn) {
  const groups = new Map();

  for (const report of reports) {
    const key = keyFn(report);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }

  return groups;
}

function buildCodeDemoTeamCoach(reports = [], exceptions = []) {
  const groups = groupCodeDemoReports(reports, (report = {}) => String(report.teamCode || report.team_code || report.teamLabel || report.team_label || "").trim());

  return Array.from(groups.entries()).map(([teamKey, rows]) => {
    const first = rows[0] || {};
    const teamExceptions = exceptions.filter((exception) => getCodeDemoExceptionTeamKey(exception) === teamKey || getCodeDemoExceptionTeamKey(exception) === String(first.teamLabel || first.team_label || "").trim());
    const exceptionSummary = summarizeCodeDemoExceptions(teamExceptions);
    const aggregate = aggregateCodeDemoHandshakes(rows);

    return {
      teamKey,
      teamCode: first.teamCode || first.team_code || "",
      teamLabel: first.teamLabel || first.team_label || teamKey,
      submittedCount: aggregate.submittedCount,
      handshakeScore: aggregate.handshakeScore,
      relevance: aggregate.relevance,
      understanding: aggregate.understanding,
      trust: aggregate.trust,
      safety: aggregate.safety,
      insight: aggregate.insight,
      scans: null,
      registrations: null,
      conversionRate: null,
      strongestSignal: aggregate.strongestSignal,
      weakestSignal: aggregate.weakestSignal,
      openExceptions: exceptionSummary.openExceptions.length,
      redExceptions: exceptionSummary.redExceptions.length,
      yellowExceptions: exceptionSummary.yellowExceptions.length,
      infoExceptions: exceptionSummary.infoExceptions.length,
      worstSeverity: exceptionSummary.worstSeverity,
    };
  }).sort((a, b) => a.teamLabel.localeCompare(b.teamLabel));
}

function buildCodeDemoActivityCoach(reports = [], exceptions = []) {
  const groups = groupCodeDemoReports(reports, (report = {}) => {
    const date = String(report.demoDate || report.demo_date || "").trim();
    const location = String(report.locationName || report.location_name || report.location || "").trim();
    const team = String(report.teamCode || report.team_code || report.teamLabel || report.team_label || "").trim();
    return [date, location, team].filter(Boolean).join("|");
  });

  return Array.from(groups.entries()).map(([activityKey, rows]) => {
    const first = rows[0] || {};
    const activityExceptions = exceptions.filter((exception) => getCodeDemoExceptionActivityKey(exception) === activityKey);
    const exceptionSummary = summarizeCodeDemoExceptions(activityExceptions);
    const aggregate = aggregateCodeDemoHandshakes(rows);

    return {
      activityKey,
      demoDate: first.demoDate || first.demo_date || "",
      locationName: first.locationName || first.location_name || first.location || "",
      teamCode: first.teamCode || first.team_code || "",
      teamLabel: first.teamLabel || first.team_label || "",
      submittedCount: aggregate.submittedCount,
      handshakeScore: aggregate.handshakeScore,
      relevance: aggregate.relevance,
      understanding: aggregate.understanding,
      trust: aggregate.trust,
      safety: aggregate.safety,
      insight: aggregate.insight,
      scans: null,
      registrations: null,
      conversionRate: null,
      strongestSignal: aggregate.strongestSignal,
      weakestSignal: aggregate.weakestSignal,
      openExceptions: exceptionSummary.openExceptions.length,
      redExceptions: exceptionSummary.redExceptions.length,
      yellowExceptions: exceptionSummary.yellowExceptions.length,
      infoExceptions: exceptionSummary.infoExceptions.length,
      worstSeverity: exceptionSummary.worstSeverity,
    };
  }).sort((a, b) => `${a.demoDate}-${a.teamCode}`.localeCompare(`${b.demoDate}-${b.teamCode}`));
}

function selectBestCodeDemoTeam(teamCoach = []) {
  return [...teamCoach]
    .filter((team) => team.submittedCount > 0)
    .sort((a, b) => b.handshakeScore - a.handshakeScore || a.worstSeverity - b.worstSeverity || a.teamLabel.localeCompare(b.teamLabel))[0] || null;
}

function selectWorstCodeDemoTeam(teamCoach = []) {
  return [...teamCoach]
    .filter((team) => team.submittedCount > 0 || team.openExceptions > 0)
    .sort((a, b) => b.worstSeverity - a.worstSeverity || a.handshakeScore - b.handshakeScore || b.openExceptions - a.openExceptions || a.teamLabel.localeCompare(b.teamLabel))[0] || null;
}

function chooseCodeDemoRecommendation({ campaignAggregate = {}, exceptionSummary = {}, scans = 0, uniqueScans = 0, registrations = 0 } = {}) {
  const conversionRate = uniqueScans > 0 ? roundCodeDemoMetric((registrations / uniqueScans) * 100) : 0;
  const weakest = campaignAggregate.weakestSignal;
  const strongest = campaignAggregate.strongestSignal;
  const exceptionTypes = exceptionSummary.exceptionTypes || {};
  const topExceptionCategory = exceptionSummary.topExceptionCategory || "";

  if (exceptionSummary.redExceptions?.length > 0) {
    return {
      priority: "red_exceptions",
      recommendationType: "resolve_red_exceptions",
      recommendation: "Resolve red exceptions first; they are likely to affect trust and reporting quality.",
    };
  }

  if (exceptionTypes.scan_registration_mismatch > 0) {
    return {
      priority: "analytics_integrity",
      recommendationType: "review_registration_integrity",
      recommendation: "Registrations exceed unique scans. Review registration integrity, duplicate protection, and scan tracking.",
    };
  }

  if (exceptionTypes.handshake_missing > 0 || campaignAggregate.submittedCount === 0) {
    return {
      priority: "missing_handshake",
      recommendationType: "enforce_handshake_completion",
      recommendation: "Close every activity with Handshake before reporting; the coaching basis is incomplete.",
    };
  }

  if (campaignAggregate.handshakeScore > 0 && campaignAggregate.handshakeScore < 6.5) {
    return {
      priority: "low_handshake_score",
      recommendationType: "improve_overall_handshake",
      recommendation: "Overall Handshake quality is low. Review team briefing and the activity script before the next activation.",
    };
  }

  if (uniqueScans >= 50 && conversionRate < 20) {
    return {
      priority: "low_conversion",
      recommendationType: "improve_qr_call_to_action",
      recommendation: "Make the QR call-to-action more visible and explain the value of registering.",
    };
  }

  if (exceptionSummary.yellowExceptions?.length > 0) {
    return {
      priority: "yellow_exceptions",
      recommendationType: "yellow_exceptions",
      recommendation: "There are warning-level exceptions that should be reviewed before the next activity.",
    };
  }

  if (weakest && weakest.value <= 6) {
    const map = {
      relevance: ["sharpen_customer_problem", "Open with a sharper customer problem before explaining the product."],
      understanding: ["clarify_product_explanation", "Make the product explanation clearer in the first 30 seconds."],
      trust: ["strengthen_trust_proof", "Use stronger proof points, examples, or guarantees to build trust faster."],
      safety: ["reduce_friction", "Reduce friction and make the next step feel safe and easy."],
      insight: ["ask_better_discovery_question", "Ask one better discovery question before presenting the offer."],
    };
    const [recommendationType, recommendation] = map[weakest.key] || ["improve_weakest_signal", "Improve the weakest Handshake signal before the next activity."];
    return { priority: "weakest_signal", recommendationType, recommendation };
  }

  if (topExceptionCategory === "technical") {
    return {
      priority: "technical_exception_pattern",
      recommendationType: "stabilize_technical_setup",
      recommendation: "Technical exceptions were registered. Verify network, QR access, and device readiness before the next activity.",
    };
  }

  return {
    priority: "repeat_strength",
    recommendationType: "repeat_strength",
    recommendation: strongest
      ? `Repeat the strongest signal (${strongest.label}) and keep the team brief simple.`
      : "Repeat the strongest parts of the activity and keep the team brief simple.",
  };
}

function generateCodeDemoCoach({ handshake = {}, handshakes = [], exceptions = [], scans = 0, uniqueScans = 0, registrations = 0 } = {}) {
  const reports = Array.isArray(handshakes) && handshakes.length ? handshakes : (handshake && Object.keys(handshake).length ? [handshake] : []);
  const campaignAggregate = aggregateCodeDemoHandshakes(reports);
  const exceptionSummary = summarizeCodeDemoExceptions(exceptions);
  const teamCoach = buildCodeDemoTeamCoach(reports, exceptionSummary.openExceptions);
  const activityCoach = buildCodeDemoActivityCoach(reports, exceptionSummary.openExceptions);
  const bestTeam = selectBestCodeDemoTeam(teamCoach);
  const worstTeam = selectWorstCodeDemoTeam(teamCoach);
  const conversionRate = uniqueScans > 0 ? roundCodeDemoMetric((registrations / uniqueScans) * 100) : 0;
  const recommendation = chooseCodeDemoRecommendation({ campaignAggregate, exceptionSummary, scans, uniqueScans, registrations });
  const strongest = campaignAggregate.strongestSignal;
  const weakest = campaignAggregate.weakestSignal;

  let strengthType = "handshake_complete";
  let strength = "The team has submitted a complete Handshake report.";
  if (campaignAggregate.submittedCount === 0 || exceptionSummary.exceptionTypes.handshake_missing > 0) {
    strengthType = "handshake_missing";
    strength = "The campaign is currently missing completed Handshake reports.";
  } else if (strongest && strongest.value >= 8) {
    strengthType = `strong_${strongest.key}`;
    strength = `${strongest.label} is the strongest campaign-level Handshake signal.`;
  } else if (campaignAggregate.handshakeScore >= 7.5) {
    strengthType = "strong_overall_handshake";
    strength = "The campaign shows a strong overall Handshake result.";
  } else if (registrations > 0 && conversionRate >= 30) {
    strengthType = "healthy_registration_conversion";
    strength = "The campaign converts a healthy share of scans into registrations.";
  }

  let improvementType = "no_major_weakness";
  let improvement = "No major weakness stands out yet.";
  if (weakest && weakest.value > 0 && weakest.value <= 6) {
    improvementType = `low_${weakest.key}`;
    improvement = `${weakest.label} is the lowest campaign-level Handshake signal and should be improved.`;
  } else if (exceptionSummary.redExceptions.length > 0) {
    improvementType = "red_exceptions";
    improvement = "Critical exceptions need attention before the next activity.";
  } else if (exceptionSummary.yellowExceptions.length > 0) {
    improvementType = "yellow_exceptions";
    improvement = "There are warning-level exceptions that should be reviewed.";
  } else if (uniqueScans > 0 && conversionRate < 20) {
    improvementType = "low_registration_conversion";
    improvement = "Registration conversion is low compared with scan activity.";
  }

  let correlationInsight = "";
  if (exceptionSummary.topExceptionType === "scan_registration_mismatch") {
    correlationInsight = "Registrations exceed unique scans, so reporting quality and registration integrity should be reviewed.";
  } else if (exceptionSummary.topExceptionType === "low_registration_conversion") {
    correlationInsight = "High scan activity did not translate into registrations, which may indicate weak call-to-action or registration friction.";
  } else if (exceptionSummary.topExceptionType === "registration_spike") {
    correlationInsight = "Registration activity is unusually high compared with scan activity, so data quality and registration sources should be reviewed.";
  } else if (exceptionSummary.topExceptionType === "handshake_missing") {
    correlationInsight = "The campaign is missing Handshake data, so the coaching basis is incomplete.";
  } else if (weakest?.key === "trust" && exceptionSummary.topExceptionCategory === "technical") {
    correlationInsight = "Trust may have been affected by technical issues during the campaign.";
  } else if (weakest?.key === "relevance" && exceptionSummary.topExceptionCategory === "location") {
    correlationInsight = "Location issues may have reduced perceived relevance.";
  } else if (weakest?.key === "understanding" && exceptionSummary.topExceptionCategory === "staffing") {
    correlationInsight = "Staffing issues may have affected product explanation quality.";
  } else if (exceptionSummary.redExceptions.length > 0) {
    correlationInsight = "Critical exceptions may have affected execution quality and reporting confidence.";
  }

  const campaignCoach = {
    submittedCount: campaignAggregate.submittedCount,
    handshakeScore: campaignAggregate.handshakeScore,
    relevance: campaignAggregate.relevance,
    understanding: campaignAggregate.understanding,
    trust: campaignAggregate.trust,
    safety: campaignAggregate.safety,
    insight: campaignAggregate.insight,
    scans,
    uniqueScans,
    registrations,
    conversionRate,
    openExceptions: exceptionSummary.openExceptions.length,
    redExceptions: exceptionSummary.redExceptions.length,
    yellowExceptions: exceptionSummary.yellowExceptions.length,
    infoExceptions: exceptionSummary.infoExceptions.length,
    strongestSignal: campaignAggregate.strongestSignal,
    weakestSignal: campaignAggregate.weakestSignal,
    bestTeam,
    worstTeam,
    recommendationPriority: recommendation.priority,
  };

  return {
    model: "codedemo-ai-coach-v3-aggregated-rule-based",
    handshakeScore: campaignAggregate.handshakeScore,
    scans,
    uniqueScans,
    registrations,
    conversionRate,
    openExceptions: exceptionSummary.openExceptions.length,
    redExceptions: exceptionSummary.redExceptions.length,
    yellowExceptions: exceptionSummary.yellowExceptions.length,
    infoExceptions: exceptionSummary.infoExceptions.length,
    exceptionTypes: exceptionSummary.exceptionTypes,
    exceptionCategories: exceptionSummary.exceptionCategories,
    topExceptionType: exceptionSummary.topExceptionType,
    topExceptionCategory: exceptionSummary.topExceptionCategory,
    correlationInsight,
    strengthType,
    improvementType,
    recommendationType: recommendation.recommendationType,
    recommendationPriority: recommendation.priority,
    strength,
    improvement,
    recommendation: recommendation.recommendation,
    strongestSignal: campaignAggregate.strongestSignal,
    weakestSignal: campaignAggregate.weakestSignal,
    bestTeam,
    worstTeam,
    campaignCoach,
    teamCoach,
    activityCoach,
  };
}

async function checkCodeDemoAnalyticsExceptions({ eventCode, scanSummary = {}, registrationSummary = {} } = {}) {
  const uniqueScans = Number(scanSummary.uniqueScans || 0);
  const registrations = Number(registrationSummary.registrations || 0);
  const conversionRate = uniqueScans > 0 ? Math.round((registrations / uniqueScans) * 1000) / 10 : 0;

  if (!eventCode) return null;

  if (registrations > uniqueScans && registrations > 0) {
    return saveCodeDemoException({
      eventCode,
      severity: "red",
      category: "analytics",
      type: "scan_registration_mismatch",
      message: "Registrations exceed unique scans",
      details: {
        uniqueScans,
        registrations,
        conversionRate,
      },
    });
  }

  if (uniqueScans >= 50 && conversionRate < 5) {
    return saveCodeDemoException({
      eventCode,
      severity: "yellow",
      category: "analytics",
      type: "low_registration_conversion",
      message: "High scan activity has very low registration conversion",
      details: {
        uniqueScans,
        registrations,
        conversionRate,
      },
    });
  }

  if (registrations >= 25 && uniqueScans <= 5) {
    return saveCodeDemoException({
      eventCode,
      severity: "yellow",
      category: "analytics",
      type: "registration_spike",
      message: "Registration activity is unusually high compared with scan activity",
      details: {
        uniqueScans,
        registrations,
        conversionRate,
      },
    });
  }

  return null;
}

function formatCodeDemoHandshakeReport(row = {}) {
  const handshakeScore = Number(row.handshake_score ?? row.handshakeScore ?? row.total_score ?? 0);

  return {
    ...row,
    relevance: Number(row.relevance ?? 0),
    understanding: Number(row.understanding ?? row.product_understanding ?? 0),
    trust: Number(row.trust ?? 0),
    safety: Number(row.safety ?? 0),
    insight: Number(row.insight ?? 0),
    handshakeScore,
    totalScore: handshakeScore,
  };
}

async function resolveCodeDemoEvent(eventCode) {
  let eventId = null;
  let meta = null;

  if (process.env.REDIS_URL) {
    eventId =
      await redis.get(`eventcode:codedemo:${eventCode}`) ||
      await redis.get(`eventcode:${eventCode}`);

    if (eventId) {
      meta = await redis.hgetall(`event:${eventId}:meta`);
    }
  }

  if (!meta || !meta.id) {
    const memoryEvent = Object.values(events).find((item) => item.code === eventCode);
    if (memoryEvent) {
      eventId = memoryEvent.id;
      meta = memoryEvent;
    }
  }

  if (!meta || !meta.id) {
    const campaign = await getCampaignByCode(eventCode);
    if (campaign) {
      eventId = campaign.id;
      meta = {
        ...(campaign.raw_event || {}),
        id: campaign.id,
        code: campaign.event_code,
        name: campaign.name,
        venue: campaign.venue,
        city: campaign.city,
        startAt: campaign.start_at,
        unlockAt: campaign.unlock_at,
        endAt: campaign.end_at,
        status: campaign.status,
        dashboardAccessKey: campaign.dashboard_access_key,
        benefitInventory: campaign.benefit_inventory || {},
      };

      if (typeof meta.demoLocations === "string") {
        try {
          meta.demoLocations = JSON.parse(meta.demoLocations);
        } catch {
          meta.demoLocations = [];
        }
      }

      if (!Array.isArray(meta.demoLocations) && Array.isArray(campaign.raw_event?.demoLocations)) {
        meta.demoLocations = campaign.raw_event.demoLocations;
      }

      if ((!meta.demoLocation || !Object.keys(meta.demoLocation || {}).length) && Array.isArray(meta.demoLocations) && meta.demoLocations[0]) {
        meta.demoLocation = meta.demoLocations[0];
      }
    }
  }

  return { eventId, meta };
}

app.post("/codedemo/handshake", async (req, res) => {
  try {
    const eventCode = String(req.body?.eventCode || "").trim();

    if (!eventCode) {
      return res.status(400).json({ ok: false, error: "eventCode is required" });
    }

    const { meta } = await resolveCodeDemoEvent(eventCode);

    if (!meta || !meta.id) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const deadline = getCodeDemoHandshakeDeadline(meta, req.body || {});

    if (!deadline.ok) {
      return res.status(403).json({
        ok: false,
        error: "Handshake deadline expired",
        deadlineAt: deadline.deadlineAt,
        endAt: deadline.endAt,
      });
    }

    const payload = {
      ...buildCodeDemoHandshakePayload(req.body || {}, meta, eventCode),
      handshakeDeadlineAt: deadline.deadlineAt,
      handshakeSubmittedWithinDeadline: true,
    };

    const saved = await saveCodeDemoHandshakeReport(payload);
    const storedHandshake = saved || payload;
    const memoryKey = `${payload.demoDate || ''}|${payload.teamCode || ''}`;
    codeDemoHandshakeReports[eventCode] = codeDemoHandshakeReports[eventCode] || {};
    codeDemoHandshakeReports[eventCode][memoryKey] = storedHandshake;

    if (process.env.REDIS_URL) {
      await redis.set(`codedemo:handshake:${eventCode}`, JSON.stringify(payload));
    }

    return res.json({ ok: true, handshake: storedHandshake });
  } catch (error) {
    console.error("Save codeDemo handshake failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to save handshake" });
  }
});

app.get("/codedemo/handshake/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const demoDate = String(req.query?.date || "").trim();

    let reports = await getCodeDemoHandshakeReports({
      eventCode,
      demoDate: demoDate || undefined,
    });

    if (!reports.length && codeDemoHandshakeReports[eventCode]) {
      reports = Object.values(codeDemoHandshakeReports[eventCode])
        .filter((report) => !demoDate || String(report.demoDate || report.demo_date || '').slice(0, 10) === demoDate);
    }

    return res.json({ ok: true, eventCode, reports: reports.map(formatCodeDemoHandshakeReport) });
  } catch (error) {
    console.error("Get codeDemo handshake failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to get handshake" });
  }
});

app.post("/codedemo/handshake-missing/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const { eventId, meta } = await resolveCodeDemoEvent(eventCode);

    if (!meta || !meta.id) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const deadline = getCodeDemoHandshakeDeadline(meta, req.body || {});
    const reports = await getCodeDemoHandshakeReports({ eventCode });

    if (reports.length > 0) {
      return res.json({
        ok: true,
        eventCode,
        missing: false,
        reports: reports.length,
        deadlineAt: deadline.deadlineAt,
        endAt: deadline.endAt,
      });
    }

    if (!deadline.expired) {
      return res.json({
        ok: true,
        eventCode,
        missing: false,
        reports: 0,
        deadlineAt: deadline.deadlineAt,
        endAt: deadline.endAt,
        reason: "Handshake deadline has not passed",
      });
    }

    const exception = await saveCodeDemoException({
      eventCode,
      eventId: eventId || meta.id || "",
      parentEventCode: meta.parentEventCode || meta.parentCode || "",
      activityId: meta.activityId || meta.dailyDemoCode || eventCode,
      severity: "yellow",
      category: "handshake",
      type: "handshake_missing",
      message: "Handshake has not been submitted after activity deadline",
      details: {
        deadlineAt: deadline.deadlineAt,
        endAt: deadline.endAt,
        activityDate: meta.demoDate || String(meta.startAt || "").slice(0, 10),
        teamCode: meta.teamCode || "",
        teamLabel: meta.teamLabel || "",
        dailyDemoCode: meta.dailyDemoCode || "",
      },
    });

    return res.json({
      ok: true,
      eventCode,
      missing: true,
      exception,
    });
  } catch (error) {
    console.error("Check codeDemo handshake missing failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to check missing handshake" });
  }
});

app.post("/codedemo/exception/:eventCode", async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const body = req.body || {};

    if (!eventCode) {
      return res.status(400).json({ ok: false, error: "Missing event code" });
    }

    const category = String(body.category || "other").trim().slice(0, 80);
    const type = String(body.type || body.exceptionType || "manual_exception").trim().slice(0, 100);
    const severityInput = String(body.severity || "yellow").trim().toLowerCase();
    const severity = ["red", "yellow", "info"].includes(severityInput) ? severityInput : "yellow";
    const message = String(body.message || body.description || "").trim().slice(0, 1000);

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing exception description" });
    }

    const { eventId, meta } = await resolveCodeDemoEvent(eventCode);

    if (!meta || !meta.id) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const exception = await saveCodeDemoException({
      eventCode,
      eventId: eventId || meta?.id || "",
      parentEventCode: meta?.parentEventCode || meta?.parentCode || body.parentEventCode || "",
      activityId: body.activityId || meta?.activityId || meta?.dailyDemoCode || eventCode,
      severity,
      category,
      type,
      message,
      details: {
        source: "team_leader",
        reportedBy: String(body.reportedBy || body.teamLeaderName || "").trim().slice(0, 160),
        teamCode: String(body.teamCode || meta?.teamCode || "").trim().slice(0, 80),
        teamLabel: String(body.teamLabel || meta?.teamLabel || "").trim().slice(0, 120),
        locationName: String(body.locationName || meta?.locationName || meta?.demoLocation?.name || "").trim().slice(0, 180),
        activityDate: String(body.activityDate || meta?.demoDate || "").trim().slice(0, 40),
        note: message,
      },
    });

    return res.json({
      ok: true,
      eventCode,
      exception,
    });
  } catch (error) {
    console.error("Create codeDemo team exception failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to create exception" });
  }
});


app.patch("/codedemo/exceptions/:id/status", requireCodePerksAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const status = String(body.status || "").trim().toLowerCase();

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid exception id" });
    }

    const exception = await updateCodeDemoExceptionStatus({
      id,
      status,
      note: body.note || body.message || "",
      updatedBy: body.updatedBy || body.owner || "",
    });

    if (!exception) {
      return res.status(404).json({ ok: false, error: "Exception not found" });
    }

    return res.json({
      ok: true,
      exception,
    });
  } catch (error) {
    console.error("Update codeDemo exception status failed:", error.message);
    const statusCode = error.message === "Invalid exception status" ? 400 : 500;
    return res.status(statusCode).json({
      ok: false,
      error: error.message === "Invalid exception status" ? error.message : "Failed to update exception status",
    });
  }
});


app.get("/codedemo/team-exceptions/:eventCode", async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const status = String(req.query?.status || "open").trim().toLowerCase();
    const limit = Number(req.query?.limit || 50);

    if (!eventCode) {
      return res.status(400).json({ ok: false, error: "Missing event code" });
    }

    const safeStatus = status === "open" ? "open" : "open";

    const exceptions = await getCodeDemoExceptions({
      eventCode,
      status: safeStatus,
      limit,
    });

    const teamExceptions = exceptions.filter((item) => {
      const details = item.details || {};
      const source = String(details.source || "").toLowerCase();
      const category = String(item.category || "").toLowerCase();

      return source === "team_leader" || [
        "internet",
        "material",
        "materials",
        "staff",
        "delayed_start",
        "other",
      ].includes(category);
    });

    return res.json({
      ok: true,
      eventCode,
      count: teamExceptions.length,
      exceptions: teamExceptions,
    });
  } catch (error) {
    console.error("Get codeDemo team exceptions failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to get team exceptions" });
  }
});


app.patch("/codedemo/team-exceptions/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const status = String(body.status || "").trim().toLowerCase();

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid exception id" });
    }

    if (!["resolved", "unresolved"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid team exception status" });
    }

    const exception = await updateCodeDemoExceptionStatus({
      id,
      status,
      note: body.note || body.message || "",
      updatedBy: body.updatedBy || body.teamLabel || "team_leader",
    });

    if (!exception) {
      return res.status(404).json({ ok: false, error: "Exception not found" });
    }

    return res.json({
      ok: true,
      exception,
    });
  } catch (error) {
    console.error("Update codeDemo team exception status failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to update team exception status" });
  }
});


app.get("/codedemo/exceptions/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const status = String(req.query?.status || "").trim();
    const limit = Number(req.query?.limit || 50);

    const exceptions = await getCodeDemoExceptions({
      eventCode,
      status: status || undefined,
      limit,
    });

    return res.json({
      ok: true,
      eventCode,
      count: exceptions.length,
      exceptions,
    });
  } catch (error) {
    console.error("Get codeDemo exceptions failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to get codeDemo exceptions" });
  }
});


app.get("/codedemo/exceptions-latest", requireCodePerksAdmin, async (req, res) => {
  try {
    const limit = Number(req.query?.limit || 50);

    const exceptions = await getLatestCodeDemoExceptions(limit);

    return res.json({
      ok: true,
      count: exceptions.length,
      exceptions,
    });
  } catch (error) {
    console.error("Get latest codeDemo exceptions failed:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Failed to get latest codeDemo exceptions",
    });
  }
});

app.get("/codedemo/coach/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const demoDate = String(req.query?.date || "").trim();

    let reports = await getCodeDemoHandshakeReports({
      eventCode,
      demoDate: demoDate || undefined,
    });

    if (!reports.length && codeDemoHandshakeReports[eventCode]) {
      reports = Object.values(codeDemoHandshakeReports[eventCode])
        .filter((report) => !demoDate || String(report.demoDate || report.demo_date || '').slice(0, 10) === demoDate);
    }

    const formattedReports = reports.map(formatCodeDemoHandshakeReport);
    const primaryHandshake = formattedReports[0] || {};

    const exceptions = await getCodeDemoExceptions({
      eventCode,
      status: "open",
      limit: 50,
    });

    const scanSummary = await getEventScanSummary(eventCode);
    const registrationSummary = await getEventRegistrationSummary(eventCode);

    await checkCodeDemoAnalyticsExceptions({
      eventCode,
      scanSummary,
      registrationSummary,
    });

    const refreshedExceptions = await getCodeDemoExceptions({
      eventCode,
      status: "open",
      limit: 50,
    });

    const coach = generateCodeDemoCoach({
      handshake: primaryHandshake,
      handshakes: formattedReports,
      exceptions: refreshedExceptions,
      scans: scanSummary.scans,
      uniqueScans: scanSummary.uniqueScans,
      registrations: registrationSummary.registrations,
    });

    return res.json({
      ok: true,
      eventCode,
      date: demoDate || "",
      coach,
      handshake: primaryHandshake,
      handshakes: formattedReports,
      campaignCoach: coach.campaignCoach,
      teamCoach: coach.teamCoach,
      activityCoach: coach.activityCoach,
      exceptions: refreshedExceptions,
      scans: scanSummary,
      registrations: registrationSummary,
    });
  } catch (error) {
    console.error("Get codeDemo AI Coach failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to get AI Coach" });
  }
});

app.get("/codedemo/handshake-report/:parentEventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const parentEventCode = String(req.params.parentEventCode || "").trim();
    const demoDate = String(req.query?.date || "").trim();

    let reports = await getCodeDemoHandshakeReports({
      parentEventCode,
      demoDate: demoDate || undefined,
    });

    if (!reports.length) {
      reports = await getCodeDemoHandshakeReports({
        eventCode: parentEventCode,
        demoDate: demoDate || undefined,
      });
    }

    return res.json({
      ok: true,
      parentEventCode,
      date: demoDate || "",
      reports: reports.map(formatCodeDemoHandshakeReport),
    });
  } catch (error) {
    console.error("Get codeDemo handshake report failed:", error.message);
    return res.status(500).json({ ok: false, error: "Failed to get handshake report" });
  }
});


app.post("/codepod/landing-track", async (req, res) => {
  try {
    const src = String(req.body?.src || "").trim();
    if (!/^[1-5]$/.test(src)) {
      return res.json({ success: true });
    }

    if (process.env.REDIS_URL) {
      const entry = {
        src,
        campaign: "pilot_indie_podcast_2026",
        path: String(req.body?.path || "").trim(),
        href: String(req.body?.href || "").trim(),
        userAgent: String(req.headers["user-agent"] || ""),
        ip: String(
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          ""
        ),
        createdAt: new Date().toISOString(),
      };

      await redis.rpush(
        "codepod:landingTrack:pilot_indie_podcast_2026",
        JSON.stringify(entry)
      );

      const emailSentKey = `codepod:landingTrack:emailSent:${src}:${entry.createdAt.slice(0, 10)}`;
      const shouldSendEmail = await redis.set(emailSentKey, "1", "NX", "EX", 86400);

      if (shouldSendEmail) {
        try {
          const srcNameById = {
            1: "Wolfgang Wee Uncut",
            2: "Leger om livet",
            3: "Synnøve",
            4: "Jan Thomas",
            5: "Fetisha",
          };
          const srcName = srcNameById[src] || "";
          const subject = `codePod pilot: src=${src} åpnet`;
          const text = [
            `src: ${src}`,
            srcName ? `name: ${srcName}` : "",
            `createdAt: ${entry.createdAt}`,
            `href: ${entry.href}`,
            `ip: ${entry.ip}`,
            `userAgent: ${entry.userAgent}`,
          ].filter(Boolean).join("\n");
          const html = `
            <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:640px;">
              <h2>codePod pilotlenke åpnet</h2>
              <p><strong>src:</strong> ${escapeHtml(src)}</p>
              ${srcName ? `<p><strong>name:</strong> ${escapeHtml(srcName)}</p>` : ""}
              <p><strong>createdAt:</strong> ${escapeHtml(entry.createdAt)}</p>
              <p><strong>href:</strong> ${escapeHtml(entry.href)}</p>
              <p><strong>ip:</strong> ${escapeHtml(entry.ip)}</p>
              <p><strong>userAgent:</strong> ${escapeHtml(entry.userAgent)}</p>
            </div>
          `;

          await sendEmail({
            to: "jan@codenxt.global",
            subject,
            html,
            text,
          });
        } catch (emailError) {
          console.warn("codePod landing track email failed:", emailError.message);
        }
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("codePod landing track failed:", error.message);
    return res.json({ success: true });
  }
});


app.get("/codepod/landing-track/latest", async (req, res) => {
  try {
    if (!process.env.REDIS_URL) {
      return res.json({ success: true, count: 0, rows: [] });
    }

    const rawRows = await redis.lrange(
      "codepod:landingTrack:pilot_indie_podcast_2026",
      -50,
      -1
    );

    const rows = (rawRows || [])
      .map((row) => {
        try {
          return JSON.parse(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    return res.json({
      success: true,
      count: rows.length,
      rows,
    });
  } catch (error) {
    console.error("codePod landing track latest failed:", error.message);
    return res.status(500).json({ success: false, error: "Failed to read landing track" });
  }
});


// GET REPORT
app.get("/codepod/report/:eventCode", async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    if (!eventCode) {
      return res.status(400).json({ ok: false, error: "Missing event code" });
    }

    let eventId = null;
    let meta = Object.values(events).find(
      (item) => item?.code === eventCode && String(item?.vertical || "").trim().toLowerCase() === "codepod"
    ) || null;

    if (meta?.id) eventId = meta.id;

    if ((!meta || !eventId) && process.env.REDIS_URL) {
      const resolvedId =
        await redis.get(`eventcode:codepod:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (resolvedId) {
        eventId = resolvedId;
        const redisMeta = await redis.hgetall(`event:${resolvedId}:meta`);
        if (redisMeta && redisMeta.id && String(redisMeta.vertical || "").trim().toLowerCase() === "codepod") {
          meta = redisMeta;
        }
      }
    }

    if ((!meta || !meta.id) && getCampaignByCode) {
      const campaign = await getCampaignByCode(eventCode);
      const rawEvent = campaign?.raw_event || null;
      const campaignVertical = String(campaign?.vertical || rawEvent?.vertical || "").trim().toLowerCase();

      if (campaign && campaignVertical === "codepod") {
        meta = rawEvent || campaign;
        eventId = meta.id || campaign.id || eventId;
      }
    }

    if (!meta) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const partnerReward = normalizeCodePodPartnerReward(meta.partnerReward || {});
    const digitalSouvenir = normalizeCodePodDigitalSouvenir(meta.digitalSouvenir || {});
    const rows = await getCodePodReportRows(eventCode, "codepod");
    const registrations = await getEventRegistrations(eventCode, 1000, "codepod");
    let keywordSummary = {
      totalInteractions: 0,
      assigned: 0,
      noReward: 0,
      exhausted: 0,
      tiers: {
        gold: 0,
        silver: 0,
        general: 0,
      },
    };

    try {
      keywordSummary = await database.getCodePodKeywordInteractionSummary(eventCode);
    } catch (keywordSummaryError) {
      console.warn("codePod keyword report summary failed:", keywordSummaryError.message);
    }

    const phoneByScanId = new Map(
      registrations
        .filter((registration) => registration.scan_id && registration.phone)
        .map((registration) => [String(registration.scan_id), String(registration.phone)])
    );

    const scanTierByScanId = new Map(
      rows
        .filter((row) => row.scan_id)
        .map((row) => [String(row.scan_id), {
          tier: String(row.tier || "").trim().toLowerCase(),
          displayTier: row.display_tier || row.tier || "",
        }])
    );

    const registrationRows = registrations.map((registration) => {
      const scanTier = scanTierByScanId.get(String(registration.scan_id || "")) || {};
      return {
        eventCode: registration.event_code || eventCode,
        eventId: registration.event_id || eventId || "",
        scanId: registration.scan_id || "",
        phone: registration.phone || "",
        timestamp: registration.created_at ? new Date(registration.created_at).toISOString() : "",
        tier: scanTier.tier || registration.tier || "",
        displayTier: scanTier.displayTier || registration.tier || "",
        source: "inside",
      };
    });

    const scans = rows.map((row) => {
      const tier = String(row.tier || "").trim().toLowerCase();
      const redemptionToken = row.redemption_token || "";

      return {
        eventCode: row.event_code || eventCode,
        eventId: row.event_id || eventId || "",
        scanId: row.scan_id || "",
        phone: phoneByScanId.get(String(row.scan_id || "")) || "",
        scanRank: row.scan_rank || null,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : "",
        tier,
        digitalSouvenirTier: tier,
        displayTier: row.display_tier || "",
        rewardType: row.reward_type || "",
        goldXtraAssigned: Boolean(redemptionToken),
        redemptionToken,
        redemptionStatus: row.redemption_status || "",
        redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
        alreadyRedeemedAttempts: Number(row.already_redeemed_attempts || 0),
        source: "qr",
      };
    });

    const uniqueScanIds = new Set(scans.map((row) => row.scanId).filter(Boolean));
    const tierCount = (tier) => scans.filter((row) => row.tier === tier).length;
    const goldXtraRows = scans.filter((row) => row.goldXtraAssigned);

    let rawScans = scans.length;
    let uniqueScans = uniqueScanIds.size;
    let joins = registrationRows.length;

    try {
      const scanSummary = await getEventScanSummary(eventCode, "codepod");
      const registrationSummary = await getEventRegistrationSummary(eventCode, "codepod");
      rawScans = Number(scanSummary.scans || rawScans || 0);
      uniqueScans = Number(scanSummary.uniqueScans || uniqueScans || 0);
      joins = Number(registrationSummary.registrations || 0);
    } catch (summaryError) {
      console.warn("codePod report Postgres summary failed:", summaryError.message);
      rawScans = Number(meta.rawScans || rawScans || 0);
      uniqueScans = Number(meta.uniqueScans || uniqueScans || 0);
      joins = Number(meta.innerCircleJoinCount || joins || 0);
    }

    return res.json({
      ok: true,
      vertical: "codepod",
      eventCode,
      event: {
        eventCode,
        eventId: eventId || meta.id || "",
        podcastName: meta.podcastName || meta.artistName || meta.name || "",
        episodeTitle: meta.episodeTitle || meta.title || meta.venue || "",
        startAt: meta.startAt || "",
        endAt: meta.endAt || "",
        digitalSouvenir,
        partnerReward,
      },
      totalScans: rawScans,
      uniqueScans,
      joins,
      registrationCount: joins,
      rows: scans,
      registrations: registrationRows,
      metrics: {
        scans: rawScans,
        uniqueScans,
        joins,
        registrations: joins,
        gold: tierCount("gold"),
        silver: tierCount("silver"),
        general: tierCount("general"),
        goldXtraAssigned: goldXtraRows.length,
        goldXtraRedeemed: goldXtraRows.filter((row) => row.redemptionStatus === "redeemed").length,
        alreadyRedeemedAttempts: scans.reduce((sum, row) => sum + Number(row.alreadyRedeemedAttempts || 0), 0),
      },
      keywordSummary,
      scans,
    });
  } catch (err) {
    console.error("Get codePod report failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to get codePod report" });
  }
});

app.get("/codeclip/report/:eventCode", async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    if (!eventCode) {
      return res.status(400).json({ ok: false, error: "Missing event code" });
    }

    let eventId = null;
    let meta = Object.values(events).find(
      (item) => item?.code === eventCode && String(item?.vertical || "").trim().toLowerCase() === "codeclip"
    ) || null;

    if (meta?.id) eventId = meta.id;

    if ((!meta || !eventId) && process.env.REDIS_URL) {
      const resolvedId =
        await redis.get(`eventcode:codeclip:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (resolvedId) {
        eventId = resolvedId;
        const redisMeta = await redis.hgetall(`event:${resolvedId}:meta`);
        if (redisMeta && redisMeta.id && String(redisMeta.vertical || "").trim().toLowerCase() === "codeclip") {
          meta = redisMeta;
        }
      }
    }

    if ((!meta || !meta.id) && getCampaignByCode) {
      const campaign = await getCampaignByCode(eventCode);
      const rawEvent = campaign?.raw_event || null;
      const campaignVertical = String(campaign?.vertical || rawEvent?.vertical || "").trim().toLowerCase();

      if (campaign && campaignVertical === "codeclip") {
        meta = rawEvent || campaign;
        eventId = meta.id || campaign.id || eventId;
      }
    }

    if (!meta) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const report = await codeClipVertical.report.buildCodeClipReport(eventCode, {
      getCodeClipInteractions,
      getCodeClipRewardAssignments,
      getCodeClipRewardAssignmentSummary,
      getEventScanSummary: (code) => getEventScanSummary(code, "codeclip"),
      getEventRegistrations: (code, limit) => getEventRegistrations(code, limit, "codeclip"),
      getEventRegistrationSummary: (code) => getEventRegistrationSummary(code, "codeclip"),
    });

    return res.json({
      ...report,
      event: {
        ...report.event,
        eventCode,
        eventId: eventId || meta.id || "",
        podcastName: meta.podcastName || meta.artistName || meta.name || "",
        episodeTitle: meta.episodeTitle || meta.title || meta.venue || "",
        startAt: meta.startAt || "",
        endAt: meta.endAt || "",
        activationMethod: normalizeActivationMethod(meta.activationMethod),
        activationKeyword: String(meta.activationKeyword || "").trim(),
        activationChannels: normalizeActivationChannels(meta.activationChannels),
      },
    });
  } catch (err) {
    console.error("Get codeClip report failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to get codeClip report" });
  }
});

app.post("/codepod/keyword-entry", async (req, res) => {
  try {
    const normalized = codePodVertical.service.normalizeCodePodKeywordAudienceEntry({
      eventCode: req.body?.eventCode,
      entryCode: req.body?.entryCode,
      keyword: req.body?.keyword,
      messageId: req.body?.messageId,
      provider: req.body?.provider,
      providerAccountId: req.body?.providerAccountId,
      requestedVertical: "codepod",
    });

    if (!normalized.ok) {
      return res.status(400).json({
        ok: false,
        vertical: "codepod",
        source: "keyword",
        transport: "message",
        errors: normalized.errors,
      });
    }

    if (!normalized.audienceEntry.messageId) {
      return res.status(400).json({
        ok: false,
        vertical: "codepod",
        source: "keyword",
        transport: "message",
        errors: [{
          code: "MESSAGE_ID_REQUIRED",
          message: "messageId is required",
        }],
      });
    }

    const resolvedEvent = await resolveCodePodKeywordEvent(
      normalized.audienceEntry.eventCode
    );

    if (!resolvedEvent.event || !resolvedEvent.eventId) {
      return res.status(404).json({
        ok: false,
        vertical: "codepod",
        source: "keyword",
        transport: "message",
        error: "Event not found",
      });
    }

    const keywordMatch = codePodVertical.service.matchCodePodActivationKeyword({
      event: resolvedEvent.event,
      keyword: normalized.audienceEntry.keyword,
    });

    if (!keywordMatch.matched) {
      return res.status(422).json({
        ok: false,
        vertical: "codepod",
        source: "keyword",
        transport: "message",
        routingOutcome: "NO_MATCH",
        reason: "NO_MATCH",
      });
    }

    let existingKeywordInteraction = null;
    try {
      existingKeywordInteraction = await database.getCodePodKeywordInteraction(
        normalized.audienceEntry.eventCode,
        normalized.audienceEntry.messageId
      );
    } catch (dbError) {
      console.warn("codePod keyword interaction read failed", {
        eventCode: normalized.audienceEntry.eventCode,
        reason: dbError.message,
      });
    }

    let digitalSouvenirAssignment = existingKeywordInteraction?.rewardAssignment || null;
    if (existingKeywordInteraction && !digitalSouvenirAssignment) {
      console.warn("codePod stored keyword interaction is missing reward assignment", {
        eventCode: normalized.audienceEntry.eventCode,
      });
    } else if (!existingKeywordInteraction) {
      digitalSouvenirAssignment = await assignCodePodDigitalSouvenirTier(
        normalized.audienceEntry.eventCode,
        normalized.audienceEntry.messageId,
        resolvedEvent.event.digitalSouvenir,
        resolvedEvent.event
      );
    }

    const buildKeywordRuntimeChain = () => {
      const input = {
        audienceEntry: normalized.audienceEntry,
        audienceIntent: normalized.audienceIntent,
      };

      if (digitalSouvenirAssignment) {
        input.rewardAssignmentResult = {
          tier: digitalSouvenirAssignment.tier,
          digitalSouvenir: digitalSouvenirAssignment,
          goldXtra: null,
        };
      }

      return codePodVertical.service.buildCodePodRuntimeChain(input);
    };

    let codePodRuntimeChain = buildKeywordRuntimeChain();
    let persistenceResult = existingKeywordInteraction && digitalSouvenirAssignment
      ? {
          attempted: true,
          persisted: true,
          status: "reused",
          action: "reuse_keyword_interaction",
          mode: "operational",
        }
      : {
          attempted: true,
          persisted: false,
          status: "degraded",
          action: "none",
          mode: "operational",
        };

    if (!existingKeywordInteraction) {
      try {
        const insertedKeywordInteraction = await database.insertCodePodKeywordInteraction({
          eventCode: normalized.audienceEntry.eventCode,
          eventId: resolvedEvent.eventId,
          messageId: normalized.audienceEntry.messageId,
          keyword: normalized.audienceEntry.keyword,
          routingOutcome: codePodRuntimeChain.routingOutcome.routingOutcome,
          tier: digitalSouvenirAssignment.tier,
          assignmentStatus: codePodRuntimeChain.rewardAssignmentSnapshot.assignmentStatus,
          interaction: {
            ...codePodRuntimeChain.interaction,
            eventId: resolvedEvent.eventId,
          },
          rewardAssignment: digitalSouvenirAssignment,
          occurredAt: codePodRuntimeChain.interaction.timestamp,
        });

        if (insertedKeywordInteraction) {
          persistenceResult = {
            attempted: true,
            persisted: true,
            status: "persisted",
            action: "upsert_keyword_interaction",
            mode: "operational",
          };
        } else {
          const conflictingKeywordInteraction = await database.getCodePodKeywordInteraction(
            normalized.audienceEntry.eventCode,
            normalized.audienceEntry.messageId
          );

          if (conflictingKeywordInteraction) {
            existingKeywordInteraction = conflictingKeywordInteraction;
            digitalSouvenirAssignment = conflictingKeywordInteraction.rewardAssignment || null;
            codePodRuntimeChain = buildKeywordRuntimeChain();
            if (digitalSouvenirAssignment) {
              persistenceResult = {
                attempted: true,
                persisted: true,
                status: "reused",
                action: "reuse_keyword_interaction",
                mode: "operational",
              };
            } else {
              console.warn("codePod conflicting keyword interaction is missing reward assignment", {
                eventCode: normalized.audienceEntry.eventCode,
              });
            }
          }
        }
      } catch (dbError) {
        console.warn("codePod keyword interaction persistence failed", {
          eventCode: normalized.audienceEntry.eventCode,
          reason: dbError.message,
        });
      }
    }

    codePodRuntimeChain = codePodVertical.service.applyCodePodPersistenceResult(
      codePodRuntimeChain,
      persistenceResult
    );

    const responsePayload = {
      ok: true,
      vertical: "codepod",
      source: "keyword",
      transport: "message",
      eventCode: normalized.audienceEntry.eventCode,
      keyword: normalized.audienceEntry.keyword,
      audienceEntry: normalized.audienceEntry,
      audienceIntent: normalized.audienceIntent,
      interaction: codePodRuntimeChain.interaction,
      routingOutcome: codePodRuntimeChain.routingOutcome,
    };

    if (digitalSouvenirAssignment) {
      responsePayload.tier = digitalSouvenirAssignment.tier;
      responsePayload.digitalSouvenir = digitalSouvenirAssignment;
      responsePayload.exhausted = Boolean(digitalSouvenirAssignment.exhausted);
      responsePayload.noReward = Boolean(digitalSouvenirAssignment.noReward);
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error("codePod keyword entry failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to process keyword entry" });
  }
});

app.post("/codeclip/keyword-entry", async (req, res) => {
  try {
    const eventCode = String(req.body?.eventCode || "").trim();
    const keyword = String(req.body?.keyword || "").trim();
    const messageId = String(req.body?.messageId || "").trim();

    if (!eventCode || !keyword || !messageId) {
      return res.status(400).json({ ok: false, error: "eventCode, keyword and messageId are required" });
    }

    let eventId = null;
    let meta = Object.values(events).find(
      (item) => item?.code === eventCode && String(item?.vertical || "").trim().toLowerCase() === "codeclip"
    ) || null;

    if (meta?.id) eventId = meta.id;

    if ((!meta || !eventId) && process.env.REDIS_URL) {
      const resolvedId =
        await redis.get(`eventcode:codeclip:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (resolvedId) {
        eventId = resolvedId;
        const redisMeta = await redis.hgetall(`event:${resolvedId}:meta`);
        if (redisMeta && redisMeta.id && String(redisMeta.vertical || "").trim().toLowerCase() === "codeclip") {
          meta = redisMeta;
        }
      }
    }

    if ((!meta || !meta.id) && getCampaignByCode) {
      const campaign = await getCampaignByCode(eventCode);
      const rawEvent = campaign?.raw_event || null;
      const campaignVertical = String(campaign?.vertical || rawEvent?.vertical || "").trim().toLowerCase();

      if (campaign && campaignVertical === "codeclip") {
        meta = rawEvent || campaign;
        eventId = meta.id || campaign.id || eventId;
      }
    }

    if (!meta || String(meta.vertical || "").trim().toLowerCase() !== "codeclip") {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const result = await codeClipVertical.service.handleCodeClipKeywordEntry({
      event: meta,
      eventCode,
      eventId: eventId || meta.id || "",
      keyword,
      messageId,
      requestedVertical: "codeclip",
      redis: process.env.REDIS_URL ? redis : null,
      codeClipVertical,
      saveCodeClipInteraction,
      saveCodeClipRewardAssignments,
      saveCodeClipXtraRedemption,
      runCodeClipCorePersistenceTransaction: withCodeClipCorePersistenceTransaction,
      saveCodeClipOutboxEvent,
    });

    return res.status(result.httpStatus).json(result.payload);
  } catch (err) {
    console.error("codeClip keyword entry failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to process keyword entry" });
  }
});

app.post("/codeclip/test-provider/keyword", async (req, res) => {
  try {
    const { normalizeProviderKeywordIngress } = require("./verticals/codeclip/provider-adapters");
    const normalizedProviderInput = normalizeProviderKeywordIngress("test", req.body || {});

    if (!normalizedProviderInput.ok) {
      return res.status(400).json({ ok: false, error: "eventCode, text and messageId are required" });
    }

    const { eventCode, keyword, messageId } = normalizedProviderInput;
    let eventId = null;
    let meta = Object.values(events).find(
      (item) => item?.code === eventCode && String(item?.vertical || "").trim().toLowerCase() === "codeclip"
    ) || null;

    if (meta?.id) eventId = meta.id;

    if ((!meta || !eventId) && process.env.REDIS_URL) {
      const resolvedId =
        await redis.get(`eventcode:codeclip:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (resolvedId) {
        eventId = resolvedId;
        const redisMeta = await redis.hgetall(`event:${resolvedId}:meta`);
        if (redisMeta && redisMeta.id && String(redisMeta.vertical || "").trim().toLowerCase() === "codeclip") {
          meta = redisMeta;
        }
      }
    }

    if ((!meta || !meta.id) && getCampaignByCode) {
      const campaign = await getCampaignByCode(eventCode);
      const rawEvent = campaign?.raw_event || null;
      const campaignVertical = String(campaign?.vertical || rawEvent?.vertical || "").trim().toLowerCase();

      if (campaign && campaignVertical === "codeclip") {
        meta = rawEvent || campaign;
        eventId = meta.id || campaign.id || eventId;
      }
    }

    if (!meta || String(meta.vertical || "").trim().toLowerCase() !== "codeclip") {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    const result = await codeClipVertical.service.handleCodeClipKeywordEntry({
      event: meta,
      eventCode,
      eventId: eventId || meta.id || "",
      keyword,
      messageId,
      requestedVertical: "codeclip",
      redis: process.env.REDIS_URL ? redis : null,
      codeClipVertical,
      saveCodeClipInteraction,
      saveCodeClipRewardAssignments,
      saveCodeClipXtraRedemption,
      runCodeClipCorePersistenceTransaction: withCodeClipCorePersistenceTransaction,
      saveCodeClipOutboxEvent,
    });

    return res.status(result.httpStatus).json(result.payload);
  } catch (err) {
    console.error("codeClip test provider keyword failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to process test provider keyword" });
  }
});

function buildCodeClipProviderPayloadFingerprint(rawBody) {
  if (Buffer.isBuffer(rawBody)) {
    return crypto.createHash("sha256").update(rawBody).digest("hex");
  }
  if (typeof rawBody === "string") {
    return crypto.createHash("sha256").update(rawBody).digest("hex");
  }
  return null;
}

function sendCodeClipProviderLedgerFailure(res) {
  return res.status(503).json({
    ok: false,
    error: "Provider keyword processing unavailable",
  });
}

function isCodeClipProviderDeliveryUpdateConfirmed(result) {
  return result?.status === "updated" && Boolean(result.row);
}

function getCodeClipCorePersistenceState(result = {}) {
  const status = result.internal?.persistenceStatus;
  if (!status) return "unknown";

  const steps = [
    status.interaction,
    status.rewardAssignments,
    status.clipXtraRedemption,
  ].filter(Boolean);
  const failed = steps.some((step) => step.attempted && step.ok === false);
  if (failed) return "failed";

  const attempted = steps.filter((step) => step.attempted);
  if (!attempted.length) return "unknown";

  return attempted.every((step) => step.ok === true && step.committed === true)
    ? "committed"
    : "unknown";
}

function getCodeClipDurableProviderReplay(delivery = null) {
  if (!delivery) return null;
  if (delivery.corePersistenceState !== "committed") return null;
  if (delivery.completionState !== "completed") return null;
  if (delivery.processingState !== "completed") return null;
  if (delivery.terminalState !== true) return null;
  if (delivery.retryEligible !== false) return null;
  if (!delivery.publicResponseJson || typeof delivery.publicResponseJson !== "object") return null;

  const httpStatus = delivery.responseStatus;
  if (
    !Number.isInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus > 299
  ) {
    return null;
  }

  return {
    httpStatus,
    payload: delivery.publicResponseJson,
  };
}

async function handleCodeClipProviderKeywordRoute(req, res) {
  try {
    const expectedToken = process.env.CODECLIP_PROVIDER_WEBHOOK_TOKEN || "";
    const providedToken = String(req.headers["x-codeclip-provider-token"] || "").trim();

    if (expectedToken && providedToken !== expectedToken) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { normalizeProviderKeywordIngress } = require("./verticals/codeclip/provider-adapters");
    const {
      verifyCodeClipProviderWebhook,
    } = require("./verticals/codeclip/provider-webhook-verification");
    const {
      buildCodeClipProviderVerificationRequest,
      resolveCodeClipProviderPolicy,
    } = require("./verticals/codeclip/provider-policy");
    const {
      normalizeCodeClipProviderEnvelope,
    } = require("./verticals/codeclip/provider-envelope-normalizer");
    const {
      buildCodeClipProviderActivationRequest,
    } = require("./verticals/codeclip/provider-activation-request");
    const {
      buildProviderKeywordIdempotencyKey,
      claimProviderKeywordIdempotency,
      readProviderKeywordResponse,
      recordProviderKeywordResponse,
    } = require("./verticals/codeclip/provider-idempotency");
    const {
      enforceCodeClipProviderRateLimit,
      getCodeClipProviderPeerIdentity,
    } = require("./verticals/codeclip/provider-rate-limit");
    const normalizedProvider = String(req.params.provider || "").trim().toLowerCase();
    const providerPolicy = resolveCodeClipProviderPolicy(normalizedProvider);
    if (!providerPolicy.ok) {
      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    const liveProvider = Boolean(providerPolicy.policy.capabilities?.liveProvider);
    const preVerificationRateLimit = await enforceCodeClipProviderRateLimit({
      redis,
      redisEnabled: Boolean(process.env.REDIS_URL),
      provider: normalizedProvider,
      phase: "pre-verification",
      identity: getCodeClipProviderPeerIdentity(req),
      liveProvider,
      requireStore: false,
    });
    if (!preVerificationRateLimit.ok) {
      return res.status(preVerificationRateLimit.status).json({
        ok: false,
        error: preVerificationRateLimit.error,
      });
    }

    const webhookVerification = verifyCodeClipProviderWebhook(buildCodeClipProviderVerificationRequest({
      policy: providerPolicy.policy,
      provider: req.params.provider,
      headers: req.headers || {},
      rawBody: req.codeClipRawBody || "",
    }));

    if (!webhookVerification.ok) {
      console.warn("codeClip provider verification rejected", {
        provider: normalizedProvider,
        route: "/codeclip/provider/:provider/keyword",
        reason: webhookVerification.reason,
        status: 400,
      });
      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    const providerEnvelope = normalizeCodeClipProviderEnvelope({
      provider: req.params.provider,
      body: req.body || {},
      headers: req.headers || {},
      query: req.query || {},
    });

    if (!providerEnvelope.ok) {
      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    const providerAccountId = String(providerEnvelope.envelope.providerAccountId || "").trim();
    if (liveProvider && !providerAccountId) {
      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    const postVerificationIdentity =
      providerAccountId ||
      providerEnvelope.envelope.senderId ||
      "non-live-provider";
    const postVerificationRateLimit = await enforceCodeClipProviderRateLimit({
      redis,
      redisEnabled: Boolean(process.env.REDIS_URL),
      provider: normalizedProvider,
      phase: "post-verification",
      identity: postVerificationIdentity,
      liveProvider,
      requireStore: liveProvider,
    });
    if (!postVerificationRateLimit.ok) {
      return res.status(postVerificationRateLimit.status).json({
        ok: false,
        error: postVerificationRateLimit.error,
      });
    }

    const providerAdapterInput = {
      ...(req.body || {}),
      text: providerEnvelope.envelope.text,
      messageId: providerEnvelope.envelope.messageId,
      providerAccountId: providerEnvelope.envelope.providerAccountId,
    };
    const normalizedProviderInput = normalizeProviderKeywordIngress(req.params.provider, providerAdapterInput);
    const activationRequest = buildCodeClipProviderActivationRequest({
      provider: req.params.provider,
      normalizedProviderInput,
      body: providerAdapterInput,
      headers: req.headers || {},
      metadata: providerEnvelope.envelope.metadata,
      events,
    });

    if (!activationRequest.ok) {
      if (["PROVIDER_REQUIRED", "KEYWORD_REQUIRED"].includes(activationRequest.reason)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid provider keyword payload",
          reason: activationRequest.reason,
        });
      }

      if (activationRequest.reason === "AMBIGUOUS_MATCH") {
        return res.status(409).json({
          ok: false,
          error: "Ambiguous provider activation match",
          reason: activationRequest.reason,
        });
      }

      if (activationRequest.reason === "NO_MATCH") {
        return res.status(404).json({
          ok: false,
          error: "Event not found",
          reason: activationRequest.reason,
        });
      }

      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    let { eventCode, keyword, messageId } = activationRequest;
    let eventId = null;
    let meta = activationRequest.event || null;

    if (meta?.id) eventId = meta.id;

    if ((!meta || !eventId) && process.env.REDIS_URL) {
      const resolvedId =
        await redis.get(`eventcode:codeclip:${eventCode}`) ||
        await redis.get(`eventcode:${eventCode}`);

      if (resolvedId) {
        eventId = resolvedId;
        const redisMeta = await redis.hgetall(`event:${resolvedId}:meta`);
        if (redisMeta && redisMeta.id && String(redisMeta.vertical || "").trim().toLowerCase() === "codeclip") {
          meta = redisMeta;
        }
      }
    }

    if ((!meta || !meta.id) && getCampaignByCode) {
      const campaign = await getCampaignByCode(eventCode);
      const rawEvent = campaign?.raw_event || null;
      const campaignVertical = String(campaign?.vertical || rawEvent?.vertical || "").trim().toLowerCase();

      if (campaign && campaignVertical === "codeclip") {
        meta = rawEvent || campaign;
        eventId = meta.id || campaign.id || eventId;
      }
    }

    if (!meta || String(meta.vertical || "").trim().toLowerCase() !== "codeclip") {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    eventCode = String(eventCode || meta.code || "").trim();
    const idempotencyKey = buildProviderKeywordIdempotencyKey({
      ...activationRequest.idempotency,
      eventCode,
    });
    const requiresIdempotencyStore = Boolean(
      providerPolicy.policy.capabilities?.liveProvider &&
      providerPolicy.policy.idempotency?.requireStoreForLiveProvider
    );

    if (requiresIdempotencyStore && !idempotencyKey) {
      return res.status(400).json({ ok: false, error: "Invalid provider keyword payload" });
    }

    const providerDeliveryIdentity = liveProvider
      ? {
          provider: normalizedProvider,
          providerAccountId,
          eventCode,
          externalMessageId: messageId,
        }
      : null;
    let providerDeliveryRecord = null;
    if (liveProvider) {
      const deliveryRecord = await createCodeClipProviderDelivery({
        ...providerDeliveryIdentity,
        eventId: eventId || null,
        idempotencyKey,
        payloadFingerprint: buildCodeClipProviderPayloadFingerprint(req.codeClipRawBody),
        verificationState: "verified",
        processingState: "processing",
        corePersistenceState: "not_started",
        completionState: "not_completed",
      });

      if (deliveryRecord.status === "failed") {
        console.warn("codeClip provider delivery ledger rejected", {
          provider: normalizedProvider,
          route: "/codeclip/provider/:provider/keyword",
          reason: "DELIVERY_LEDGER_UNAVAILABLE",
        });
        return sendCodeClipProviderLedgerFailure(res);
      }
      providerDeliveryRecord = deliveryRecord.row;
    }

    if (requiresIdempotencyStore && !process.env.REDIS_URL) {
      return res.status(503).json({
        ok: false,
        error: "Provider keyword processing unavailable",
      });
    }

    let idempotencyClaim = { enabled: false, claimed: true };
    if (process.env.REDIS_URL) {
      try {
        idempotencyClaim = await claimProviderKeywordIdempotency({
          redis,
          key: idempotencyKey,
          ttlSeconds: providerPolicy.policy.idempotency?.claimTtlSeconds || 300,
        });
      } catch (idempotencyError) {
        console.warn("codeClip provider idempotency rejected", {
          provider: normalizedProvider,
          route: "/codeclip/provider/:provider/keyword",
          reason: "IDEMPOTENCY_STORE_UNAVAILABLE",
          status: requiresIdempotencyStore ? 503 : 500,
        });

        if (requiresIdempotencyStore) {
          return res.status(503).json({
            ok: false,
            error: "Provider keyword processing unavailable",
          });
        }

        throw idempotencyError;
      }
    }

    if (idempotencyClaim.enabled && !idempotencyClaim.claimed) {
      const storedResponse = await readProviderKeywordResponse({
        redis,
        key: idempotencyKey,
      });

      if (storedResponse) {
        if (liveProvider) {
          if (providerDeliveryRecord?.corePersistenceState !== "committed") {
            console.warn("codeClip provider delivery replay rejected", {
              provider: normalizedProvider,
              route: "/codeclip/provider/:provider/keyword",
              reason: "DELIVERY_REPLAY_WITHOUT_DURABLE_COMMIT",
            });
            return sendCodeClipProviderLedgerFailure(res);
          }

          const replayUpdate = await updateCodeClipProviderDeliveryState(
            providerDeliveryIdentity,
            {
              processingState: "completed",
              completionState: "completed",
              responseStatus: 200,
              publicResponseJson: storedResponse,
              completedAt: new Date().toISOString(),
              retryEligible: false,
              terminalState: true,
            }
          );
          if (!isCodeClipProviderDeliveryUpdateConfirmed(replayUpdate)) {
            return sendCodeClipProviderLedgerFailure(res);
          }
        }
        return res.status(200).json(storedResponse);
      }

      if (
        liveProvider &&
        providerDeliveryRecord?.corePersistenceState === "committed"
      ) {
        const durableReplay = getCodeClipDurableProviderReplay(providerDeliveryRecord);
        if (durableReplay) {
          try {
            await recordProviderKeywordResponse({
              redis,
              key: idempotencyKey,
              payload: durableReplay.payload,
              ttlSeconds: providerPolicy.policy.idempotency?.responseTtlSeconds || 86400,
            });
          } catch (cacheRepairError) {
            console.warn("codeClip provider delivery replay cache repair rejected", {
              provider: normalizedProvider,
              route: "/codeclip/provider/:provider/keyword",
              reason: "DELIVERY_DURABLE_REPLAY_CACHE_REPAIR_UNAVAILABLE",
            });
            return sendCodeClipProviderLedgerFailure(res);
          }

          return res.status(durableReplay.httpStatus).json(durableReplay.payload);
        }

        console.warn("codeClip provider delivery processing rejected", {
          provider: normalizedProvider,
          route: "/codeclip/provider/:provider/keyword",
          reason: "DELIVERY_DURABLE_COMMIT_WITHOUT_REPLAY",
        });
        return sendCodeClipProviderLedgerFailure(res);
      }

      return res.status(202).json({
        ok: false,
        duplicate: true,
        status: "processing",
        eventCode,
        messageId,
      });
    }

    if (
      liveProvider &&
      providerDeliveryRecord?.corePersistenceState === "committed"
    ) {
      console.warn("codeClip provider delivery processing rejected", {
        provider: normalizedProvider,
        route: "/codeclip/provider/:provider/keyword",
        reason: "DELIVERY_DURABLE_COMMIT_WITHOUT_REPLAY",
      });
      return sendCodeClipProviderLedgerFailure(res);
    }

    if (liveProvider) {
      const processingUpdate = await updateCodeClipProviderDeliveryState(
        providerDeliveryIdentity,
        {
          corePersistenceState: "processing",
          lastAttemptAt: new Date().toISOString(),
        }
      );
      if (!isCodeClipProviderDeliveryUpdateConfirmed(processingUpdate)) {
        return sendCodeClipProviderLedgerFailure(res);
      }
    }

    const result = await codeClipVertical.service.handleCodeClipKeywordEntry({
      event: meta,
      eventCode,
      eventId: eventId || meta.id || "",
      keyword,
      messageId,
      requestedVertical: "codeclip",
      redis: process.env.REDIS_URL ? redis : null,
      codeClipVertical,
      saveCodeClipInteraction,
      saveCodeClipRewardAssignments,
      saveCodeClipXtraRedemption,
      runCodeClipCorePersistenceTransaction: withCodeClipCorePersistenceTransaction,
      saveCodeClipOutboxEvent,
    });

    const persistenceSeverity = String(result.internal?.persistenceDecision?.severity || "")
      .trim()
      .toLowerCase();
    const corePersistenceState = getCodeClipCorePersistenceState(result);
    if (liveProvider && persistenceSeverity === "critical") {
      const failureUpdate = await updateCodeClipProviderDeliveryState(
        providerDeliveryIdentity,
        {
          processingState: "failed",
          corePersistenceState: "failed",
          completionState: "not_completed",
          errorClass: "critical_persistence_failure",
          retryEligible: true,
          terminalState: false,
          lastAttemptAt: new Date().toISOString(),
        }
      );
      if (!isCodeClipProviderDeliveryUpdateConfirmed(failureUpdate)) {
        return sendCodeClipProviderLedgerFailure(res);
      }
      return sendCodeClipProviderLedgerFailure(res);
    }

    if (liveProvider && corePersistenceState !== "committed") {
      const unconfirmedUpdate = await updateCodeClipProviderDeliveryState(
        providerDeliveryIdentity,
        {
          processingState: "failed",
          corePersistenceState: "unknown",
          completionState: "not_completed",
          errorClass: "unconfirmed_core_persistence",
          retryEligible: true,
          terminalState: false,
          lastAttemptAt: new Date().toISOString(),
        }
      );
      if (!isCodeClipProviderDeliveryUpdateConfirmed(unconfirmedUpdate)) {
        return sendCodeClipProviderLedgerFailure(res);
      }
      return sendCodeClipProviderLedgerFailure(res);
    }

    if (liveProvider) {
      const committedUpdate = await updateCodeClipProviderDeliveryState(
        providerDeliveryIdentity,
        {
          corePersistenceState: "committed",
          lastAttemptAt: new Date().toISOString(),
        }
      );
      if (!isCodeClipProviderDeliveryUpdateConfirmed(committedUpdate)) {
        return sendCodeClipProviderLedgerFailure(res);
      }
    }

    if (idempotencyClaim.enabled) {
      await recordProviderKeywordResponse({
        redis,
        key: idempotencyKey,
        payload: result.payload,
        ttlSeconds: providerPolicy.policy.idempotency?.responseTtlSeconds || 86400,
      });
    }

    if (liveProvider) {
      const completionUpdate = await updateCodeClipProviderDeliveryState(
        providerDeliveryIdentity,
        {
          processingState: "completed",
          completionState: "completed",
          responseStatus: result.httpStatus,
          publicResponseJson: result.payload,
          completedAt: new Date().toISOString(),
          retryEligible: false,
          terminalState: true,
        }
      );
      if (!isCodeClipProviderDeliveryUpdateConfirmed(completionUpdate)) {
        return sendCodeClipProviderLedgerFailure(res);
      }
    }

    return res.status(result.httpStatus).json(result.payload);
  } catch (err) {
    console.error("codeClip provider keyword failed:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to process provider keyword" });
  }
}

function handleCodeClipMetaProviderChallengeRoute(req, res) {
  try {
    const {
      resolveCodeClipProviderPolicy,
    } = require("./verticals/codeclip/provider-policy");
    const {
      verifyCodeClipProviderChallenge,
    } = require("./verticals/codeclip/provider-challenge-verification");
    const providerPolicy = resolveCodeClipProviderPolicy("meta");
    const verifyTokenEnvName = providerPolicy.ok
      ? providerPolicy.policy.verifyTokenEnvName
      : "";
    const verifyToken = verifyTokenEnvName ? process.env[verifyTokenEnvName] : "";
    const challengeVerification = verifyCodeClipProviderChallenge({
      provider: "meta",
      query: req.query || {},
      verifyToken,
    });

    if (!challengeVerification.ok) {
      console.warn("codeClip provider challenge rejected", {
        provider: "meta",
        route: "/codeclip/provider/meta/keyword",
        reason: challengeVerification.reason,
        status: 403,
      });
      return res.status(403).type("text/plain").send("Invalid provider challenge");
    }

    return res.status(200).type("text/plain").send(challengeVerification.challenge);
  } catch (err) {
    console.error("codeClip Meta provider challenge failed:", err.message);
    return res.status(500).type("text/plain").send("Invalid provider challenge");
  }
}

app.get("/codeclip/provider/meta/keyword", handleCodeClipMetaProviderChallengeRoute);
app.post("/codeclip/provider/:provider/keyword", handleCodeClipProviderKeywordRoute);

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
<title>Verified Reward — codePerks</title>
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
    <h1>Verified Reward</h1>
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
            defaultLang: meta.defaultLang || meta.lang || meta.language || "en",
            lang: meta.defaultLang || meta.lang || meta.language || "en",
            language: meta.defaultLang || meta.lang || meta.language || "en",
            screenVideoUrl: meta.screenVideoUrl || "",
            innerCircleJoinCount: Number(meta.innerCircleJoinCount || 0),
            benefitInventory: meta.benefitInventory || null,
          };
        }
      }
    }

    if (!event || !eventId) {
      return res.status(404).json({ error: "Event not found" });
    }

const phone = req.body.phone || "";
  const scanId = String(req.body.scanId || "").trim();

let joins = 0;
let shouldSendWelcomeMessage = false;
let ownershipCertificate = null;

if (process.env.REDIS_URL) {
  if (phone) {
    const benefitWindow = getCodePerksBenefitWindowStatus(event || meta || {});
    const alreadyRegistered = await redis.sismember(`event:${eventId}:uniquePhones`, phone);
    const isCodePodInnerCircle = String(req.body?.vertical || event?.vertical || meta?.vertical || "").trim().toLowerCase() === "codepod";
    const codePodStartMs = Date.parse((event || meta || {}).unlockAt || (event || meta || {}).startAt || "");
    const codePodNotOpen = isCodePodInnerCircle && Number.isFinite(codePodStartMs) && Date.now() < codePodStartMs;

    if (!alreadyRegistered && (isCodePodInnerCircle ? codePodNotOpen : benefitWindow.status !== "open")) {
      joins = Number(await redis.get(`event:${eventId}:innerCircleJoinCount`) || 0);

      return res.json({
        success: true,
        eventCode,
        eventId,
        innerCircleJoinCount: Number(joins || 0),
        ownershipCertificate: null,
        benefitWindowStatus: benefitWindow.status,
        benefitWindow,
      });
    }

    const added = await redis.sadd(`event:${eventId}:uniquePhones`, phone);

    if (added === 1) {
      joins = await redis.incr(`event:${eventId}:innerCircleJoinCount`);
      shouldSendWelcomeMessage = true;

      const certificateId =
        `CP-DOC-${eventCode}-${String(joins).padStart(6, "0")}`;

      let benefitAssignment = null;

      if (scanId && process.env.REDIS_URL) {
        const assignmentKey = `event:${eventId}:benefitAssignment:${scanId}`;
        const storedAssignment = await redis.get(assignmentKey);

        if (storedAssignment) {
          try {
            benefitAssignment = JSON.parse(storedAssignment);
          } catch {
            benefitAssignment = null;
          }
        }
      }

      if (!benefitAssignment) {
        benefitAssignment = await assignCodePerksBenefitTier(eventId, meta || {});
      }

      ownershipCertificate = {
        certificateId,
        phone,
        eventCode,
        eventId,
        scanId,
        tier: benefitAssignment.tier,
        benefitTier: benefitAssignment.tier,
        benefitInventory: benefitAssignment.inventoryStatus,
        benefitWindow: getCodePerksBenefitWindowStatus(event || meta || {}),
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
    const benefitWindow = getCodePerksBenefitWindowStatus(event || {});
    if (benefitWindow.status !== "open") {
      return res.json({
        success: true,
        eventCode,
        eventId,
        innerCircleJoinCount: Number(event.innerCircleJoinCount || 0),
        ownershipCertificate: null,
        benefitWindowStatus: benefitWindow.status,
        benefitWindow,
      });
    }
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

  try {
    await saveEventRegistration({
      eventCode,
      eventId,
      vertical: event?.vertical || meta?.vertical || "",
      registrationId: ownershipCertificate?.certificateId || "",
      scanId,
      tier: ownershipCertificate?.tier || ownershipCertificate?.benefitTier || "",
      phone,
      teamCode: event?.teamCode || meta?.teamCode || "",
      teamLabel: event?.teamLabel || meta?.teamLabel || "",
      dailyDemoCode: event?.dailyDemoCode || meta?.dailyDemoCode || "",
      dailyDemoDayIndex: event?.dailyDemoDayIndex || meta?.dailyDemoDayIndex || null,
      dailyDemoTeamIndex: event?.dailyDemoTeamIndex || meta?.dailyDemoTeamIndex || null,
      userAgent: req.headers["user-agent"] || "",
      ipHash: crypto.createHash("sha256").update(String(req.ip || "")).digest("hex"),
      rawPayload: {
        source: "web_join",
        phone,
        scanId,
        eventCode,
        eventId,
        ownershipCertificate,
      },
    });
  } catch (registrationError) {
    console.error("POSTGRES EVENT REGISTRATION SAVE FAILED:", registrationError.message);
  }
}
    return res.json({
      success: true,
      eventCode,
      eventId,
      innerCircleJoinCount: Number(joins || 0),
      ownershipCertificate,
      benefitWindowStatus: ownershipCertificate?.benefitWindow?.status || "open",
      benefitWindow: ownershipCertificate?.benefitWindow || getCodePerksBenefitWindowStatus(event || meta || {}),
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
function buildAudienceEntry({
  entryCode,
  scanId,
  requestedVertical,
  userAgent,
  ip,
}) {
  return {
    entryCode,
    scanId,
    requestedVertical,
    source: "scan",
    transport: "http",
    userAgent,
    ip,
    receivedAt: new Date().toISOString(),
  };
}

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
    const requestedVerticalInput = String(req.body?.vertical || req.query?.vertical || "").trim().toLowerCase();
    const requestedVertical = requestedVerticalInput || "codetone";
    const audienceEntry = buildAudienceEntry({
      entryCode: eventCode,
      scanId,
      requestedVertical,
      userAgent: req.get("user-agent") || "",
      ip,
    });
    const normalizedScanAudienceEntry = codeClipVertical.service.normalizeAudienceEntry("scan", {
      entryCode: eventCode,
      scanId,
      requestedVertical,
    });
    const codeClipAudienceEntry = normalizedScanAudienceEntry.ok
      ? normalizedScanAudienceEntry.audienceEntry
      : audienceEntry;
    const codeClipAudienceIntent = normalizedScanAudienceEntry.ok
      ? normalizedScanAudienceEntry.audienceIntent
      : null;
    let eventId = null;
    let event = null;

    const resolvedEvent = await resolveEventReference(eventCode, {
      requestedVertical,
      explicitVertical: !!requestedVerticalInput,
    });
    eventId = resolvedEvent.eventId;
    event = resolvedEvent.event;

    if (!event || !eventId) {
      if (requestedVertical === "codeclip") {
        const noCampaignMatchInteraction = codeClipVertical.service.buildNoCampaignMatchInteraction({
          eventCode,
          scanId,
          audienceEntry: codeClipAudienceEntry,
        });
        try {
          await saveCodeClipInteraction(noCampaignMatchInteraction);
        } catch (dbError) {
          console.warn("codeClip NO_CAMPAIGN_MATCH Interaction Postgres save failed:", dbError.message);
        }
      }

      return res.status(404).json({ error: "Event not found" });
    }

const eventVertical = String(event?.vertical || "").trim().toLowerCase();
const vertical = requestedVertical === "codepod" || eventVertical === "codepod"
  ? "codepod"
  : (requestedVertical === "codeclip" || eventVertical === "codeclip" ? "codeclip" : requestedVertical);

if (process.env.REDIS_URL) {
  const rateLimit = vertical === "codepod" ? 2000 : 200;
  const rateKey = `ratelimit:scan:v2:${vertical}:${ip}`;
  const hits = await redis.incr(rateKey);

  if (hits === 1) {
    await redis.expire(rateKey, 60);
  }

  if (hits > rateLimit) {
    return res.status(429).json({
      error: "Too many scan attempts. Please try again shortly.",
    });
  }
}

if (vertical === "codepod" && eventId && scanId && process.env.REDIS_URL) {
  const alreadyScanned = await redis.sismember(`event:${eventId}:uniqueScanIds`, scanId);
  if (alreadyScanned) {
    let previousTier = "general";

    const storedSouvenir = await redis.get(`codepod:digitalSouvenir:scan:${eventCode}:${scanId}`);
    if (storedSouvenir) {
      try {
        const souvenirAssignment = JSON.parse(storedSouvenir);
        const storedTier = String(souvenirAssignment?.tier || "").trim().toLowerCase();
        if (["gold", "silver", "general"].includes(storedTier)) previousTier = storedTier;
      } catch {
        previousTier = "general";
      }
    } else {
      const storedGoldXtra = await redis.get(`codepod:partnerReward:scan:${eventCode}:${scanId}`);
      if (storedGoldXtra) {
        try {
          const goldXtraAssignment = JSON.parse(storedGoldXtra);
          if (goldXtraAssignment?.assigned) previousTier = "gold";
        } catch {
          previousTier = "general";
        }
      }
    }

    return res.json({
      success: true,
      eventCode,
      eventId,
      alreadyParticipated: true,
      tier: previousTier,
      messageKey: "alreadyParticipated",
    });
  }
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

const persistFinalScan = async (finalTier, extraPayload = {}, interaction = null) => {
  try {
    await saveEventScan({
      eventCode: interaction?.eventCode || eventCode,
      eventId: interaction?.eventId || eventId,
      vertical,
      scanId: interaction?.scanId || scanId,
      scanRank: interaction?.scanRank ?? scanRank,
      tier: interaction?.tier || finalTier,
      teamCode: event.teamCode || event.demoLocation?.teamCode || "",
      teamLabel: event.teamLabel || event.demoLocation?.teamLabel || "",
      dailyDemoCode: event.dailyDemoCode || event.code || eventCode,
      dailyDemoDayIndex: event.dailyDemoDayIndex || event.dailyDemoIndex || null,
      dailyDemoTeamIndex: event.dailyDemoTeamIndex || null,
      userAgent: req.get("user-agent") || "",
      ipHash: crypto.createHash("sha256").update(String(req.ip || "")).digest("hex"),
      rawPayload: {
        ...(req.body || {}),
        finalTier,
        ...extraPayload,
      },
    });
  } catch (dbScanError) {
    console.error("POSTGRES SCAN SAVE FAILED:", dbScanError.message);
  }
};

if (vertical === "codeperks" && process.env.REDIS_URL && scanId) {
  const benefitWindow = getCodePerksBenefitWindowStatus(event || {});
  const assignmentKey = `event:${eventId}:benefitAssignment:${scanId}`;

  let benefitAssignment = null;
  const storedAssignment = await redis.get(assignmentKey);

  if (storedAssignment) {
    try {
      benefitAssignment = JSON.parse(storedAssignment);
    } catch {
      benefitAssignment = null;
    }
  }

  if (!benefitAssignment && benefitWindow.status === "open") {
    benefitAssignment = await assignCodePerksBenefitTier(eventId, event || {});
    await redis.set(assignmentKey, JSON.stringify(benefitAssignment));
  }

  if (benefitAssignment?.tier) {
    tier = benefitAssignment.tier;
  }

  await persistFinalScan(tier, { benefitAssignment });
	
  return res.json({
    success: true,
    eventCode,
    eventId,
    rawScans: Number(rawScans || 0),
    uniqueScans: Number(uniqueScans || 0),
    scanRank,
    tier,
    benefitTier: tier,
    benefitInventory: benefitAssignment?.inventoryStatus || null,
    benefitWindow,
  });
}

if (vertical === "codeclip") {
  const result = await codeClipVertical.service.handleCodeClipScan({
    event,
    eventCode,
    eventId,
    scanId,
    rawScans,
    uniqueScans,
    scanRank,
    audienceEntry: codeClipAudienceEntry,
    audienceIntent: codeClipAudienceIntent,
    redis: process.env.REDIS_URL ? redis : null,
    codeClipVertical,
    persistFinalScan,
    saveCodeClipInteraction,
    saveCodeClipRewardAssignments,
    runCodeClipCorePersistenceTransaction: withCodeClipCorePersistenceTransaction,
    saveCodeClipOutboxEvent,
    saveCodeClipXtraRedemption,
  });

  return res.status(result.httpStatus).json(result.payload);
}

const isCodePodScan = vertical === "codepod" || String(event?.vertical || "").trim().toLowerCase() === "codepod";
const codePodAudienceEntry = isCodePodScan
  ? codePodVertical.service.normalizeCodePodScanAudienceEntry({
    eventCode,
    eventId,
    scanId,
    requestedVertical: vertical,
  })
  : null;
void codePodAudienceEntry;
let codePodSouvenirAssignment = null;
let goldXtraAssignment = null;
let codePodRuntimeChain = null;
let tierLimits = null;

if (isCodePodScan) {
  const now = Date.now();
  const startMs = Date.parse(event.startAt || "");
  const unlockMs = Date.parse(event.unlockAt || "");
  const isBeforeStart = Number.isFinite(startMs) && now < startMs;
  const isBeforeUnlock = Number.isFinite(unlockMs) && now < unlockMs;
  if (isBeforeStart || isBeforeUnlock) {
    return res.json({
      success: false,
      status: "locked",
      error: "bonus_window_locked",
      unlockAt: event.unlockAt || event.startAt || "",
      serverTime: new Date(now).toISOString(),
    });
  }
}

if (isCodePodScan && Date.now() > Date.parse(event.endAt)) {
  return res.json({
    success: false,
    status: "expired",
    error: "bonus_window_expired",
  });
}

const effectiveCodePodPartnerReward = event?.partnerReward?.active
  ? event.partnerReward
  : event?.digitalSouvenir?.goldXtra;

if (isCodePodScan && effectiveCodePodPartnerReward) {
  goldXtraAssignment = await assignCodePodGoldXtra(eventCode, scanId, effectiveCodePodPartnerReward);
}

if (isCodePodScan && goldXtraAssignment?.assigned) {
  tier = "gold";
} else if (isCodePodScan) {
  codePodSouvenirAssignment = await assignCodePodDigitalSouvenirTier(
    eventCode,
    scanId,
    event.digitalSouvenir,
    event
  );
  tier = codePodSouvenirAssignment.tier || "general";
} else {
  const audienceSize = Number(event.audienceSize || event.maxClaims || 1000);
  const goldLimit = Math.max(1, Math.round(audienceSize * 0.01));
  const silverLimit = Math.max(goldLimit + 1, Math.round(audienceSize * 0.05));

  if (scanRank && scanRank <= goldLimit) {
    tier = "gold";
  } else if (scanRank && scanRank <= silverLimit) {
    tier = "silver";
  }

  tierLimits = {
    audienceSize,
    goldLimit,
    silverLimit,
  };
}
if (isCodePodScan && codePodAudienceEntry?.ok) {
  codePodRuntimeChain = codePodVertical.service.buildCodePodRuntimeChain({
    audienceEntry: codePodAudienceEntry.audienceEntry,
    audienceIntent: codePodAudienceEntry.audienceIntent,
    eventCode,
    eventId,
    scanId,
    rawScans,
    uniqueScans,
    scanRank,
    tier,
    rewardAssignmentResult: {
      tier,
      digitalSouvenir: codePodSouvenirAssignment,
      goldXtra: goldXtraAssignment,
    },
  });
}
const codePodResponseInteraction = codePodRuntimeChain?.interaction || null;
const codePodResponseReward = codePodRuntimeChain?.rewardAssignmentSnapshot || null;
const responsePayload = {
  success: true,
  eventCode: codePodResponseInteraction?.eventCode || eventCode,
  eventId: codePodResponseInteraction?.eventId || eventId,
  rawScans: Number(codePodResponseInteraction?.rawScans ?? rawScans ?? 0),
  uniqueScans: Number(codePodResponseInteraction?.uniqueScans ?? uniqueScans ?? 0),
  scanRank: codePodResponseInteraction?.scanRank ?? scanRank,
  tier: codePodResponseReward?.tier || codePodResponseInteraction?.tier || tier,
};
if (tierLimits) {
  responsePayload.tierLimits = tierLimits;
}
if (codePodSouvenirAssignment) {
  responsePayload.digitalSouvenir = codePodSouvenirAssignment;
  responsePayload.exhausted = Boolean(codePodSouvenirAssignment.exhausted);
  responsePayload.noReward = Boolean(codePodSouvenirAssignment.noReward);
}
	
if (isCodePodScan && goldXtraAssignment?.assigned) {
    try {
      await saveCodePodGoldXtraRedemption({
        token: goldXtraAssignment.redemptionToken,
        eventCode,
        eventId,
        scanId,
        vertical: "codepod",
        rewardType: "partner_reward",
        tier: "gold",
        displayTier: "GoldXtra",
        partnerName: goldXtraAssignment.partnerName,
        rewardTitle: goldXtraAssignment.title,
        redemptionLocation: goldXtraAssignment.redemptionLocation,
        redemptionDeadline: goldXtraAssignment.redemptionDeadline,
        redemptionInstructions: goldXtraAssignment.redemptionInstructions,
        status: "assigned",
        assignedAt: goldXtraAssignment.assignedAt,
        rawPayload: {
          eventCode,
          eventId,
          scanId,
          tier,
          displayTier: "GoldXtra",
          rewardType: "partner_reward",
          partnerReward: goldXtraAssignment,
        },
      });
    } catch (dbError) {
      console.warn("codePod GoldXtra Postgres save failed:", dbError.message);
    }

    responsePayload.displayTier = "GoldXtra";
    responsePayload.rewardType = "partner_reward";
    responsePayload.partnerReward = {
      active: true,
      assigned: true,
      title: goldXtraAssignment.title,
      partnerName: goldXtraAssignment.partnerName,
      quantity: goldXtraAssignment.quantity,
      assignedCount: goldXtraAssignment.assignedCount,
      remaining: goldXtraAssignment.remaining,
      redemptionToken: goldXtraAssignment.redemptionToken,
      partnerLogo: goldXtraAssignment.partnerLogo,
      partnerLogoFileName: goldXtraAssignment.partnerLogoFileName,
    };
}

const persistenceTier = codePodRuntimeChain?.rewardAssignmentSnapshot?.tier || tier;
await persistFinalScan(
  persistenceTier,
  { digitalSouvenir: codePodSouvenirAssignment },
  codePodRuntimeChain?.interaction || null
);
	
return res.json(responsePayload);
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

    const screenVideoEvent = await resolveScreenVideoEvent(eventCode);

    if (!screenVideoEvent.ok) {
      return res.status(screenVideoEvent.status).json(screenVideoEvent.body);
    }

    const event = screenVideoEvent.event;
    const eventId = screenVideoEvent.eventId;
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
    claimWindowHours: Math.max(0, Number(benefitInventory?.claimWindowHours || 24)),
  };
}

function parseBenefitWindowTime(value, { endOfDay = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(`${raw}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`);
  }

  return Date.parse(raw);
}

function getCodePerksBenefitWindowStatus(meta = {}) {
  const inventory = parseBenefitInventoryFromMeta(meta);
  const startMs = parseBenefitWindowTime(inventory.campaignStart);
  const endMs = parseBenefitWindowTime(inventory.campaignEnd, { endOfDay: true });
  const nowMs = Date.now();

  const status =
    Number.isFinite(startMs) && nowMs < startMs
      ? "not_open"
      : Number.isFinite(endMs) && nowMs > endMs
        ? "closed"
        : "open";

  return {
    status,
    messageKey:
      status === "not_open"
        ? "benefit_not_open"
        : status === "closed"
          ? "benefit_closed"
          : "benefit_open",
    campaignStart: inventory.campaignStart,
    campaignEnd: inventory.campaignEnd,
    now: new Date(nowMs).toISOString(),
    claimUntil: Number.isFinite(endMs)
      ? new Date(endMs + inventory.claimWindowHours * 60 * 60 * 1000).toISOString()
      : "",
    claimWindowHours: inventory.claimWindowHours,
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

async function logCodeDemoInventoryExceptions(eventId, meta = {}, inventoryStatus = {}) {
  const eventCode = meta.code || meta.eventCode || "";
  if (!eventCode) return;

  const lowThreshold = 3;

  const checks = [
    {
      tier: "gold",
      total: Number(inventoryStatus.goldTotal || 0),
      remaining: Number(inventoryStatus.goldRemaining || 0),
    },
    {
      tier: "silver",
      total: Number(inventoryStatus.silverTotal || 0),
      remaining: Number(inventoryStatus.silverRemaining || 0),
    },
  ];

  for (const item of checks) {
    if (item.total <= 0) continue;

    if (item.remaining <= 0) {
      await saveCodeDemoException({
        eventCode,
        eventId,
        severity: "red",
        category: "inventory",
        type: "inventory_empty",
        message: `${item.tier} inventory is empty`,
        details: {
          tier: item.tier,
          total: item.total,
          remaining: item.remaining,
        },
      });
      continue;
    }

    if (item.remaining <= lowThreshold) {
      await saveCodeDemoException({
        eventCode,
        eventId,
        severity: "yellow",
        category: "inventory",
        type: "inventory_low",
        message: `${item.tier} inventory is low`,
        details: {
          tier: item.tier,
          total: item.total,
          remaining: item.remaining,
          lowThreshold,
        },
      });
    }
  }
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
      await logCodeDemoInventoryExceptions(eventId, freshMeta, inventoryStatus);
      return { tier: "gold", inventoryStatus };
    }

    await redis.decr(`event:${eventId}:benefit:goldAssigned`);
  }

  if (inventory.silverTotal > 0) {
    const silverAssigned = await redis.incr(`event:${eventId}:benefit:silverAssigned`);

    if (silverAssigned <= inventory.silverTotal) {
      const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, freshMeta);
      await logCodeDemoInventoryExceptions(eventId, freshMeta, inventoryStatus);
      return { tier: "silver", inventoryStatus };
    }

    await redis.decr(`event:${eventId}:benefit:silverAssigned`);
  }

  await redis.incr(`event:${eventId}:benefit:standardAssigned`);
  const inventoryStatus = await getCodePerksBenefitInventoryStatus(eventId, freshMeta);
  await logCodeDemoInventoryExceptions(eventId, freshMeta, inventoryStatus);

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

    const eventId =
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
        reason: "Certificate not found",
      });
    }

    const tier = certificate.tier || certificate.benefitTier || "general";
    const benefitTier = certificate.benefitTier || certificate.tier || tier;

    return res.json({
      ok: true,
      valid: true,
      status: certificate.status || "active",
      eventCode,
      certificateId,
      eventId,
      tier,
      benefitTier,
      issuedAt: certificate.issuedAt || "",
      issuedBy: certificate.issuedBy || "codePerks by codeNXT",
      ownershipCertificate: certificate,
      event: {
        id: eventId,
        code: meta?.code || eventCode,
        name: meta?.name || meta?.pageName || "codePerks campaign",
      },
    });
  } catch (error) {
    console.error("certificate validate error", error);
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
    campaignName: String(body.campaignName || body.eventName || "").trim(),
    companyName: String(body.companyName || "").trim(),
    claimant: {
      fullName: String(body.claimant?.fullName || "").trim(),
      address: String(body.claimant?.address || "").trim(),
      postalCode: String(body.claimant?.postalCode || "").trim(),
      country: String(body.claimant?.country || "").trim(),
      phone: String(body.claimant?.phone || "").trim(),
      email: String(body.claimant?.email || "").trim(),
    },
    benefitTier: String(body.benefitTier || body.tier || "").trim(),
    tier: String(body.tier || body.benefitTier || "").trim(),
    eventId: String(body.eventId || "").trim(),
    rewardTitle: String(body.rewardTitle || body.reward || body.benefit || "").trim(),
    redemptionLocation: String(body.redemptionLocation || "").trim(),
    redemptionDeadline: String(body.redemptionDeadline || "").trim(),
    redemptionDeadlineTime: String(body.redemptionDeadlineTime || "23:59").trim(),
    redemptionInstructions: String(body.redemptionInstructions || body.instructions || "Vis tilsendt QR-kode").trim(),
    participantLang: String(body.participantLang || body.lang || "no").trim().toLowerCase(),
    redemptionToken: crypto.randomBytes(24).toString("hex"),
    redeemUrl: "",
    redeemed: false,
    redeemedAt: null,
    redeemedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "codePerks certificate",
  };
}

function validateCodePerksRewardClaim(claim) {
  return Boolean(
    claim.eventCode &&
    claim.certificateId &&
    claim.claimant &&
    claim.claimant.fullName &&
    claim.claimant.email
  );
}

function isCodePerksClaimExpired(claim = {}) {
  const deadline = String(claim.redemptionDeadline || "").trim();
  if (!deadline) return false;

  const deadlineTime = String(claim.redemptionDeadlineTime || "23:59").trim() || "23:59";
  const safeTime = /^\d{2}:\d{2}$/.test(deadlineTime) ? deadlineTime : "23:59";
  const deadlineDate = new Date(`${deadline}T${safeTime}:59.999Z`);
  if (Number.isNaN(deadlineDate.getTime())) return false;

  return Date.now() > deadlineDate.getTime();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function formatCodePerksDeadlineDisplay(dateValue = "", timeValue = "", lang = "no") {
  const rawDate = String(dateValue || "").trim();
  const rawTime = String(timeValue || "").trim();

  if (!rawDate) return "Not specified";

  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const displayDate = match ? `${match[3]}/${match[2]}/${match[1]}` : rawDate;

  const prefixes = {
    no: "innen kl.",
    en: "by",
    de: "bis",
    fr: "avant",
    es: "antes de las",
  };

  const prefix = prefixes[lang] || prefixes.no;

  if (!rawTime) return displayDate;

  return `${displayDate} ${prefix} ${rawTime}`;
}

async function sendCodePerksRedemptionEmail(claim = {}) {
  const recipientEmail = String(claim.claimant?.email || "").trim();
  if (!recipientEmail) return { ok: false, skipped: true, reason: "missing_recipient" };

  const redeemBaseUrl = process.env.CODEPERKS_REDEEM_BASE_URL || "https://codeperks.codenxt.global/redeem";
  const redeemUrl = `${redeemBaseUrl}/${encodeURIComponent(claim.redemptionToken)}`;
  claim.redeemUrl = redeemUrl;

  const qrDataUrl = await QRCode.toDataURL(redeemUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 360,
  });

  const fallbackCompanyName =
    claim.companyName ||
    claim.company ||
    claim.meta?.companyName ||
    "codePerks";

  const companyName = fallbackCompanyName;
  const campaignName = claim.campaignName || claim.eventCode || "kampanjen";

  const participantLang = ["no", "en", "de", "fr", "es"].includes(
    String(claim.participantLang || "").toLowerCase()
  )
    ? String(claim.participantLang || "").toLowerCase()
    : "no";

  const localized = {
    no: {
      subject: `Din fordel er klar • ${campaignName}`,
      heading: `Takk for at du deltok i ${campaignName} hos ${companyName}.`,
      hello: "Hei",
      intro: "Din fordel er registrert og klar til innløsning. Vis QR-koden nedenfor ved utlevering.",
      benefit: "Fordel",
      category: "Kategori",
      pickup: "Hentested",
      validUntil: "Gyldig til",
      instructions: "Instruksjoner",
      certificate: "Sertifikat-ID",
      oneUse: "Denne QR-koden kan kun brukes én gang.",
      deadlineTimePrefix: "innen kl.",
      footer: "Sendt automatisk av codePerks.",
      defaultReward: "Din fordel",
    },
    en: {
      subject: `Your benefit is ready • ${campaignName}`,
      heading: `Thank you for participating in ${campaignName} at ${companyName}.`,
      hello: "Hello",
      intro: "Your benefit is registered and ready for redemption. Show the QR code below when collecting it.",
      benefit: "Benefit",
      category: "Category",
      pickup: "Pickup location",
      validUntil: "Valid until",
      instructions: "Instructions",
      certificate: "Certificate ID",
      oneUse: "This QR code can only be used once.",
      deadlineTimePrefix: "by",
      footer: "Sent automatically by codePerks.",
      defaultReward: "Your benefit",
    },
    fr: {
      subject: `Votre avantage est prêt • ${campaignName}`,
      heading: `Merci d’avoir participé à ${campaignName} chez ${companyName}.`,
      hello: "Bonjour",
      intro: "Votre avantage est enregistré et prêt à être utilisé.",
      benefit: "Avantage",
      category: "Catégorie",
      pickup: "Lieu de retrait",
      validUntil: "Valable jusqu’au",
      instructions: "Instructions",
      certificate: "ID du certificat",
      oneUse: "Ce QR code ne peut être utilisé qu’une seule fois.",
      deadlineTimePrefix: "avant",
      footer: "Envoyé automatiquement par codePerks.",
      defaultReward: "Votre avantage",
    },
    de: {
      subject: `Ihr Vorteil ist bereit • ${campaignName}`,
      heading: `Vielen Dank für Ihre Teilnahme an ${campaignName} bei ${companyName}.`,
      hello: "Hallo",
      intro: "Ihr Vorteil wurde registriert und ist bereit zur Einlösung.",
      benefit: "Vorteil",
      category: "Kategorie",
      pickup: "Abholort",
      validUntil: "Gültig bis",
      instructions: "Anweisungen",
      certificate: "Zertifikat-ID",
      oneUse: "Dieser QR-Code kann nur einmal verwendet werden.",
      deadlineTimePrefix: "bis",
      footer: "Automatisch gesendet von codePerks.",
      defaultReward: "Ihr Vorteil",
    },
    es: {
      subject: `Tu beneficio está listo • ${campaignName}`,
      heading: `Gracias por participar en ${campaignName} en ${companyName}.`,
      hello: "Hola",
      intro: "Tu beneficio ha sido registrado y está listo para ser utilizado.",
      benefit: "Beneficio",
      category: "Categoría",
      pickup: "Lugar de recogida",
      validUntil: "Válido hasta",
      instructions: "Instrucciones",
      certificate: "ID del certificado",
      oneUse: "Este código QR solo puede utilizarse una vez.",
      deadlineTimePrefix: "antes de las",
      footer: "Enviado automáticamente por codePerks.",
      defaultReward: "Tu beneficio",
    },
  }[participantLang];

  const subject = localized.subject;
  const rewardTitle = claim.rewardTitle || localized.defaultReward;
  const redemptionLocation = claim.redemptionLocation || "Not specified";
  const redemptionDeadline = claim.redemptionDeadline || "Not specified";
  const redemptionDeadlineTime = claim.redemptionDeadlineTime || "23:59";
  const redemptionDeadlineDisplay = formatCodePerksDeadlineDisplay(
    claim.redemptionDeadline,
    redemptionDeadlineTime,
    participantLang
  );
  const redemptionInstructions = claim.redemptionInstructions || "Show the attached QR code.";

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;max-width:640px;">
      <h2>${escapeHtml(localized.heading)}</h2>
      <p>${escapeHtml(localized.hello)} ${escapeHtml(claim.claimant?.fullName || "")},</p>
      <p>${escapeHtml(localized.intro)}</p>

      <div style="padding:16px;border:1px solid #ddd;border-radius:12px;margin:18px 0;">
        <p><strong>${localized.benefit}:</strong><br/>${escapeHtml(rewardTitle)}</p>
        <p><strong>${localized.category}:</strong><br/>${escapeHtml(claim.tier || claim.benefitTier || "")}</p>
        <p><strong>${localized.pickup}:</strong><br/>${escapeHtml(redemptionLocation)}</p>
        <p><strong>${localized.validUntil}:</strong><br/>${escapeHtml(redemptionDeadlineDisplay)}</p>
        <p><strong>${localized.instructions}:</strong><br/>${escapeHtml(redemptionInstructions)}</p>
        <p><strong>${localized.certificate}:</strong><br/>${escapeHtml(claim.certificateId)}</p>
      </div>

      <div style="text-align:center;margin:24px 0;">
        <img src="${qrDataUrl}" alt="codePerks redemption QR code" width="260" height="260" style="display:block;margin:0 auto;border:1px solid #ddd;border-radius:12px;padding:12px;background:#fff;" />
        <p style="font-size:13px;color:#666;margin-top:10px;">${localized.oneUse}</p>
      </div>

      <p style="font-size:12px;color:#666;">${escapeHtml(localized.footer)}</p>
    </div>
  `;

  const text = [
    localized.heading,
    "",
    `${localized.benefit}: ${rewardTitle}`,
    `${localized.category}: ${claim.tier || claim.benefitTier || ""}`,
    `${localized.pickup}: ${redemptionLocation}`,
    `${localized.validUntil}: ${redemptionDeadlineDisplay}`,
    `${localized.instructions}: ${redemptionInstructions}`,
    `${localized.certificate}: ${claim.certificateId}`,
    "",
    `QR / redemption link: ${redeemUrl}`,
    "",
    localized.oneUse,
  ].join("\n");

  await sendEmail({
    to: recipientEmail,
    subject,
    html,
    text,
    fromName: companyName,
  });

  return { ok: true, redeemUrl };
}

app.post("/reward-claim", limitRewardClaim, async (req, res) => {
  try {
    const claim = buildCodePerksRewardClaim(req.body || {});

    if (process.env.REDIS_URL && claim.eventCode) {
      try {
        const eventId =
          await redis.get(`eventcode:codeperks:${claim.eventCode}`) ||
          await redis.get(`eventcode:${claim.eventCode}`);

        if (eventId) {
          const meta = await redis.hgetall(`event:${eventId}:meta`);
          claim.companyName = claim.companyName || String(meta?.companyName || "").trim();
          claim.campaignName = claim.campaignName || String(meta?.name || claim.eventCode || "").trim();
        }
      } catch (metaError) {
        console.warn("Could not enrich reward claim with event meta:", metaError.message);
      }
    }

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
      await redis.set(`codeperks:redemption:${claim.redemptionToken}`, claim.id);
      await redis.rpush(eventClaimsKey, claim.id);

      let emailResult = null;
      try {
        emailResult = await sendCodePerksRedemptionEmail(claim);
        console.log("CODEPERKS_REDEMPTION_EMAIL_RESULT", emailResult);
        await redis.set(claimKey, JSON.stringify(claim));
      } catch (emailError) {
        console.error("codePerks redemption email error", emailError);
        emailResult = { ok: false, error: emailError.message };
      }

      console.log("CODEPERKS_REWARD_CLAIM_REDIS", claim);

      return res.json({
        ok: true,
        claim,
        email: emailResult,
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

    let emailResult = null;
    try {
      emailResult = await sendCodePerksRedemptionEmail(claim);
    } catch (emailError) {
      console.error("codePerks redemption email error", emailError);
      emailResult = { ok: false, error: emailError.message };
    }

    globalThis.__CODEPERKS_REWARD_CLAIMS.push(claim);

    console.log("CODEPERKS_REWARD_CLAIM_MEMORY", claim);

    return res.json({
      ok: true,
      claim,
      email: emailResult,
    });
  } catch (error) {
    console.error("reward-claim error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not register reward claim",
    });
  }
});



app.get("/admin/redis-codetone-events", async (req, res) => {
  try {
    const providedKey = String(req.headers["x-admin-key"] || "").trim();
    const configuredKey = process.env.CODEPERKS_ADMIN_KEY || "CTONE";

    if (providedKey !== configuredKey) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    if (!redis) {
      return res.status(500).json({
        ok: false,
        error: "Redis not available",
      });
    }

    const eventCodeKeys = await redis.keys("eventcode:*");

    const codeToneKeys = eventCodeKeys.filter(
      (key) =>
        key.toLowerCase().includes("codetone") ||
        key.includes("CT-")
    );

    const events = [];

    for (const key of codeToneKeys) {
      const eventId = await redis.get(key);

      if (!eventId) continue;

      const meta = await redis.hgetall(`event:${eventId}:meta`);

      const scanCount =
        Number(await redis.get(`event:${eventId}:scanCount`)) || 0;

      const joinCount =
        Number(await redis.get(`event:${eventId}:innerCircleJoinCount`)) || 0;

      events.push({
        redisKey: key,
        eventId,
        eventCode:
          meta?.eventCode ||
          meta?.code ||
          key.split(":").pop(),
        vertical: meta?.vertical || "",
        name: meta?.name || meta?.title || "",
        venue: meta?.venue || "",
        city: meta?.city || "",
        createdAt:
          meta?.createdAt ||
          meta?.created_at ||
          "",
        status: meta?.status || "",
        scanCount,
        joinCount,
      });
    }

    events.sort((a, b) =>
      String(b.createdAt || "").localeCompare(
        String(a.createdAt || "")
      )
    );

    return res.json({
      ok: true,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("redis-codetone-events error", error);

    return res.status(500).json({
      ok: false,
      error: "Could not read codeTone events",
    });
  }
});


app.get("/postgres-campaign/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const campaign = await getCampaignByCode(eventCode);

    if (!campaign) {
      return res.status(404).json({
        ok: false,
        error: "Campaign not found in Postgres",
      });
    }

    return res.json({
      ok: true,
      campaign,
    });
  } catch (error) {
    console.error("postgres campaign lookup error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not load campaign from Postgres",
    });
  }
});

app.get("/event-registrations/:eventCode", requireCodePerksAdmin, async (req, res) => {
  try {
    const eventCode = String(req.params.eventCode || "").trim();
    const limit = Number(req.query.limit || 50);
    const registrations = await getEventRegistrations(eventCode, limit);

    return res.json({
      ok: true,
      eventCode,
      count: registrations.length,
      registrations,
    });
  } catch (error) {
    console.error("event registrations lookup error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not load event registrations from Postgres",
    });
  }
});


app.get("/redemption/:token", limitCertificateValidate, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        valid: false,
        error: "Missing redemption token",
      });
    }

    const isCodePodGoldXtraToken = token.toUpperCase().startsWith("GX-");
    const isCodeClipXtraToken = token.toUpperCase().startsWith("CX-");

    if (process.env.REDIS_URL) {
      if (isCodePodGoldXtraToken) {
        const rawGoldXtra = await redis.get(`codepod:partnerReward:token:${token}`);
        const goldXtra = rawGoldXtra ? JSON.parse(rawGoldXtra) : null;

        if (goldXtra) {
          return res.json(buildCodePodGoldXtraValidationPayload(goldXtra));
        }

        const postgresGoldXtra = await getCodePodGoldXtraRedemptionByToken(token);
        if (postgresGoldXtra) {
          return res.json(buildCodePodGoldXtraValidationPayload(postgresGoldXtra));
        }

        return res.status(404).json({
          ok: false,
          status: "not_found",
        });
      }

      if (isCodeClipXtraToken) {
        const result = await codeClipVertical.service.validateClipXtraToken({
          token,
          redis,
          getCodeClipXtraRedemptionByToken,
          codeClipVertical,
        });

        return res.status(result.found ? 200 : 404).json(result.payload);
      }

      const claimId = await redis.get(`codeperks:redemption:${token}`);
      const raw = claimId ? await redis.get(`codeperks:claim:${claimId}`) : null;
      const claim = raw ? JSON.parse(raw) : null;

      if (!claim) {
        return res.status(404).json({
          ok: false,
          valid: false,
          error: "Redemption code not found",
        });
      }

      return res.json({
        ok: true,
        valid: true,
        redeemed: Boolean(claim.redeemed),
        redeemedAt: claim.redeemedAt || null,
        expired: isCodePerksClaimExpired(claim),
        eventCode: claim.eventCode,
        certificateId: claim.certificateId,
        claimId: claim.id,
        tier: claim.tier || claim.benefitTier || "",
        rewardTitle: claim.rewardTitle || "",
        redemptionLocation: claim.redemptionLocation || "",
        redemptionDeadline: claim.redemptionDeadline || "",
        redemptionDeadlineTime: claim.redemptionDeadlineTime || "",
        redemptionInstructions: claim.redemptionInstructions || "",
        status: claim.status || "pending",
      });
    }

    if (isCodePodGoldXtraToken) {
      const postgresGoldXtra = await getCodePodGoldXtraRedemptionByToken(token);
      if (postgresGoldXtra) {
        return res.json(buildCodePodGoldXtraValidationPayload(postgresGoldXtra));
      }

      return res.status(404).json({
        ok: false,
        status: "not_found",
      });
    }

    if (isCodeClipXtraToken) {
      const result = await codeClipVertical.service.validateClipXtraToken({
        token,
        redis: null,
        getCodeClipXtraRedemptionByToken,
        codeClipVertical,
      });

      return res.status(result.found ? 200 : 404).json(result.payload);
    }

    const claim = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).find(
      (entry) => entry.redemptionToken === token
    );

    if (!claim) {
      return res.status(404).json({
        ok: false,
        valid: false,
        error: "Redemption code not found",
      });
    }

    return res.json({
      ok: true,
      valid: true,
      redeemed: Boolean(claim.redeemed),
      redeemedAt: claim.redeemedAt || null,
      eventCode: claim.eventCode,
      certificateId: claim.certificateId,
      claimId: claim.id,
      status: claim.status || "pending",
    });
  } catch (error) {
    console.error("redemption lookup error", error);
    return res.status(500).json({
      ok: false,
      valid: false,
      error: "Could not validate redemption code",
    });
  }
});

app.post("/redemption/:token/redeem", limitClaimStatus, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const redeemedBy = String(req.body?.redeemedBy || "partner").trim() || "partner";
    const requestEventCode = String(req.body?.eventCode || req.query?.eventCode || "").trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing redemption token",
      });
    }

    if (token.toUpperCase().startsWith("CX-")) {
      const result = await codeClipVertical.service.redeemClipXtraToken({
        token,
        redeemedBy,
        redis: process.env.REDIS_URL ? redis : null,
        redeemCodeClipXtraRedemption,
        getCodeClipXtraRedemptionByToken,
        codeClipVertical,
      });

      return res.status(result.httpStatus).json(result.payload);
    }

    if (token.toUpperCase().startsWith("GX-")) {
      const result = await redeemCodePodGoldXtraRedemption(token, redeemedBy);
      const row = result.row;

      if (result.status === "not_found" || !row) {
        return res.status(404).json({
          ok: false,
          status: "not_found",
        });
      }

      if (result.status === "already_redeemed") {
        const refreshedRow = await getCodePodGoldXtraRedemptionByToken(token);
        await refreshCodePodGoldXtraRedisToken(token, refreshedRow || row);

        return res.status(409).json({
          ok: false,
          status: "already_redeemed",
          redeemedAt: (refreshedRow || row).redeemed_at || null,
        });
      }

      await refreshCodePodGoldXtraRedisToken(token, row);

      return res.json({
        ...buildCodePodGoldXtraValidationPayload(row),
        ok: true,
        status: "redeemed",
      });
    }

    if (process.env.REDIS_URL) {
      const claimId = await redis.get(`codeperks:redemption:${token}`);
      const claimKey = claimId ? `codeperks:claim:${claimId}` : "";
      const raw = claimKey ? await redis.get(claimKey) : null;
      const claim = raw ? JSON.parse(raw) : null;

      if (!claim) {
        if (requestEventCode) {
          await saveCodeDemoException({
            eventCode: requestEventCode,
            severity: "red",
            category: "claim",
            type: "invalid_claim",
            message: "Redemption code was not found",
            details: {
              token,
              attemptedBy: redeemedBy,
            },
          });
        }

        return res.status(404).json({
          ok: false,
          validationStatus: "invalid_claim",
          error: "Redemption code not found",
        });
      }

      if (claim.redeemed) {
        await saveCodeDemoException({
          eventCode: claim.eventCode || "",
          eventId: claim.eventId || "",
          severity: "red",
          category: "claim",
          type: "already_redeemed",
          message: "Claim has already been redeemed",
          details: {
            claimId: claim.claimId || "",
            token,
            redeemedAt: claim.redeemedAt || null,
            redeemedBy: claim.redeemedBy || "",
            attemptedBy: redeemedBy,
          },
        });

        return res.status(409).json({
          ok: false,
          alreadyRedeemed: true,
          redeemedAt: claim.redeemedAt || null,
          validationStatus: "already_redeemed",
          error: "Already redeemed",
        });
      }

      if (isCodePerksClaimExpired(claim)) {
        await saveCodeDemoException({
          eventCode: claim.eventCode || "",
          eventId: claim.eventId || "",
          severity: "red",
          category: "claim",
          type: "expired_claim",
          message: "Claim has expired",
          details: {
            claimId: claim.id || claim.claimId || "",
            token,
            attemptedBy: redeemedBy,
            expiresAt: claim.expiresAt || claim.claimUntil || claim.validUntil || null,
          },
        });

        return res.status(410).json({
          ok: false,
          expired: true,
          validationStatus: "expired_claim",
          error: "Redemption code expired",
        });
      }

      claim.redeemed = true;
      claim.redeemedAt = new Date().toISOString();
      claim.redeemedBy = redeemedBy;
      claim.status = "fulfilled";
      claim.updatedAt = claim.redeemedAt;

      await redis.set(claimKey, JSON.stringify(claim));

      return res.json({
        ok: true,
        redeemed: true,
        claim,
      });
    }

    const claim = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).find(
      (entry) => entry.redemptionToken === token
    );

    if (!claim) {
      return res.status(404).json({
        ok: false,
        error: "Redemption code not found",
      });
    }

    if (claim.redeemed) {
      await saveCodeDemoException({
        eventCode: claim.eventCode || "",
        eventId: claim.eventId || "",
        severity: "red",
        category: "claim",
        type: "already_redeemed",
        message: "Claim has already been redeemed",
        details: {
          claimId: claim.claimId || "",
          token,
          redeemedAt: claim.redeemedAt || null,
          redeemedBy: claim.redeemedBy || "",
          attemptedBy: redeemedBy,
        },
      });

      return res.status(409).json({
        ok: false,
        alreadyRedeemed: true,
        redeemedAt: claim.redeemedAt || null,
        validationStatus: "already_redeemed",
        error: "Already redeemed",
      });
    }

    claim.redeemed = true;
    claim.redeemedAt = new Date().toISOString();
    claim.redeemedBy = redeemedBy;
    claim.status = "fulfilled";
    claim.updatedAt = claim.redeemedAt;

    return res.json({
      ok: true,
      redeemed: true,
      claim,
    });
  } catch (error) {
    console.error("redemption redeem error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not redeem reward",
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

app.post("/send-fulfillment-list/:eventCode", requireCodePerksAdmin, limitRewardClaimsRead, async (req, res) => {
  const eventCode = String(req.params.eventCode || "").trim();

  try {
    const campaign = await getCampaignByCode(eventCode);
    const rawEvent = campaign?.raw_event || {};
    const rewardDelivery = rawEvent.rewardDelivery || {};
    const recipientName = String(rewardDelivery.responsiblePerson || "").trim();
    const recipientEmail = String(rewardDelivery.email || "").trim();

    if (!recipientEmail) {
      return res.status(400).json({
        ok: false,
        error: "No fulfillment contact email found for this campaign",
      });
    }

    let claims = [];

    if (process.env.REDIS_URL) {
      const eventClaimsKey = `codeperks:claims:event:${eventCode}`;
      const claimIds = await redis.lrange(eventClaimsKey, 0, -1);

      for (const claimId of claimIds) {
        const raw = await redis.get(`codeperks:claim:${claimId}`);
        if (raw) claims.push(JSON.parse(raw));
      }
    } else {
      claims = (globalThis.__CODEPERKS_REWARD_CLAIMS || []).filter(
        (claim) => claim.eventCode === eventCode
      );
    }

    let phoneRows = [];

    if (process.env.REDIS_URL) {
      const storedPhones = await redis.lrange(`event:${campaign.id}:phones`, 0, -1);
      phoneRows = storedPhones
        .map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    const rows = claims
      .map((claim, index) => {
        const phoneFallback = phoneRows[index] || {};
        return {
          certificateId: String(claim.certificateId || "").trim(),
          name: String(claim.claimant?.fullName || claim.fullName || "").trim(),
          phone: String(claim.claimant?.phone || claim.phone || phoneFallback.phone || "").trim(),
          tier: String(claim.tier || claim.benefitTier || "").trim(),
          status: String(claim.status || "").trim(),
        };
      })
      .filter((row) => row.name || row.phone);

    const htmlRows = rows.length
      ? rows.map((row) => `
          <tr>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;">${row.name}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;">${row.phone}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;">${row.tier}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;">${row.status}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;">${row.certificateId}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="5" style="padding:12px;">No claims registered yet.</td></tr>`;

    const textRows = rows.length
      ? rows.map((row) =>
          `${row.name}, ${row.phone}, ${row.tier}, ${row.status}, ${row.certificateId}`
        ).join("\n")
      : "No claims registered yet.";

    const eventTimeZone = String(
      rawEvent.timeZone ||
      rawEvent.timezone ||
      rawEvent.metadata?.timeZone ||
      rawEvent.metadata?.timezone ||
      "UTC"
    ).trim() || "UTC";

    const formatGeneratedAt = (date, timeZone) => {
      const parts = new Intl.DateTimeFormat("nb-NO", {
        timeZone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});

      return `${parts.day}-${parts.month}-${parts.year} kl. ${parts.hour}:${parts.minute}`;
    };

    const generatedAt = formatGeneratedAt(new Date(), eventTimeZone);

    const issuedCount = rows.length;
    const claimedCount = rows.length;
    const subject = `codePerks Fulfillment List • ${eventCode} • ${rows.length} Claim${rows.length === 1 ? "" : "s"}`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#111;">
        <h2>codePerks fulfillment list</h2>
        <p>Campaign: <strong>${eventCode}</strong></p>
        ${recipientName ? `<p>Fulfillment contact: <strong>${recipientName}</strong></p>` : ""}
        <p>Issued: <strong>${issuedCount}</strong><br/>Claimed: <strong>${claimedCount}</strong></p>
        <p style="color:#666;font-size:13px;">Generated: ${generatedAt}</p>

        <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:720px;margin-top:18px;">
          <thead>
            <tr>
              <th align="left" style="padding:8px 10px;border-bottom:2px solid #111;">Name</th>
              <th align="left" style="padding:8px 10px;border-bottom:2px solid #111;">Phone</th>
              <th align="left" style="padding:8px 10px;border-bottom:2px solid #111;">Tier</th>
              <th align="left" style="padding:8px 10px;border-bottom:2px solid #111;">Status</th>
              <th align="left" style="padding:8px 10px;border-bottom:2px solid #111;">Certificate ID</th>
            </tr>
          </thead>
          <tbody>${htmlRows}</tbody>
        </table>

        <p style="margin-top:24px;color:#666;font-size:12px;">
          Sent automatically by codePerks.
        </p>
      </div>
    `;

    const text = [
      "codePerks fulfillment list",
      `Campaign: ${eventCode}`,
      recipientName ? `Fulfillment contact: ${recipientName}` : "",
      `Issued: ${issuedCount}`,
      `Claimed: ${claimedCount}`,
      `Generated: ${generatedAt}`,
      "",
      "name,phone,tier,status,certificate_id",
      textRows,
    ].filter(Boolean).join("\n");

    await sendEmail({
      to: recipientEmail,
      subject,
      html,
      text,
    });

    return res.json({
      ok: true,
      eventCode,
      sentTo: recipientEmail,
      totalClaims: rows.length,
      issued: issuedCount,
      claimed: claimedCount,
      sentAt: generatedAt,
    });
  } catch (error) {
    console.error("send fulfillment list error", error);
    return res.status(500).json({
      ok: false,
      error: "Could not send fulfillment list",
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


if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);

    if (process.env.REDIS_URL) {
      testRedisConnection().catch((err) => {
        console.error("Redis test failed:", err.message);
      });
    } else {
      console.log("Redis disabled - running in memory mode");
    }

    startCodeClipOutboxWorker();
  });
}

module.exports = { app };
