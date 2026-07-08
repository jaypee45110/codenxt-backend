const test = require("node:test");
const assert = require("node:assert/strict");

const {
  captureCodeClipProviderRawBody,
} = require("./verticals/codeclip/provider-raw-body");

test("codeClip provider raw body capture preserves Buffer bytes", () => {
  const req = {};
  const rawBody = Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x31, 0x7d]);

  const result = captureCodeClipProviderRawBody(req, rawBody);

  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(req.codeClipRawBody));
  assert.ok(Buffer.isBuffer(result.rawBody));
  assert.deepEqual([...req.codeClipRawBody], [...rawBody]);
  assert.deepEqual([...result.rawBody], [...rawBody]);
});

test("codeClip provider raw body capture stores an independent Buffer copy", () => {
  const req = {};
  const rawBody = Buffer.from("CLIP");

  const result = captureCodeClipProviderRawBody(req, rawBody);
  rawBody.write("X");

  assert.equal(result.ok, true);
  assert.equal(req.codeClipRawBody.toString(), "CLIP");
});

test("codeClip provider raw body capture handles empty Buffer", () => {
  const req = {};
  const result = captureCodeClipProviderRawBody(req, Buffer.alloc(0));

  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(req.codeClipRawBody));
  assert.equal(req.codeClipRawBody.length, 0);
});

test("codeClip provider raw body capture treats missing body as empty Buffer", () => {
  const req = {};
  const result = captureCodeClipProviderRawBody(req);

  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(req.codeClipRawBody));
  assert.equal(req.codeClipRawBody.length, 0);
});

test("codeClip provider raw body capture rejects missing request explicitly", () => {
  assert.deepEqual(
    captureCodeClipProviderRawBody(null, Buffer.from("CLIP")),
    { ok: false, reason: "REQUEST_REQUIRED" }
  );
});

test("codeClip provider raw body capture does not stringify or parse non-Buffers", () => {
  const req = {};
  const rawBody = {
    toString() {
      throw new Error("should not stringify");
    },
    toJSON() {
      throw new Error("should not parse");
    },
  };

  const result = captureCodeClipProviderRawBody(req, rawBody);

  assert.deepEqual(result, { ok: false, reason: "RAW_BODY_BUFFER_REQUIRED" });
  assert.equal(Object.hasOwn(req, "codeClipRawBody"), false);
});

test("codeClip provider raw body capture does not create verification fields", () => {
  const req = {};
  const result = captureCodeClipProviderRawBody(req, Buffer.from("CLIP"));

  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(req, "secret"), false);
  assert.equal(Object.hasOwn(req, "signature"), false);
  assert.equal(Object.hasOwn(req, "signatureHeader"), false);
  assert.equal(Object.hasOwn(req, "signatureHeaders"), false);
  assert.equal(Object.hasOwn(req, "verification"), false);
  assert.equal(Object.hasOwn(req, "verificationMethod"), false);
});
