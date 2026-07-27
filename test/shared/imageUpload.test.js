import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import sharp from "sharp";

import cloudinary from "../../src/shared/utils/cloudinary.js";
import {
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
  deleteImage,
  uploadImage,
  validateImageFile,
} from "../../src/shared/utils/imageUpload.js";

const imageBuffer = await sharp({
  create: { width: 1000, height: 750, channels: 3, background: "#228b22" },
}).png().toBuffer();

const bunnyEnvironment = {
  BUNNY_PUBLIC_STORAGE_ZONE: "petyardpublicmedia",
  BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "public-access-key",
  BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PUBLIC_CDN_BASE_URL: "https://media.petyardstores.com",
  BUNNY_PRIVATE_STORAGE_ZONE: "petyardprivatepayments",
  BUNNY_PRIVATE_STORAGE_ACCESS_KEY: "private-access-key",
  BUNNY_PRIVATE_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PRIVATE_CDN_BASE_URL: "https://proofs.petyardstores.com",
};

function withEnvironment(values, run) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function imageFile(overrides = {}) {
  return {
    buffer: imageBuffer,
    mimetype: "image/png",
    size: imageBuffer.length,
    ...overrides,
  };
}

test("image facade preserves no-file and raw validation behavior", async () => {
  assert.equal(await uploadImage(null), null);
  assert.equal(validateImageFile(null), undefined);
  assert.throws(() => validateImageFile(imageFile({ mimetype: "application/pdf" })), /Invalid image type/);
  assert.throws(() => validateImageFile(imageFile({ size: 5 * 1024 * 1024 + 1 })), /Image is too large/);
});

test("Cloudinary remains the default and preserves descriptor shape", async (t) => {
  let options;
  let receivedBuffer;
  t.mock.method(cloudinary.uploader, "upload_stream", (receivedOptions, callback) => {
    options = receivedOptions;
    return {
      end(buffer) {
        receivedBuffer = buffer;
        callback(null, { public_id: "petyard/users/cloudinary-id", secure_url: "https://res.cloudinary.com/example/image/upload/v1/a.webp" });
      },
    };
  });

  await withEnvironment({
    PUBLIC_MEDIA_STORAGE_PROVIDER: "cloudinary",
    PRIVATE_MEDIA_STORAGE_PROVIDER: "cloudinary",
  }, async () => {
    const result = await uploadImage(imageFile(), {
      folder: "petyard/users",
      publicId: "caller-id",
      profile: IMAGE_UPLOAD_PROFILES.TILE,
    });
    assert.deepEqual(result, { public_id: "petyard/users/cloudinary-id", url: "https://res.cloudinary.com/example/image/upload/v1/a.webp" });
  });

  assert.equal(options.folder, "petyard/users");
  assert.equal(options.public_id, "caller-id");
  const metadata = await sharp(receivedBuffer).metadata();
  assert.equal(metadata.format, "webp");
});

test("Bunny selects public and private zones independently and returns unchanged descriptor shape", async () => {
  const uploads = [];
  await withEnvironment({
    ...bunnyEnvironment,
    PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny",
    PRIVATE_MEDIA_STORAGE_PROVIDER: "bunny",
  }, async () => {
    const publicResult = await uploadImage(imageFile(), {
      folder: "petyard/products",
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.TILE,
      uuid: () => "public-id",
      bunnyUpload: async (request) => uploads.push(request),
    });
    const privateResult = await uploadImage(imageFile(), {
      folder: "instapay_screenshots",
      visibility: IMAGE_VISIBILITY.PRIVATE,
      profile: IMAGE_UPLOAD_PROFILES.PROOF,
      uuid: () => "private-id",
      bunnyUpload: async (request) => uploads.push(request),
    });
    assert.deepEqual(publicResult, {
      public_id: "petyard/products/public-id",
      url: "https://media.petyardstores.com/petyard/products/public-id.webp",
    });
    assert.deepEqual(privateResult, {
      public_id: "instapay_screenshots/private-id",
      url: "https://proofs.petyardstores.com/instapay_screenshots/private-id.webp",
    });
  });

  assert.equal(uploads[0].zone, "petyardpublicmedia");
  assert.equal(uploads[1].zone, "petyardprivatepayments");
  assert.equal(uploads[0].objectKey, "petyard/products/public-id.webp");
  assert.equal(uploads[1].objectKey, "instapay_screenshots/private-id.webp");
  assert.equal((await sharp(uploads[0].buffer).metadata()).format, "webp");
  assert.ok((await sharp(uploads[0].buffer).metadata()).width <= 480);
  assert.deepEqual(await sharp(uploads[1].buffer).metadata().then(({ width, height }) => ({ width, height })), { width: 1000, height: 750 });
});

test("SVG and GIF pass through without conversion", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  let request;
  await withEnvironment({ ...bunnyEnvironment, PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny" }, async () => {
    const result = await uploadImage({ buffer: svg, mimetype: "image/svg+xml", size: svg.length }, {
      folder: "petyard/users",
      uuid: () => "avatar",
      bunnyUpload: async (value) => { request = value; },
    });
    assert.deepEqual(result, {
      public_id: "petyard/users/avatar",
      url: "https://media.petyardstores.com/petyard/users/avatar.svg",
    });
  });
  assert.equal(request.buffer, svg);
  assert.equal(request.contentType, "image/svg+xml");
});

test("deletion is routed by its stored URL and remains best effort", async (t) => {
  const requests = [];
  t.mock.method(axios, "request", async (request) => {
    requests.push(request);
    return { status: 204 };
  });
  await withEnvironment({ ...bunnyEnvironment }, async () => {
    await deleteImage({ public_id: "old", url: "https://media.petyardstores.com/petyard/users/old.webp" });
    await deleteImage({ public_id: "proof", url: "https://proofs.petyardstores.com/instapay_screenshots/proof.webp" });
    await deleteImage({ public_id: "external", url: "https://external.example/image.webp" });
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /petyardpublicmedia\/petyard\/users\/old\.webp$/);
  assert.match(requests[1].url, /petyardprivatepayments\/instapay_screenshots\/proof\.webp$/);
});

test("Cloudinary deletion uses the stored descriptor while external and cleanup failures stay nonthrowing", async () => {
  const destroyed = [];
  let warnings = 0;
  const configuration = {
    publicProvider: "cloudinary",
    privateProvider: "cloudinary",
    public: null,
    private: null,
    storageTimeoutMs: 15000,
  };
  const cloudinaryClient = {
    uploader: {
      async destroy(publicId) { destroyed.push(publicId); },
    },
  };

  await deleteImage(
    {
      public_id: "petyard/users/avatar",
      url: "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/users/avatar.webp",
    },
    { configuration, cloudinaryClient },
  );
  await deleteImage(
    { public_id: "external", url: "https://oauth.example/avatar.png" },
    { configuration, cloudinaryClient },
  );
  assert.deepEqual(destroyed, ["petyard/users/avatar"]);

  await deleteImage(
    {
      public_id: "petyard/users/failing",
      url: "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/users/failing.webp",
    },
    {
      configuration,
      cloudinaryClient: { uploader: { async destroy() { throw new Error("provider secret"); } } },
      logger: { warn() { warnings += 1; } },
    },
  );
  assert.equal(warnings, 1);
});
