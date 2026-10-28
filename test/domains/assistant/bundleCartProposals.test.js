import express from "express";
import http from "node:http";
import { createAssistantCartRouter } from "../../../src/domains/assistant/customer/assistant.cart-routes.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { buildBundleProductCard } from "../../../src/domains/bundle/bundle.product-card.js";
import { buildCatalogSnapshot } from "../../../src/domains/assistant/products/assistant.product-cards.js";
import { prepareCartProposal, getCartProposal, confirmCartProposal } from "../../../src/domains/assistant/customer/assistant.cart-api.js";
import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, OTHER, clone } from "../bundle/fixtures/bundleCartTransaction.js";
import { AssistantAccount, AssistantChat, AssistantDietaryWarning, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { AssistantCartProposal } from "../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { prepareBundleCartReview, getBundleCartReviewState, confirmBundleCartReview } from "../../../src/domains/assistant/customer/assistant.bundle-cart-proposals.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

function reviews(t, options) {
  const s = fixture(t, options);
  s.config = { ...testConfig({ productSearchEnabled: true, cartPolicy: { version: "synthetic", proposalSeconds: 600, rateMax: 10, rateWindowSeconds: 60 },
    catalogClassification: { version: "synthetic", foodCategoryIds: [B], nonFoodCategoryIds: [OTHER], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] } }),
    cartEnabled: true, bundleCartEnabled: true };
  s.account = { _id: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId(U), __v: 0, blocked: false, activeRun: null };
  s.chat = { _id: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId(U), __v: 0, activeSubject: null, contextVersion: 0, subjects: [] };
  s.records = []; s.pets = []; s.warnings = []; s.proposalWrites = 0; s.commits = 0; s.aborts = 0; s.ends = 0;
  s.proposalIndexes = [{ key: { owner: 1, key: 1 }, unique: true }];
  function query(read) {
    let session;
    return { select() { return this; }, maxTimeMS() { return this; }, sort() { return this; }, limit() { return this; },
      session(value) { session = value; return this; }, lean() { return this; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (!s.api || session) assert.equal(session, s.session); return read(); }).then(resolve, reject);
      } };
  }
  t.mock.method(UserModel, "findById", () => query(() => clone(s.user)));
  t.mock.method(AssistantAccount, "findOne", filter => query(() => String(filter.owner) === U ? clone(s.account) : null));
  t.mock.method(AssistantChat, "findOne", filter => query(() => String(filter.owner) === U ? clone(s.chat) : null));
  t.mock.method(PetModel, "find", () => query(() => clone({ rows: s.pets }).rows));
  t.mock.method(PetModel, "findOne", filter => query(() => s.pets.find(row => String(row._id) === String(filter._id)) ?? null));
  t.mock.method(AssistantDietaryWarning, "find", () => query(() => s.warnings));
  t.mock.method(AssistantCartProposal.collection, "indexes", async () => s.proposalIndexes);
  t.mock.method(AssistantCartProposal, "findOne", filter => query(() => {
    s.onProposalRead?.();
    return s.records.find(row => String(row.owner) === String(filter.owner) &&
      (filter.key === undefined || row.key === filter.key) && (filter._id === undefined || String(row._id) === String(filter._id))) ?? null;
  }));
  t.mock.method(AssistantCartProposal, "create", async ([row], { session }) => {
    assert.equal(session, s.session); s.proposalWrites++;
    if (s.duplicateAttempts > 0) { s.duplicateAttempts--; throw Object.assign(Error("duplicate review race"), { code: 11000 }); }
    if (s.failProposal) throw Error("proposal insert failed");
    const doc = new AssistantCartProposal(row); assert.equal(doc.validateSync(), undefined);
    s.records.push(doc.toObject()); return [doc];
  });
  for (const [Model, field] of [[AssistantAccount, "account"], [AssistantChat, "chat"]]) {
    t.mock.method(Model.collection, "updateOne", async (filter, update, { session }) => {
      assert.equal(session, s.session); assert.equal(filter.$expr.$eq[0], "$$ROOT");
      assert.deepEqual(filter.$expr.$eq[1].$literal, s[field]);
      if (s.contextConflict === field) return { matchedCount: 0, modifiedCount: 0 };
      s[field].__v += update.$inc.__v; return { matchedCount: 1, modifiedCount: 1 };
    });
  }
  t.mock.method(PetModel.collection, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter.petOwner), U);
    if (s.contextConflict === "pet") return { matchedCount: 0, modifiedCount: 0 };
    const pet = s.pets.find(row => String(row._id) === String(filter._id)); pet.__v += update.$inc.__v;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  for (const Model of [AssistantCartProposal, AssistantAccount, AssistantChat]) {
    t.mock.method(Model, "createCollection", () => assert.fail("no collection setup"));
    t.mock.method(Model, "createIndexes", () => assert.fail("no index setup"));
  }
  s.session.withTransaction = async (callback, options) => {
    assert.deepEqual(options.readConcern, { level: "snapshot" }); assert.deepEqual(options.writeConcern, { w: "majority" });
    const snapshot = clone({ cart: s.cart, user: s.user, account: s.account, chat: s.chat, records: s.records, receipts: s.receipts, pets: s.pets });
    try { const result = await callback(); s.commits++; if (s.loseResponse) { s.loseResponse = false; throw Error("unknown commit result"); } return result; }
    catch (error) { if (error.message !== "unknown commit result") { Object.assign(s, snapshot); s.aborts++; } throw error; }
  };
  s.session.endSession = async () => { s.ends++; };
  t.mock.method(mongoose, "startSession", async () => s.session);
  s.body = { warehouseId: W, language: "en", change: { action: "add", bundleId: B, expectedRevision: 2, quantity: 1 } };
  s.prepareReview = async (body = s.body, key = "bundle-review-0001") => {
    const result = await prepareBundleCartReview(s.actor, body, key, s.config); s.proposal = result.proposal; return result;
  };
  s.confirmReview = (body = { expectedVersion: 1, fingerprint: s.proposal.fingerprint, warehouseId: W }) => confirmBundleCartReview(s.actor, s.proposal.id, body, s.config);
  s.state = () => getBundleCartReviewState(s.actor, s.proposal.id, s.config);
  s.bindSuggestion = () => {
    const card = buildBundleProductCard({ bundle: s.definitions[0], warehouse: s.warehouse, products: s.products, lang: "en" });
    const catalog = buildCatalogSnapshot({ status: "results", products: [{ ...card, priceDisplay: "exact" }], effectiveWarehouseId: W, rerouted: false },
      { constrained: false }, { warehouseId: W }, null, "en");
    s.source = { _id: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId(U), chat: s.chat._id, run: new mongoose.Types.ObjectId(),
      role: "assistant", subjectId: null, catalogJson: JSON.stringify(catalog), expiresAt: new Date(Date.now() + 300000) };
    s.sourceRun = { _id: s.source.run, purpose: "customer", status: "completed", responseMessage: s.source._id };
    t.mock.method(AssistantMessage, "findOne", filter => query(() => s.source && String(filter._id) === String(s.source._id) && String(filter.owner) === String(s.source.owner) &&
      String(filter.chat) === String(s.source.chat) && s.source.role === "assistant" && s.source.expiresAt > filter.expiresAt.$gt ? clone(s.source) : null));
    t.mock.method(AssistantRun, "findOne", filter => query(() => { const f = filter.$and[0]; return s.sourceRun?.purpose === "customer" && s.sourceRun.status === "completed" &&
      String(f._id) === String(s.sourceRun._id) && String(f.responseMessage) === String(s.sourceRun.responseMessage) ? clone(s.sourceRun) : null; }));
    s.body.sourceMessageId = String(s.source._id);
  };
  s.savedPet = () => {
    const pet = { _id: new mongoose.Types.ObjectId(OTHER), petOwner: new mongoose.Types.ObjectId(U), __v: 0, name: "Milo", type: "cat",
      chronic_conditions: [], temp_health_issues: [] };
    s.pets = [pet]; s.chat.activeSubject = `pet:${OTHER}`; return pet;
  };
  return s;
}

test("durable review saves server-generated identity and context without writing the cart", async t => {
  const s = reviews(t, { ordinary: true }), before = clone(s.cart); const result = await s.prepareReview();
  assert.equal(result.duplicate, false); assert.equal(result.proposal.status, "pending");
  assert.equal(s.records.length, 1); assert.equal(s.proposalWrites, 1); assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []);
  assert.match(JSON.parse(s.records[0].inputJson).groupId, /^[a-f\d]{24}$/); assert.match(s.records[0].key, /^bundle:v1:[a-f\d]{64}$/);
  assert.equal(s.account.__v, 1); assert.equal(s.chat.__v, 1); assert.equal(s.user.__v, 3);
  assert.equal(s.ends, 1); assert.ok(Date.parse(result.proposal.expiresAt) > Date.now());
});

test("same prepare key returns the original review and changed input conflicts", async t => {
  const s = reviews(t); const first = await s.prepareReview(); const again = await s.prepareReview();
  assert.deepEqual(again.proposal, first.proposal); assert.equal(again.duplicate, true); assert.equal(s.proposalWrites, 1);
  await assert.rejects(s.prepareReview({ ...s.body, change: { ...s.body.change, quantity: 2 } }), { code: "idempotency_conflict" });
});

test("confirmation commits a cart and retained receipt, and retries never add again", async t => {
  const s = reviews(t); await s.prepareReview(); const result = await s.confirmReview();
  assert.equal(result.confirmed, true); assert.equal(result.duplicate, false); assert.equal(s.cart.bundles[0].quantity, 1);
  s.definitions = []; s.products = []; s.chat.contextVersion++; s.account.activeRun = new mongoose.Types.ObjectId();
  const repeated = await s.confirmReview(); assert.equal(repeated.duplicate, true); assert.deepEqual(repeated.receipt, result.receipt);
  const state = await s.state(); assert.equal(state.proposal.status, "confirmed"); assert.deepEqual(state.receipt, result.receipt);
  assert.equal(s.cart.bundles[0].quantity, 1); assert.equal(s.writes.length, 3);
});

test("unknown commit response is recovered through state with no reapplication", async t => {
  const s = reviews(t, { existing: false }); await s.prepareReview(); s.loseResponse = true;
  await assert.rejects(s.confirmReview(), /unknown commit result/);
  const result = await s.state(); assert.equal(result.proposal.status, "confirmed"); assert.equal(result.receipt.cartId, String(s.cart._id));
  assert.equal((await s.confirmReview()).duplicate, true); assert.equal(s.cart.bundles[0].quantity, 1);
});

test("changed chat, pet or dietary-warning context blocks first confirmation", async t => {
  const s = reviews(t); const pet = s.savedPet(); await s.prepareReview();
  s.chat.contextVersion++; await assert.rejects(s.confirmReview(), { code: "context_changed" }); s.chat.contextVersion--;
  s.pets[0].name = "Changed"; await assert.rejects(s.confirmReview(), { code: "context_changed" }); s.pets[0].name = pet.name;
  s.warnings = [{ _id: new mongoose.Types.ObjectId(), subjectId: s.chat.activeSubject, state: "active", text: "Avoid food", version: 1 }];
  await assert.rejects(s.confirmReview(), { code: "context_changed" }); assert.deepEqual(s.writes, []);
});

test("dietary caution applies to every surviving component, including unclassified products", async t => {
  const s = reviews(t); s.savedPet(); s.pets[0].chronic_conditions = ["allergy"];
  s.products[0].category = B; await assert.rejects(s.prepareReview(), { code: "food_review_required" });
  delete s.products[0].category; await assert.rejects(s.prepareReview(), { code: "food_review_required" });
  s.products[0].category = OTHER; await s.prepareReview(); await s.confirmReview(); assert.equal(s.cart.bundles.length, 1);
});

test("an unsaved pet review cannot outlive the selected temporary subject", async t => {
  const s = reviews(t); const expiresAt = new Date(Date.now() + 100000);
  s.chat.activeSubject = "chat:11111111-1111-4111-8111-111111111111";
  s.chat.subjects = [{ id: s.chat.activeSubject, name: "Cat", species: "cat", expiresAt }]; s.products[0].category = OTHER;
  const result = await s.prepareReview(); assert.equal(result.proposal.expiresAt, expiresAt.toISOString());
});

test("expired reviews do not execute but already committed receipts remain recoverable", async t => {
  const s = reviews(t); await s.prepareReview();
  const expiry = Date.parse(s.proposal.expiresAt);
  // Advance time without changing the signed persisted expiry.
  const RealDate = Date;
  class LaterDate extends RealDate { constructor(...args) { super(...(args.length ? args : [expiry + 1])); } static now() { return expiry + 1; } }
  t.mock.property(globalThis, "Date", LaterDate);
  await assert.rejects(s.confirmReview(), { code: "bundle_cart_review_expired" }); assert.deepEqual(s.writes, []);
  assert.equal((await s.state()).proposal.status, "expired");
});

test("an expired confirmed review returns its saved receipt even after the original context is gone", async t => {
  const s = reviews(t); await s.prepareReview(); const first = await s.confirmReview();
  const expiry = Date.parse(s.proposal.expiresAt), RealDate = Date;
  class LaterDate extends RealDate { constructor(...args) { super(...(args.length ? args : [expiry + 1])); } static now() { return expiry + 1; } }
  t.mock.property(globalThis, "Date", LaterDate);
  s.chat.contextVersion++; s.chat.activeSubject = `pet:${OTHER}`; s.products = []; s.definitions = [];
  const retry = await s.confirmReview(); assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, first.receipt);
  assert.equal((await s.state()).proposal.status, "confirmed"); assert.equal(s.writes.length, 3);
});

test("duplicate-key recovery gets one bounded fresh transaction attempt", async t => {
  const s = reviews(t); s.duplicateAttempts = 1; await s.prepareReview();
  assert.equal(s.proposalWrites, 2); assert.equal(s.aborts, 1); assert.equal(s.records.length, 1); assert.equal(s.account.__v, 1);
  s.duplicateAttempts = 3;
  await assert.rejects(s.prepareReview(s.body, "bundle-review-0002"), { code: 11000 });
  assert.equal(s.proposalWrites, 4); assert.equal(s.records.length, 1); assert.equal(s.ends, 2);
});

test("the dedicated bundle flag is absent from existing activation unless explicitly enabled", () => {
  const config = testConfig({ productSearchEnabled: true });
  assert.equal(config.bundleCartEnabled, false); assert.equal(config.cartEnabled, false);
});

test("whole-group removal and absolute set use the same durable review and receipt flow", async t => {
  const s = reviews(t); await s.prepareReview(); const added = await s.confirmReview();
  const groupId = added.receipt.result.groupsAfter[0].id;
  // The shared driver fixture expects version seven at its first CAS; update that assertion for subsequent writes.
  const { CartModel } = await import("../../../src/domains/cart/cart.model.js");
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(filter.__v, s.cart.__v); assert.deepEqual(filter.$expr.$eq[1].$literal, s.cart);
    Object.assign(s.cart, update.$set); for (const key of Object.keys(update.$unset)) delete s.cart[key]; s.cart.__v++;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  await s.prepareReview({ warehouseId: W, language: "en", change: { action: "set", groupId, quantity: 2 } }, "bundle-review-0002");
  await s.confirmReview(); assert.equal(s.cart.bundles[0].quantity, 2);
  s.definitions = [];
  await s.prepareReview({ warehouseId: W, language: "en", change: { action: "remove", groupId } }, "bundle-review-0003");
  await s.confirmReview(); assert.deepEqual(s.cart.bundles, []); assert.equal(s.cart.totalCartPrice, 0);
});

test("receipt creation failure aborts cart, account and chat changes together in the fixture", async t => {
  const s = reviews(t); await s.prepareReview();
  const before = clone({ cart: s.cart, user: s.user, account: s.account, chat: s.chat }); s.failReceipt = true;
  await assert.rejects(s.confirmReview(), /receipt unavailable/);
  for (const key of Object.keys(before)) assert.deepEqual(s[key], before[key]); assert.equal(s.receipts.length, 0); assert.equal(s.aborts, 1);
});

test("expiry detected after cart staging aborts the complete uncommitted operation", async t => {
  const s = reviews(t); await s.prepareReview();
  const before = clone({ cart: s.cart, user: s.user, account: s.account, chat: s.chat });
  const RealDate = Date, expiry = Date.parse(s.proposal.expiresAt); let current = Date.now();
  class ControlledDate extends RealDate { constructor(...args) { super(...(args.length ? args : [current])); } static now() { return current; } }
  t.mock.property(globalThis, "Date", ControlledDate); s.onWrite = () => { current = expiry + 1; };
  await assert.rejects(s.confirmReview(), { code: "bundle_cart_review_expired" });
  for (const key of Object.keys(before)) assert.deepEqual(mongoose.mongo.BSON.serialize({ value: s[key] }),
    mongoose.mongo.BSON.serialize({ value: before[key] }));
  assert.equal(s.receipts.length, 0);
});

test("a saved pet fence conflict prevents a first cart mutation", async t => {
  const s = reviews(t); s.savedPet(); await s.prepareReview(); s.contextConflict = "pet";
  await assert.rejects(s.confirmReview(), { code: "context_changed" }); assert.deepEqual(s.writes, []); assert.equal(s.receipts.length, 0);
});

test("a foreign-owner review cannot be read or confirmed", async t => {
  const s = reviews(t); await s.prepareReview(); s.records[0].owner = new mongoose.Types.ObjectId(OTHER);
  await assert.rejects(s.state(), { code: "bundle_cart_review_not_found" });
  await assert.rejects(s.confirmReview(), { code: "bundle_cart_review_not_found" }); assert.deepEqual(s.writes, []);
});

test("context fence failure or proposal insert failure cannot leave a usable new review", async t => {
  const s = reviews(t); s.contextConflict = "chat";
  await assert.rejects(s.prepareReview(), { code: "context_changed" }); assert.equal(s.records.length, 0); assert.equal(s.account.__v, 0);
  s.contextConflict = null; s.failProposal = true; await assert.rejects(s.prepareReview(), /proposal insert failed/);
  assert.equal(s.records.length, 0); assert.equal(s.chat.__v, 0); assert.equal(s.account.__v, 0);
});

test("fresh blocked, inactive or unverified accounts cannot execute or recover", async t => {
  const s = reviews(t); await s.prepareReview(); s.account.blocked = true;
  await assert.rejects(s.confirmReview(), { code: "ai_restricted" }); await assert.rejects(s.state(), { code: "ai_restricted" }); s.account.blocked = false;
  s.user.active = false; await assert.rejects(s.confirmReview(), { code: "BUNDLE_ACCESS_DENIED" }); s.user.active = true;
  s.user.phoneVerified = false; await assert.rejects(s.state(), { code: "BUNDLE_ACCESS_DENIED" }); assert.deepEqual(s.writes, []);
});

test("active chat runs block new mutation but allow receipt state recovery", async t => {
  const s = reviews(t); await s.prepareReview(); s.account.activeRun = new mongoose.Types.ObjectId();
  await assert.rejects(s.confirmReview(), { code: "active_request" });
  assert.equal((await s.state()).proposal.status, "pending"); assert.deepEqual(s.writes, []);
});

test("strict confirmation and preparation validation reject client prices, group IDs and altered fingerprints", async t => {
  const s = reviews(t);
  await assert.rejects(s.prepareReview({ ...s.body, change: { ...s.body.change, newGroupId: OTHER } }), { code: "invalid_request" });
  await assert.rejects(s.prepareReview({ ...s.body, price: 1 }), { code: "invalid_request" });
  await s.prepareReview(); await assert.rejects(s.confirmReview({ expectedVersion: 1, fingerprint: "0".repeat(64), warehouseId: W }), { code: "bundle_cart_review_changed" });
  await assert.rejects(s.confirmReview({ expectedVersion: 1, fingerprint: s.proposal.fingerprint, quote: {} }), { code: "invalid_request" });
  assert.deepEqual(s.writes, []);
});

test("the current resolved warehouse must match for a first application, while committed recovery is preserved", async t => {
  const s = reviews(t); await s.prepareReview();
  const body = { expectedVersion: 1, fingerprint: s.proposal.fingerprint, warehouseId: OTHER };
  await assert.rejects(s.confirmReview(body), { code: "bundle_cart_warehouse_changed" }); assert.deepEqual(s.writes, []);
  await assert.rejects(s.confirmReview({ expectedVersion: 1, fingerprint: s.proposal.fingerprint }), { code: "invalid_identifier" });
  const first = await s.confirmReview(); assert.deepEqual((await s.confirmReview(body)).receipt, first.receipt); assert.equal(s.cart.bundles[0].quantity, 1);
});

test("corrupt or ordinary-product proposal records cannot execute as bundle reviews", async t => {
  const s = reviews(t); await s.prepareReview(); const json = s.records[0].quoteJson; s.records[0].quoteJson = "{}";
  await assert.rejects(s.confirmReview(), { code: "bundle_cart_review_unavailable" }); s.records[0].quoteJson = json;
  s.records[0].inputJson = JSON.stringify({ productId: P }); await assert.rejects(s.state(), { code: "bundle_cart_review_unavailable" });
  assert.deepEqual(s.writes, []);
});

test("review storage readiness and dedicated flag fail closed without initialization", async t => {
  const s = reviews(t); s.config.bundleCartEnabled = false;
  await assert.rejects(s.prepareReview(), { code: "bundle_cart_actions_unavailable" }); s.config.bundleCartEnabled = true;
  s.proposalIndexes = []; await assert.rejects(s.prepareReview(), { code: "bundle_cart_review_store_unavailable" });
  s.proposalIndexes = [{ key: { owner: 1, key: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }];
  await assert.rejects(s.prepareReview(), { code: "bundle_cart_review_store_unavailable" }); assert.equal(s.records.length, 0);
});

test("ordinary-add reviews generate and restore a server line ID while rejecting client-generated IDs", async t => {
  const s = reviews(t); const body = { warehouseId: W, language: "en", change: { action: "ordinary_add",
    cartId: String(s.cart._id), expectedCartVersion: 7, productId: P, productType: "SIMPLE", quantity: 2 } };
  await assert.rejects(s.prepareReview({ ...body, change: { ...body.change, newItemId: OTHER } }), { code: "invalid_request" });
  await s.prepareReview(body); const envelope = JSON.parse(s.records[0].inputJson);
  assert.match(envelope.itemId, /^[a-f\d]{24}$/); assert.equal(envelope.request.change.newItemId, undefined);
  assert.equal(s.proposal.quote.ordinaryItemsAfter[0].id, envelope.itemId);
  const first = await s.confirmReview(); assert.equal(String(s.cart.items[0]._id), envelope.itemId); assert.equal(s.cart.items[0].quantity, 2);
  assert.deepEqual((await s.confirmReview()).receipt, first.receipt); assert.equal((await s.state()).proposal.status, "confirmed");
});

test("ordinary quantity increase obeys dietary restrictions while explicit decrease or removal remains possible", async t => {
  const s = reviews(t, { ordinary: true }); s.savedPet(); s.pets[0].chronic_conditions = ["allergy"]; s.products[0].category = B;
  const base = { warehouseId: W, language: "en", change: { action: "ordinary_set", cartId: String(s.cart._id),
    expectedCartVersion: 7, itemId: String(s.cart.items[0]._id), quantity: 3 } };
  await assert.rejects(s.prepareReview(base), { code: "food_review_required" });
  await s.prepareReview({ ...base, change: { ...base.change, quantity: 1 } }, "ordinary-decrease"); await s.confirmReview();
  assert.equal(s.cart.items[0].quantity, 1); s.expectedCartVersion = 8;
  await s.prepareReview({ ...base, change: { action: "ordinary_remove", cartId: String(s.cart._id), expectedCartVersion: 8,
    itemId: String(s.cart.items[0]._id) } }, "ordinary-remove-1");
  await s.confirmReview(); assert.deepEqual(s.cart.items, []);
});

test("reviewed rebind commits only the selected target and recovers after later warehouse/context changes", async t => {
  const s = reviews(t); s.cart.bundles = [{ id: OTHER, bundleId: B, bundleRevision: 2, quantity: 1, unitPricePiastres: 1500 }];
  s.warehouses = [{ _id: W, active: true }, { _id: OTHER, active: true }]; s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 10 });
  s.expectedWarehouseId = OTHER;
  await s.prepareReview({ warehouseId: OTHER, language: "en", change: { action: "rebind", cartId: String(s.cart._id), expectedCartVersion: 7 } });
  const body = { expectedVersion: 1, fingerprint: s.proposal.fingerprint, warehouseId: OTHER };
  const first = await s.confirmReview(body); assert.equal(String(s.cart.warehouse), OTHER); assert.equal(s.cart.bundles[0].id, OTHER);
  s.chat.contextVersion++; s.products = []; s.definitions = [];
  assert.deepEqual((await s.confirmReview({ ...body, warehouseId: W })).receipt, first.receipt); assert.equal(s.cart.__v, 8);
});


test("suggested bundle preparation binds the saved message and only confirmation mutates the cart", async t => {
  const s = reviews(t); s.bindSuggestion(); const before = clone(s.cart); await s.prepareReview();
  assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []); assert.ok(s.proposal.expiresAt <= s.source.expiresAt.toISOString());
  const result = await s.confirmReview(); assert.equal(result.confirmed, true); assert.equal(s.cart.bundles[0].bundleId, B);
  s.source = null; s.sourceRun = null; assert.equal((await s.confirmReview()).duplicate, true);
});

for (const change of ["owner", "warehouse", "revision", "bundle", "purpose", "subject", "expiry"]) test(`saved suggestion rejects changed ${change} before cart writes`, async t => {
  const s = reviews(t); s.bindSuggestion();
  if (change === "owner") s.source.owner = new mongoose.Types.ObjectId(OTHER);
  if (change === "purpose") s.sourceRun.purpose = "admin_business";
  if (change === "subject") s.source.subjectId = `pet:${OTHER}`;
  if (change === "expiry") s.source.expiresAt = new Date(Date.now() - 1);
  if (["warehouse", "revision", "bundle"].includes(change)) {
    const catalog = JSON.parse(s.source.catalogJson);
    if (change === "warehouse") { catalog.requestedWarehouseId = OTHER; catalog.effectiveWarehouseId = OTHER; catalog.products[0].warehouseId = OTHER; }
    if (change === "revision") catalog.products[0].revision++;
    if (change === "bundle") catalog.products[0].id = OTHER;
    s.source.catalogJson = JSON.stringify(catalog);
  }
  await assert.rejects(s.prepareReview(), error => error.status === 404 || error.status === 409);
  assert.deepEqual(s.writes, []); assert.equal(s.records.length, 0);
});

test("a source changed or expired after preparation blocks first confirmation", async t => {
  const s = reviews(t); s.bindSuggestion(); await s.prepareReview(); s.source.catalogJson = s.source.catalogJson.replace("Pair", "Changed");
  await assert.rejects(s.confirmReview(), { code: "context_changed" }); assert.deepEqual(s.writes, []);
});

test("normal cart-proposal API prepares and confirms a source-bound bundle with a public allowlist", async t => {
  const s = reviews(t); s.api = true; s.bindSuggestion();
  mockAssistantTransactions(t); t.mock.method(mongoose, "startSession", async () => s.session);
  t.mock.method(AssistantAccount, "updateOne", async (_filter, _update, { session }) => { assert.equal(session, s.session); return { matchedCount: 1 }; });
  const body = { sourceMessageId: String(s.source._id), warehouseId: W, bundleId: B, expectedRevision: 2, quantity: 1, language: "en" };
  const prepared = await prepareCartProposal(U, body, "normal-api-bundle-1", s.config); assert.equal(prepared.proposal.status, "pending");
  assert.equal(prepared.proposal.quote.type, "BUNDLE"); assert.equal(prepared.proposal.quote.bundleSubtotal, 15);
  for (const key of ["ownerId", "patch", "demands", "expectedCartVersion", "itemsSubtotalPiastres"]) assert.equal(prepared.proposal.quote[key], undefined);
  await assert.rejects(prepareCartProposal(U, { sourceMessageId: body.sourceMessageId, warehouseId: W, productId: P, quantity: 1, language: "en" }, "normal-api-bundle-1", s.config), { code: "idempotency_conflict" });
  const confirm = { expectedVersion: 1, fingerprint: prepared.proposal.fingerprint, warehouseId: W };
  await assert.rejects(confirmCartProposal(U, prepared.proposal.id, { ...confirm, warehouseId: OTHER }, s.config), { code: "bundle_cart_warehouse_changed" });
  const result = await confirmCartProposal(U, prepared.proposal.id, confirm, s.config); assert.equal(result.confirmed, true); assert.equal(result.receipt.result.type, "BUNDLE");
  assert.equal(result.receipt.result.patch, undefined); assert.equal(s.cart.bundles[0].quantity, 1);
  s.source = null; s.sourceRun = null;
  const state = await getCartProposal(U, prepared.proposal.id, {}, s.config); assert.equal(state.proposal.status, "confirmed"); assert.deepEqual(state.receipt, result.receipt);
  assert.equal((await confirmCartProposal(U, prepared.proposal.id, confirm, s.config)).duplicate, true); assert.equal(s.cart.bundles[0].quantity, 1);
});


test("the existing HTTP cart router reaches source-bound bundle review and explicit confirmation", async t => {
  const s = reviews(t); s.api = true; s.bindSuggestion(); mockAssistantTransactions(t); t.mock.method(mongoose, "startSession", async () => s.session);
  t.mock.method(AssistantAccount, "updateOne", async (_filter, _update, { session }) => { assert.equal(session, s.session); return { matchedCount: 1 }; });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = s.user; next(); });
  app.use("/cart-proposals", createAssistantCartRouter({ getConfig: () => s.config }));
  app.use((error, _req, res, _next) => res.status(error.status ?? error.statusCode ?? 500).json({ code: error.code ?? "error" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: `/cart-proposals${path}`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Idempotency-Key": "http-bundle-review" } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }); req.on("error", reject); req.end(payload);
  });
  const body = { sourceMessageId: String(s.source._id), bundleId: B, expectedRevision: 2, warehouseId: W, quantity: 1, language: "ar" };
  const prepared = await request("POST", "", body); assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const proposal = prepared.body.data.proposal; assert.equal(proposal.quote.type, "BUNDLE"); assert.equal(s.cart.bundles, undefined);
  assert.equal((await request("POST", `/${proposal.id}/confirmations`, { expectedVersion: 1, fingerprint: proposal.fingerprint })).status, 400);
  const confirmed = await request("POST", `/${proposal.id}/confirmations`, { expectedVersion: 1, fingerprint: proposal.fingerprint, warehouseId: W });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); assert.equal(confirmed.body.data.confirmed, true); assert.equal(s.cart.bundles[0].quantity, 1);
  assert.equal(confirmed.body.data.receipt.result.demands, undefined); assert.equal(confirmed.body.data.receipt.result.bundlesAfter[0].components[0].allocations, undefined);
  s.source = null; s.sourceRun = null; const recovered = await request("GET", `/${proposal.id}`);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.data.proposal.status, "confirmed"); assert.deepEqual(recovered.body.data.receipt, confirmed.body.data.receipt);
});

test("an internal unbound bundle review cannot be executed through the public cart API", async t => {
  const s = reviews(t); await s.prepareReview(); s.api = true; mockAssistantTransactions(t); t.mock.method(mongoose, "startSession", async () => s.session);
  t.mock.method(AssistantAccount, "updateOne", async () => ({ matchedCount: 1 }));
  await assert.rejects(confirmCartProposal(U, s.proposal.id, { expectedVersion: 1, fingerprint: s.proposal.fingerprint, warehouseId: W }, s.config), { code: "cart_proposal_unavailable" });
  assert.deepEqual(s.writes, []);
});
