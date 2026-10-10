import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createProductVideoRouter } from "../../../../src/domains/videos/productVideos/productVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

test("product upload-session route returns the established data envelope", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(req, _res, next) => {
      req.user = { _id: "507f1f77bcf86cd799439011" };
      next();
    }],
    isUploadEnabled: () => true,
    getService: () => ({
      async createUploadSessions({ productId, actorId, idempotencyKey }) {
        assert.equal(productId, "507f191e810c19729de860ea");
        assert.equal(String(actorId), "507f1f77bcf86cd799439011");
        assert.equal(idempotencyKey, "batch-key-123");
        return [{ clientId: "first", productVideoId: "placement-a", position: 0,
          status: "awaiting_upload", upload: { endpoint: "tus" } }];
      },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/products/507f191e810c19729de860ea/videos/upload-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "batch-key-123" },
      body: JSON.stringify({ files: [{ clientId: "first" }] }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.deepEqual(body, { data: [{ clientId: "first", productVideoId: "placement-a",
      position: 0, status: "awaiting_upload", upload: { endpoint: "tus" } }] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("disabled Product Video uploads never invoke the application", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    isUploadEnabled: () => false,
    getService: () => { throw new Error("must stay disabled"); },
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos/upload-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "batch-key-123" },
      body: JSON.stringify({ files: [] }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error[0].code, "VIDEO_UPLOAD_DISABLED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an issued upload may refresh on the same placement after new uploads are disabled", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    isUploadEnabled: () => false,
    getService: () => ({
      async refreshUploadAuthorization({ productId, videoId }) {
        assert.equal(productId, "507f191e810c19729de860ea");
        assert.equal(videoId, "507f1f77bcf86cd799439011");
        return { productVideoId: videoId, position: 1, status: "awaiting_upload",
          upload: { endpoint: "tus" } };
      },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos/507f1f77bcf86cd799439011/upload-authorization`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: {
      productVideoId: "507f1f77bcf86cd799439011", position: 1,
      status: "awaiting_upload", upload: { endpoint: "tus" },
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("product editors can read upload status without a public feature flag", async () => {
  const app = express();
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    isUploadEnabled: () => false,
    getService: () => ({
      async listAdminStatus() { return [{ productVideoId: "placement-a", status: "processing" }]; },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{
      productVideoId: "placement-a", status: "processing",
    }] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an editor may request deletion even while new Product Video uploads are disabled", async () => {
  const app = express();
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    isUploadEnabled: () => false,
    getService: () => ({
      async requestDeletion({ productId, videoId }) {
        assert.equal(productId, "507f191e810c19729de860ea");
        assert.equal(videoId, "507f1f77bcf86cd799439011");
        return { productVideoId: videoId, status: "deleting" };
      },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos/507f1f77bcf86cd799439011`, {
      method: "DELETE",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { data: {
      productVideoId: "507f1f77bcf86cd799439011", status: "deleting",
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an editor may cancel an unfinished upload while new uploads are disabled", async () => {
  const app = express();
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    isUploadEnabled: () => false,
    getService: () => ({
      async cancelPendingUpload({ productId, videoId }) {
        assert.equal(productId, "507f191e810c19729de860ea");
        assert.equal(videoId, "507f1f77bcf86cd799439011");
        return { productVideoId: videoId, status: "cancelled" };
      },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos/507f1f77bcf86cd799439011/upload-session`, {
      method: "DELETE",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { data: {
      productVideoId: "507f1f77bcf86cd799439011", status: "cancelled",
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an editor may hide a ready Product Video from reels without disabling product media", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()],
    getService: () => ({
      async setReelsVisibility({ productId, videoId, showInReelsFeed }) {
        assert.equal(productId, "507f191e810c19729de860ea");
        assert.equal(videoId, "507f1f77bcf86cd799439011");
        assert.equal(showInReelsFeed, false);
        return { productVideoId: videoId, showInReelsFeed };
      },
    }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/507f191e810c19729de860ea/videos/507f1f77bcf86cd799439011`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showInReelsFeed: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: {
      productVideoId: "507f1f77bcf86cd799439011", showInReelsFeed: false,
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("replacement session creation forwards the placement, actor and idempotency key", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "actor" }; next(); }],
    isUploadEnabled: () => true,
    getService: () => ({ async createReplacementUploadSession(input) {
      assert.deepEqual(input, { productId: "product", videoId: "video", actorId: "actor",
        idempotencyKey: "replacement-key", file: { clientId: "selected" } });
      return { productVideoId: "video", replacementId: "replacement", status: "awaiting_upload" };
    } }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/product/videos/video/replacement-upload-session`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "replacement-key" },
      body: JSON.stringify({ file: { clientId: "selected" } }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: {
      productVideoId: "video", replacementId: "replacement", status: "awaiting_upload",
    } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("replacement shutdown blocks new reservations but keeps generation-scoped refresh and cancellation available", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(_req, _res, next) => next()], isUploadEnabled: () => false,
    getService: () => ({
      async createReplacementUploadSession() { throw new Error("must remain disabled"); },
      async refreshReplacementAuthorization(input) {
        assert.deepEqual(input, { productId: "product", videoId: "video", replacementId: "replacement" });
        return { status: "awaiting_upload" };
      },
      async cancelReplacementUpload(input) {
        assert.deepEqual(input, { productId: "product", videoId: "video", replacementId: "replacement" });
        return { status: "cancelled" };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/products/product/videos/video`;
    assert.equal((await fetch(`${base}/replacement-upload-session`, { method: "POST" })).status, 503);
    const refreshed = await fetch(`${base}/replacements/replacement/upload-authorization`, { method: "POST" });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), { data: { status: "awaiting_upload" } });
    const cancelled = await fetch(`${base}/replacements/replacement/upload-session`, { method: "DELETE" });
    assert.equal(cancelled.status, 202);
    assert.deepEqual(await cancelled.json(), { data: { status: "cancelled" } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
