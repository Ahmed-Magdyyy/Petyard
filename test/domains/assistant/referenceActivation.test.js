import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceService, referenceCanActivate } from "../../../src/domains/assistant/references/assistant.reference-service.js";
import { AssistantReference } from "../../../src/domains/assistant/references/assistant.reference.model.js";
import { referenceVectorIndex } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";
import { referenceMemory, referenceActor, referenceBody, referenceFile, referenceTestConfig } from "./fixtures/referenceMemory.js";

async function fixture() {
  const memory = referenceMemory(), { state } = memory, actor = referenceActor(), config = referenceTestConfig();
  await memory.application.upload(actor, referenceBody(), referenceFile(), config);
  const worker = memory.worker(); worker.start(config); await worker.idle();
  const row = state.rows[0]; state.coverageCalls = 0;
  const proof = { model: "text-embedding-3-large", dimensions: 1536, manifestHash: row.passageHash, passageCount: row.passageCount, indexId: "initial-fixture-index",
    indexName: referenceVectorIndex.name, indexVersion: 1, verifiedAt: new Date(state.time) };
  Object.assign(row, { status: "needs_review", stage: "awaiting_approval", storedPassageCount: row.passageCount, searchVerification: proof });
  row.version++;
  const application = createReferenceService({ ...memory.dependencies, verifyCoverage: async (source, manifest) => {
    state.coverageCalls++; assert.equal(source.status, "needs_review"); assert.equal(sourceHash(manifest), source.passageHash);
    if (state.duringCoverage) await state.duringCoverage(source);
    if (state.failCoverage) throw new Error("private synthetic upstream details");
    return state.badProof ? { ...proof, manifestHash: "f".repeat(64) } : { ...proof, indexId: "fresh-fixture-index", indexVersion: 2, verifiedAt: new Date(state.time) };
  } });
  const run = (body = { expectedVersion: row.version }, approvingActor = actor) => application.activate(approvingActor, row._id, body, config);
  return { ...memory, application, actor, config, row, run };
}

test("approval rechecks coverage and saves an exact-generation SuperAdmin decision in one versioned update", async () => {
  const f = await fixture(), reviewedVersion = f.row.version;
  assert.equal(referenceCanActivate(f.row), true);
  const result = await f.run();
  assert.equal(result.status, "ready"); assert.equal(result.stage, "ready"); assert.equal(result.version, reviewedVersion + 1);
  assert.equal(result.actions.canActivate, false); assert.equal(result.activatedBy, String(f.actor._id));
  assert.equal(result.activatedAt, f.state.time.toISOString()); assert.equal(f.state.coverageCalls, 1);
  assert.equal(f.row.activation.manifestHash, f.row.passageHash); assert.equal(f.row.activation.sourceHash, f.row.sha256);
  assert.equal(f.row.activation.reviewedVersion, reviewedVersion); assert.equal(f.row.searchVerification.indexId, "fresh-fixture-index");
  assert.equal(new AssistantReference(f.row).validateSync(), undefined);
  assert.doesNotMatch(JSON.stringify(result), /manifestHash|sourceHash|fresh-fixture-index|reviewedVersion/);
  const again = await f.run(); assert.equal(again.version, result.version); assert.equal(f.state.coverageCalls, 1);
  await assert.rejects(f.run({ expectedVersion: reviewedVersion }), { code: "reference_changed" });
});

test("failed or mismatched fresh verification leaves the source unapproved and preserves its revision", async () => {
  for (const field of ["failCoverage", "badProof", "failGet"]) {
    const f = await fixture(), version = f.row.version; f.state[field] = true;
    await assert.rejects(f.run(), { code: "reference_activation_check_failed" });
    assert.equal(f.row.status, "needs_review"); assert.equal(f.row.version, version); assert.equal(f.row.activation, undefined);
  }
});

test("disabled, incomplete, blocked and wrong-generation preparations cannot reach fresh verification", async () => {
  for (const mutate of [row => { row.status = "disabled"; }, row => { row.indexingBlocked = true; },
    row => { row.storedPassageCount = 0; }, row => { row.searchVerification = undefined; },
    row => { row.searchVerification.manifestHash = "f".repeat(64); }, row => { row.passageVersion = "unknown-preparation"; },
    row => { row.searchVerification.indexName = "wrong-index"; }, row => { row.searchVerification.model = "text-embedding-3-small"; },
    row => { delete row.searchVerification.model; }, row => { row.searchVerification.dimensions = 3072; },
    row => { row.failureCode = "reference_indexing_invalid"; }]) {
    const f = await fixture(); mutate(f.row); assert.equal(referenceCanActivate(f.row), false);
    await assert.rejects(f.run(), { code: "reference_activation_unavailable" }); assert.equal(f.state.coverageCalls, 0);
    assert.equal(f.row.activation, undefined);
  }
});

test("only verified SuperAdmins can approve; request fields and versions remain strict", async () => {
  const f = await fixture();
  for (const role of ["guest", "user", "moderator", "admin"]) await assert.rejects(f.run(undefined, { ...f.actor, role }), { code: "access_denied" });
  await assert.rejects(f.run(undefined, { ...f.actor, phoneVerified: false }), { code: "access_denied" });
  for (const body of [{}, { expectedVersion: "1" }, { expectedVersion: 0 }, { expectedVersion: f.row.version, approved: true }]) {
    await assert.rejects(f.run(body), { code: "invalid_request" });
  }
  assert.equal(f.state.coverageCalls, 0);
  const otherSuperAdmin = referenceActor(); const result = await f.run(undefined, otherSuperAdmin);
  assert.equal(result.activatedBy, String(otherSuperAdmin._id)); assert.equal(result.uploadedBy, String(f.actor._id));
});

test("disable during fresh verification wins over the late approval result", async () => {
  const f = await fixture(); f.state.duringCoverage = () => f.application.disable(f.actor, f.row._id, { expectedVersion: f.row.version }, f.config);
  await assert.rejects(f.run(), { code: "reference_changed" }); assert.equal(f.row.status, "disabled"); assert.equal(f.row.activation, undefined);
});

test("concurrent approval requests cannot overwrite the winning actor or create a second revision", async () => {
  const f = await fixture(), version = f.row.version; let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.state.duringCoverage = async () => { if (f.state.coverageCalls === 2) release(); await pending; };
  const results = await Promise.allSettled([f.run({ expectedVersion: version }), f.run({ expectedVersion: version }, referenceActor())]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "reference_changed");
  assert.equal(f.row.version, version + 1); assert.equal(f.row.activation.reviewedVersion, version);
});

test("disabling a ready reference retains its historical approval but prevents reactivation", async () => {
  const f = await fixture(); const approved = await f.run();
  const disabled = await f.application.disable(f.actor, f.row._id, { expectedVersion: approved.version }, f.config);
  assert.equal(disabled.status, "disabled"); assert.equal(disabled.actions.canActivate, false); assert.equal(disabled.activatedAt, approved.activatedAt);
  await assert.rejects(f.run(), { code: "reference_activation_unavailable" }); assert.equal(f.state.coverageCalls, 1);
});
