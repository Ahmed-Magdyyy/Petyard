import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildBunnyCdnUrl,
  deleteBunnyObject,
  downloadBunnyObject,
  getBunnyObjectKeyFromUrl,
  uploadBunnyObject,
} from "../../src/shared/utils/bunnyStorage.js";

const storage = {
  zone: "petyardpublicmedia",
  accessKey: "storage-secret-value",
  endpoint: "https://storage.bunnycdn.com",
};

test("Bunny upload uses the exact encoded Storage API request and checksum", async () => {
  const calls = [];
  const body = Buffer.from("image bytes");
  const transport = {
    async request(request) {
      calls.push(request);
      return { status: 201 };
    },
  };

  await uploadBunnyObject({
    ...storage,
    objectKey: "petyard/products/blue cat+1.webp",
    buffer: body,
    contentType: "image/webp",
    transport,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://storage.bunnycdn.com/petyardpublicmedia/petyard/products/blue%20cat%2B1.webp",
  );
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].data, body);
  assert.equal(calls[0].headers.AccessKey, storage.accessKey);
  assert.equal(calls[0].headers["Content-Type"], "image/webp");
  assert.equal(
    calls[0].headers.Checksum,
    crypto.createHash("sha256").update(body).digest("hex").toUpperCase(),
  );
});

test("Bunny upload retries transient errors no more than twice and not permanent 4xx errors", async () => {
  let attempts = 0;
  await uploadBunnyObject({
    ...storage,
    objectKey: "petyard/users/user.webp",
    buffer: Buffer.from("x"),
    contentType: "image/webp",
    transport: {
      async request() {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("temporary");
          error.response = { status: 503, headers: {} };
          throw error;
        }
        return { status: 201 };
      },
    },
    sleep: async () => {},
    random: () => 0,
  });
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    () => uploadBunnyObject({
      ...storage,
      objectKey: "petyard/users/user.webp",
      buffer: Buffer.from("x"),
      contentType: "image/webp",
      transport: {
        async request() {
          attempts += 1;
          const error = new Error("denied");
          error.response = { status: 403, headers: {} };
          throw error;
        },
      },
    }),
  );
  assert.equal(attempts, 1);
});

test("Bunny upload requires a 201 response and never leaks the access key", async () => {
  await assert.rejects(
    () => uploadBunnyObject({
      ...storage,
      objectKey: "petyard/users/user.webp",
      buffer: Buffer.from("x"),
      contentType: "image/webp",
      transport: { async request() { return { status: 200 }; } },
    }),
    (error) => {
      assert.doesNotMatch(error.message, /storage-secret-value/);
      return true;
    },
  );
});

test("Storage download preserves a sanitized not-found identity", async () => {
  await assert.rejects(
    () => downloadBunnyObject({
      ...storage,
      objectKey: "petyard/users/missing.webp",
      transport: {
        async request() {
          const error = new Error(`denied ${storage.accessKey}`);
          error.response = { status: 404, headers: {} };
          throw error;
        },
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.doesNotMatch(error.message, new RegExp(storage.accessKey));
      return true;
    },
  );
});

test("Bunny deletes accept 2xx and 404, while rejecting invalid paths and roots", async () => {
  for (const status of [200, 204, 404]) {
    await deleteBunnyObject({
      ...storage,
      objectKey: "petyard/users/user.webp",
      transport: { async request() { return { status }; } },
    });
  }
  await assert.rejects(() => deleteBunnyObject({
    ...storage,
    objectKey: "petyard/users/user.webp",
    transport: { async request() { return { status: 500 }; } },
  }));
  assert.throws(() => buildBunnyCdnUrl({ cdnBaseUrl: "https://media.petyardstores.com", objectKey: "petyard/../private/a.webp" }));
  assert.throws(() => getBunnyObjectKeyFromUrl({
    url: "https://media.petyardstores.com/petyard/users/u.webp",
    cdnBaseUrl: "https://media.petyardstores.com",
    allowedRoot: "instapay_screenshots",
  }));
});

test("Bunny CDN helpers use only the exact configured origin", () => {
  const cdnBaseUrl = "https://media.petyardstores.com";
  const url = buildBunnyCdnUrl({ cdnBaseUrl, objectKey: "petyard/users/user 1.webp" });
  assert.equal(url, "https://media.petyardstores.com/petyard/users/user%201.webp");
  assert.equal(getBunnyObjectKeyFromUrl({ url, cdnBaseUrl, allowedRoot: "petyard" }), "petyard/users/user 1.webp");
  assert.equal(getBunnyObjectKeyFromUrl({
    url: "https://lookalike.petyardstores.com/petyard/users/user.webp",
    cdnBaseUrl,
    allowedRoot: "petyard",
  }), null);
});
