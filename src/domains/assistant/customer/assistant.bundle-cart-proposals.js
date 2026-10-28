import { storedCatalogDto } from "../products/assistant.product-cards.js";
import { customerRunFilter } from "../shared/assistant.purpose.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { AssistantCartProposal } from "../shared/assistant.cart-proposal.model.js";
import { AssistantAccount, AssistantChat, AssistantDietaryWarning, AssistantMessage, AssistantRun } from "../shared/assistant.models.js";
import { UserModel } from "../../user/user.model.js";
import { PetModel } from "../../pet/pet.model.js";
import { ProductModel } from "../../product/product.model.js";
import { requireBundleUser } from "../../bundle/bundle.access.js";
import { previewBundleCartChange, stageBundleCartChangeWithReceipt, recoverBundleCartChange } from "../../bundle/bundle.cart-transaction.js";
import { requireCartActions } from "../shared/assistant.config.js";
import { assertAccess } from "../shared/assistant.store.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { subjectsFor, subjectFingerprint, subjectFromPet, PET_CONTEXT_FIELDS } from "./assistant.context.js";
import { catalogDietaryRisk, classifyCatalogProduct } from "../products/assistant.catalog-policy.js";
import { bundleCartReviewInput, bundleCartReviewConfirmation } from "./assistant.bundle-cart.validation.js";
import { assertBundleCartProposalStore as ready, runBundleCartReviewTransaction as transact } from "../../bundle/bundle.cart-review-store.js";

const kind = "bundle_cart_review_v1";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function encode(value, max = 65536) {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || Buffer.byteLength(json) > max) reject("bundle_cart_review_too_large", 413);
  return json;
}
function enabled(config) {
  requireCartActions(config);
  if (config.bundleCartEnabled !== true) reject("bundle_cart_actions_unavailable", 503);
}
async function access(owner, config, session, allowActiveRun = false) {
  enabled(config);
  const user = await UserModel.findById(owner).select("_id role active phoneVerified deletedAt account_status __v").maxTimeMS(5000).session(session).lean();
  if (String(user?._id) !== String(owner)) reject("authentication_required", 401);
  requireBundleUser(user);
  const account = await AssistantAccount.findOne({ owner }).maxTimeMS(5000).session(session).lean();
  if (!account) reject("assistant_account_not_found", 404);
  assertAccess(account, config);
  if (account.activeRun && !allowActiveRun) reject("active_request", 409);
  return { user, account };
}
async function context(owner, authorization, config, session, request = {}) {
  const chat = await AssistantChat.findOne({ owner }).maxTimeMS(5000).session(session).lean();
  if (!chat || !Number.isSafeInteger(chat.contextVersion) || chat.contextVersion < 0) reject("context_changed", 409);
  const subjects = await subjectsFor(owner, chat, config, session);
  const subject = chat.activeSubject ? subjects.find(row => row.id === chat.activeSubject) : null;
  if (chat.activeSubject && !subject) reject("context_changed", 409);
  const warnings = subject ? await AssistantDietaryWarning.find({ owner, subjectId: subject.id, state: "active" })
    .sort({ _id: 1 }).limit(config.maxMemoryEntries + 1).maxTimeMS(5000).session(session).lean() : [];
  if (warnings.length > config.maxMemoryEntries) reject("context_too_large", 413);
  let source = null;
  if (request.sourceMessageId) {
    source = await AssistantMessage.findOne({ _id: objectId(request.sourceMessageId), owner, chat: chat._id, role: "assistant", expiresAt: { $gt: new Date() } })
      .maxTimeMS(5000).session(session).lean();
    if (!source) reject("source_message_not_found", 404);
    const run = await AssistantRun.findOne(customerRunFilter({ _id: source.run, owner, chat: chat._id, status: "completed", responseMessage: source._id }))
      .maxTimeMS(5000).session(session).lean();
    const catalog = storedCatalogDto(source.catalogJson);
    const card = catalog?.products.find(row => row.type === "BUNDLE" && row.id === request.change.bundleId && row.inStock);
    if (!run || request.change.action !== "add" || catalog?.status !== "results" || (source.subjectId ?? null) !== (chat.activeSubject ?? null) ||
        catalog.subjectId !== (source.subjectId ?? null) || catalog.requestedWarehouseId !== request.warehouseId ||
        catalog.effectiveWarehouseId !== request.warehouseId || catalog.rerouted || !card || card.revision !== request.change.expectedRevision) reject("context_changed", 409);
  }
  const binding = hash({ kind, ...(source ? { source: String(source._id), catalog: source.catalogJson } : {}), chat: String(chat._id), contextVersion: chat.contextVersion, subject: subjectFingerprint(subject),
    warnings: warnings.map(row => ({ id: String(row._id), version: row.version, text: row.text })),
    restrictionVersion: authorization.account.restrictionVersion ?? 0, config: config.signature });
  return { chat, subject, warnings, binding, sourceExpiresAt: source?.expiresAt };
}
async function dietary(quote, scope, config, session) {
  if (!["known", "unknown"].includes(catalogDietaryRisk(scope.subject, scope.warnings))) return;
  const increasedOrdinary = ["ordinary_add", "ordinary_set"].includes(quote.action) ? quote.ordinaryItemsAfter.filter(row =>
    row.quantity > (quote.ordinaryItemsBefore.find(before => before.id === row.id)?.quantity ?? 0)) : [];
  const ids = [...new Set([...quote.groups.flatMap(group => group.components.map(row => row.productId)), ...increasedOrdinary.map(row => row.productId)])];
  if (!ids.length) return;
  const products = await ProductModel.find({ _id: { $in: ids.map(objectId) }, isActive: true })
    .select("_id category subcategory isActive").maxTimeMS(5000).session(session).lean();
  if (ids.some(id => {
    const matches = products.filter(row => String(row._id) === id);
    return matches.length !== 1 || matches[0].isActive !== true || classifyCatalogProduct(matches[0], config.catalogClassification) !== "nonfood";
  })) reject("food_review_required", 409);
}
const fingerprint = record => hash({ kind, id: String(record._id), owner: String(record.owner), requestHash: record.requestHash,
  binding: record.binding, version: record.version, expiresAt: new Date(record.expiresAt).toISOString(), quoteJson: record.quoteJson, inputJson: record.inputJson });
function retained(record) {
  try {
    if (record.version !== 1 || typeof record.inputJson !== "string" || Buffer.byteLength(record.inputJson) > 2048 ||
        typeof record.quoteJson !== "string" || Buffer.byteLength(record.quoteJson) > 65536) throw Error();
    const envelope = JSON.parse(record.inputJson);
    if (envelope.kind !== kind) throw Error();
    const request = bundleCartReviewInput(envelope.request);
    if (hash({ kind, request }) !== record.requestHash || !Number.isFinite(new Date(record.expiresAt).getTime()) || fingerprint(record) !== record.fingerprint) throw Error();
    const { sourceMessageId, ...cartRequest } = request;
    const args = { ...cartRequest, change: { ...request.change,
      ...(request.change.action === "add" ? { newGroupId: String(objectId(envelope.groupId)) } : {}),
      ...(request.change.action === "ordinary_add" ? { newItemId: String(objectId(envelope.itemId)) } : {}) } };
    const quote = JSON.parse(record.quoteJson);
    if (quote.ownerId !== String(record.owner) || quote.warehouseId !== request.warehouseId || quote.action !== request.change.action) throw Error();
    return { request, args, proposal: { id: String(record._id), version: 1, fingerprint: record.fingerprint,
      expiresAt: new Date(record.expiresAt).toISOString(), status: new Date(record.expiresAt) <= new Date() ? "expired" : "pending", quote } };
  } catch { reject("bundle_cart_review_unavailable", 503); }
}
function operation(record, stored) {
  return { proposalId: String(record._id), proposalFingerprint: record.fingerprint, quote: stored.proposal.quote };
}
async function load(owner, id, session) {
  const record = await AssistantCartProposal.findOne({ _id: id, owner }).maxTimeMS(5000).session(session).lean();
  if (!record) reject("bundle_cart_review_not_found", 404);
  return { record, ...retained(record) };
}
async function fence(Model, snapshot, session) {
  if (!snapshot?._id || !Number.isSafeInteger(snapshot.__v) || snapshot.__v < 0 || snapshot.__v >= Number.MAX_SAFE_INTEGER) reject("bundle_cart_context_unavailable", 503);
  const result = await Model.collection.updateOne({ _id: snapshot._id, $expr: { $eq: ["$$ROOT", { $literal: snapshot }] } },
    { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) reject("context_changed", 409);
}
async function fenceContext(owner, authorization, scope, session) {
  await fence(AssistantAccount, authorization.account, session);
  await fence(AssistantChat, scope.chat, session);
  if (scope.subject?.saved) {
    const pet = await PetModel.findOne({ _id: objectId(scope.subject.id.slice(4)), petOwner: owner })
      .select(`petOwner ${PET_CONTEXT_FIELDS} __v`).maxTimeMS(5000).session(session).lean();
    if (!pet || subjectFingerprint(subjectFromPet(pet)) !== subjectFingerprint(scope.subject)) reject("context_changed", 409);
    // The selected pet projection is fenced field-by-field; it is not a full document.
    if (!Number.isSafeInteger(pet.__v) || pet.__v < 0 || pet.__v >= Number.MAX_SAFE_INTEGER) reject("bundle_cart_context_unavailable", 503);
    const filter = { _id: pet._id, __v: pet.__v, petOwner: owner };
    for (const key of PET_CONTEXT_FIELDS.split(" ")) filter[key] = Object.hasOwn(pet, key) ? { $eq: pet[key], $exists: true } : { $exists: false };
    const result = await PetModel.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) reject("context_changed", 409);
  }
}

// Saved chat suggestions additionally bind their message, completed customer run and catalog snapshot.
export async function prepareBundleCartReview(actor, body, key, config) {
  enabled(config);
  const owner = objectId(requireBundleUser(actor)), request = bundleCartReviewInput(body);
  if (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) reject("idempotency_key_required");
  await ready();
  const storedKey = request.sourceMessageId ? key : `bundle:v1:${hash(key)}`, requestHash = hash({ kind, request });
  const groupId = request.change.action === "add" ? String(new mongoose.Types.ObjectId()) : null;
  const itemId = request.change.action === "ordinary_add" ? String(new mongoose.Types.ObjectId()) : null;
  return transact(async session => {
    const authorization = await access(owner, config, session);
    const existing = await AssistantCartProposal.findOne({ owner, key: storedKey }).maxTimeMS(5000).session(session).lean();
    if (existing) {
      if (existing.requestHash !== requestHash) reject("idempotency_conflict", 409);
      return { proposal: retained(existing).proposal, duplicate: true };
    }
    const scope = await context(owner, authorization, config, session, request);
    const { sourceMessageId, ...cartRequest } = request;
    const args = { ...cartRequest, change: { ...request.change, ...(groupId ? { newGroupId: groupId } : {}), ...(itemId ? { newItemId: itemId } : {}) } };
    const quote = await previewBundleCartChange(authorization.user, args, { session });
    await dietary(quote, scope, config, session);
    const expiresAt = new Date(Math.min(Date.now() + config.cartPolicy.proposalSeconds * 1000,
      scope.subject?.expiresAt ? new Date(scope.subject.expiresAt).getTime() : Infinity,
      scope.sourceExpiresAt ? new Date(scope.sourceExpiresAt).getTime() : Infinity));
    const record = { _id: new mongoose.Types.ObjectId(), owner, key: storedKey, requestHash,
      inputJson: encode({ kind, request, groupId, ...(itemId ? { itemId } : {}) }, 2048), quoteJson: encode(quote), binding: scope.binding, version: 1, expiresAt };
    record.fingerprint = fingerprint(record);
    await fenceContext(owner, authorization, scope, session);
    if (expiresAt <= new Date()) reject("bundle_cart_review_expired", 409);
    const [saved] = await AssistantCartProposal.create([record], { session });
    return { proposal: retained(saved).proposal, duplicate: false };
  });
}

export async function getBundleCartReviewState(actor, idValue, config) {
  enabled(config); const owner = objectId(requireBundleUser(actor)), id = objectId(idValue); await ready();
  return transact(async session => {
    const authorization = await access(owner, config, session, true), stored = await load(owner, id, session);
    const saved = await recoverBundleCartChange(authorization.user, stored.args, operation(stored.record, stored), { session });
    return { proposal: { ...stored.proposal, status: saved ? "confirmed" : stored.proposal.status }, receipt: saved?.receipt ?? null };
  });
}

export async function confirmBundleCartReview(actor, idValue, body, config) {
  enabled(config); const owner = objectId(requireBundleUser(actor)), id = objectId(idValue), expected = bundleCartReviewConfirmation(body); await ready();
  return transact(async session => {
    const authorization = await access(owner, config, session, true), stored = await load(owner, id, session);
    if (stored.proposal.version !== expected.expectedVersion || stored.proposal.fingerprint !== expected.fingerprint) reject("bundle_cart_review_changed", 409);
    const saved = await recoverBundleCartChange(authorization.user, stored.args, operation(stored.record, stored), { session });
    if (saved) return { ...saved, confirmed: true };
    if (expected.warehouseId !== stored.args.warehouseId) reject("bundle_cart_warehouse_changed", 409);
    if (authorization.account.activeRun) reject("active_request", 409);
    if (stored.proposal.status === "expired") reject("bundle_cart_review_expired", 409);
    const scope = await context(owner, authorization, config, session, stored.request);
    if (scope.binding !== stored.record.binding) reject("context_changed", 409);
    await dietary(stored.proposal.quote, scope, config, session);
    await fenceContext(owner, authorization, scope, session);
    const result = await stageBundleCartChangeWithReceipt(authorization.user, stored.args, operation(stored.record, stored), { session });
    enabled(config);
    if (new Date(stored.record.expiresAt) <= new Date() || scope.subject?.expiresAt && new Date(scope.subject.expiresAt) <= new Date()) reject("bundle_cart_review_expired", 409);
    return { ...result, confirmed: true };
  });
}
