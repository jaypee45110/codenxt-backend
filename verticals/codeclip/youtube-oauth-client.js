class CodeClipYouTubeOAuthClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodeClipYouTubeOAuthClientError";
    this.code = code;
    this.details = details;
  }
}

function clientError(code, message, details = {}) {
  return new CodeClipYouTubeOAuthClientError(code, message, details);
}

function buildCodeClipYouTubeAuthorizationUrl({ policy, state }) {
  const url = new URL(policy.authorizationEndpoint);
  url.searchParams.set("client_id", policy.clientId);
  url.searchParams.set("redirect_uri", policy.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", policy.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeCodeClipYouTubeAuthorizationCode({
  code,
  policy,
  fetchImpl = global.fetch,
} = {}) {
  const authorizationCode = String(code || "").trim();
  if (!authorizationCode) {
    throw clientError("youtube_oauth_state_invalid", "YouTube authorization code is missing");
  }
  if (typeof fetchImpl !== "function") {
    throw clientError("youtube_connection_unavailable", "YouTube OAuth fetch is unavailable");
  }
  let response;
  try {
    response = await fetchImpl(policy.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: policy.clientId,
        client_secret: policy.clientSecret,
        code: authorizationCode,
        grant_type: "authorization_code",
        redirect_uri: policy.callbackUrl,
      }).toString(),
    });
  } catch {
    throw clientError("youtube_connection_unavailable", "YouTube token exchange unavailable");
  }
  if (!response || !response.ok) {
    throw clientError("youtube_connection_unavailable", "YouTube token exchange failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw clientError("youtube_connection_unavailable", "YouTube token exchange failed");
  }
  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  if (!accessToken) {
    throw clientError("youtube_connection_unavailable", "YouTube token exchange failed");
  }
  return {
    accessToken,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

function normalizeYouTubeChannel(item = {}) {
  const channelId = String(item.id || "").trim();
  if (!/^UC[A-Za-z0-9_-]{20,32}$/.test(channelId)) {
    throw clientError("youtube_channel_not_found", "YouTube channel ID was not returned");
  }
  return {
    channelId,
    displayName: String(item.snippet?.title || "").trim() || channelId,
    thumbnailUrl:
      typeof item.snippet?.thumbnails?.default?.url === "string"
        ? item.snippet.thumbnails.default.url
        : null,
  };
}

async function fetchAuthenticatedYouTubeChannel({
  accessToken,
  policy,
  fetchImpl = global.fetch,
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token || typeof fetchImpl !== "function") {
    throw clientError("youtube_connection_unavailable", "YouTube channel lookup unavailable");
  }
  const url = new URL(policy.channelsEndpoint);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw clientError("youtube_connection_unavailable", "YouTube channel lookup unavailable");
  }
  if (!response || !response.ok) {
    throw clientError("youtube_connection_unavailable", "YouTube channel lookup failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw clientError("youtube_connection_unavailable", "YouTube channel lookup failed");
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throw clientError("youtube_channel_not_found", "No authenticated YouTube channel was found");
  }
  if (items.length > 1) {
    throw clientError("youtube_channel_ambiguous", "Authenticated YouTube channel is ambiguous");
  }
  return normalizeYouTubeChannel(items[0]);
}

module.exports = {
  CodeClipYouTubeOAuthClientError,
  buildCodeClipYouTubeAuthorizationUrl,
  exchangeCodeClipYouTubeAuthorizationCode,
  fetchAuthenticatedYouTubeChannel,
};
