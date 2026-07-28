import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  assertSafePublicId,
  captureUnresolvedGroup,
  classifyCloudinaryAsset,
  copyOneAsset,
  createRecoveryByteBudget,
  createRecoveryProvenance,
  findPreflightBlockers,
  groupUnresolvedSources,
  materializeCapturedRecovery,
  parseCopyArguments,
  profileForAsset,
  readResponseBufferLimited,
  recoverUnresolvedGroup,
  releaseRecoveryCaptures,
  runBounded,
  resumeCopyEntry,
  sourceSort,
  summarizeEntries,
  transformAsset,
  validatePreviousManifest,
  verifyManifestEntry,
  verifyRecoveryBaseEntries,
  withRecoveryCaptureCleanup,
} from "../../scripts/cloudinaryToBunnyCopy.js";

const env = {
  CLOUDINARY_CLOUD_NAME: "dxemmiorv",
  BUNNY_PUBLIC_STORAGE_ZONE: "petyardpublicmedia",
  BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "public-secret-value",
  BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PUBLIC_CDN_BASE_URL: "https://media.petyardstores.com",
  BUNNY_PRIVATE_STORAGE_ZONE: "petyardprivatepayments",
  BUNNY_PRIVATE_STORAGE_ACCESS_KEY: "private-secret-value",
  BUNNY_PRIVATE_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PRIVATE_CDN_BASE_URL: "https://proofs.petyardstores.com",
};

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
const publicAsset = {
  public_id: "petyard/users/avatar",
  format: "svg",
  resource_type: "image",
  secure_url: "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/users/avatar.svg",
};

test("copy argument parsing is read-only by default and write confirmation is exact", () => {
  assert.deepEqual(parseCopyArguments([]), {
    onlyPublic: false,
    onlyInstapay: false,
    limit: null,
    concurrency: 4,
    copy: false,
    verifyOnly: false,
    manifest: null,
    recoveryReport: null,
  });
  assert.throws(() => parseCopyArguments(["--copy"]), /--confirm-bunny-write/);
  assert.throws(() => parseCopyArguments(["--only-public", "--only-instapay"]));
  assert.throws(() => parseCopyArguments(["--limit=0"]));
  assert.deepEqual(parseCopyArguments(["--copy", "--confirm-bunny-write", "--only-public", "--limit=10"]), {
    onlyPublic: true,
    onlyInstapay: false,
    limit: 10,
    concurrency: 4,
    copy: true,
    verifyOnly: false,
    manifest: null,
    recoveryReport: null,
  });
  assert.throws(() => parseCopyArguments(["--recover-unresolved=report.json"]), /requires --manifest/);
  assert.throws(() => parseCopyArguments(["--recover-unresolved=report.json", "--manifest=copy.json", "--limit=1"]), /cannot be combined/);
});

test("unresolved recovery grouping is restricted to exact public image fields", () => {
  const url = "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/products/stale.svg";
  const groups = groupUnresolvedSources({ unresolved: [
    { collection: "orders", path: "items.0.productImageUrl", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
    { collection: "carts", path: "items.2.productImageUrl", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
    { collection: "products", path: "images.0.url", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
    { collection: "products", path: "variants.0.images.0.url", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
  ] }, { cloudName: "dxemmiorv" });
  assert.deepEqual(groups, [{ publicId: "petyard/products/stale", sourceCloud: "dxemmiorv", urls: [url] }]);
  assert.throws(() => groupUnresolvedSources({ unresolved: [
    { collection: "products", path: "images.0.caption", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
  ] }, { cloudName: "dxemmiorv" }), /unsupported unresolved source/);
  assert.throws(() => groupUnresolvedSources({ unresolved: [
    { collection: "products", path: "variants.0.images.0.alt", value: url, publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
  ] }, { cloudName: "dxemmiorv" }), /unsupported unresolved source/);
  assert.throws(() => groupUnresolvedSources({ unresolved: [
    { collection: "orders", path: "items.0.productImageUrl", value: "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/products/%E0%A4%A.webp", publicId: "petyard/products/stale", reason: "unresolved-source-public-id" },
  ] }, { cloudName: "dxemmiorv" }), /identity mismatch/);
});

test("recovery provenance binds a fully verified parent to the exact dry run", () => {
  const parent = {
    sourceCloud: "dxemmiorv",
    entries: [{ status: "verified" }],
  };
  const dryRun = {
    mode: "dry-run",
    manifestHash: crypto.createHash("sha256").update(JSON.stringify(parent)).digest("hex"),
    database: { host: "db.example", name: "petyard" },
    updatedDocuments: 0,
    conflicts: 0,
    unresolvedSourceUrls: 1,
    unresolved: [{ reason: "unresolved-source-public-id" }],
  };
  const provenance = createRecoveryProvenance(parent, dryRun, { cloudName: "dxemmiorv" });
  assert.equal(provenance.parentManifestHash, dryRun.manifestHash);
  assert.equal(provenance.database.name, "petyard");
  assert.throws(() => createRecoveryProvenance(parent, { ...dryRun, manifestHash: "0".repeat(64) }, { cloudName: "dxemmiorv" }), /not bound/);
  assert.throws(() => createRecoveryProvenance({ ...parent, confirmedUnavailableSources: [{}] }, dryRun, { cloudName: "dxemmiorv" }), /prior recovery metadata/);
});

test("recovery freshly verifies every inherited Bunny object and blocks on a mismatch", async () => {
  const targetHash = crypto.createHash("sha256").update(svg).digest("hex");
  const parent = { entries: [{
    source: { publicId: "petyard/users/avatar" },
    classification: "public",
    status: "verified",
    target: {
      zone: "petyardpublicmedia",
      objectKey: "petyard/users/avatar.svg",
      unsignedUrl: "https://media.petyardstores.com/petyard/users/avatar.svg",
      sha256: targetHash,
    },
  }] };
  const verified = await verifyRecoveryBaseEntries(parent, {
    env,
    concurrency: 1,
    transport: { async request() { return { status: 200, data: svg }; } },
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(verified[0].status, "verified");
  assert.equal(verified[0].verifiedAt, "2026-07-27T00:00:00.000Z");
  await assert.rejects(() => verifyRecoveryBaseEntries(parent, {
    env,
    concurrency: 1,
    transport: { async request() { return { status: 200, data: Buffer.from("different") }; } },
  }), /inherited Bunny object failed verification/);
});

test("delivery-cache recovery requires valid image bytes and verifies Bunny", async () => {
  const url = "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/products/stale.svg";
  let stored = null;
  const requestedUrls = [];
  const captured = await captureUnresolvedGroup({ publicId: "petyard/products/stale", sourceCloud: "dxemmiorv", urls: [url] }, {
    adminApi: { async resource() { const error = new Error("missing"); error.http_code = 404; throw error; } },
    fetchImpl: async (requestedUrl) => {
      requestedUrls.push(requestedUrl);
      const status = requestedUrls.length === 1 ? 404 : 200;
      return new Response(status === 200 ? svg : null, {
        status,
        headers: { "content-type": status === 200 ? "image/svg+xml" : "text/plain" },
      });
    },
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(captured.kind, "captured");
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[1], /petyard_recovery_attempt=/);

  const result = await materializeCapturedRecovery(captured, {
    env,
    copy: true,
    transport: { async request(request) {
      if (request.method === "GET" && stored == null) { const error = new Error("missing"); error.response = { status: 404, headers: {} }; throw error; }
      if (request.method === "PUT") { stored = request.data; return { status: 201 }; }
      return { status: 200, data: stored };
    } },
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(result.kind, "entry");
  assert.equal(result.entry.status, "verified");
  assert.equal(result.entry.recovery.source, "delivery-cache");
  assert.equal(result.entry.target.objectKey, "petyard/products/stale.svg");
  assert.equal(result.entry.recovery.sourceSha256, crypto.createHash("sha256").update(svg).digest("hex"));
  assert.equal(requestedUrls.length, 2);
});

test("recovery streaming cancels oversized bodies and enforces the shared retained-byte budget", async () => {
  let cancelled = false;
  let produced = 0;
  const oversized = new Response(new ReadableStream({
    pull(controller) {
      produced += 1;
      controller.enqueue(Uint8Array.from([produced, produced, produced, produced]));
      if (produced > 10) controller.close();
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "image/webp" } });
  const perFileBudget = createRecoveryByteBudget(20);
  await assert.rejects(
    () => readResponseBufferLimited(oversized, { maxBytes: 5, byteBudget: perFileBudget }),
    /recovery-source-too-large/,
  );
  assert.equal(cancelled, true);
  assert.equal(perFileBudget.usedBytes, 0);

  const shared = createRecoveryByteBudget(6);
  const first = await readResponseBufferLimited(new Response(Buffer.from("1234")), { maxBytes: 10, byteBudget: shared });
  assert.equal(first.length, 4);
  await assert.rejects(
    () => readResponseBufferLimited(new Response(Buffer.from("5678")), { maxBytes: 10, byteBudget: shared }),
    /recovery-capture-total-byte-limit/,
  );
  assert.equal(shared.usedBytes, 4);
  shared.release(first.length);
  assert.equal(shared.usedBytes, 0);
});

test("recovery capture cleanup releases successful buffers when another capture is blocked", async () => {
  const byteBudget = createRecoveryByteBudget(20);
  const buffer = Buffer.from("captured");
  byteBudget.reserve(buffer.length);
  const captures = [
    { kind: "captured", buffer },
    { kind: "blocked", error: "source-blocked" },
  ];

  releaseRecoveryCaptures(captures, byteBudget);

  assert.equal(byteBudget.usedBytes, 0);
  assert.equal(captures[0].buffer, null);
});

test("recovery capture cleanup runs when inherited verification fails", async () => {
  const byteBudget = createRecoveryByteBudget(20);
  const buffer = Buffer.from("captured");
  byteBudget.reserve(buffer.length);
  const captures = [{ kind: "captured", buffer }];

  await assert.rejects(
    () => withRecoveryCaptureCleanup(captures, byteBudget, async () => {
      throw new Error("inherited-verification-failed");
    }),
    /inherited-verification-failed/,
  );

  assert.equal(byteBudget.usedBytes, 0);
  assert.equal(captures[0].buffer, null);
});

test("confirmed source deletion records exact URL hashes while mixed failures block", async () => {
  const urls = [
    "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/products/gone.svg",
    "https://res.cloudinary.com/dxemmiorv/image/upload/v2/petyard/products/gone.svg",
  ];
  const missingAdmin = { async resource() { const error = new Error("missing"); error.http_code = 404; throw error; } };
  let missingAttempts = 0;
  const unavailable = await recoverUnresolvedGroup({ publicId: "petyard/products/gone", sourceCloud: "dxemmiorv", urls }, {
    adminApi: missingAdmin,
    fetchImpl: async () => { missingAttempts += 1; return new Response(null, { status: 404, headers: { "content-type": "text/plain" } }); },
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.record.status, "confirmed-unavailable");
  assert.equal(unavailable.record.deliveryAttempts, 3);
  assert.equal(unavailable.record.urlSha256.length, 2);
  assert.ok(unavailable.record.urlSha256.every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(missingAttempts, 6);

  let calls = 0;
  const blocked = await recoverUnresolvedGroup({ publicId: "petyard/products/gone", sourceCloud: "dxemmiorv", urls }, {
    adminApi: missingAdmin,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 404 : 403, headers: { "content-type": "text/plain" } });
    },
  });
  assert.equal(blocked.kind, "blocked");
});

test("classification, profile mapping, safe IDs, and ordering are deterministic", () => {
  assert.deepEqual(classifyCloudinaryAsset(publicAsset), { classification: "public" });
  assert.deepEqual(classifyCloudinaryAsset({ public_id: "instapay_screenshots/proof" }), { classification: "private" });
  assert.deepEqual(classifyCloudinaryAsset({ public_id: "other/file" }), { error: "unsupported-public-id-root" });
  assert.equal(profileForAsset({ public_id: "petyard/categories/cat" }, "public"), "tile");
  assert.equal(profileForAsset({ public_id: "petyard/products/p" }, "public"), "standard");
  assert.equal(profileForAsset({ public_id: "instapay_screenshots/p" }, "private"), "proof");
  assert.deepEqual(sourceSort([{ public_id: "petyard/z" }, { public_id: "petyard/a" }]).map((x) => x.public_id), ["petyard/a", "petyard/z"]);
  for (const unsafe of ["petyard/../private", "petyard//a", "petyard/a?x=1", "petyard\\a"]) assert.throws(() => assertSafePublicId(unsafe));
});

test("preflight blocks duplicates and unsupported formats, while private proofs preserve source bytes", async () => {
  const blockers = findPreflightBlockers([
    publicAsset,
    { ...publicAsset },
    { ...publicAsset, public_id: "petyard/users/unsupported", format: "tiff" },
  ]);
  assert.deepEqual(blockers, [
    "duplicate-source-identity",
    "duplicate-source-identity",
    "unsupported-source-format",
  ]);

  const proofBytes = Buffer.from("original-payment-proof-bytes");
  const transformed = await transformAsset(
    proofBytes,
    { public_id: "instapay_screenshots/proof", format: "png" },
    "proof",
  );
  assert.equal(transformed.buffer, proofBytes);
  assert.equal(transformed.format, "png");
  assert.equal(transformed.contentType, "image/png");
});

test("copy skips identical existing bytes and refuses a collision without PUT", async () => {
  let puts = 0;
  const identical = await copyOneAsset(publicAsset, {
    env,
    downloadSource: async () => svg,
    transport: { async request(request) {
      assert.equal(request.method, "GET");
      return { status: 200, data: svg };
    } },
  });
  assert.equal(identical.status, "skipped-existing-identical");
  assert.equal(puts, 0);

  const collision = await copyOneAsset(publicAsset, {
    env,
    copy: true,
    downloadSource: async () => svg,
    transport: { async request(request) {
      if (request.method === "PUT") puts += 1;
      return { status: 200, data: Buffer.from("different") };
    } },
  });
  assert.equal(collision.status, "collision");
  assert.equal(puts, 0);
});

test("resume manifests must match current targets and verify-only rechecks Storage hashes", async () => {
  const targetHash = crypto.createHash("sha256").update(svg).digest("hex");
  const entry = {
    source: { publicId: publicAsset.public_id },
    classification: "public",
    target: {
      zone: "petyardpublicmedia",
      objectKey: "petyard/users/avatar.svg",
      unsignedUrl: "https://media.petyardstores.com/petyard/users/avatar.svg",
      sha256: targetHash,
    },
    status: "verified",
  };
  assert.equal(
    validatePreviousManifest({ entries: [entry] }, { env, classes: ["public"] }).entries[0],
    entry,
  );
  assert.throws(() =>
    validatePreviousManifest(
      { entries: [{ ...entry, target: { ...entry.target, zone: "wrong-zone" } }] },
      { env, classes: ["public"] },
    ),
  );

  const verified = await verifyManifestEntry(entry, {
    env,
    transport: { async request() { return { status: 200, data: svg }; } },
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.verifiedAt, "2026-07-27T00:00:00.000Z");
});

test("copy resume rechecks unchanged verified entries without downloading or putting again", async () => {
  const targetHash = crypto.createHash("sha256").update(svg).digest("hex");
  const previousManifest = { entries: [{
    source: { publicId: publicAsset.public_id, secureUrl: publicAsset.secure_url, format: "svg", version: null },
    classification: "public", status: "verified",
    target: { zone: "petyardpublicmedia", objectKey: "petyard/users/avatar.svg", unsignedUrl: "https://media.petyardstores.com/petyard/users/avatar.svg", sha256: targetHash },
  }] };
  let sourceDownloads = 0;
  const result = await resumeCopyEntry(publicAsset, {
    previousManifest,
    copy: true,
    env,
    downloadSource: async () => { sourceDownloads += 1; return svg; },
    transport: { async request(request) { assert.equal(request.method, "GET"); return { status: 200, data: svg }; } },
  });
  assert.equal(result.status, "skipped-existing-identical");
  assert.equal(sourceDownloads, 0);
});

test("Storage authentication failures are not mistaken for a missing target", async () => {
  let puts = 0;
  const result = await copyOneAsset(publicAsset, {
    env,
    copy: true,
    downloadSource: async () => svg,
    transport: {
      async request(request) {
        if (request.method === "PUT") puts += 1;
        const error = new Error("denied-secret-value");
        error.response = { status: 403, headers: {} };
        throw error;
      },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(puts, 0);
  assert.doesNotMatch(JSON.stringify(result), /denied-secret-value/);
});

test("copy verifies post-upload hashes with an injected in-memory transport", async () => {
  let object = null;
  let puts = 0;
  const result = await copyOneAsset(publicAsset, {
    env,
    copy: true,
    downloadSource: async () => svg,
    transport: { async request(request) {
      if (request.method === "GET" && object == null) {
        const error = new Error("not found");
        error.response = { status: 404, headers: {} };
        throw error;
      }
      if (request.method === "PUT") {
        puts += 1;
        object = request.data;
        return { status: 201 };
      }
      return { status: 200, data: object };
    } },
  });
  assert.equal(puts, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.target.objectKey, "petyard/users/avatar.svg");
  assert.equal(result.target.sha256.length, 64);
  assert.equal(result.sourceSha256.length, 64);
});

test("bounded execution preserves result order and summary never exposes configuration secrets", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await runBounded([3, 1, 2], 2, async (value) => {
    active += 1;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return { status: "planned", classification: "public", target: { format: "webp", profile: "standard" }, value };
  });
  assert.deepEqual(results.map((result) => result.value), [3, 1, 2]);
  assert.ok(maxActive <= 2);
  assert.deepEqual(summarizeEntries(results), { statuses: { planned: 3 }, classes: { public: 3 }, formats: { webp: 3 }, profiles: { standard: 3 } });
  assert.doesNotMatch(JSON.stringify(results), /public-secret-value/);
});
