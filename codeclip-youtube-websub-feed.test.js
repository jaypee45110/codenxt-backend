const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseCodeClipYouTubeWebSubAtomFeed,
} = require("./verticals/codeclip/youtube-websub-feed");

const CHANNEL_ID = "UCvwiNkgNuGuizjo33NZhzPg";
const TOPIC = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

function youtubeFeedXml({ topic = TOPIC, channelId = CHANNEL_ID, entries = true } = {}) {
  const entryXml = entries
    ? `<entry>
        <id>yt:video:LdSe5-sM5e0</id>
        <yt:videoId>LdSe5-sM5e0</yt:videoId>
        <yt:channelId>${channelId}</yt:channelId>
        <link rel="alternate" href="https://www.youtube.com/watch?v=LdSe5-sM5e0"/>
        <published>2026-07-25T08:46:01+00:00</published>
        <updated>2026-07-25T08:47:00+00:00</updated>
      </entry>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <link rel="self" href="${topic}"/>
  <id>yt:channel:${channelId}</id>
  <updated>2026-07-25T08:47:00+00:00</updated>
  ${entryXml}
</feed>`;
}

test("YouTube Atom parser accepts YouTube http self-link and returns canonical HTTPS topic", () => {
  const feed = parseCodeClipYouTubeWebSubAtomFeed(
    youtubeFeedXml({
      topic: `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    })
  );

  assert.equal(feed.topic, TOPIC);
  assert.equal(feed.channelId, CHANNEL_ID);
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].channelId, CHANNEL_ID);
  assert.equal(feed.entries[0].videoId, "LdSe5-sM5e0");
});

test("YouTube Atom parser rejects http self-link for non-YouTube host", () => {
  assert.throws(
    () =>
      parseCodeClipYouTubeWebSubAtomFeed(
        youtubeFeedXml({
          topic: `http://example.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
        })
      ),
    (error) => error.code === "INVALID_ATOM_FEED" && error.details.fieldName === "topic"
  );
});

test("YouTube Atom parser rejects http self-link with wrong feed path", () => {
  assert.throws(
    () =>
      parseCodeClipYouTubeWebSubAtomFeed(
        youtubeFeedXml({
          topic: `http://www.youtube.com/not-feeds/videos.xml?channel_id=${CHANNEL_ID}`,
        })
      ),
    (error) => error.code === "INVALID_ATOM_FEED" && error.details.fieldName === "topic"
  );
});

test("YouTube Atom parser rejects invalid or missing channel_id", () => {
  assert.throws(
    () =>
      parseCodeClipYouTubeWebSubAtomFeed(
        youtubeFeedXml({
          topic: "http://www.youtube.com/feeds/videos.xml?channel_id=not-a-channel",
        })
      ),
    (error) => error.code === "INVALID_ATOM_FEED" && error.details.fieldName === "channelId"
  );
  assert.throws(
    () =>
      parseCodeClipYouTubeWebSubAtomFeed(
        youtubeFeedXml({
          topic: "http://www.youtube.com/feeds/videos.xml",
        })
      ),
    (error) => error.code === "INVALID_ATOM_FEED" && error.details.fieldName === "channelId"
  );
});

test("YouTube Atom parser keeps existing HTTPS feed fixture behavior", () => {
  const feed = parseCodeClipYouTubeWebSubAtomFeed(youtubeFeedXml());

  assert.equal(feed.topic, TOPIC);
  assert.equal(feed.channelId, CHANNEL_ID);
  assert.equal(feed.entries[0].externalMessageId, `youtube:${CHANNEL_ID}:LdSe5-sM5e0:published`);
});
