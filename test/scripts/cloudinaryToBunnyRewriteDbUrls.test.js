import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createVerifiedManifestMap,
  createConfirmedUnavailableMap,
  getManifestCompletenessErrors,
  applyForwardPlan,
  applyRollbackPlan,
  assertRecoveryDatabaseIdentity,
  buildRollbackPlan,
  parseCloudinaryImageUrl,
  parseRewriteArguments,
  planDocumentUrlRewrites,
  planRollbackField,
  redactReportValue,
  validateRecoveryProvenance,
} from "../../scripts/cloudinaryToBunnyRewriteDbUrls.js";

const publicUrl = "https://res.cloudinary.com/dxemmiorv/image/upload/c_limit,w_480,q_auto:good,f_webp/v1773192088/petyard/categories/cats.png";
const privateUrl = "https://res.cloudinary.com/dx5n4ekk2/image/upload/v1773192088/instapay_screenshots/proof.png";
const manifest = {
  entries: [
    { status: "verified", classification: "public", source: { publicId: "petyard/categories/cats" }, target: { zone: "petyardpublicmedia", objectKey: "petyard/categories/cats.webp", unsignedUrl: "https://media.petyardstores.com/petyard/categories/cats.webp", sha256: "a".repeat(64) } },
    { status: "skipped-existing-identical", classification: "private", source: { publicId: "instapay_screenshots/proof" }, target: { zone: "petyardprivatepayments", objectKey: "instapay_screenshots/proof.webp", unsignedUrl: "https://proofs.petyardstores.com/instapay_screenshots/proof.webp", sha256: "b".repeat(64) } },
  ],
};

const unavailableUrl = "https://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/products/gone.webp";
const unavailableRecord = {
  status: "confirmed-unavailable",
  classification: "public",
  sourceCloud: "dxemmiorv",
  publicId: "petyard/products/gone",
  adminStatus: 404,
  deliveryStatus: 404,
  deliveryAttempts: 3,
  urlSha256: [crypto.createHash("sha256").update(unavailableUrl).digest("hex")],
  confirmedAt: "2026-07-27T00:00:00.000Z",
};

const recoveryProvenance = {
  version: 1,
  parentManifestHash: "c".repeat(64),
  recoveryReportHash: "d".repeat(64),
  database: { host: "db.example", name: "petyard" },
  sourceCloud: "dxemmiorv",
};

test("Cloudinary parser recognizes original and transformed image URLs but not other resource types", () => {
  assert.deepEqual(parseCloudinaryImageUrl(publicUrl), {
    cloudName: "dxemmiorv",
    publicId: "petyard/categories/cats",
    value: publicUrl,
  });
  assert.deepEqual(parseCloudinaryImageUrl(privateUrl), {
    cloudName: "dx5n4ekk2",
    publicId: "instapay_screenshots/proof",
    value: privateUrl,
  });
  assert.equal(parseCloudinaryImageUrl("https://external.example/image.png"), null);
  assert.deepEqual(parseCloudinaryImageUrl("https://res.cloudinary.com/dxemmiorv/video/upload/v1/petyard/a.mp4"), {
    unsupported: true,
    reason: "unsupported-cloudinary-resource",
  });
  assert.deepEqual(parseCloudinaryImageUrl("https://res.cloudinary.com/unknown/image/upload/v1/petyard/a.png"), {
    unsupported: true,
    reason: "unknown-cloudinary-cloud",
  });
  assert.deepEqual(parseCloudinaryImageUrl("http://res.cloudinary.com/dxemmiorv/image/upload/v1/petyard/a.png"), {
    unsupported: true,
    reason: "non-https-cloudinary-url",
  });
});

test("rewrite planning traverses images in fixtures without rewriting external or malformed strings", () => {
  const map = createVerifiedManifestMap(manifest);
  const document = {
    product: { images: [{ public_id: "legacy", url: publicUrl }], variants: [{ image: { url: publicUrl } }] },
    cart: { items: [{ image: publicUrl }] },
    favorite: { image: publicUrl },
    order: { items: [{ image: publicUrl }], instapayScreenshot: privateUrl },
    user: { image: "https://oauth.example/avatar.png" },
    malformed: "not an image URL",
  };
  const result = planDocumentUrlRewrites(document, map);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.changes.length, 6);
  assert.ok(result.changes.some((change) => change.path === "order.instapayScreenshot" && change.after.startsWith("https://proofs.petyardstores.com/")));
  assert.ok(result.changes.every((change) => change.before === publicUrl || change.before === privateUrl));
  assert.equal(document.user.image, "https://oauth.example/avatar.png");
  assert.equal(result.stats.externalUrlsIgnored, 1);
});

test("unverified or missing manifest entries block source URL rewrites", () => {
  const map = createVerifiedManifestMap({ entries: [{ ...manifest.entries[0], status: "planned" }] });
  const result = planDocumentUrlRewrites({ image: publicUrl }, map);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.unresolved, [{
    path: "image",
    value: publicUrl,
    publicId: "petyard/categories/cats",
    reason: "unresolved-source-public-id",
  }]);
});

test("only exact confirmed-unavailable snapshot URLs plan a null replacement", () => {
  const unavailableMap = createConfirmedUnavailableMap({ confirmedUnavailableSources: [unavailableRecord] });
  const result = planDocumentUrlRewrites(
    { items: [{ productImageUrl: unavailableUrl }] },
    createVerifiedManifestMap(manifest),
    { confirmedUnavailableMap: unavailableMap, allowConfirmedUnavailable: true },
  );
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.changes.map(({ path, before, after, classification }) => ({ path, before, after, classification })), [{
    path: "items.0.productImageUrl",
    before: unavailableUrl,
    after: null,
    classification: "confirmed-unavailable",
  }]);

  const wrongUrl = unavailableUrl.replace("v1", "v2");
  const mismatch = planDocumentUrlRewrites(
    { items: [{ productImageUrl: wrongUrl }] },
    createVerifiedManifestMap(manifest),
    { confirmedUnavailableMap: unavailableMap, allowConfirmedUnavailable: true },
  );
  assert.equal(mismatch.changes.length, 0);
  assert.equal(mismatch.unresolved.length, 1);

  const wrongField = planDocumentUrlRewrites(
    { image: unavailableUrl },
    createVerifiedManifestMap(manifest),
    { confirmedUnavailableMap: unavailableMap, allowConfirmedUnavailable: true },
  );
  assert.equal(wrongField.unresolved.length, 1);
});

test("apply requires every manifest entry to be verified and complete", () => {
  assert.deepEqual(getManifestCompletenessErrors(manifest), []);
  assert.ok(getManifestCompletenessErrors({ entries: [...manifest.entries, { status: "planned" }] }).length > 0);
  assert.ok(getManifestCompletenessErrors({ entries: [{ ...manifest.entries[0], target: { unsignedUrl: "https://media.petyardstores.com/a" } }] }).length > 0);
  const recoveryManifest = {
    ...manifest,
    sourceCloud: "dxemmiorv",
    recoveryProvenance,
    confirmedUnavailableSources: [unavailableRecord],
  };
  assert.deepEqual(getManifestCompletenessErrors(recoveryManifest), []);
  assert.ok(getManifestCompletenessErrors({ ...recoveryManifest, recoveryProvenance: null }).length > 0);
  assert.ok(getManifestCompletenessErrors({ ...recoveryManifest, confirmedUnavailableSources: [{ ...unavailableRecord, deliveryStatus: 200 }] }).length > 0);
  assert.equal(validateRecoveryProvenance(recoveryManifest), recoveryProvenance);
  assert.doesNotThrow(() => assertRecoveryDatabaseIdentity(recoveryManifest, { host: "db.example", name: "petyard" }));
  assert.throws(() => assertRecoveryDatabaseIdentity(recoveryManifest, { host: "other-db.example", name: "petyard" }), /does not match/);
});

test("forward and rollback batch writers continue after an independent batch error", async () => {
  let calls = 0;
  const connection = { connection: { db: { collection() { return { async bulkWrite() { calls += 1; if (calls === 1) throw new Error("fake failure"); return { matchedCount: 1, modifiedCount: 1 }; } }; } } } };
  const plan = [
    { collection: "orders", operation: { updateOne: {} } },
    { collection: "orders", operation: { updateOne: {} } },
  ];
  const forward = await applyForwardPlan(connection, plan, { batchSize: 1 });
  assert.equal(calls, 2);
  assert.equal(forward[0].error, "bulk-write-failed");
  assert.equal(forward[1].modified, 1);
  calls = 0;
  const rollback = await applyRollbackPlan(connection, plan, { batchSize: 1 });
  assert.equal(calls, 2);
  assert.equal(rollback[0].error, "bulk-write-failed");
  assert.equal(rollback[1].modified, 1);
});

test("apply and rollback confirmation guards are exact and rollback is compare-before-restore", () => {
  assert.throws(() => parseRewriteArguments(["--manifest=report.json", "--apply"]), /--confirm-live-db-rewrite/);
  assert.throws(() => parseRewriteArguments(["--rollback-report=report.json", "--apply"]), /--confirm-live-db-rollback/);
  assert.throws(() => parseRewriteArguments([]), /exactly one/);
  assert.equal(planRollbackField("after", { before: "before", after: "after" }).action, "restore");
  assert.equal(planRollbackField("before", { before: "before", after: "after" }).action, "already-restored");
  assert.equal(planRollbackField("changed-by-user", { before: "before", after: "after" }).action, "conflict");
  assert.equal(planRollbackField(null, { before: unavailableUrl, after: null }).action, "restore");
});

test("rollback accepts null forward values and filters for an exact BSON null", async () => {
  const documentId = "64b7f0f0f0f0f0f0f0f0f0f0";
  const connection = { connection: { db: { collection() { return {
    async findOne() { return { _id: documentId, items: [{ productImageUrl: null }] }; },
  }; } } } };
  const rollback = await buildRollbackPlan(connection, { changedFields: [{
    collection: "orders",
    documentId,
    path: "items.0.productImageUrl",
    before: unavailableUrl,
    after: null,
  }] });
  assert.equal(rollback.summary.restored, 1);
  assert.deepEqual(
    rollback.plan[0].operation.updateOne.filter["items.0.productImageUrl"],
    { $type: 10 },
  );
});

test("reports redact connection secrets", () => {
  const value = "failed mongodb+srv://alice:super-secret@cluster.example/petyard";
  assert.doesNotMatch(redactReportValue(value), /super-secret/);
});
