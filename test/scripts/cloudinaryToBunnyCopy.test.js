import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  assertSafePublicId,
  classifyCloudinaryAsset,
  copyOneAsset,
  findPreflightBlockers,
  parseCopyArguments,
  profileForAsset,
  runBounded,
  resumeCopyEntry,
  sourceSort,
  summarizeEntries,
  transformAsset,
  validatePreviousManifest,
  verifyManifestEntry,
} from "../../scripts/cloudinaryToBunnyCopy.js";

const env = {
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
  });
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
