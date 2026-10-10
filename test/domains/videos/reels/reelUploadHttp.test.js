import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", router);
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/api/v1/videos/admin` };
}

test("Reel upload route remains closed even if its env flag is enabled before worker wiring", async () => {
  const { server, url } = await serve(createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    isReelUploadEnabled: () => true,
    getUploadService: () => { throw new Error("must not reach provider"); },
  }));
  try {
    const response = await fetch(`${url}/reel-1/upload-session`, { method: "POST" });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an explicitly enabled test seam passes actor, idempotency key, and one file", async () => {
  const file = { filename: "puppy.mp4", mimeType: "video/mp4", sizeBytes: 1024 };
  const { server, url } = await serve(createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    isReelUploadEnabled: () => true,
    isReelPipelineReady: () => true,
    getUploadService: () => ({
      async createSession({ videoId, actor, idempotencyKey, file: received }) {
        assert.equal(videoId, "reel-1");
        assert.deepEqual(actor, { id: "admin-1", role: "admin" });
        assert.equal(idempotencyKey, "reel-key-123");
        assert.deepEqual(received, file);
        return { videoId, status: "reserving" };
      },
    }),
  }));
  try {
    const response = await fetch(`${url}/reel-1/upload-session`, {
      method: "POST", headers: { "content-type": "application/json",
        "Idempotency-Key": "reel-key-123" }, body: JSON.stringify({ file }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { data: { videoId: "reel-1", status: "reserving" } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("existing Reel sessions support protected status/refresh/cancel with both upload gates closed", async () => {
  const calls = [];
  const { server, url } = await serve(createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "staff-id", role: req.get("role") || roles.ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
      allowedTo(roles.ADMIN, roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS)],
    isReelUploadEnabled: () => false, isReelPipelineReady: () => false,
    getUploadService: () => ({
      async getUploadStatus(input) { calls.push(input); return { status: "processing" }; },
      async refreshUploadAuthorization(input) { calls.push(input); return { status: "awaiting_upload" }; },
      async cancelUpload(input) { calls.push(input); return { status: "cancelled" }; },
    }),
  }));
  try {
    for (const [path, method, expected] of [["/reel-1/upload-session", "GET", 200],
      ["/reel-1/upload-sessions/session-1/authorization", "POST", 200],
      ["/reel-1/upload-sessions/session-1", "DELETE", 202]]) {
      const response = await fetch(`${url}${path}`, { method });
      assert.equal(response.status, expected);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const input = calls.at(-1);
      assert.equal(input.videoId, "reel-1");
      assert.deepEqual(input.actor, { id: "staff-id", role: roles.ADMIN });
      if (method !== "GET") assert.equal(input.sessionId, "session-1");
      for (const headers of [{ role: roles.USER }, { control: "no" }]) {
        assert.equal((await fetch(`${url}${path}`, { method, headers })).status, 403);
      }
    }
    assert.equal(calls.length, 3);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("replacement HTTP routes fix the server-side purpose and preserve the hard-off gate", async () => {
  const seen = [];
  let ready = false;
  const { server, url } = await serve(createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "staff", role: roles.SUPER_ADMIN }; next(); }],
    isReelUploadEnabled: () => true, isReelPipelineReady: () => ready,
    getUploadService: () => ({
      async createSession(input) { seen.push(input); return { status: "reserving" }; },
      async getUploadStatus(input) { seen.push(input); return { status: "processing" }; },
      async refreshUploadAuthorization(input) { seen.push(input); return { status: "awaiting_upload" }; },
      async cancelUpload(input) { seen.push(input); return { status: "cancelled" }; },
    }),
  }));
  try {
    assert.equal((await fetch(`${url}/reel/replacement-upload-session`, { method: "POST" })).status, 503);
    assert.equal(seen.length, 0);
    ready = true;
    assert.equal((await fetch(`${url}/reel/replacement-upload-session`, { method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "replacement-key" },
      body: JSON.stringify({ purpose: "initial", file: { filename: "new.mp4" } }) })).status, 202);
    assert.equal(seen[0].idempotencyKey, "replacement-key");
    ready = false;
    for (const [suffix, method, status] of [["replacement-upload-session", "GET", 200],
      ["replacement-upload-sessions/session/authorization", "POST", 200],
      ["replacement-upload-sessions/session", "DELETE", 202]]) {
      const response = await fetch(`${url}/reel/${suffix}`, { method });
      assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(seen.length, 4);
    for (const input of seen) assert.equal(input.purpose, "replacement");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
