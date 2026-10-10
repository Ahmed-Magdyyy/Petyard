import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createBunnyStreamAdapter } from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const batchId = "507f1f77bcf86cd799439012";
const replacementId = "507f1f77bcf86cd799439013";
const guid = "507f1f77-aaaa-bbbb-cccc-799439012000";
const createdAt = new Date("2026-10-02T00:00:00Z");
const failedAt = new Date("2026-10-02T00:01:00Z");
const initialMarker = "petyard-product-video:507f1f77bcf86cd799439011";
const replacementMarker = "petyard-product-replacement:507f1f77bcf86cd799439013";

function setup({ replacement = false, placement = {}, batch = {}, reservation = {}, assets = [],
  page, video = {}, providerError } = {}) {
  const marker = replacement ? replacementMarker : initialMarker;
  const db = replacementDatabase({
    // Deliberately no product: failed reservations must survive whole-product deletion.
    placements: [{ _id: videoId, productId, uploadBatchId: batchId, position: 0,
      activeSlot: false, lifecycleState: "failed", createdAt, removedAt: failedAt, ...placement }],
    batches: [{ _id: batchId, productId, status: "failed", createdAt, failedAt,
      failureCode: "VIDEO_PROVIDER_UNAVAILABLE", ...batch }],
    replacements: replacement ? [{ _id: replacementId, productId, videoId,
      status: "failed", createdAt, finishedAt: failedAt,
      failureCode: "VIDEO_PROVIDER_UNAVAILABLE", ...reservation }] : [],
    assets,
  });
  const forbidden = async () => { throw new Error("Inspection must not mutate database, queue or cache"); };
  for (const table of Object.values(db)) {
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate",
      "findOneAndDelete", "deleteOne", "deleteMany", "startSession"]) {
      if (table[method]) table[method] = forbidden;
    }
  }
  const reads = [];
  const provider = createBunnyStreamAdapter({ libraryId: "754739", apiKey: "synthetic-api-key",
    requestTimeoutMs: 1000, async http(url, options) {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      reads.push(url);
      if (providerError) throw providerError;
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(`/videos/${guid}`)) return {
        ok: true, async json() { return { guid, title: marker, videoLibraryId: 754739,
          dateUploaded: "2026-10-02T00:00:30", status: 0, length: 0, storageSize: 0,
          encodeProgress: 0, availableResolutions: null, ...video }; },
      };
      assert.equal(parsed.pathname, "/library/754739/videos");
      assert.equal(parsed.searchParams.get("search"), marker);
      assert.equal(parsed.searchParams.get("page"), "1");
      assert.equal(parsed.searchParams.get("itemsPerPage"), "10");
      return { ok: true, async json() { return page ?? {
        items: [{ title: marker, guid }], totalItems: 1, currentPage: 1,
      }; } };
    } });
  const repository = createProductVideoRepository({ ...db, libraryId: "754739", recordOperation: forbidden });
  const application = createProductVideoService({ repository, provider, enqueue: forbidden, invalidateCaches: forbidden });
  return { application, reads, target: { videoId, ...(replacement ? { replacementId } : {}) } };
}

test("an exact empty initial Product Video orphan is only reported, even after its product is deleted", async () => {
  const { application, target, reads } = setup();
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "candidate", providerGuid: guid });
  assert.equal(reads.length, 2);
});

test("a failed replacement is inspected by its own generation while the ready video and successor stay unchanged", async () => {
  const { application, target } = setup({ replacement: true,
    placement: { activeSlot: true, lifecycleState: "ready", activeAssetId: batchId, replacementId: productId },
    assets: [{ _id: batchId, ownerType: "product_video", ownerId: videoId,
      libraryId: "754739", providerGuid: "current-guid", technicalState: "ready" }],
  });
  const before = await application.listAdminStatus({ productId });
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "candidate", providerGuid: guid });
  assert.deepEqual(await application.listAdminStatus({ productId }), before);
});

test("live, issued, already-bound or unrelated reservations never trigger provider discovery", async () => {
  for (const changes of [
    { placement: { activeSlot: true } }, { placement: { lifecycleState: "reserving" } },
    { placement: { activeAssetId: batchId } }, { placement: { pendingAssetId: batchId } },
    { placement: { replacementId } }, { placement: { uploadSessionIssuedAt: createdAt } },
    { batch: { status: "issued" } }, { batch: { issuedAt: createdAt } },
    { batch: { productId: videoId } }, { batch: { failureCode: "VIDEO_UPLOAD_ABANDONED" } },
    { replacement: true, reservation: { status: "reserving" } },
    { replacement: true, reservation: { issuedAt: createdAt } },
    { replacement: true, reservation: { assetId: batchId } },
    { replacement: true, reservation: { videoId: productId } },
    { replacement: true, reservation: { productId: videoId } },
    { replacement: true, reservation: { failureCode: "VIDEO_PROVIDER_FAILED" } },
  ]) {
    const { application, target, reads } = setup(changes);
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "not_applicable" });
    assert.deepEqual(reads, []);
  }
});

test("partial, duplicate and malformed provider search results are ambiguous", async () => {
  for (const page of [
    { items: [{ title: initialMarker, guid }], totalItems: 2, currentPage: 1 },
    { items: [{ title: initialMarker, guid }, { title: initialMarker, guid: "second-guid" }], totalItems: 2, currentPage: 1 },
    { items: [{ title: initialMarker, guid }], totalItems: 1, currentPage: 2 },
    { items: [{ title: initialMarker, guid: "../unsafe" }], totalItems: 1, currentPage: 1 },
    { items: [{ title: initialMarker, guid: 123 }], totalItems: 1, currentPage: 1 },
    { items: [{ title: initialMarker }], totalItems: 1, currentPage: 1 },
    { items: null, totalItems: 0, currentPage: 1 },
    { items: [], totalItems: "0", currentPage: 1 },
    { items: Array(11).fill({ title: "other", guid }), totalItems: 11, currentPage: 1 },
  ]) {
    const { application, target, reads } = setup({ page });
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "ambiguous" });
    assert.equal(reads.length, 1);
  }
});

test("missing exact markers and legacy human-readable titles do not prove provider absence", async () => {
  for (const items of [[], [{ title: `Product video ${videoId}`, guid }], [{ title: replacementMarker, guid }]]) {
    const { application, target, reads } = setup({ page: { items, totalItems: items.length, currentPage: 1 } });
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "no_match_observed" });
    assert.equal(reads.length, 1);
  }
});

test("provider identity, creation window and empty-media evidence must all match", async () => {
  for (const video of [
    { guid: "another-guid" }, { title: replacementMarker }, { videoLibraryId: 999 },
    { status: 2 }, { status: 4 }, { length: 1 }, { storageSize: 1 }, { encodeProgress: 1 },
    { availableResolutions: "720p" }, { availableResolutions: ["720p"] },
    { dateUploaded: "2026-10-01T23:54:59Z" }, { dateUploaded: "2026-10-02T00:16:01Z" },
    { dateUploaded: "2026-10-02T03:00:30" }, { dateUploaded: "2026-09-32T00:00:30Z" },
    { dateUploaded: undefined }, { length: undefined }, { storageSize: "0" },
  ]) {
    const { application, target } = setup({ video });
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "requires_review" });
  }
});

test("UTC and explicit Egyptian offsets identify the same provider creation instant", async () => {
  for (const dateUploaded of ["2026-10-02T00:00:30", "2026-10-02T00:00:30Z", "2026-10-02T03:00:30+03:00"]) {
    const { application, target } = setup({ video: { dateUploaded } });
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "candidate", providerGuid: guid });
  }
});

test("a provider GUID tracked by any local owner is not an orphan candidate", async () => {
  const { application, target } = setup({ assets: [{ _id: batchId, ownerType: "reel", ownerId: productId,
    libraryId: "754739", providerGuid: guid, technicalState: "ready" }] });
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "already_tracked" });
});

test("invalid reservation timestamps fail closed before provider requests", async () => {
  for (const changes of [
    { placement: { createdAt: undefined } }, { batch: { failedAt: undefined } },
    { batch: { failedAt: new Date("2026-10-01T23:59:59Z") } },
    { replacement: true, reservation: { finishedAt: new Date(NaN) } },
  ]) {
    const { application, target, reads } = setup(changes);
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "ambiguous" });
    assert.deepEqual(reads, []);
  }
});

test("invalid discovery identities are rejected without provider requests", async () => {
  const { application, reads } = setup();
  for (const target of [undefined, null, {}, { videoId: "invalid" }, { videoId, replacementId: null },
    { videoId, replacementId: "invalid" }, { videoId: { toString: () => videoId } }]) {
    await assert.rejects(application.inspectUncertainCreation(target), (error) =>
      error.statusCode === 400 && error.errors[0].code === "VIDEO_INVALID_MEDIA");
  }
  assert.deepEqual(reads, []);
});

test("provider failures remain safe errors rather than absence or cleanup authorization", async () => {
  const { application, target } = setup({ providerError: new Error("private URL and secret") });
  await assert.rejects(application.inspectUncertainCreation(target), (error) =>
    error.code === "BUNNY_STREAM_PROVIDER_ERROR" && !error.message.includes("secret"));
});

test("a lost initial create response leaves an inspectable reservation without retrying creation", async () => {
  const db = replacementDatabase({ products: [{ _id: productId }] }, { now: () => createdAt.getTime() });
  let marker;
  const methods = [];
  const forbidden = async () => { throw new Error("No cleanup, queue or cache work is expected"); };
  const provider = createBunnyStreamAdapter({ libraryId: "754739", apiKey: "synthetic-api-key", requestTimeoutMs: 1000,
    async http(url, options) {
      methods.push(options.method);
      if (options.method === "POST") {
        marker = JSON.parse(options.body).title;
        throw new Error("Provider created a video but its response was lost");
      }
      assert.equal(options.method, "GET");
      return { ok: true, async json() { return new URL(url).search ? {
        items: [{ title: marker, guid }], totalItems: 1, currentPage: 1,
      } : { guid, title: marker, videoLibraryId: 754739, dateUploaded: "2026-10-02T00:00:00Z",
        status: 0, length: 0, storageSize: 0, encodeProgress: 0, availableResolutions: null }; } };
    } });
  const repository = createProductVideoRepository({ ...db, libraryId: "754739", now: () => createdAt.getTime(),
    recordOperation: forbidden });
  const application = createProductVideoService({ repository, provider, now: () => createdAt.getTime(),
    enqueue: forbidden, invalidateCaches: forbidden });
  const request = { productId, actorId: batchId, idempotencyKey: "lost-create-001",
    files: [{ clientId: "selected", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 }] };
  await assert.rejects(application.createUploadSessions(request), (error) => error.statusCode === 503);
  await assert.rejects(application.createUploadSessions(request), (error) => error.statusCode === 409);
  assert.deepEqual(await application.inspectUncertainCreation({ videoId: marker.split(":")[1] }),
    { status: "candidate", providerGuid: guid });
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(methods, ["POST", "GET", "GET"]);
});
