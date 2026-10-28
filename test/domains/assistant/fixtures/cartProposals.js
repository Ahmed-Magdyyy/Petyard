import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import jwt from "jsonwebtoken";
import { createAssistantRouter } from "../../../../src/domains/assistant/assistant.routes.js";
import { prepareCartAdditionProposal, revalidateCartAdditionProposal, confirmCartAdditionProposal } from "../../../../src/domains/assistant/customer/assistant.cart-proposals.js";
import { AssistantCartProposal } from "../../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { AssistantCartReceipt } from "../../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { AssistantAccount, AssistantChat, AssistantDietaryWarning, AssistantMessage, AssistantRun } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../../src/domains/warehouse/warehouse.model.js";
import { CartModel } from "../../../../src/domains/cart/cart.model.js";
import { CollectionModel } from "../../../../src/domains/collection/collection.model.js";
import { mockAssistantTransactions } from "./mockAssistantTransactions.js";
import { matchesQuery } from "./matchesQuery.js";
import { testConfig } from "./foundationPolicy.js";

export const oid = (value) => new mongoose.Types.ObjectId(value);
export const W = "111111111111111111111111", P = "222222222222222222222222", C = "333333333333333333333333";
export const F = "444444444444444444444444", V = "555555555555555555555555", OTHER = "666666666666666666666666";

export function cartProposalFixture(t, { confirmation = false } = {}) {
  mockAssistantTransactions(t);
  const owner = oid(); const chatId = oid(); const runId = oid(); const sourceId = oid();
  const config = testConfig({ productSearchEnabled: true, catalogClassification: { version: "proposal-test-v1",
    foodCategoryIds: [F], nonFoodCategoryIds: [C], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] } });
  const state = { owner, config, records: [], writes: 0, cartReads: 0, reads: 0, pets: [], warnings: [],
    indexes: [{ key: { owner: 1, key: 1 }, unique: true }],
    user: { _id: owner, __v: 0, active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed" },
    account: { _id: oid(), __v: 0, owner, blocked: false, activeRun: null }, chat: { _id: chatId, __v: 0, owner, activeSubject: null, contextVersion: 0, subjects: [] },
    product: { _id: oid(P), isActive: true, type: "SIMPLE", category: C, name_en: "Toy", name_ar: "لعبة", price: 100,
      images: [], warehouseStocks: [{ warehouse: W, quantity: 10 }] }, cart: null };
  state.catalog = { version: 1, status: "results", subjectId: null, subjectName: null, requestedWarehouseId: W,
    effectiveWarehouseId: W, rerouted: false, generatedAt: new Date().toISOString(), dataMode: "snapshot", currency: "EGP",
    suitability: "not_verified", notices: [], products: [{ id: P, slug: "toy", name: "Toy", type: "SIMPLE", image: null,
      price: 100, discountedPrice: null, inStock: true, hasVariants: false, priceDisplay: "exact" }] };
  state.source = { _id: sourceId, owner, chat: chatId, run: runId, role: "assistant", subjectId: null, expiresAt: new Date(Date.now() + 600000) };
  state.run = { _id: runId, owner, chat: chatId, purpose: "customer", status: "completed", responseMessage: sourceId };
  const query = (read) => {
    let session;
    const execute = () => {
      if (state.confirming) assert.equal(session, state.session, "confirmation reads must share the transaction");
      return read();
    };
    return { select() { return this; }, maxTimeMS() { return this; }, sort() { return this; }, limit() { return this; },
      session(value) { session = value; return this; }, lean() { return Promise.resolve().then(execute); },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); } };
  };
  const find = (row, filter) => row && matchesQuery(row, filter) ? row : null;
  t.mock.method(UserModel, "findById", (id) => query(() => { state.reads++; return String(id) === String(owner) ? state.user : null; }));
  t.mock.method(AssistantAccount, "findOne", (filter) => query(() => find(state.account, filter)));
  t.mock.method(AssistantChat, "findOne", (filter) => query(() => find(state.chat, filter)));
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => find(state.run, filter)));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => {
    const row = { ...state.source, catalogJson: JSON.stringify(state.catalog) }; return find(row, filter);
  }));
  t.mock.method(PetModel, "find", (filter) => query(() => state.pets.filter((row) => matchesQuery(row, filter))));
  t.mock.method(AssistantDietaryWarning, "find", (filter) => query(() => state.warnings.filter((row) => matchesQuery(row, filter))));
  t.mock.method(ProductModel, "findById", (id) => query(() => String(id) === P ? state.product : null));
  t.mock.method(ProductModel, "find", (filter) => query(() => {
    state.onCartRefresh?.(); return filter._id.$in.includes(P) ? [state.product] : [];
  }));
  t.mock.method(WarehouseModel, "findById", (id) => query(() => String(id) === W ? { _id: W, active: true } : null));
  t.mock.method(CartModel, "findOne", (filter) => query(() => { state.cartReads++; assert.equal(String(filter.user), String(owner)); return state.cart; }));
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "updateMany", () => assert.fail("No promotion maintenance in proposal preparation"));
  t.mock.method(CartModel.prototype, "save", () => assert.fail("No cart save in proposal preparation"));
  for (const method of ["create", "updateOne", "updateMany", "deleteOne", "deleteMany"]) {
    t.mock.method(CartModel, method, () => assert.fail("No cart writes in proposal preparation"));
  }
  t.mock.method(AssistantCartProposal, "findOne", (filter) => query(() => state.records.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantCartProposal.collection, "indexes", async () => state.indexes);
  t.mock.method(AssistantCartProposal, "create", async ([record], options) => {
    if (state.records.some((row) => String(row.owner) === String(record.owner) && row.key === record.key)) {
      throw Object.assign(new Error("synthetic unique-index conflict"), { code: 11000 });
    }
    assert.ok(options.session); const doc = new AssistantCartProposal(record); assert.equal(doc.validateSync(), undefined);
    const row = doc.toObject(); state.writes++;
    if (state.failInsert) throw new Error("synthetic insert failure");
    state.records.push(row);
    if (state.duplicateRace) { state.duplicateRace = false; throw Object.assign(new Error("synthetic duplicate race"), { code: 11000 }); }
    return [doc];
  });
  state.body = { sourceMessageId: String(sourceId), warehouseId: W, productId: P, quantity: 2, language: "en" };
  state.options = { expiresAt: new Date(Date.now() + 300000) };
  state.prepare = (body = state.body, key = "prepare-key-1", options = state.options) => prepareCartAdditionProposal(owner, body, key, config, options);
  state.check = (proposal, changes = {}) => revalidateCartAdditionProposal(owner, proposal.id,
    { expectedVersion: proposal.version, fingerprint: proposal.fingerprint, ...changes }, config);
  if (confirmation) {
    state.receipts = []; state.fences = []; state.cartWrites = 0; state.commits = 0; state.aborts = 0; state.attempts = 0;
    const clone = (value) => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;
    t.mock.method(mongoose, "startSession", async () => {
      const session = { active: false, inTransaction() { return this.active; }, async endSession() {},
        async withTransaction(callback) {
          state.session = this;
          for (;;) {
            const saved = clone({ receipts: state.receipts, cart: state.cart, records: state.records,
              user: state.user, account: state.account, chat: state.chat, pets: state.pets });
            let committed = false; this.active = true; state.attempts++;
            try {
              const result = await callback();
              if (state.retryOnce) {
                state.retryOnce = false; Object.assign(state, saved); state.onRetry?.(); continue;
              }
              await state.beforeCommit?.();
              state.commits++; committed = true;
              if (state.loseResponse) { state.loseResponse = false; throw new Error("simulated unknown commit response"); }
              return result;
            } catch (error) {
              if (!committed) { Object.assign(state, saved); state.aborts++; }
              throw error;
            } finally { this.active = false; }
          }
        } };
      return session;
    });
    t.mock.method(PetModel, "findOne", (filter) => query(() => state.pets.find((pet) => matchesQuery(pet, filter)) ?? null));
    t.mock.method(AssistantAccount, "updateOne", async (filter, update, options) => {
      assert.equal(options.session, state.session); assert.equal(String(filter.owner), String(owner));
      Object.assign(state.account, update.$set); return { matchedCount: 1, modifiedCount: 1 };
    });
    const rows = new Map([[UserModel, () => state.user], [AssistantAccount, () => state.account],
      [AssistantChat, () => state.chat], [PetModel, (filter) => state.pets.find((pet) => String(pet._id) === String(filter._id))]]);
    for (const [model, rowFor] of rows) t.mock.method(model.collection, "updateOne", async (filter, update, options) => {
      assert.equal(options.session, state.session); assert.equal(state.session.active, true);
      state.fences.push(model.modelName);
      if (state.failFence === model.modelName) return { matchedCount: 0, modifiedCount: 0 };
      const row = rowFor(filter);
      assert.equal(String(row._id), String(filter._id));
      for (const [key, condition] of Object.entries(filter)) {
        if (key !== "_id") assert.deepEqual(clone(row[key]), clone(condition.$eq));
      }
      assert.deepEqual(update, { $inc: { __v: 1 } }); row.__v = (row.__v ?? 0) + 1;
      return { matchedCount: 1, modifiedCount: 1 };
    });
    t.mock.method(CartModel.collection, "indexes", async () => [{ key: { user: 1 }, unique: true,
      partialFilterExpression: { user: { $type: "objectId" } } }]);
    t.mock.method(CartModel, "create", async ([row], options) => {
      assert.equal(options.session, state.session); state.cartWrites++; state.cart = new CartModel(row).toObject();
      return [new CartModel(row)];
    });
    t.mock.method(CartModel.collection, "updateOne", async (filter, update, options) => {
      assert.equal(options.session, state.session); state.cartWrites++;
      assert.deepEqual(clone(filter.$expr.$eq[1].$literal), clone(state.cart));
      Object.assign(state.cart, update.$set); delete state.cart.abandonedAt; state.cart.__v++;
      return { matchedCount: 1, modifiedCount: 1 };
    });
    t.mock.method(AssistantCartReceipt.collection, "indexes", async () => [{ name: "_id_", key: { _id: 1 } }]);
    t.mock.method(AssistantCartReceipt, "findOne", (filter) => query(() => state.receipts.find((row) => matchesQuery(row, filter)) ?? null));
    t.mock.method(AssistantCartReceipt, "create", async ([row], options) => {
      assert.equal(options.session, state.session);
      if (state.failReceipt) throw new Error("simulated receipt failure");
      const doc = new AssistantCartReceipt(row); state.receipts.push(doc.toObject()); return [doc];
    });
    state.confirm = async (proposal, changes = {}) => {
      state.confirming = true;
      try { return await confirmCartAdditionProposal(owner, proposal.id,
        { expectedVersion: proposal.version, fingerprint: proposal.fingerprint, ...changes }, config); }
      finally { state.confirming = false; }
    };
    state.apiConfig = { ...config, cartEnabled: true, cartPolicy: { version: "synthetic-test", proposalSeconds: 60, rateMax: 100, rateWindowSeconds: 60 } };
  }
  return state;
}

export async function cartProposalHttpFixture(t) {
  const state = cartProposalFixture(t, { confirmation: true });
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-cart-coordinator-http-only";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const app = express(); app.use(express.json());
  // Use actual authentication, routing, admission and confirmation; only persistence is simulated.
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.apiConfig }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); listener.once("error", reject);
  });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/cart-proposals`;
  const token = jwt.sign({ userId: String(state.owner) }, process.env.JWT_ACCESS_SECRET);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "http-coordinator-prepare" };
  state.checkoutUrl = url.replace(/\/cart-proposals$/, "/checkout-summary");
  state.httpHeaders = headers;
  state.request = async (method, suffix = "", body, suppliedHeaders = headers) => {
    const response = await fetch(url + suffix, { method, headers: suppliedHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  state.httpPrepare = () => state.request("POST", "", state.body);
  state.httpConfirm = (proposal, extra = {}) => state.request("POST", `/${proposal.id}/confirmations`,
    { expectedVersion: proposal.version, fingerprint: proposal.fingerprint, ...extra });
  state.httpStatus = (proposal) => state.request("GET", `/${proposal.id}`);
  return state;
}

