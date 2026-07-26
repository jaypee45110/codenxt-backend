const { XMLParser, XMLValidator } = require("fast-xml-parser");

const {
  normalizeCodeClipProviderAccountId,
} = require("./provider-account-bindings");

const YOUTUBE_WEBSUB_MAX_ENTRIES = 20;
const YOUTUBE_ATOM_FEED_HOST = "www.youtube.com";
const YOUTUBE_ATOM_FEED_PATH = "/feeds/videos.xml";

class CodeClipYouTubeWebSubFeedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeWebSubFeedError";
    this.code = code;
    this.details = details;
  }
}

function feedError(code, message, details = {}) {
  return new CodeClipYouTubeWebSubFeedError(code, message, details);
}

function asString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readLocalName(container, localName) {
  if (!container || typeof container !== "object") return undefined;
  if (Object.hasOwn(container, localName)) return container[localName];

  const suffix = `:${localName}`;
  for (const [key, value] of Object.entries(container)) {
    if (key.endsWith(suffix)) return value;
  }
  return undefined;
}

function readAttribute(container, name) {
  if (!container || typeof container !== "object") return "";
  return asString(container[`@_${name}`] || container[`@${name}`] || container[name]);
}

function readText(value) {
  if (value && typeof value === "object") {
    return asString(value["#text"] || value.text || value.value);
  }
  return asString(value);
}

function readLinkHref(links, rel) {
  for (const link of asArray(links)) {
    if (!link || typeof link !== "object") continue;
    const linkRel = readAttribute(link, "rel").toLowerCase();
    if (rel && linkRel !== rel) continue;
    const href = readAttribute(link, "href");
    if (href) return href;
  }
  return "";
}

function normalizeTopicUrl(value, fieldName) {
  const raw = asString(value);
  if (!raw) {
    throw feedError("INVALID_ATOM_FEED", `${fieldName} is required`, { fieldName });
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw feedError("INVALID_ATOM_FEED", `${fieldName} must be a valid URL`, { fieldName });
  }

  if (url.protocol === "https:") {
    return url.toString();
  }

  if (
    url.protocol !== "http:" ||
    url.hostname !== YOUTUBE_ATOM_FEED_HOST ||
    url.pathname !== YOUTUBE_ATOM_FEED_PATH
  ) {
    throw feedError("INVALID_ATOM_FEED", `${fieldName} must be an HTTPS URL`, { fieldName });
  }

  const channelId = normalizeYouTubeChannelId(url.searchParams.get("channel_id") || "", "channelId");
  url.protocol = "https:";
  url.hostname = YOUTUBE_ATOM_FEED_HOST;
  url.pathname = YOUTUBE_ATOM_FEED_PATH;
  url.search = `?channel_id=${encodeURIComponent(channelId)}`;
  url.hash = "";

  return url.toString();
}

function readChannelIdFromTopic(topic) {
  try {
    return new URL(topic).searchParams.get("channel_id") || "";
  } catch {
    return "";
  }
}

function normalizeYouTubeChannelId(value, fieldName = "channelId") {
  try {
    return normalizeCodeClipProviderAccountId("youtube", value);
  } catch {
    throw feedError("INVALID_ATOM_FEED", `${fieldName} must be a YouTube channel ID`, {
      fieldName,
    });
  }
}

function normalizeYouTubeVideoId(value) {
  const normalized = asString(value);
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(normalized)) {
    throw feedError("INVALID_ATOM_ENTRY", "videoId is required", {
      fieldName: "videoId",
    });
  }
  return normalized;
}

function normalizeTimestamp(value, fieldName) {
  const raw = asString(value);
  if (!raw) {
    throw feedError("INVALID_ATOM_ENTRY", `${fieldName} is required`, { fieldName });
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw feedError("INVALID_ATOM_ENTRY", `${fieldName} must be a valid timestamp`, {
      fieldName,
    });
  }
  return parsed.toISOString();
}

function parseAuthor(author) {
  if (!author || typeof author !== "object") return null;
  const name = readText(readLocalName(author, "name"));
  const uri = readText(readLocalName(author, "uri"));
  if (!name && !uri) return null;
  return { name: name || null, uri: uri || null };
}

function normalizeEntry(entry, feedChannelId) {
  if (!entry || typeof entry !== "object") {
    throw feedError("INVALID_ATOM_ENTRY", "entry must be an object");
  }

  const videoId = normalizeYouTubeVideoId(readLocalName(entry, "videoId"));
  const channelId = normalizeYouTubeChannelId(
    readLocalName(entry, "channelId") || feedChannelId,
    "channelId"
  );
  const entryId = asString(readLocalName(entry, "id")) || `yt:video:${videoId}`;
  const publishedAt = normalizeTimestamp(readLocalName(entry, "published"), "publishedAt");
  const updatedAt = normalizeTimestamp(readLocalName(entry, "updated"), "updatedAt");
  const alternateUrl = readLinkHref(readLocalName(entry, "link"), "alternate") || null;

  return {
    eventType: "published_video",
    activationIdentity: `youtube:${channelId}:${videoId}:published`,
    externalMessageId: `youtube:${channelId}:${videoId}:published`,
    entryId,
    videoId,
    channelId,
    title: readText(readLocalName(entry, "title")) || null,
    publishedAt,
    updatedAt,
    author: parseAuthor(readLocalName(entry, "author")),
    alternateUrl,
  };
}

function rejectUnsafeXmlFeatures(xml) {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw feedError("MALFORMED_XML", "XML document type declarations are not supported");
  }
}

function parseCodeClipYouTubeWebSubAtomFeed(rawBody, options = {}) {
  const maxEntries = options.maxEntries || YOUTUBE_WEBSUB_MAX_ENTRIES;
  const xml = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  if (!xml.trim()) {
    throw feedError("EMPTY_BODY", "YouTube WebSub body is empty");
  }

  rejectUnsafeXmlFeatures(xml);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw feedError("MALFORMED_XML", "YouTube WebSub XML is malformed");
  }

  let parsed;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: false,
      htmlEntities: false,
    });
    parsed = parser.parse(xml);
  } catch {
    throw feedError("MALFORMED_XML", "YouTube WebSub XML could not be parsed");
  }

  const feed = readLocalName(parsed, "feed");
  if (!feed || typeof feed !== "object") {
    throw feedError("INVALID_ATOM_FEED", "Atom feed is required");
  }

  const topic = normalizeTopicUrl(readLinkHref(readLocalName(feed, "link"), "self"), "topic");
  const channelId = normalizeYouTubeChannelId(readChannelIdFromTopic(topic), "channelId");
  const rawEntries = readLocalName(feed, "entry");
  const entries = rawEntries === undefined
    ? []
    : Array.isArray(rawEntries)
      ? rawEntries
      : [rawEntries];

  if (!entries.length) {
    return {
      topic,
      channelId,
      feedId: readText(readLocalName(feed, "id")) || null,
      updatedAt: readText(readLocalName(feed, "updated")) || null,
      entries: [],
    };
  }

  if (entries.length > maxEntries) {
    throw feedError("TOO_MANY_ENTRIES", "YouTube WebSub notification has too many entries", {
      maxEntries,
    });
  }

  return {
    topic,
    channelId,
    feedId: readText(readLocalName(feed, "id")) || null,
    updatedAt: readText(readLocalName(feed, "updated")) || null,
    entries: entries.map((entry) => normalizeEntry(entry, channelId)),
  };
}

module.exports = {
  CodeClipYouTubeWebSubFeedError,
  YOUTUBE_WEBSUB_MAX_ENTRIES,
  parseCodeClipYouTubeWebSubAtomFeed,
};
