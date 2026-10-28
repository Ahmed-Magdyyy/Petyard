import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { prepareCartAdditionProposal, getCartAdditionProposal } from "../../../src/domains/assistant/customer/assistant.cart-proposals.js";
import { AssistantCartProposal } from "../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { assistantModels } from "../../../src/domains/assistant/shared/assistant.models.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { prepareCartProposal, getCartProposal, confirmCartProposal } from "../../../src/domains/assistant/customer/assistant.cart-api.js";

import { cartProposalFixture as fixture, oid, W, P, C, F, V, OTHER } from "./fixtures/cartProposals.js";

test("proposal schema has owner/key uniqueness but no TTL or implicit store initialization", () => {
  assert.ok(AssistantCartProposal.schema.indexes().some(([keys, options]) => keys.owner === 1 && keys.key === 1 && options.unique));
  assert.ok(AssistantCartProposal.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
  assert.equal(Object.values(assistantModels).includes(AssistantCartProposal), false);
  assert.equal(AssistantCartProposal.schema.options.autoCreate, false); assert.equal(AssistantCartProposal.schema.options.autoIndex, false);
});

test("preparation retains a bounded owner-bound preview without cart writes and retrieval keeps the exact snapshot", async (t) => {
  const s = fixture(t); const result = await s.prepare();
  assert.equal(result.duplicate, false); assert.equal(result.proposal.status, "pending");
  assert.equal(result.proposal.version, 1); assert.match(result.proposal.fingerprint, /^[a-f\d]{64}$/);
  assert.equal(result.proposal.quote.itemsSubtotalAfter, 200); assert.equal(result.proposal.quote.cartId, null);
  assert.equal(s.records.length, 1); assert.equal(String(s.records[0].owner), String(s.owner));
  assert.deepEqual((await getCartAdditionProposal(s.owner, result.proposal.id, s.config)).proposal, result.proposal);
});

test("an identical key replays the original proposal even when prices change and cannot extend its expiry", async (t) => {
  const s = fixture(t); const first = await s.prepare(); const reads = s.cartReads;
  s.product.price = 999;
  const repeated = await s.prepare({ ...s.body, variantId: null }, "prepare-key-1", { expiresAt: new Date(Date.now() + 500000) });
  assert.equal(repeated.duplicate, true); assert.deepEqual(repeated.proposal, first.proposal);
  assert.equal(s.cartReads, reads); assert.equal(s.writes, 1);
  await assert.rejects(s.prepare({ ...s.body, quantity: 3 }), { code: "idempotency_conflict", status: 409 });
});

test("a duplicate-key retry recovers a concurrently inserted original proposal", async (t) => {
  const s = fixture(t); s.duplicateRace = true;
  const result = await s.prepare();
  assert.equal(result.duplicate, true); assert.equal(s.records.length, 1);
  assert.equal(result.proposal.id, String(s.records[0]._id));
});

test("simultaneous identical preparations recover the same proposal under the simulated unique index", async (t) => {
  const s = fixture(t);
  const results = await Promise.all([s.prepare(), s.prepare()]);
  assert.equal(s.records.length, 1); assert.equal(results.filter((value) => value.duplicate).length, 1);
  assert.equal(results[0].proposal.id, results[1].proposal.id);
  assert.equal(results[0].proposal.fingerprint, results[1].proposal.fingerprint);
});

test("simultaneous changed content under one key has one winner and one conflict", async (t) => {
  const s = fixture(t);
  const results = await Promise.allSettled([s.prepare(), s.prepare({ ...s.body, quantity: 3 })]);
  assert.equal(s.records.length, 1); assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(results.find((value) => value.status === "rejected").reason.code, "idempotency_conflict");
});

test("freshness checking ignores ephemeral new-line IDs and never executes or changes the proposal", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare(); const before = JSON.stringify(s.records);
  const checked = await s.check(proposal);
  assert.equal(checked.ready, true); assert.equal(checked.executed, false);
  assert.deepEqual(checked.proposal, proposal); assert.equal(JSON.stringify(s.records), before); assert.equal(s.writes, 1);
});

test("changed fingerprints and unsupported versions cannot be confirmed", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  await assert.rejects(s.check(proposal, { fingerprint: "f".repeat(64) }), { code: "cart_proposal_changed", status: 409 });
  await assert.rejects(s.check(proposal, { expectedVersion: 2 }), { code: "invalid_request", status: 400 });
});

test("changed prices or cart contents require a new preview and preserve the original proposal", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  s.product.price = 200;
  await assert.rejects(s.check(proposal), { code: "cart_proposal_changed", status: 409 });
  s.product.price = 100;
  s.cart = new CartModel({ user: s.owner, warehouse: W, items: [], totalCartPrice: 0 }).toObject();
  await assert.rejects(s.check(proposal), { code: "cart_proposal_changed", status: 409 });
  assert.equal(s.writes, 1);
});

test("stock loss or a source/warehouse mismatch cannot become a valid proposal", async (t) => {
  const s = fixture(t); s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 100 }];
  await assert.rejects(s.prepare(), { statusCode: 400 }); assert.equal(s.records.length, 0);
  s.product.warehouseStocks = [{ warehouse: W, quantity: 10 }];
  await assert.rejects(s.prepare({ ...s.body, warehouseId: OTHER }), { code: "context_changed" });
  s.catalog.products[0].inStock = false;
  await assert.rejects(s.prepare(), { code: "product_not_in_source" });
});

test("an exact source offer cannot be replaced with a different variant", async (t) => {
  const s = fixture(t);
  Object.assign(s.catalog.products[0], { type: "VARIANT", hasVariants: true,
    matchingOffer: { variantId: V, packageWeightGrams: 3000, options: [] }, matchingOfferCount: 1 });
  Object.assign(s.product, { type: "VARIANT", variants: [V, OTHER].map((id) => ({ _id: oid(id), price: 100,
    options: [{ name: "Weight", value: "3kg" }], warehouseStocks: [{ warehouse: W, quantity: 10 }] })) });
  await assert.rejects(s.prepare(), { code: "invalid_request" });
  await assert.rejects(s.prepare({ ...s.body, variantId: OTHER }), { code: "variant_not_in_source" });
  const { proposal } = await s.prepare({ ...s.body, variantId: V });
  assert.equal(proposal.quote.addition.variantId, V);
  assert.equal((await s.check(proposal)).executed, false);
  s.product.variants[0].options[0].value = "1kg";
  await assert.rejects(s.check(proposal), { code: "source_offer_changed", status: 409 });
  await assert.rejects(s.prepare({ ...s.body, variantId: V }, "prepare-key-2"), { code: "source_offer_changed", status: 409 });
});

test("foreign proposal IDs and foreign source messages remain indistinguishable from missing records", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  s.records[0].owner = oid(OTHER);
  await assert.rejects(getCartAdditionProposal(s.owner, proposal.id, s.config), { code: "cart_proposal_not_found", status: 404 });
  await assert.rejects(s.check(proposal), { code: "cart_proposal_not_found", status: 404 });
  s.source.owner = oid(OTHER);
  await assert.rejects(s.prepare(s.body, "prepare-key-2"), { code: "source_message_not_found", status: 404 });
});

test("disabled, revoked, banned, unverified or active-run accounts cannot prepare/revalidate", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  s.account.blocked = true; await assert.rejects(s.check(proposal), { code: "ai_restricted", status: 403 });
  s.account.blocked = false; s.account.activeRun = oid(); await assert.rejects(s.prepare(s.body, "prepare-key-2"), { code: "active_request" });
  s.account.activeRun = null; s.user.phoneVerified = false; await assert.rejects(s.check(proposal), { code: "access_denied" });
  s.user.phoneVerified = true; s.user.account_status = "banned"; await assert.rejects(s.check(proposal), { code: "access_denied" });
  s.user.account_status = "confirmed"; s.user.active = false; await assert.rejects(s.check(proposal), { code: "authentication_required" });
  await assert.rejects(prepareCartAdditionProposal(s.owner, s.body, "prepare-key-2", { enabled: false }, s.options), { code: "assistant_disabled" });
});

test("expired source, incomplete run and changed pet context reject stale cards", async (t) => {
  const s = fixture(t); s.run.status = "queued";
  await assert.rejects(s.prepare(), { code: "context_changed" }); s.run.status = "completed";
  s.chat.activeSubject = `pet:${OTHER}`; await assert.rejects(s.prepare(), { code: "context_changed" }); s.chat.activeSubject = null;
  s.source.expiresAt = new Date(Date.now() - 1); await assert.rejects(s.prepare(), { code: "source_message_not_found" });
});

test("current dietary warnings override old food cards and changed context fences existing proposals", async (t) => {
  const s = fixture(t); const petId = oid(); const subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, petOwner: s.owner, name: "Milo", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId; s.product.category = F;
  const { proposal } = await s.prepare();
  s.warnings.push({ _id: oid(), owner: s.owner, subjectId, state: "active", version: 1, text: "Existing dietary caution" });
  await assert.rejects(s.check(proposal), { code: "food_review_required" });
  s.warnings = []; s.chat.contextVersion++;
  await assert.rejects(s.check(proposal), { code: "context_changed" }); assert.equal(s.writes, 1);
});

test("preparation rechecks access/context after quotation and does not persist stale work", async (t) => {
  const s = fixture(t); s.onCartRefresh = () => { s.chat.contextVersion++; };
  await assert.rejects(s.prepare(), { code: "context_changed" }); assert.equal(s.records.length, 0);
  s.onCartRefresh = () => { s.account.blocked = true; };
  await assert.rejects(s.prepare(), { code: "ai_restricted" }); assert.equal(s.records.length, 0);
});

test("product deactivation during quotation cannot persist a usable proposal", async (t) => {
  const s = fixture(t); s.onCartRefresh = () => { s.product.isActive = false; };
  await assert.rejects(s.prepare(), { code: "product_not_found", status: 404 });
  assert.equal(s.records.length, 0); assert.equal(s.writes, 0);
});

test("expiry is supplied by trusted server policy, bounded by source retention and cannot execute expired proposals", async (t) => {
  const s = fixture(t);
  for (const options of [{}, { expiresAt: "future" }, { expiresAt: new Date(Date.now() - 1) }, { expiresAt: new Date(Date.now() + 700000) }]) {
    await assert.rejects(s.prepare(s.body, "prepare-key-1", options), { code: "cart_proposal_expiry_required" });
  }
  const { proposal } = await s.prepare();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(proposal.expiresAt).getTime() + 1 });
  assert.equal((await getCartAdditionProposal(s.owner, proposal.id, s.config)).proposal.status, "expired");
  await assert.rejects(s.check(proposal), { code: "cart_proposal_expired", status: 409 });
});

test("invalid input, client-supplied ownership/expiry and missing keys reject before reads", async (t) => {
  const s = fixture(t);
  for (const body of [{ ...s.body, owner: OTHER }, { ...s.body, expiresAt: new Date().toISOString() },
    { ...s.body, quantity: "2" }, { ...s.body, warehouseId: null }, { ...s.body, productId: "bad" }, { ...s.body, language: "arabizi" }]) {
    await assert.rejects(s.prepare(body), (error) => error.status === 400);
  }
  await assert.rejects(s.prepare(s.body, "bad"), { code: "idempotency_key_required" }); assert.equal(s.reads, 0);
});

test("tampered stored quotes fail closed, and failed insertion cannot mutate a cart", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  s.records[0].quoteJson = "{}";
  await assert.rejects(getCartAdditionProposal(s.owner, proposal.id, s.config), { code: "cart_proposal_unavailable", status: 503 });
  s.failInsert = true;
  await assert.rejects(s.prepare(s.body, "prepare-key-2"), /synthetic insert failure/); assert.equal(s.records.length, 1);
});

test("missing, partial, sparse, expiring or case-folding proposal indexes fail closed without creating schema", async (t) => {
  const s = fixture(t);
  for (const indexes of [[], [{ key: { owner: 1, key: 1 }, unique: false }],
    [{ key: { owner: 1, key: 1 }, unique: true, sparse: true }],
    [{ key: { owner: 1, key: 1 }, unique: true, partialFilterExpression: { owner: { $exists: true } } }],
    [{ key: { owner: 1, key: 1 }, unique: true, collation: { locale: "en", strength: 2 } }],
    [{ key: { owner: 1, key: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]]) {
    s.indexes = indexes;
    await assert.rejects(s.prepare(), { code: "cart_proposal_store_unavailable", status: 503 });
  }
  assert.equal(s.writes, 0); assert.equal(s.cartReads, 0);
});

test("tampered canonical inputs cannot reuse an intact quote/fingerprint", async (t) => {
  const s = fixture(t); const { proposal } = await s.prepare();
  s.records[0].inputJson = JSON.stringify({ ...s.body, quantity: 3 });
  await assert.rejects(s.check(proposal), { code: "cart_proposal_unavailable", status: 503 });
});

test("an oversized calculated preview is rejected before proposal insertion", async (t) => {
  const s = fixture(t); s.product.name_en = "x".repeat(70000);
  await assert.rejects(s.prepare(), { code: "cart_preview_too_large", status: 413 });
  assert.equal(s.records.length, 0); assert.equal(s.writes, 0);
});

test("expiry during preparation or freshness calculation cannot produce a ready proposal", async (t) => {
  const s = fixture(t); const fixed = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: fixed });
  s.onCartRefresh = () => { t.mock.timers.tick(1000); };
  await assert.rejects(s.prepare(s.body, "prepare-key-1", { expiresAt: new Date(fixed + 500) }), { code: "cart_proposal_expired" });
  assert.equal(s.records.length, 0);
  s.onCartRefresh = null;
  const { proposal } = await s.prepare(s.body, "prepare-key-2", { expiresAt: new Date(Date.now() + 500) });
  s.onCartRefresh = () => { t.mock.timers.tick(1000); };
  await assert.rejects(s.check(proposal), { code: "cart_proposal_expired" });
});

test("confirmation stages one addition and receipt with all reads/writes in its owned transaction", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare(); const commits = s.commits;
  const result = await s.confirm(proposal);
  assert.equal(result.confirmed, true); assert.equal(result.duplicate, false);
  assert.equal(s.commits, commits + 1); assert.equal(s.session.active, false);
  assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.receipts.length, 1);
  assert.deepEqual(s.fences, ["User", "AssistantAccount", "AssistantChat"]);
  assert.equal(result.receipt.cartId, String(s.cart._id));
});

test("confirmation success is withheld until the transaction commit resolves", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  let release, entered;
  const pendingCommit = new Promise((resolve) => { release = resolve; });
  const commitEntered = new Promise((resolve) => { entered = resolve; });
  s.beforeCommit = () => { entered(); return pendingCommit; };
  let returned = false;
  const pending = s.confirm(proposal).then((value) => { returned = true; return value; });
  await commitEntered; assert.equal(returned, false); release();
  assert.equal((await pending).confirmed, true);
});

test("confirmation recovery returns the committed receipt after quote/source expiry and cart clearing", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  const first = await s.confirm(proposal); const fences = s.fences.length; const writes = s.cartWrites;
  s.cart.items = []; s.product.price = 999; s.source = null; s.chat.contextVersion++;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(proposal.expiresAt).getTime() + 1 });
  const recovered = await s.confirm(proposal);
  assert.equal(recovered.duplicate, true); assert.deepEqual(recovered.receipt, first.receipt);
  assert.equal(s.cartWrites, writes); assert.equal(s.fences.length, fences); assert.deepEqual(s.cart.items, []);
});

test("expired unexecuted proposals reject without a cart write", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  t.mock.timers.enable({ apis: ["Date"], now: new Date(proposal.expiresAt).getTime() + 1 });
  await assert.rejects(s.confirm(proposal), { code: "cart_proposal_expired" });
  assert.equal(s.cartWrites, 0); assert.equal(s.receipts.length, 0);
});

test("current access restrictions reject both first execution and receipt recovery", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  s.account.blocked = true; await assert.rejects(s.confirm(proposal), { code: "ai_restricted" });
  s.account.blocked = false; await s.confirm(proposal);
  s.user.phoneVerified = false; await assert.rejects(s.confirm(proposal), { code: "access_denied" });
  assert.equal(s.cartWrites, 1);
});

test("confirmation rejects foreign IDs, altered fingerprints, extra fields and corrupt retained data", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  await assert.rejects(s.confirm({ ...proposal, id: OTHER }), { code: "cart_proposal_not_found" });
  await assert.rejects(s.confirm(proposal, { fingerprint: "f".repeat(64) }), { code: "cart_proposal_changed" });
  await assert.rejects(s.confirm(proposal, { owner: OTHER }), { code: "invalid_request" });
  s.records[0].quoteJson = '{}';
  await assert.rejects(s.confirm(proposal), { code: "cart_proposal_unavailable" });
  assert.equal(s.cartWrites, 0);
});

test("changed context, price or source stock cannot be confirmed", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  s.chat.contextVersion++; await assert.rejects(s.confirm(proposal), { code: "context_changed" });
  s.chat.contextVersion--; s.product.price = 200; await assert.rejects(s.confirm(proposal), /Cart changed/);
  s.product.price = 100; s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 20 }];
  await assert.rejects(s.confirm(proposal), /not available/);
  assert.equal(s.cartWrites, 0); assert.equal(s.receipts.length, 0);
});

test("confirmation fences a saved pet's current health context and ownership", async (t) => {
  const s = fixture(t, { confirmation: true }); const petId = oid(); const subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, __v: 0, petOwner: s.owner, name: "Cat", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId;
  const { proposal } = await s.prepare();
  const result = await s.confirm(proposal);
  assert.equal(result.confirmed, true); assert.equal(s.pets[0].__v, 1);
  assert.deepEqual(s.fences, ["User", "AssistantAccount", "AssistantChat", "Pet"]);
  assert.equal(s.pets[0].name, "Cat"); assert.deepEqual(s.pets[0].chronic_conditions, []);
});

test("a new dietary warning prevents confirmation of an older food offer", async (t) => {
  const s = fixture(t, { confirmation: true }); const petId = oid(); const subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, __v: 0, petOwner: s.owner, name: "Cat", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId;
  s.product.category = F;
  const { proposal } = await s.prepare();
  s.warnings.push({ _id: oid(), owner: s.owner, subjectId, state: "active", version: 1, text: "No chicken" });
  await assert.rejects(s.confirm(proposal), { code: "food_review_required" });
  assert.equal(s.cartWrites, 0); assert.equal(s.receipts.length, 0);
});

test("a saved pet transferred to another owner cannot authorize an old proposal", async (t) => {
  const s = fixture(t, { confirmation: true }); const petId = oid(); const subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, __v: 0, petOwner: s.owner, name: "Cat", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId;
  const { proposal } = await s.prepare(); s.pets[0].petOwner = oid(OTHER);
  await assert.rejects(s.confirm(proposal), { code: "context_changed" });
  assert.equal(s.cartWrites, 0);
});

test("missing or invalid authorization fence versions fail closed without silent migration", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  for (const field of ["user", "account", "chat"]) {
    delete s[field].__v;
    await assert.rejects(s.confirm(proposal), { code: "cart_context_unavailable" });
    s[field].__v = 0;
  }
  assert.equal(s.cartWrites, 0);
});

test("a conditional authorization/context fence failure aborts before cart mutation", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  for (const name of ["User", "AssistantAccount", "AssistantChat"]) {
    s.failFence = name;
    await assert.rejects(s.confirm(proposal), { code: "context_changed" });
    assert.equal(s.user.__v, 0); assert.equal(s.account.__v, 0); assert.equal(s.chat.__v, 0);
  }
  assert.equal(s.cartWrites, 0);
});

test("receipt failure escapes the coordinator and its simulated transaction restores the cart/fences", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare(); s.failReceipt = true;
  await assert.rejects(s.confirm(proposal), /simulated receipt failure/);
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
  assert.equal(s.user.__v, 0); assert.equal(s.chat.__v, 0); assert.ok(s.aborts > 0);
});

test("expiry reached during staging aborts the simulated cart and receipt transaction", async (t) => {
  const s = fixture(t, { confirmation: true }); const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const { proposal } = await s.prepare(s.body, "prepare-expiry", { expiresAt: new Date(now + 500) });
  s.onCartRefresh = () => t.mock.timers.tick(1000);
  await assert.rejects(s.confirm(proposal), { code: "cart_proposal_expired" });
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
});

test("post-staging access/context changes propagate and abort instead of returning success", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  s.onCartRefresh = () => { s.account.blocked = true; };
  await assert.rejects(s.confirm(proposal), { code: "ai_restricted" });
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
});

test("simulated transaction retries recompute staging and retain one final addition", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare(); const attempts = s.attempts;
  s.retryOnce = true; const result = await s.confirm(proposal);
  assert.equal(result.confirmed, true); assert.equal(s.attempts, attempts + 2);
  assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.receipts.length, 1); assert.equal(s.user.__v, 1);
});

test("a simulated retry rechecks a newly blocked account before any second mutation", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare();
  s.retryOnce = true; s.onRetry = () => { s.account.blocked = true; };
  await assert.rejects(s.confirm(proposal), { code: "ai_restricted" });
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
});

test("a simulated committed addition with a lost response recovers without another addition", async (t) => {
  const s = fixture(t, { confirmation: true }); const { proposal } = await s.prepare(); s.loseResponse = true;
  await assert.rejects(s.confirm(proposal), /simulated unknown commit response/);
  const writes = s.cartWrites; assert.equal(s.receipts.length, 1);
  const result = await s.confirm(proposal);
  assert.equal(result.duplicate, true); assert.equal(s.cartWrites, writes); assert.equal(s.cart.items[0].quantity, 2);
});

test("public application preparation, confirmation and status retain the same owned state", async (t) => {
  const s = fixture(t, { confirmation: true });
  const prepared = await prepareCartProposal(s.owner, s.body, "api-key-1", s.apiConfig);
  assert.equal(prepared.proposal.status, "pending"); assert.equal(prepared.receipt, null); assert.equal(prepared.duplicate, false);
  assert.ok(new Date(prepared.proposal.expiresAt).getTime() <= Date.now() + 60000);
  const result = await confirmCartProposal(s.owner, prepared.proposal.id,
    { expectedVersion: prepared.proposal.version, fingerprint: prepared.proposal.fingerprint }, s.apiConfig);
  assert.equal(result.confirmed, true);
  const status = await getCartProposal(s.owner, prepared.proposal.id, {}, s.apiConfig);
  assert.equal(status.proposal.status, "confirmed"); assert.deepEqual(status.receipt, result.receipt);
  const repeated = await prepareCartProposal(s.owner, s.body, "api-key-1", s.apiConfig);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.proposal.status, "confirmed");
  assert.equal(s.cartWrites, 1); assert.equal(s.account.cartRateCount, 4);
  assert.equal(s.account.dayMessages, undefined, "cart actions do not consume a chat message");
});

test("public preparation caps lifetime to retained source expiry without renewing a replay", async (t) => {
  const s = fixture(t, { confirmation: true }); s.source.expiresAt = new Date(Date.now() + 10000);
  const first = await prepareCartProposal(s.owner, s.body, "api-short-source", s.apiConfig);
  assert.equal(first.proposal.expiresAt, s.source.expiresAt.toISOString());
  const repeated = await prepareCartProposal(s.owner, s.body, "api-short-source", s.apiConfig);
  assert.equal(repeated.proposal.expiresAt, first.proposal.expiresAt);
});

test("public rate admission shares durable owner counters across operations and provides reset", async (t) => {
  const s = fixture(t, { confirmation: true }); s.apiConfig.cartPolicy.rateMax = 1;
  const first = await prepareCartProposal(s.owner, s.body, "api-rate-key", s.apiConfig);
  await assert.rejects(getCartProposal(s.owner, first.proposal.id, {}, s.apiConfig),
    (error) => error.code === "cart_request_rate_limit" && error.status === 429 && error.retryAt instanceof Date);
  s.account.cartRateStart = new Date(Date.now() - 61000);
  assert.equal((await getCartProposal(s.owner, first.proposal.id, {}, s.apiConfig)).proposal.status, "pending");
  assert.equal(s.account.cartRateCount, 1);
});

test("disabled cart actions touch no store, and cart admission rejects restricted users", async (t) => {
  const s = fixture(t, { confirmation: true }); const reads = s.reads;
  await assert.rejects(prepareCartProposal(s.owner, s.body, "api-disabled", s.config), { code: "cart_actions_unavailable" });
  assert.equal(s.reads, reads); assert.equal(s.cartReads, 0);
  s.account.blocked = true;
  await assert.rejects(prepareCartProposal(s.owner, s.body, "api-blocked", s.apiConfig), { code: "ai_restricted" });
  assert.equal(s.account.cartRateStart, undefined);
});

test("public status can recover during an active chat run without reapplying the cart", async (t) => {
  const s = fixture(t, { confirmation: true }); const prepared = await prepareCartProposal(s.owner, s.body, "api-active-run", s.apiConfig);
  const result = await confirmCartProposal(s.owner, prepared.proposal.id,
    { expectedVersion: prepared.proposal.version, fingerprint: prepared.proposal.fingerprint }, s.apiConfig);
  s.account.activeRun = oid();
  const status = await getCartProposal(s.owner, prepared.proposal.id, {}, s.apiConfig);
  assert.deepEqual(status.receipt, result.receipt); assert.equal(s.cartWrites, 1);
});

test("public domain quote conflicts are actionable sanitized requote errors", async (t) => {
  const s = fixture(t, { confirmation: true }); s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 20 }];
  await assert.rejects(prepareCartProposal(s.owner, s.body, "api-out-stock", s.apiConfig), { code: "cart_requote_required", status: 409 });
  assert.equal(s.cartWrites, 0);
});

test("complete documented wire examples match actual public preparation and confirmation field shapes", async (t) => {
  const examples = JSON.parse(readFileSync(new URL("./fixtures/contracts/assistant-cart-examples.json", import.meta.url), "utf8"));
  const s = fixture(t, { confirmation: true });
  const prepared = await prepareCartProposal(s.owner, s.body, "api-documentation", s.apiConfig);
  const result = await confirmCartProposal(s.owner, prepared.proposal.id,
    { expectedVersion: prepared.proposal.version, fingerprint: prepared.proposal.fingerprint }, s.apiConfig);
  const shape = (value) => value === null ? "null" : Array.isArray(value) ? value.map(shape) :
    typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])])) : typeof value;
  assert.deepEqual(shape({ data: prepared }), shape(examples.prepareResponse));
  assert.deepEqual(shape({ data: result }), shape(examples.confirmResponse));
  const status = await getCartProposal(s.owner, prepared.proposal.id, {}, s.apiConfig);
  assert.deepEqual(shape({ data: status }), shape(examples.confirmedStatusResponse));
});
