function normalizeCodeClipProviderWebhookPathInput(pathOrReq) {
  if (typeof pathOrReq === "string") return pathOrReq;
  if (!pathOrReq || typeof pathOrReq !== "object") return "";

  return String(pathOrReq.path || pathOrReq.originalUrl || "");
}

function isCodeClipProviderWebhookPath(pathOrReq) {
  const path = normalizeCodeClipProviderWebhookPathInput(pathOrReq)
    .split("?")[0]
    .replace(/\/+$/, "");

  return (
    /^\/codeclip\/provider\/[^/]+\/keyword$/.test(path) ||
    isCodeClipYouTubeProviderWebhookPath(path)
  );
}

function isCodeClipProviderKeywordWebhookPath(pathOrReq) {
  const path = normalizeCodeClipProviderWebhookPathInput(pathOrReq)
    .split("?")[0]
    .replace(/\/+$/, "");

  return /^\/codeclip\/provider\/[^/]+\/keyword$/.test(path);
}

function isCodeClipYouTubeProviderWebhookPath(pathOrReq) {
  const path = normalizeCodeClipProviderWebhookPathInput(pathOrReq)
    .split("?")[0]
    .replace(/\/+$/, "");

  return (
    /^\/codeclip\/provider\/youtube\/[^/]+$/.test(path) ||
    /^\/api\/codeclip\/providers\/youtube\/websub\/[^/]+$/.test(path)
  );
}

function captureCodeClipProviderRawBody(req, buf) {
  if (!req || typeof req !== "object") {
    return { ok: false, reason: "REQUEST_REQUIRED" };
  }

  if (buf == null) {
    req.codeClipRawBody = Buffer.alloc(0);
    return { ok: true, rawBody: req.codeClipRawBody };
  }

  if (!Buffer.isBuffer(buf)) {
    return { ok: false, reason: "RAW_BODY_BUFFER_REQUIRED" };
  }

  req.codeClipRawBody = Buffer.from(buf);
  return { ok: true, rawBody: req.codeClipRawBody };
}

module.exports = {
  captureCodeClipProviderRawBody,
  isCodeClipProviderKeywordWebhookPath,
  isCodeClipProviderWebhookPath,
  isCodeClipYouTubeProviderWebhookPath,
};
