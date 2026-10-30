import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createPublicVideoRouter } from "../../../../src/domains/videos/public/publicVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

test("feed scoping uses existing bearer/guest identities and never fingerprints anonymous requests", async () => {
  const calls = [];
  const app = express();
  app.use("/videos", createPublicVideoRouter({
    optionalAccess: (req, _res, next) => {
      if (req.get("authorization")) req.user = { _id: "507f1f77bcf86cd799439011" };
      next();
    },
    getService: () => ({ async listFeed(input) {
      calls.push(input);
      return { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] };
    } }),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/videos/feed?page=1&limit=20&kind=all`;
    for (const headers of [{ "user-agent": "one" }, { "user-agent": "two" },
      { "x-guest-id": "guest-1", "user-agent": "one" }, { "x-guest-id": "guest-1", "user-agent": "two" },
      { authorization: "Bearer device-a", "x-guest-id": "guest-1" }, { authorization: "Bearer device-b" }]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), { data: { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] } });
    }
    assert.deepEqual(calls.slice(0, 2).map(call => [call.identity, call.feedScope]), [[null, ""], [null, ""]]);
    assert.deepEqual(calls.slice(2, 4).map(call => [call.identity, call.feedScope]),
      [[{ type: "guest", id: "guest-1" }, ""], [{ type: "guest", id: "guest-1" }, ""]]);
    assert.deepEqual(calls[4].identity, { type: "user", id: "507f1f77bcf86cd799439011" });
    assert.notEqual(calls[4].feedScope, calls[5].feedScope);
    assert.match(calls[4].feedScope, /^[a-f\d]{64}$/);
    assert.ok(!calls[4].feedScope.includes("device-a"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("public route passes guest identity to list and save without requiring bearer auth", async () => {
  const app = express();
  app.use("/api/v1/videos", createPublicVideoRouter({
    optionalAccess: (_req, _res, next) => next(),
    saveAccess: (req, _res, next) => { req.guestId = req.headers["x-guest-id"]; next(); },
    getService: () => ({
      async listYouTube({ identity }) {
        assert.deepEqual(identity, { type: "guest", id: "guest-1" });
        return { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] };
      },
      async listFeed({ identity, kind }) {
        assert.deepEqual(identity, { type: "guest", id: "guest-1" });
        assert.equal(kind, "reel");
        return { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] };
      },
      async save({ identity, id }) {
        assert.deepEqual(identity, { type: "guest", id: "guest-1" });
        return { videoId: id, isSaved: true };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos`;
  try {
    const listed = await fetch(`${url}/youtube`, { headers: { "x-guest-id": "guest-1" } });
    assert.equal(listed.status, 200);
    const feed = await fetch(`${url}/feed?kind=reel`, { headers: { "x-guest-id": "guest-1" } });
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get("cache-control"), "private, no-store");
    const saved = await fetch(`${url}/saved/video-1`, { method: "PUT",
      headers: { "x-guest-id": "guest-1" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { data: { videoId: "video-1", isSaved: true } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
