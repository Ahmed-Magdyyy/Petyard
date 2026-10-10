import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { createProductVideoService } from "../../../src/domains/videos/productVideos/productVideo.service.js";
import { createEditorialVideoRouter } from "../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { createProductVideoRouter } from "../../../src/domains/videos/productVideos/productVideo.routes.js";
import { createPublicVideoRouter } from "../../../src/domains/videos/public/publicVideo.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";

const root = fileURLToPath(new URL("../../../src/domains/videos/", import.meta.url));
const sources = readdirSync(root, { recursive: true }).filter((file) => file.endsWith(".js"));

test("default Videos middleware protects staff routes, allows public reads and isolates guest saves", async () => {
  let publicCalls = 0;
  const app = express();
  const staffService = () => assert.fail("anonymous requests must not reach staff services");
  app.use("/admin", createEditorialVideoRouter({ getService: staffService, getUploadService: staffService }));
  app.use("/products/:id/videos", createProductVideoRouter({ getService: staffService }));
  app.use("/videos", createPublicVideoRouter({ getService: () => ({
    async listYouTube({ identity }) { publicCalls += 1; assert.equal(identity, null); return []; },
    async save({ identity, id }) {
      publicCalls += 1;
      assert.deepEqual(identity, { type: "guest", id: "guest-middleware-test" });
      return { videoId: id, isSaved: true };
    },
  }) }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, method] of [["/admin", "GET"], ["/admin/id/cover", "POST"],
      ["/admin/id/approve", "POST"], ["/products/id/videos", "GET"],
      ["/products/id/videos/upload-sessions", "POST"], ["/videos/saved/id", "PUT"]]) {
      assert.equal((await fetch(base + path, { method })).status, 401, path);
    }
    assert.equal((await fetch(base + "/videos/youtube")).status, 200);
    assert.equal((await fetch(base + "/videos/youtube", {
      headers: { authorization: "Bearer invalid-token" },
    })).status, 401);
    assert.equal((await fetch(base + "/videos/saved/id", { method: "PUT",
      headers: { "x-guest-id": "guest-middleware-test" },
    })).status, 200);
    assert.equal(publicCalls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Videos routes only compose middleware and controller handlers, not inline business or HTTP handlers", () => {
  assert.equal(sources.some((file) => file.endsWith(".application.js")), false);
  const routes = sources.filter((file) => file.endsWith(".routes.js"));
  assert.equal(routes.length, 7);
  for (const file of routes) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.match(source, /\.controller\.js/);
    assert.doesNotMatch(source, /asyncHandler|async \(req|req\.body|res\.status|process\.env|createBunnyStreamAdapter|\.repository\.js/);
    assert.ok(existsSync(resolve(root, file.replace(".routes.js", ".controller.js"))));
  }
});

test("Videos relative imports resolve after service moves, including the product and worker consumers", () => {
  const files = sources.map((file) => resolve(root, file)).concat([
    resolve(root, "../product/product.service.js"),
    resolve(root, "../../workers/videoProvider.worker.js"),
  ]);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+\.js)\1/g)) {
      assert.ok(existsSync(resolve(dirname(file), match[2])), `${file}: ${match[2]}`);
    }
  }
});

test("Videos services and controllers do not query models, and repositories do not contact queues or caches", () => {
  for (const file of sources) {
    const source = readFileSync(resolve(root, file), "utf8");
    if (/\.(service|controller)\.js$/.test(file)) {
      assert.doesNotMatch(source, /from\s+["'][^"']*\.model\.js["']|\bmodel\.(find|update|create|delete)/, file);
    }
    if (file.endsWith(".repository.js")) {
      assert.doesNotMatch(source, /\.queue\.js|productCache\.service|\bawait enqueue\(|\binvalidateProductCaches\(/, file);
    }
  }
});

test("extracted Product Video validation preserves safe errors on invalid replacement identities", async () => {
  const service = createProductVideoService({ repository: {}, provider: {} });
  for (const method of ["refreshReplacementAuthorization", "cancelReplacementUpload"]) {
    await assert.rejects(service[method]({ productId: "invalid", videoId: "invalid", replacementId: "invalid" }),
      (error) => error.statusCode === 400 && error.errors[0].code === "VIDEO_INVALID_MEDIA");
  }
});

test("production service getters construct with synthetic settings without provider requests", async () => {
  const settings = {
    VIDEOS_PUBLIC_ENABLED: "false", REEL_UPLOADS_ENABLED: "false",
    PRODUCT_VIDEO_UPLOADS_ENABLED: "false", PRODUCT_VIDEOS_PUBLIC_ENABLED: "false",
    BUNNY_STREAM_LIBRARY_ID: "1", BUNNY_STREAM_API_KEY: "test-only-api-key",
    BUNNY_STREAM_READ_ONLY_API_KEY: "test-only-read-key", BUNNY_STREAM_TOKEN_KEY: "test-only-token-key",
    BUNNY_STREAM_CDN_HOSTNAME: "video.example.invalid", YOUTUBE_DATA_API_KEY: "test-only-youtube-key",
    BUNNY_STREAM_UPLOAD_AUTH_TTL_SECONDS: "21600", BUNNY_STREAM_PLAYBACK_TTL_SECONDS: "900",
    BUNNY_STREAM_REQUEST_TIMEOUT_MS: "15000",
  };
  const previous = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, settings);
  globalThis.fetch = async () => assert.fail("service construction must not call a provider");
  try {
    for (const [file, getter, method] of [
      ["editorial/editorialVideo.service.js", "getEditorialVideoService", "approve"],
      ["reels/reelUpload.service.js", "getReelUploadService", "createSession"],
      ["reels/reelPreview.service.js", "getReelPreviewService", "grant"],
      ["productVideos/productVideo.service.js", "getProductVideoService", "createUploadSessions"],
      ["productVideos/productVideoPreview.service.js", "getProductVideoPreviewService", "grant"],
      ["public/publicVideo.service.js", "getPublicVideoService", "listFeed"],
      ["public/publicReelPlayback.service.js", "getPublicReelPlaybackService", "grant"],
      ["public/publicProductPlayback.service.js", "getPublicProductPlaybackService", "grant"],
      ["provider/bunnyStreamWebhook.service.js", "getBunnyStreamWebhookService", "receive"],
      ["provider/videoProviderAdmin.service.js", "getVideoProviderAdminService", "retry"],
    ]) {
      const module = await import(`${pathToFileURL(resolve(root, file)).href}?architecture-check`);
      const service = await module[getter]();
      assert.equal(typeof service[method], "function", getter);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
