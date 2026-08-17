const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCodeClipCreatorSessionToken,
  verifyCodeClipCreatorSessionToken,
  buildCodeClipCreatorSessionSetCookie,
  parseCookieHeader,
  COOKIE_NAME,
} = require("./verticals/codeclip/creator-session");

const ENV = { CODECLIP_CREATOR_SESSION_SECRET: "unit-test-creator-session-secret" };

test("creator session token verifies for matching event and rejects mismatch/expiry", () => {
  const token = createCodeClipCreatorSessionToken(
    { eventCode: "CC-1", ttlSeconds: 600, now: 1_700_000_000_000 },
    ENV
  );
  assert.equal(
    verifyCodeClipCreatorSessionToken(
      token,
      { eventCode: "CC-1", now: 1_700_000_000_000 },
      ENV
    ).ok,
    true
  );
  assert.equal(
    verifyCodeClipCreatorSessionToken(
      token,
      { eventCode: "CC-OTHER", now: 1_700_000_000_000 },
      ENV
    ).ok,
    false
  );
  assert.equal(
    verifyCodeClipCreatorSessionToken(
      token,
      { eventCode: "CC-1", now: 1_700_000_000_000 + 700_000 },
      ENV
    ).ok,
    false
  );
  assert.doesNotMatch(token, /dashboardAccessKey|CC-1\.dashboard/i);
});

test("Set-Cookie is HttpOnly Secure SameSite=None", () => {
  const cookie = buildCodeClipCreatorSessionSetCookie("abc.def", {
    ttlSeconds: 600,
    secure: true,
  });
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.doesNotMatch(cookie, /dashboardAccessKey/i);
});

test("parseCookieHeader extracts creator cookie", () => {
  const parsed = parseCookieHeader(`${COOKIE_NAME}=hello%2Eworld; other=1`);
  assert.equal(parsed[COOKIE_NAME], "hello.world");
});
