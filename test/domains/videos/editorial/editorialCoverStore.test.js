import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createEditorialCoverStore } from "../../../../src/domains/videos/editorial/editorialCover.store.js";
import { uploadImage } from "../../../../src/shared/utils/imageUpload.js";

const coverId = "507f191e810c19729de860ea";
const configuration = () => ({ publicProvider: "bunny", public: {
  zone: "images", endpoint: "https://storage.bunnycdn.com", accessKey: "fake-key",
  cdnBaseUrl: "https://images.example" }, storageTimeoutMs: 15000 });

async function image(width = 12, height = 20, format = "jpeg", orientation) {
  let input = sharp({ create: { width, height, channels: 3, background: "red" } });
  if (orientation) input = input.withMetadata({ orientation });
  return input[format]().toBuffer();
}

function fixture() {
  const writes = [];
  const deletes = [];
  const store = createEditorialCoverStore({ configuration,
    upload: (file, options) => uploadImage(file, { ...options,
      bunnyUpload: async (input) => { writes.push(input); } }),
    remove: async (input) => { deletes.push(input); },
  });
  return { store, writes, deletes };
}

test("portrait covers reuse the image pipeline and match strict cleanup keys for every supported format", async () => {
  const { store, writes, deletes } = fixture();
  for (const format of ["jpeg", "png", "webp"]) {
    const result = await store.upload({ coverId: coverId.toUpperCase(), buffer: await image(12, 20, format) });
    assert.deepEqual(result, { public_id: `petyard/video-covers/${coverId}`,
      url: `https://images.example/petyard/video-covers/${coverId}.webp` });
    const metadata = await sharp(writes.at(-1).buffer).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 12);
    assert.equal(metadata.height, 20);
    assert.equal(writes.at(-1).contentType, "image/webp");
  }
  await store.remove({ coverId });
  assert.ok(writes.every((write) => write.objectKey === deletes[0].objectKey));
  assert.equal(deletes[0].objectKey, `petyard/video-covers/${coverId}.webp`);
  assert.equal(deletes[0].timeoutMs, 15000);
});

test("portrait validation and uploaded pixels agree after EXIF orientation", async () => {
  const { store, writes } = fixture();
  await store.upload({ coverId, buffer: await image(20, 12, "jpeg", 6) });
  const output = await sharp(writes[0].buffer).metadata();
  assert.equal(output.width, 12);
  assert.equal(output.height, 20);
  assert.equal(output.orientation, undefined);
  await assert.rejects(store.upload({ coverId, buffer: await image(12, 20, "jpeg", 6) }),
    (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_COVER");
  assert.equal(writes.length, 1);
});

test("covers fit the portrait image bound without cropping or enlarging", async () => {
  const { store, writes } = fixture();
  await store.upload({ coverId, buffer: await image(1200, 2400) });
  const output = await sharp(writes[0].buffer).metadata();
  assert.equal(output.width, 960);
  assert.equal(output.height, 1920);
});

test("invalid, non-portrait, animated, oversized and pixel-bomb covers never write storage", async () => {
  const { store, writes } = fixture();
  const frames = Buffer.concat([Buffer.alloc(12 * 20 * 3, 0), Buffer.alloc(12 * 20 * 3, 255)]);
  const animated = await sharp(frames, { raw: { width: 12, height: 40, pageHeight: 20,
    channels: 3 } }).webp({ loop: 0 }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const valid = await image(12, 20);
  for (const buffer of [null, Buffer.alloc(0), Buffer.alloc(5 * 1024 * 1024 + 1),
    Buffer.from("corrupt image"), valid.subarray(0, valid.length - 24),
    await image(20, 12), await image(12, 12), await image(12, 20, "gif"), animated,
    await image(4000, 5000, "png"),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="20"></svg>')]) {
    await assert.rejects(store.upload({ coverId, buffer }),
      (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_COVER");
  }
  assert.deepEqual(writes, []);
});

test("cover IDs cannot escape the reserved folder on upload or deletion", async () => {
  const { store, writes, deletes } = fixture();
  for (const id of ["../other", "https://images.example/other.webp", "", null, "a".repeat(25)]) {
    await assert.rejects(store.upload({ coverId: id, buffer: await image() }), TypeError);
    await assert.rejects(store.remove({ coverId: id }), TypeError);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(deletes, []);
});

test("strict cover deletion works without a descriptor and propagates storage failure", async () => {
  let request;
  const store = createEditorialCoverStore({ configuration, async remove(input) {
    request = input;
    throw new Error("storage unavailable");
  } });
  await assert.rejects(store.remove({ coverId }), /storage unavailable/);
  assert.equal(request.objectKey, `petyard/video-covers/${coverId}.webp`);
  assert.equal(request.zone, "images");
});

test("cover storage fails closed without Bunny and preserves upload failures for compensation", async () => {
  let writes = 0;
  for (const config of [{ publicProvider: "cloudinary" }, { publicProvider: "bunny" }]) {
    const store = createEditorialCoverStore({ configuration: () => config,
      async upload() { writes++; }, async remove() { writes++; } });
    for (const work of [() => store.upload({ coverId, buffer: Buffer.from("image") }),
      () => store.remove({ coverId })]) {
      await assert.rejects(work(), (error) => error.statusCode === 503 &&
        error.errors[0].code === "VIDEO_COVER_STORAGE_UNAVAILABLE");
    }
  }
  const store = createEditorialCoverStore({ configuration, async upload() {
    throw new Error("PUT response lost");
  } });
  await assert.rejects(store.upload({ coverId, buffer: await image() }), /PUT response lost/);
  assert.equal(writes, 0);
});

test("existing standard, tile and proof image behavior is unchanged by the portrait profile", async () => {
  const buffer = await image(20, 12, "jpeg", 6);
  for (const profile of ["standard", "tile", "proof"]) {
    let written;
    await uploadImage({ buffer, size: buffer.length, mimetype: "image/jpeg" },
      { folder: "petyard/test", publicId: "existing", profile, configuration: configuration(),
        bunnyUpload: async (input) => { written = input; } });
    const output = await sharp(written.buffer).metadata();
    assert.equal(output.width, 20);
    assert.equal(output.height, 12);
  }
});
