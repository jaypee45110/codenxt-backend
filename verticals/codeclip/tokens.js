const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const CODECLIP_CLIP_XTRA_TOKEN_PREFIX = "CX";
const CODECLIP_CLIP_XTRA_TOKEN_KEY_PREFIX = "codeclip:clipXtra:token:";

function buildCodeClipXtraTokenKey(token) {
  return `${CODECLIP_CLIP_XTRA_TOKEN_KEY_PREFIX}${token}`;
}

function createCodeClipXtraTokenValue() {
  return `${CODECLIP_CLIP_XTRA_TOKEN_PREFIX}-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

async function createCodeClipXtraToken(redis, payload = {}) {
  if (!redis) {
    throw new Error("Redis client is required to create a codeClip ClipXtra token");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = createCodeClipXtraTokenValue();
    const tokenKey = buildCodeClipXtraTokenKey(token);
    const stored = await redis.set(tokenKey, JSON.stringify({ ...payload, token }), "NX");
    if (stored) return token;
  }

  const token = `${CODECLIP_CLIP_XTRA_TOKEN_PREFIX}-${uuidv4().replace(/-/g, "").toUpperCase()}`;
  await redis.set(buildCodeClipXtraTokenKey(token), JSON.stringify({ ...payload, token }), "NX");
  return token;
}

module.exports = {
  CODECLIP_CLIP_XTRA_TOKEN_KEY_PREFIX,
  buildCodeClipXtraTokenKey,
  createCodeClipXtraToken,
  createCodeClipXtraTokenValue,
};
