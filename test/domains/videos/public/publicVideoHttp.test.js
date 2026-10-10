import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createPublicVideoRouter } from "../../../../src/domains/videos/public/publicVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

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
