import assert from "node:assert/strict";
import test from "node:test";

import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { VideoSaveModel } from "../../../../src/domains/videos/public/videoSave.model.js";

const published = {
  id: "507f1f77bcf86cd799439011", kind: "youtube", status: "published",
  youtubeId: "dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية",
  description_en: "A guide", description_ar: "", publishedAt: new Date("2026-09-28T12:00:00Z"),
  authorId: "internal-user", pendingChange: { content: { title_en: "Unapproved" } },
};
const reel = { id: "507f1f77bcf86cd799439013", kind: "reel", status: "published",
  title_en: "Play", title_ar: "العب", description_en: "Watch", description_ar: "",
  publishedAt: new Date("2026-09-28T13:00:00Z"),
  asset: { providerGuid: "private-bunny-guid", libraryId: "754739",
    durationSeconds: 20, width: 720, height: 1280 } };
const productVideo = { id: "507f1f77bcf86cd799439014", kind: "product",
  productId: "507f1f77bcf86cd799439015", feedAt: new Date("2026-09-28T14:00:00Z"),
  product: { name_en: "Ball", name_ar: "كرة" },
  asset: { providerGuid: "private-product-guid", libraryId: "754739",
    durationSeconds: 24, width: 1080, height: 1920 } };

function fakeRepository() {
  const saves = new Set();
  const key = (identity, id) => `${identity.type}:${identity.id}:${id}`;
  return {
    saves,
    async listYouTube() { return { totalResults: 1, data: [published] }; },
    async listReels() { return { totalResults: 1, data: [reel] }; },
    async listProducts() { return { totalResults: 1, data: [productVideo] }; },
    async listMixed({ includeReels, includeProducts }) {
      const data = [includeProducts && productVideo, includeReels && reel].filter(Boolean);
      return { totalResults: data.length, data };
    },
    async getPublished(id) {
      return id === published.id ? published : id === reel.id ? reel : null;
    },
    async savedIds({ identity, videoIds }) {
      return new Set(identity ? videoIds.filter((id) => saves.has(key(identity, id))) : []);
    },
    async listSaved({ identity, kind }) {
      const data = [published, reel].filter((video) =>
        (kind === "all" || kind === video.kind) && saves.has(key(identity, video.id)));
      return { totalResults: data.length, data };
    },
    async save({ identity, videoId }) { saves.add(key(identity, videoId)); },
    async unsave({ identity, videoId }) { saves.delete(key(identity, videoId)); },
  };
}

test("custom editorial covers win over provider covers without changing product posters or leaking pending fields", async () => {
  const repository = fakeRepository();
  const custom = (row) => ({ ...row, activeCoverId: "private-cover-generation", cover: {
    public_id: "private-cover-key", url: "https://images.example/custom.webp" },
    pendingChange: { content: { coverId: "pending-private-id" }, coverUrl: "https://images.example/pending.webp" },
    asset: { ...row.asset, poster: { url: "https://images.example/provider.webp" } } });
  repository.listYouTube = async () => ({ totalResults: 1, data: [custom(published)] });
  repository.listMixed = async () => ({ totalResults: 2, data: [custom(reel), custom(productVideo)] });
  repository.getPublished = async () => custom(reel);
  repository.listSaved = async () => ({ totalResults: 1, data: [custom(reel)] });
  const app = createPublicVideoService({ repository, isEnabled: () => true, isProductEnabled: () => true });
  const youtube = await app.listYouTube({}); const feed = await app.listFeed({ kind: "all" });
  assert.equal(youtube.data[0].coverUrl, "https://images.example/custom.webp");
  assert.deepEqual(feed.data.map((row) => row.coverUrl), ["https://images.example/custom.webp", "https://images.example/provider.webp"]);
  assert.equal((await app.getVideo({ id: reel.id })).coverUrl, "https://images.example/custom.webp");
  assert.equal((await app.listSaved({ identity: { type: "guest", id: "guest" } })).data[0].coverUrl,
    "https://images.example/custom.webp");
  assert.equal(/private|pending/.test(JSON.stringify({ youtube, feed })), false);
  repository.listYouTube = async () => ({ totalResults: 1, data: [{ ...published, cover: null }] });
  repository.listReels = async () => ({ totalResults: 1, data: [{ ...reel,
    cover: null, asset: { ...reel.asset, poster: { url: "https://images.example/provider.webp" } } }] });
  assert.equal((await app.listYouTube({})).data[0].coverUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal((await app.listFeed({})).data[0].coverUrl, "https://images.example/provider.webp");
});

test("public YouTube DTO uses approved fields and never exposes pending or provider state", async () => {
  const app = createPublicVideoService({ repository: fakeRepository(), isEnabled: () => true });
  const result = await app.listYouTube({ lang: "ar" });
  assert.equal(result.totalResults, 1);
  assert.equal(result.totalPages, 1);
  assert.equal(result.data[0].title, "رعاية");
  assert.equal(result.data[0].description, "A guide");
  assert.equal(result.data[0].embedUrl, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(result.data[0].canSave, true);
  assert.equal(result.data[0].isSaved, false);
  assert.deepEqual(Object.keys(result.data[0]).sort(), [
    "canSave", "coverUrl", "description", "embedUrl", "id", "isSaved", "kind",
    "publishedAt", "title", "youtubeId",
  ].sort());
});

test("Reel feed, detail, and saves use only public media metadata", async () => {
  const repository = fakeRepository();
  const app = createPublicVideoService({ repository, isEnabled: () => true });
  const guest = { type: "guest", id: "guest-reel" };
  const feed = await app.listFeed({ identity: guest, lang: "ar" });
  assert.equal(feed.totalResults, 1);
  assert.equal(feed.data[0].title, "العب");
  assert.equal(feed.data[0].aspectRatio, 720 / 1280);
  assert.equal(feed.data[0].coverUrl, null);
  assert.equal(feed.data[0].playbackHref, `/api/v1/videos/${reel.id}/playback`);
  assert.equal(JSON.stringify(feed).includes("private-bunny-guid"), false);
  assert.equal(JSON.stringify(feed).includes("754739"), false);
  await app.save({ id: reel.id, identity: guest });
  assert.equal((await app.getVideo({ id: reel.id, identity: guest })).isSaved, true);
  assert.equal((await app.listFeed({ identity: guest })).data[0].isSaved, true);
  assert.deepEqual((await app.listSaved({ identity: guest, kind: "reel" })).data[0].kind, "reel");
  assert.equal((await app.listSaved({ identity: guest, kind: "youtube" })).totalResults, 0);
});

test("mixed feed, Reel detail and saved Reels project copied covers without provider descriptors", async () => {
  const repository = fakeRepository();
  const withCover = (row) => ({ ...row, asset: { ...row.asset, poster: {
    public_id: "private-object-key", url: `https://images.example/${row.id}.webp` } } });
  repository.listMixed = async () => ({ totalResults: 2, data: [withCover(productVideo), withCover(reel)] });
  repository.getPublished = async () => withCover(reel);
  repository.listSaved = async () => ({ totalResults: 1, data: [withCover(reel)] });
  const app = createPublicVideoService({ repository, isEnabled: () => true, isProductEnabled: () => true });
  const feed = await app.listFeed({ kind: "all" });
  assert.deepEqual(feed.data.map((row) => row.coverUrl), [
    `https://images.example/${productVideo.id}.webp`, `https://images.example/${reel.id}.webp`,
  ]);
  assert.equal((await app.getVideo({ id: reel.id })).coverUrl, feed.data[1].coverUrl);
  assert.equal((await app.listSaved({ identity: { type: "guest", id: "guest" } })).data[0].coverUrl,
    feed.data[1].coverUrl);
  assert.equal(JSON.stringify(feed).includes("private-object-key"), false);
  assert.equal(JSON.stringify(feed).includes("private-bunny-guid"), false);
});

test("product and mixed feeds honor independent public switches and do not save product entries", async () => {
  const app = createPublicVideoService({ repository: fakeRepository(),
    isEnabled: () => true, isProductEnabled: () => true });
  assert.equal((await app.listFeed({ kind: "reel" })).totalResults, 1);
  const product = (await app.listFeed({ kind: "product", lang: "ar" })).data[0];
  assert.equal(product.title, "كرة");
  assert.equal(product.productId, productVideo.productId);
  assert.equal(product.productHref, `/api/v1/products/${productVideo.productId}`);
  assert.equal(product.playbackHref, `/api/v1/product-videos/${productVideo.id}/playback`);
  assert.equal(product.canSave, false);
  assert.equal(product.isSaved, false);
  assert.equal(JSON.stringify(product).includes("private-product-guid"), false);
  assert.deepEqual((await app.listFeed({ kind: "all" })).data.map((v) => v.kind),
    ["product", "reel"]);
  await assert.rejects(app.listFeed({ kind: "youtube" }),
    (error) => error.statusCode === 422);
  const noProduct = createPublicVideoService({ repository: fakeRepository(),
    isEnabled: () => true });
  assert.equal((await noProduct.listFeed({ kind: "product" })).totalResults, 0);
  assert.equal((await noProduct.listFeed({ kind: "all" })).totalResults, 1);
  const onlyProduct = createPublicVideoService({ repository: fakeRepository(),
    isProductEnabled: () => true });
  assert.equal((await onlyProduct.listFeed({ kind: "reel" })).totalResults, 0);
  assert.deepEqual((await onlyProduct.listFeed({ kind: "all" })).data.map((v) => v.kind),
    ["product"]);
  await assert.rejects(onlyProduct.save({ id: productVideo.id,
    identity: { type: "guest", id: "g" } }), (error) => error.statusCode === 404);
});

test("guest and user saves are separate, idempotent, and reflected in public reads", async () => {
  const repository = fakeRepository();
  const app = createPublicVideoService({ repository, isEnabled: () => true });
  const guest = { type: "guest", id: "guest-a" };
  const user = { type: "user", id: "guest-a" };

  assert.deepEqual(await app.save({ id: published.id, identity: guest }),
    { videoId: published.id, isSaved: true });
  await app.save({ id: published.id, identity: guest });
  assert.equal(repository.saves.size, 1);
  assert.equal((await app.getVideo({ id: published.id, identity: guest })).isSaved, true);
  assert.equal((await app.getVideo({ id: published.id, identity: user })).isSaved, false);
  assert.equal((await app.getVideo({ id: published.id })).isSaved, false);
  assert.equal((await app.listSaved({ identity: guest })).data[0].isSaved, true);
  assert.equal((await app.listSaved({ identity: user })).totalResults, 0);

  await app.unsave({ id: published.id, identity: guest });
  assert.deepEqual(await app.unsave({ id: published.id, identity: guest }),
    { videoId: published.id, isSaved: false });
  assert.equal(repository.saves.size, 0);
});

test("disabled public flag hides lists and detail and prevents new saves", async () => {
  let called = false;
  const repository = fakeRepository();
  repository.listYouTube = async () => { called = true; throw new Error("unexpected query"); };
  const app = createPublicVideoService({ repository });
  assert.deepEqual(await app.listYouTube({}),
    { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] });
  assert.equal(called, false);
  assert.equal((await app.listSaved({ identity: { type: "guest", id: "g" } })).totalResults, 0);
  await assert.rejects(app.getVideo({ id: published.id }), (error) => error.statusCode === 404);
  await assert.rejects(app.save({ id: published.id, identity: { type: "guest", id: "g" } }),
    (error) => error.statusCode === 404);
});

test("unpublished or product Video IDs cannot be newly saved", async () => {
  const app = createPublicVideoService({ repository: fakeRepository(), isEnabled: () => true });
  await assert.rejects(app.save({ id: "507f1f77bcf86cd799439012",
    identity: { type: "guest", id: "g" } }), (error) => error.statusCode === 404);
  await assert.rejects(app.listSaved({}), (error) => error.statusCode === 401);
  await assert.rejects(app.listYouTube({ page: "1.5" }), (error) => error.statusCode === 422);
  await assert.rejects(app.listSaved({ identity: { type: "guest", id: "g" }, kind: "product" }),
    (error) => error.statusCode === 422);
});

test("Video Save indexes isolate identity and deduplicate a save", () => {
  const unique = VideoSaveModel.schema.indexes().find(([, options]) => options.unique);
  assert.deepEqual(unique[0], { identityType: 1, identityId: 1, videoId: 1 });
});
