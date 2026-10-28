import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { CartModel } from "../cart/cart.model.js";
import { refreshOrdinaryCartSliceForBundle, cartItemSnapshots } from "../cart/cart.service.js";
import { UserModel } from "../user/user.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ProductModel } from "../product/product.model.js";
import { ManualBundle } from "./bundle.model.js";
import { AssistantCartReceipt } from "../assistant/shared/assistant.cart-receipt.model.js";
import { requireBundleUser } from "./bundle.access.js";
import { bundleId, bundleInputError, exactBundleFields } from "./bundle.draft-input.js";
import { calculateBundleCartChange, inspectBundleCartState } from "./bundle.cart-state.js";
import { bundleCartEditActions, normalizeBundleCartEdit, prepareBundleCartEdit, fenceBundleCartAddress } from "./bundle.cart-edits.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";
import { isWarehouseOperational } from "../warehouse/warehouse.fulfillment.js";
import { assertReorderedOrdinaryItems, fenceBundleReorderOrder } from "./bundle.reorder.js";

const maxBytes = 65536;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oid = value => new mongoose.Types.ObjectId(bundleId(value));
const fail = (message, code = "BUNDLE_CART_REVIEW_REQUIRED", status = 409) => bundleInputError(message, code, status);
function encode(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maxBytes) fail("Bundle review is too large", "BUNDLE_CART_REVIEW_TOO_LARGE", 413);
  return json;
}
function transaction(session) {
  if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) fail("An active caller transaction is required", "BUNDLE_CART_TRANSACTION_REQUIRED", 503);
}
function request(actor, args) {
  const owner = bundleId(requireBundleUser(actor));
  exactBundleFields(args, ["warehouseId", "language", "change"]);
  const warehouseId = bundleId(args.warehouseId);
  if (!["en", "ar"].includes(args.language)) fail("Invalid language", "BUNDLE_INVALID_REQUEST", 400);
  // Use the same strict action guards before any source reads, including on receipt recovery.
  const change = args.change;
  if (change && bundleCartEditActions.includes(change.action)) return { owner, warehouseId, language: args.language, change: normalizeBundleCartEdit(change) };
  if (!change || !["add", "set", "remove"].includes(change.action)) fail("Invalid cart action", "BUNDLE_INVALID_REQUEST", 400);
  exactBundleFields(change, change.action === "add" ? ["action", "bundleId", "expectedRevision", "quantity", "newGroupId"] :
    change.action === "set" ? ["action", "groupId", "quantity"] : ["action", "groupId"]);
  if (change.action !== "remove" && (!Number.isSafeInteger(change.quantity) || change.quantity < 1)) fail("Invalid quantity", "BUNDLE_INVALID_REQUEST", 400);
  let normalized;
  if (change.action === "add") {
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1) fail("Invalid revision", "BUNDLE_INVALID_REQUEST", 400);
    normalized = { action: "add", bundleId: bundleId(change.bundleId), expectedRevision: change.expectedRevision,
      quantity: change.quantity, newGroupId: bundleId(change.newGroupId) };
  } else normalized = { action: change.action, groupId: bundleId(change.groupId), ...(change.action === "set" ? { quantity: change.quantity } : {}) };
  return { owner, warehouseId, language: args.language, change: normalized };
}
async function userFor(owner, session) {
  const user = await UserModel.findById(oid(owner)).select("_id role active phoneVerified deletedAt account_status __v")
    .maxTimeMS(5000).session(session).lean();
  if (String(user?._id).toLowerCase() !== owner) fail("Authentication required", "BUNDLE_ACCESS_DENIED", 401);
  requireBundleUser(user); return user;
}
async function fenceUser(user, session) {
  const version = user.__v;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER)) fail("Account context unavailable", "BUNDLE_CART_CONTEXT_UNAVAILABLE", 503);
  const filter = { _id: user._id, __v: version === undefined ? { $exists: false } : version };
  for (const key of ["role", "active", "phoneVerified", "deletedAt", "account_status"]) {
    filter[key] = Object.hasOwn(user, key) ? { $eq: user[key], $exists: true } : { $exists: false };
  }
  const result = await UserModel.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("Account context changed");
}
export { userFor as loadBundleCartUser, fenceUser as fenceBundleCartUser };
async function readiness() {
  let cartIndexes, receiptIndexes;
  try { cartIndexes = await CartModel.collection.indexes(); receiptIndexes = await AssistantCartReceipt.collection.indexes(); }
  catch { fail("Cart storage is not ready", "BUNDLE_CART_STORE_UNAVAILABLE", 503); }
  const simple = row => !row.sparse && !row.partialFilterExpression && (!row.collation || row.collation.locale === "simple");
  const unique = cartIndexes.some(row => JSON.stringify(row.key) === '{"user":1}' && row.unique === true && !row.sparse &&
    (!row.collation || row.collation.locale === "simple") &&
    (!row.partialFilterExpression || JSON.stringify(row.partialFilterExpression) === '{"user":{"$type":"objectId"}}'));
  const identity = receiptIndexes.some(row => row.name === "_id_" && JSON.stringify(row.key) === '{"_id":1}' && simple(row));
  if (!unique || !identity || [...cartIndexes, ...receiptIndexes].some(row => row.expireAfterSeconds !== undefined)) {
    fail("Cart storage is not ready", "BUNDLE_CART_STORE_UNAVAILABLE", 503);
  }
}
async function sources(input, session, { forView = false } = {}) {
  const user = await userFor(input.owner, session);
  const raw = await CartModel.findOne({ user: oid(input.owner) }).maxTimeMS(5000).session(session).lean();
  if (raw && (String(raw.user).toLowerCase() !== input.owner || raw.guestId != null ||
      !forView && !["rebind", "address"].includes(input.change?.action) && String(raw.warehouse).toLowerCase() !== input.warehouseId)) fail("Cart ownership or warehouse changed");
  if (raw?.bundles !== undefined && (!Array.isArray(raw.bundles) || raw.bundles.some(row => !row || row.constructor !== Object))) fail("Saved bundle groups are unavailable");
  const warehouse = await WarehouseModel.findById(oid(input.warehouseId)).select("_id active fulfillment").maxTimeMS(5000).session(session).lean();
  if (String(warehouse?._id).toLowerCase() !== input.warehouseId || !isWarehouseOperational(warehouse)) fail("Selected warehouse is unavailable", "BUNDLE_WAREHOUSE_UNAVAILABLE");
  const edit = bundleCartEditActions.includes(input.change?.action) ? await prepareBundleCartEdit(raw, input, session) : null;
  const slice = raw ? await refreshOrdinaryCartSliceForBundle(edit?.candidate ?? raw, input.warehouseId, input.language, { session }) :
    { items: [], before: [], after: [], removedItems: [] };
  if (edit) {
    slice.before = cartItemSnapshots(CartModel.hydrate({ ...raw, bundles: undefined }));
    if (edit.targetItemId && !slice.items.some(row => String(row._id) === edit.targetItemId && row.quantity === edit.targetQuantity)) fail("Requested ordinary item is unavailable");
    assertReorderedOrdinaryItems(edit, slice.items);
  }
  const definitionIds = [...new Set([...((edit?.candidate ?? raw)?.bundles ?? []).filter(row => input.change?.action !== "remove" || row.id !== input.change.groupId).map(row => row.bundleId),
    ...(input.change?.action === "add" ? [input.change.bundleId] : [])].map(value => bundleId(value)))];
  let definitions = definitionIds.length ? await ManualBundle.find({ _id: { $in: definitionIds.map(oid) } })
    .select("_id origin aiEvidenceJson status revision name_en name_ar components pricePiastres").maxTimeMS(5000).session(session).lean() : [];
  if (!Array.isArray(definitions)) fail("Bundle definitions are unavailable");
  if (forView) definitions = definitions.filter(row => {
    if (!row || !Array.isArray(row.components) || row.components.some(component => !component)) return false;
    try {
      normalizeFixedBundleComponents(row.components.map(component => ({ productId: String(component.productId), productType: component.productType,
        variantId: component.variantId == null ? null : String(component.variantId), quantity: component.quantity })));
      return true;
    } catch (error) { if (error.code === "BUNDLE_INVALID_COMPONENTS") return false; throw error; }
  });
  else if (definitions.some(row => !row || !Array.isArray(row.components) || row.components.some(component => !component))) fail("Bundle definitions are unavailable");
  const productIds = [...new Set([...slice.items.map(row => String(row.product)), ...definitions.flatMap(row =>
    (row.components ?? []).map(component => String(component.productId)))].map(bundleId))];
  const products = productIds.length ? await ProductModel.find({ _id: { $in: productIds.map(oid) }, isActive: true, $or: [
    { type: "SIMPLE", warehouseStocks: { $elemMatch: { warehouse: oid(input.warehouseId), quantity: { $gt: 0 } } } },
    { type: "VARIANT", variants: { $elemMatch: { warehouseStocks: { $elemMatch: { warehouse: oid(input.warehouseId), quantity: { $gt: 0 } } } } } },
  ] }).select("_id type isActive price name_en name_ar images warehouseStocks variants._id variants.price variants.images variants.options variants.warehouseStocks")
    .maxTimeMS(5000).session(session).lean() : [];
  return { raw, slice, user, warehouse, definitions, products, edit };
}
async function calculate(input, session) {
  const { raw, slice, user, warehouse, definitions, products, edit } = await sources(input, session);
  const context = raw ? { ...(edit?.candidate ?? raw), items: slice.items } : null;
  const calculateState = edit ? inspectBundleCartState : calculateBundleCartChange;
  const result = calculateState({ ownerId: input.owner, cart: context, warehouseId: input.warehouseId, warehouse,
    products, definitions, change: input.change, language: input.language });
  if (edit) result.action = input.change.action;
  const quote = { ...result, ordinaryItemsBefore: slice.before, ordinaryItemsAfter: slice.after, removedOrdinaryItems: slice.removedItems };
  if (edit) Object.assign(quote, { warehouseBefore: String(raw.warehouse), warehouseAfter: input.warehouseId,
    deliveryAddressBefore: JSON.parse(JSON.stringify(raw.deliveryAddress ?? null)),
    deliveryAddressAfter: JSON.parse(JSON.stringify(edit.candidate.deliveryAddress ?? null)),
    addressFingerprint: edit.address ? hash(edit.address) : null });
  if (edit?.reorderOrderId) Object.assign(quote, { reorderOrderId: edit.reorderOrderId, reorderFingerprint: edit.reorderFingerprint });
  encode(quote); return { quote, raw, slice, user, edit };
}

// Internal read reuse; source records must never be sent directly to a client.
export async function prepareBundleCartChange(actor, args, { session } = {}) {
  transaction(session);
  return calculate(request(actor, args), session);
}

export async function loadBundleCartViewSources(actor, args, { session } = {}) {
  if (session != null) transaction(session);
  exactBundleFields(args, ["warehouseId", "language"]);
  if (!["en", "ar"].includes(args.language)) fail("Invalid language", "BUNDLE_INVALID_REQUEST", 400);
  return sources({ owner: bundleId(requireBundleUser(actor)), warehouseId: bundleId(args.warehouseId), language: args.language }, session, { forView: true });
}

// Internal preview only: no durable proposal or public confirmation route is supplied here.
export async function previewBundleCartChange(actor, args, { session = null } = {}) {
  if (session !== null) transaction(session);
  return (await calculate(request(actor, args), session)).quote;
}
function operation(actor, args, review) {
  const input = request(actor, args);
  exactBundleFields(review, ["proposalId", "proposalFingerprint", "quote"]);
  const proposalId = oid(review.proposalId);
  if (typeof review.proposalFingerprint !== "string" || !/^[a-f\d]{64}$/.test(review.proposalFingerprint)) fail("Invalid review fingerprint", "BUNDLE_INVALID_REQUEST", 400);
  const quote = JSON.parse(encode(review.quote));
  return { input, proposalId, quote, requestHash: hash({ kind: "bundle_cart_change_v1", input, proposalId: String(proposalId),
    proposalFingerprint: review.proposalFingerprint, quote }) };
}
function receiptDto(record) {
  try {
    if (typeof record.resultJson !== "string" || Buffer.byteLength(record.resultJson) > maxBytes) throw Error();
    const result = JSON.parse(record.resultJson);
    if (hash(result) !== record.resultHash || result.cartId !== String(record.cartId)) throw Error();
    return { proposalId: String(record._id), cartId: String(record.cartId), recordedAt: new Date(record.recordedAt).toISOString(), result };
  } catch { fail("Saved result is unavailable", "BUNDLE_CART_RECEIPT_UNAVAILABLE", 503); }
}
async function retained(op, session) {
  const record = await AssistantCartReceipt.findOne({ _id: op.proposalId, owner: oid(op.input.owner) }).maxTimeMS(5000).session(session).lean();
  if (!record) return null;
  if (record.requestHash !== op.requestHash) fail("Review key was already used for a different change", "BUNDLE_CART_IDEMPOTENCY_CONFLICT");
  return { receipt: receiptDto(record), duplicate: true };
}
export async function recoverBundleCartChange(actor, args, review, { session } = {}) {
  transaction(session); const op = operation(actor, args, review); await readiness();
  await userFor(op.input.owner, session); return retained(op, session);
}

// Caller must authorize/bind the durable review, abort on error, commit, and recover uncertain commits.
export async function stageBundleCartChangeWithReceipt(actor, args, review, { session } = {}) {
  transaction(session); const op = operation(actor, args, review); await readiness();
  await userFor(op.input.owner, session);
  const existing = await retained(op, session); if (existing) return existing;
  const fresh = await calculate(op.input, session);
  if (encode(fresh.quote) !== encode(op.quote)) fail("Cart or bundle review changed");
  await fenceUser(fresh.user, session);
  await fenceBundleReorderOrder(fresh.edit, session);
  await fenceBundleCartAddress(fresh.edit?.address, session);
  const now = new Date(), { raw, slice, quote, edit } = fresh;
  const draft = raw ? CartModel.hydrate(raw) : new CartModel({ user: oid(op.input.owner), warehouse: oid(op.input.warehouseId), currency: "EGP", __v: 0, createdAt: now });
  draft.items = slice.items; draft.bundles = quote.patch.bundles; draft.totalCartPrice = quote.patch.totalCartPrice;
  if (edit) { draft.warehouse = edit.candidate.warehouse; draft.deliveryAddress = edit.candidate.deliveryAddress; }
  draft.checkoutKey ||= randomUUID(); draft.status = "ACTIVE"; draft.lastActivityAt = now; draft.updatedAt = now; draft.abandonedAt = undefined;
  await draft.validate();
  if (raw) {
    const editSet = edit ? { warehouse: draft.warehouse,
      ...(draft.deliveryAddress == null ? {} : { deliveryAddress: draft.toObject().deliveryAddress }) } : {};
    const editUnset = edit && draft.deliveryAddress == null ? { deliveryAddress: "" } : {};
    const result = await CartModel.collection.updateOne({ _id: raw._id, user: oid(op.input.owner), __v: raw.__v,
      $expr: { $eq: ["$$ROOT", { $literal: raw }] } }, {
      $set: { ...editSet, items: draft.items.toObject(), bundles: draft.bundles.toObject(), totalCartPrice: draft.totalCartPrice,
        checkoutKey: draft.checkoutKey, status: draft.status, lastActivityAt: now, updatedAt: now },
      $unset: { abandonedAt: "", ...editUnset }, $inc: { __v: 1 },
    }, { session });
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("Cart changed during confirmation");
  } else await CartModel.collection.insertOne(draft.toObject(), { session });
  const result = { ...quote, cartId: String(draft._id) }, resultJson = encode(result);
  const [record] = await AssistantCartReceipt.create([{ _id: op.proposalId, owner: oid(op.input.owner), requestHash: op.requestHash,
    cartId: draft._id, resultJson, resultHash: hash(result), recordedAt: now }], { session });
  return { receipt: receiptDto(record), duplicate: false };
}
