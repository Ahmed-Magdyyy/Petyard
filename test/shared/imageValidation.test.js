import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { uploadImage, validateImageFile } from "../../src/shared/utils/imageUpload.js";

const configuration = { publicProvider: "bunny", privateProvider: "bunny", storageTimeoutMs: 15000,
  public: { zone: "test", endpoint: "https://storage.example", accessKey: "fake-test-key", cdnBaseUrl: "https://media.petyardstores.com" } };
const svg = (inner, extra = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" ${extra}>${inner}</svg>`);
const file = (buffer, mimetype) => ({ buffer, mimetype, size: buffer.length });

test("safe SVG is rasterized, JPEG aliases decode honestly, and valid GIF bytes are preserved", async () => {
  const uploads = [];
  const result = await uploadImage(file(svg('<rect width="10" height="10" fill="red"/>'), "image/svg+xml"),
    { folder: "petyard/products", configuration, bunnyUpload: async (request) => uploads.push(request) });
  assert.ok(result.url.endsWith(".webp"));
  assert.equal(uploads[0].contentType, "image/webp");
  assert.equal((await sharp(uploads[0].buffer).metadata()).format, "webp");
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).jpeg().toBuffer();
  await uploadImage(file(jpeg, "image/jpg"), { folder: "petyard/products", configuration, bunnyUpload: async () => {} });
  const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).gif().toBuffer();
  await uploadImage(file(gif, "image/gif"), { folder: "petyard/products", configuration, bunnyUpload: async (request) => {
    assert.equal(request.contentType, "image/gif");
    assert.deepEqual(request.buffer, gif);
  } });
});

test("active/external SVG and malformed or mislabeled images fail before a provider call", async () => {
  let calls = 0;
  const upload = (buffer, mime) => uploadImage(file(buffer, mime), { folder: "petyard/products", configuration,
    bunnyUpload: async () => { calls++; } });
  for (const buffer of [
    svg('<script>alert(1)</script>'),
    svg('<foreignObject><div>HTML</div></foreignObject>'),
    svg('<image href="https://external.example/image.png"/>'),
    svg('<image href="&#104;ttps://external.example/image.png"/>'),
    svg('<rect fill="url(file:///etc/passwd)"/>'),
    svg('<style>@import "https://external.example/style.css";</style>'),
    svg('', 'onload="alert(1)"'),
    svg('<use href="#external"/>', 'xml:base="file:///tmp/"'),
    Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'),
    Buffer.from('<svg><unclosed>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="1"/>'),
  ]) await assert.rejects(upload(buffer, "image/svg+xml"), (error) => error.statusCode === 400);
  await assert.rejects(upload(svg(''), "image/png"), (error) => error.statusCode === 400);
  await assert.rejects(upload(Buffer.from("not a GIF"), "image/gif"), (error) => error.statusCode === 400);
  assert.equal(calls, 0);
});

test("actual buffer bytes enforce the upload limit even when declared size is incorrect", () => {
  assert.throws(() => validateImageFile({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: "image/png", size: 1 }),
    (error) => error.statusCode === 400);
});
