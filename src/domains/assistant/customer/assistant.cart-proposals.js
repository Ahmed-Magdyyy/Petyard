import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { previewCartAdditionService, cartAdditionQuoteForComparison as materialQuote } from "../../cart/cart.service.js";
import { ProductModel } from "../../product/product.model.js";
import { UserModel } from "../../user/user.model.js";
import { PetModel } from "../../pet/pet.model.js";
import { accountStatus } from "../../../shared/constants/enums.js";
import { AssistantAccount, AssistantChat, AssistantDietaryWarning, AssistantMessage, AssistantRun } from "../shared/assistant.models.js";
import { AssistantCartProposal } from "../shared/assistant.cart-proposal.model.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { transaction, assertAccess } from "../shared/assistant.store.js";
import { customerRunFilter } from "../shared/assistant.purpose.js";
import { storedCatalogDto } from "../products/assistant.product-cards.js";
import { catalogDietaryRisk, classifyCatalogProduct } from "../products/assistant.catalog-policy.js";
import { normalizeOfferAttributes } from "../products/assistant.product-attributes.js";
import { subjectsFor, subjectFingerprint, PET_CONTEXT_FIELDS, subjectFromPet } from "./assistant.context.js";
import { recoverCartAdditionReceipt, stageCartAdditionWithReceipt } from "./assistant.cart-receipts.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxBytes = 65536;
const encode = (value) => {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) reject("cart_preview_too_large", 413);
  return json;
};

function input(body) {
  fields(body, ["sourceMessageId", "warehouseId", "productId", "variantId", "quantity", "language"]);
  if (!Number.isSafeInteger(body.quantity) || body.quantity < 1 || !["ar", "en"].includes(body.language)) reject("invalid_request");
  return { sourceMessageId: String(objectId(body.sourceMessageId)), warehouseId: String(objectId(body.warehouseId)),
    productId: String(objectId(body.productId)), variantId: body.variantId == null ? null : String(objectId(body.variantId)),
    quantity: body.quantity, language: body.language };
}

async function access(owner, config, session = null, { allowActiveRun = false } = {}) {
  requireEnabled(config);
  if (config.productSearchEnabled !== true) reject("product_search_unavailable", 503);
  const user = await UserModel.findById(owner).select("active phoneVerified deletedAt account_status __v").maxTimeMS(5000).session(session).lean();
  if (!user || !user.active || user.deletedAt) reject("authentication_required", 401);
  if (!user.phoneVerified || [accountStatus.BANNED, accountStatus.DELETED].includes(user.account_status)) reject("access_denied", 403);
  const account = await AssistantAccount.findOne({ owner }).maxTimeMS(5000).session(session).lean();
  if (!account) reject("assistant_account_not_found", 404);
  assertAccess(account, config);
  if (account.activeRun && !allowActiveRun) reject("active_request", 409);
  return { user, account };
}

// Separate counters keep cart recovery requests from consuming chat-message quota.
export async function admitCartRequest(ownerValue, config) {
  const owner = objectId(String(ownerValue));
  return transaction(async (session) => {
    const { account } = await access(owner, config, session, { allowActiveRun: true });
    const now = new Date();
    const reset = account.cartRateStart ? new Date(new Date(account.cartRateStart).getTime() + config.cartPolicy.rateWindowSeconds * 1000) : now;
    const count = reset <= now ? 0 : (account.cartRateCount ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(reset.getTime())) reject("cart_rate_unavailable", 503);
    if (count >= config.cartPolicy.rateMax) reject("cart_request_rate_limit", 429, reset);
    const result = await AssistantAccount.updateOne({ _id: account._id, owner }, {
      $set: { cartRateStart: reset <= now ? now : account.cartRateStart, cartRateCount: count + 1 },
    }, { session });
    if (result.matchedCount !== 1) reject("context_changed", 409);
  });
}

async function storeReady() {
  let indexes;
  try { indexes = await AssistantCartProposal.collection.indexes(); } catch { reject("cart_proposal_store_unavailable", 503); }
  const unique = indexes.some((entry) => JSON.stringify(entry.key) === JSON.stringify({ owner: 1, key: 1 }) &&
    entry.unique === true && !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple"));
  if (!unique || indexes.some((entry) => entry.expireAfterSeconds !== undefined)) reject("cart_proposal_store_unavailable", 503);
}

async function scope(owner, args, config, session = null) {
  const now = new Date();
  const source = await AssistantMessage.findOne({ _id: objectId(args.sourceMessageId), owner, role: "assistant", expiresAt: { $gt: now } })
    .maxTimeMS(5000).session(session).lean();
  if (!source) reject("source_message_not_found", 404);
  const run = await AssistantRun.findOne(customerRunFilter({ _id: source.run, owner, chat: source.chat,
    status: "completed", responseMessage: source._id })).maxTimeMS(5000).session(session).lean();
  const chat = await AssistantChat.findOne({ _id: source.chat, owner }).maxTimeMS(5000).session(session).lean();
  const catalog = storedCatalogDto(source.catalogJson);
  if (!run || !chat || (chat.activeSubject ?? null) !== (source.subjectId ?? null) ||
      catalog?.status !== "results" || catalog.subjectId !== (source.subjectId ?? null) ||
      catalog.requestedWarehouseId !== args.warehouseId || catalog.effectiveWarehouseId !== args.warehouseId || catalog.rerouted) reject("context_changed", 409);
  const card = catalog.products.find((entry) => entry.id === args.productId && entry.type !== "BUNDLE" && entry.inStock);
  if (!card) reject("product_not_in_source", 409);
  if (card.type === "SIMPLE" ? args.variantId !== null : args.variantId === null) reject("invalid_request");
  if (card.matchingOffer && card.matchingOffer.variantId !== args.variantId) reject("variant_not_in_source", 409);
  const subjects = await subjectsFor(owner, chat, config, session, now);
  const subject = source.subjectId ? subjects.find((entry) => entry.id === source.subjectId) : null;
  if (source.subjectId && !subject) reject("context_changed", 409);
  const warnings = source.subjectId ? await AssistantDietaryWarning.find({ owner, subjectId: source.subjectId, state: "active" })
    .sort({ _id: 1 }).limit(config.maxMemoryEntries + 1).maxTimeMS(5000).session(session).lean() : [];
  if (warnings.length > config.maxMemoryEntries) reject("context_too_large", 413);
  const product = await ProductModel.findById(args.productId).select("type isActive category subcategory name_en name_ar variants._id variants.options").maxTimeMS(5000).session(session).lean();
  if (!product || product.isActive !== true) reject("product_not_found", 404);
  if (product.type !== card.type) reject("context_changed", 409);
  if (card.matchingOffer) {
    const variant = card.type === "VARIANT" ? product.variants?.find((entry) => String(entry._id) === args.variantId) : null;
    if (card.type === "VARIANT" && !variant) reject("source_offer_changed", 409);
    const attributes = normalizeOfferAttributes(product, variant);
    const mass = attributes.get("weight");
    if ((card.matchingOffer.packageWeightGrams !== null && (mass?.state !== "known" || mass.value !== card.matchingOffer.packageWeightGrams)) ||
        card.matchingOffer.options.some((entry) => attributes.get(entry.name)?.state !== "known" || String(attributes.get(entry.name).value) !== entry.value)) {
      reject("source_offer_changed", 409);
    }
  }
  if (["known", "unknown"].includes(catalogDietaryRisk(subject, warnings)) && classifyCatalogProduct(product, config.catalogClassification) !== "nonfood") {
    reject("food_review_required", 409);
  }
  return { productType: card.type, sourceExpiresAt: source.expiresAt, chat, subject, binding: hash({ source: String(source._id), catalog: source.catalogJson,
    chat: String(chat._id), contextVersion: chat.contextVersion, subject: subjectFingerprint(subject),
    warnings: warnings.map((entry) => ({ id: String(entry._id), version: entry.version, text: entry.text })), config: config.signature }) };
}

const fingerprint = (record, quote) => hash({ id: String(record._id), owner: String(record.owner), requestHash: record.requestHash,
  binding: record.binding, version: record.version, expiresAt: new Date(record.expiresAt).toISOString(), quote: materialQuote(quote) });

function dto(record) {
  try {
    if (Buffer.byteLength(record.quoteJson) > maxBytes) throw new Error();
    if (typeof record.inputJson !== "string" || Buffer.byteLength(record.inputJson) > 2048) throw new Error();
    if (hash(input(JSON.parse(record.inputJson))) !== record.requestHash) throw new Error();
    const quote = JSON.parse(record.quoteJson);
    if (fingerprint(record, quote) !== record.fingerprint) throw new Error();
    return { id: String(record._id), version: record.version, fingerprint: record.fingerprint,
      status: new Date(record.expiresAt) <= new Date() ? "expired" : "pending", expiresAt: new Date(record.expiresAt).toISOString(), quote };
  } catch { reject("cart_proposal_unavailable", 503); }
}

// Internal preparation only. No HTTP/model tool or store initialization is registered by this module.
export async function prepareCartAdditionProposal(ownerValue, body, key, config, { expiresAt, boundToSource = false } = {}) {
  const owner = objectId(String(ownerValue)); const args = input(body);
  if (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) reject("idempotency_key_required");
  await access(owner, config);
  await storeReady();
  const requestHash = hash(args);
  const existing = await AssistantCartProposal.findOne({ owner, key }).maxTimeMS(5000).lean();
  if (existing) {
    if (existing.requestHash !== requestHash) reject("idempotency_conflict", 409);
    return { proposal: dto(existing), duplicate: true };
  }
  const initial = await scope(owner, args, config);
  let until = expiresAt instanceof Date ? new Date(expiresAt) : null;
  if (boundToSource && until && new Date(initial.sourceExpiresAt) < until) until = new Date(initial.sourceExpiresAt);
  if (!until || !Number.isFinite(until.getTime()) || until <= new Date() || until > initial.sourceExpiresAt) reject("cart_proposal_expiry_required", 503);
  const quote = await previewCartAdditionService({ userId: String(owner), warehouseId: args.warehouseId, productId: args.productId,
    productType: initial.productType, variantId: args.variantId, quantity: args.quantity, lang: args.language });
  await access(owner, config);
  if ((await scope(owner, args, config)).binding !== initial.binding) reject("context_changed", 409);
  const record = { _id: new mongoose.Types.ObjectId(), owner, key, requestHash, inputJson: JSON.stringify(args), binding: initial.binding,
    quoteJson: encode(quote), version: 1, expiresAt: until };
  record.fingerprint = fingerprint(record, quote);
  return transaction(async (session) => {
    const raced = await AssistantCartProposal.findOne({ owner, key }).session(session).lean();
    if (raced) {
      if (raced.requestHash !== requestHash) reject("idempotency_conflict", 409);
      return { proposal: dto(raced), duplicate: true };
    }
    if (until <= new Date()) reject("cart_proposal_expired", 409);
    const [saved] = await AssistantCartProposal.create([record], { session });
    return { proposal: dto(saved), duplicate: false };
  });
}

export async function getCartAdditionProposal(ownerValue, idValue, config) {
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  await access(owner, config);
  await storeReady();
  const record = await AssistantCartProposal.findOne({ _id: id, owner }).maxTimeMS(5000).lean();
  if (!record) reject("cart_proposal_not_found", 404);
  return { proposal: dto(record) };
}

const receiptOperation = (owner, record, proposal, args) => ({ owner: String(owner), proposalId: String(record._id), proposalFingerprint: record.fingerprint,
  addition: { warehouseId: args.warehouseId, productId: args.productId, productType: proposal.quote.addition.productType,
    variantId: args.variantId, quantity: args.quantity, language: args.language }, expectedQuote: proposal.quote });

export async function getCartAdditionState(ownerValue, idValue, config) {
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  await storeReady();
  return transaction(async (session) => {
    await access(owner, config, session, { allowActiveRun: true });
    const record = await AssistantCartProposal.findOne({ _id: id, owner }).maxTimeMS(5000).session(session).lean();
    if (!record) reject("cart_proposal_not_found", 404);
    const proposal = dto(record);
    const recovered = await recoverCartAdditionReceipt(receiptOperation(owner, record, proposal, input(JSON.parse(record.inputJson))), { session });
    return { proposal: { ...proposal, status: recovered ? "confirmed" : proposal.status }, receipt: recovered?.receipt ?? null };
  });
}

// This is a freshness check, not confirmation/execution; the future writer must revalidate atomically.
export async function revalidateCartAdditionProposal(ownerValue, idValue, body, config) {
  fields(body, ["expectedVersion", "fingerprint"]);
  if (body.expectedVersion !== 1 || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(body.fingerprint)) reject("invalid_request");
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  await access(owner, config);
  await storeReady();
  const record = await AssistantCartProposal.findOne({ _id: id, owner }).maxTimeMS(5000).lean();
  if (!record) reject("cart_proposal_not_found", 404);
  const proposal = dto(record);
  if (record.version !== body.expectedVersion || record.fingerprint !== body.fingerprint) reject("cart_proposal_changed", 409);
  if (proposal.status === "expired") reject("cart_proposal_expired", 409);
  const args = input(JSON.parse(record.inputJson));
  const initial = await scope(owner, args, config);
  if (initial.binding !== record.binding) reject("context_changed", 409);
  const quote = await previewCartAdditionService({ userId: String(owner), warehouseId: args.warehouseId, productId: args.productId,
    productType: initial.productType, variantId: args.variantId, quantity: args.quantity, lang: args.language });
  await access(owner, config);
  if ((await scope(owner, args, config)).binding !== record.binding || hash(materialQuote(quote)) !== hash(materialQuote(proposal.quote))) reject("cart_proposal_changed", 409);
  if (new Date(record.expiresAt) <= new Date()) reject("cart_proposal_expired", 409);
  return { proposal, ready: true, executed: false };
}

async function fence(model, snapshot, session) {
  if (!snapshot?._id || !Number.isSafeInteger(snapshot.__v) || snapshot.__v < 0 || snapshot.__v >= Number.MAX_SAFE_INTEGER) {
    reject("cart_context_unavailable", 503);
  }
  const filter = { _id: snapshot._id };
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "_id") filter[key] = { $eq: value, $exists: true };
  }
  // A real write holds the record against concurrent blocks/context edits until commit.
  const result = await model.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) reject("context_changed", 409);
}

// Internal coordinator only; the eventual route must still authenticate the caller.
export async function confirmCartAdditionProposal(ownerValue, idValue, body, config) {
  requireEnabled(config);
  fields(body, ["expectedVersion", "fingerprint"]);
  if (body.expectedVersion !== 1 || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(body.fingerprint)) reject("invalid_request");
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  await storeReady();
  return transaction(async (session) => {
    const authorization = await access(owner, config, session);
    const record = await AssistantCartProposal.findOne({ _id: id, owner }).maxTimeMS(5000).session(session).lean();
    if (!record) reject("cart_proposal_not_found", 404);
    const proposal = dto(record);
    if (record.version !== body.expectedVersion || record.fingerprint !== body.fingerprint) reject("cart_proposal_changed", 409);
    const args = input(JSON.parse(record.inputJson));
    const operation = receiptOperation(owner, record, proposal, args);
    const recovered = await recoverCartAdditionReceipt(operation, { session });
    if (recovered) return { ...recovered, confirmed: true };
    if (proposal.status === "expired") reject("cart_proposal_expired", 409);
    const context = await scope(owner, args, config, session);
    if (context.binding !== record.binding) reject("context_changed", 409);
    await fence(UserModel, authorization.user, session);
    await fence(AssistantAccount, authorization.account, session);
    await fence(AssistantChat, context.chat, session);
    if (context.subject?.saved) {
      const pet = await PetModel.findOne({ _id: objectId(context.subject.id.slice(4)), petOwner: owner })
        .select(`petOwner ${PET_CONTEXT_FIELDS} __v`).maxTimeMS(5000).session(session).lean();
      if (!pet || subjectFingerprint(subjectFromPet(pet)) !== subjectFingerprint(context.subject)) reject("context_changed", 409);
      await fence(PetModel, pet, session);
    }
    const result = await stageCartAdditionWithReceipt(operation, { session });
    await access(owner, config, session);
    if ((await scope(owner, args, config, session)).binding !== record.binding) reject("context_changed", 409);
    if (new Date(record.expiresAt) <= new Date() || new Date(context.sourceExpiresAt) <= new Date()) reject("cart_proposal_expired", 409);
    return { ...result, confirmed: true };
  });
}
