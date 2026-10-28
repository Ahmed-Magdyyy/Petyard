import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { OrderModel } from "../order/order.model.js";
import { selectFinalFulfilledOrderItems } from "../order/order.fulfillment.js";
import { ManualBundle } from "./bundle.model.js";
import { assertBundleOrderSnapshot } from "./bundle.order-snapshot.js";
import { savedBundleCartGroups } from "./bundle.cart-state.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";
import { bundleId, bundleInputError } from "./bundle.draft-input.js";

const fail = message => bundleInputError(message, "BUNDLE_CART_REVIEW_REQUIRED", 409);
const sku = row => JSON.stringify([String(row.product), row.productType, row.variantId == null ? null : String(row.variantId)]);
const hash = value => createHash("sha256").update(value).digest("hex");
const componentsKey = rows => JSON.stringify(normalizeFixedBundleComponents(rows.map(row => ({ productId: String(row.productId),
  productType: row.productType, variantId: row.variantId == null ? null : String(row.variantId), quantity: row.quantity }))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

// Builds a copy only; current pricing, combined stock, cart CAS and receipt stay with the cart primitive.
export async function prepareBundleReorder(raw, input, session) {
  const order = await OrderModel.findOne({ _id: new mongoose.Types.ObjectId(input.change.orderId), user: new mongoose.Types.ObjectId(input.owner) })
    .select("+checkoutKey").maxTimeMS(5000).session(session).lean();
  if (!order || String(order._id) !== input.change.orderId || String(order.user) !== input.owner || order.guestId != null) {
    bundleInputError("Order not found", "BUNDLE_ORDER_NOT_FOUND", 404);
  }
  assertBundleOrderSnapshot(order);
  if (!order.bundleGroups?.length) fail("Use the existing ordinary reorder flow for this order");
  if (order.__v !== undefined && (!Number.isSafeInteger(order.__v) || order.__v < 0 || order.__v >= Number.MAX_SAFE_INTEGER)) fail("Order version is unavailable");
  const candidate = { ...raw, items: raw.items.map(row => ({ ...row })), bundles: savedBundleCartGroups(raw).map(row => ({ ...row })) };
  const generated = (kind, id) => hash(JSON.stringify(["bundle-reorder-v1", input.owner, String(raw._id), input.change.orderId, kind, id])).slice(0, 24);
  const targets = new Map();
  for (const row of selectFinalFulfilledOrderItems(order.items).filter(row => row.bundleGroupId == null && row.bundleComponentIndex == null)) {
    bundleId(String(row.product));
    if (!["SIMPLE", "VARIANT"].includes(row.productType) || row.productType === "SIMPLE" && row.variantId != null ||
      !Number.isSafeInteger(row.quantity) || row.quantity < 1) fail("Saved ordinary reorder item is invalid");
    if (row.productType === "VARIANT") bundleId(String(row.variantId));
    const key = sku(row), target = targets.get(key);
    if (target) {
      target.quantity += row.quantity;
      if (!Number.isSafeInteger(target.quantity)) fail("Reorder quantity is too large");
    } else targets.set(key, { product: row.product, productType: row.productType, variantId: row.variantId, quantity: row.quantity });
  }
  for (const [key, target] of targets) {
    const matches = candidate.items.filter(row => sku(row) === key);
    if (matches.length > 1) fail("Ordinary cart identity is ambiguous");
    if (matches.length) matches[0].quantity = target.quantity;
    else {
      const id = generated("item", key);
      if (candidate.items.some(row => String(row._id) === id)) fail("Cart item identifier already exists");
      candidate.items.push({ ...target, _id: new mongoose.Types.ObjectId(id), itemPrice: 0 });
    }
  }
  const definitions = await ManualBundle.find({ _id: { $in: order.bundleGroups.map(group => new mongoose.Types.ObjectId(group.bundleId)) } })
    .select("_id revision pricePiastres components").maxTimeMS(5000).session(session).lean();
  for (const group of order.bundleGroups) {
    const matches = definitions.filter(row => String(row._id) === group.bundleId);
    if (matches.length !== 1) fail("Reordered bundle is unavailable");
    const definition = matches[0], existing = candidate.bundles.find(row => row.bundleId === group.bundleId);
    if (componentsKey(definition.components) !== componentsKey(group.components)) fail("Bundle contents changed; choose the current offer again");
    const id = existing?.id ?? generated("group", group.bundleId);
    if (!existing && candidate.bundles.some(row => row.id === id)) fail("Cart group identifier already exists");
    const next = { id, bundleId: group.bundleId, bundleRevision: definition.revision, quantity: group.quantity, unitPricePiastres: definition.pricePiastres };
    if (existing) Object.assign(existing, next); else candidate.bundles.push(next);
  }
  return { candidate, targetItemId: null, targetQuantity: null, address: null, reorderTargets: [...targets.values()],
    sourceOrder: order, reorderOrderId: input.change.orderId, reorderFingerprint: hash(mongoose.mongo.BSON.serialize(order)) };
}

export async function fenceBundleReorderOrder(edit, session) {
  if (!edit?.sourceOrder) return;
  const order = edit.sourceOrder;
  const result = await OrderModel.collection.updateOne({ _id: order._id, user: order.user,
    $expr: { $eq: ["$$ROOT", { $literal: order }] } }, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("Order changed during reorder confirmation");
}

export function assertReorderedOrdinaryItems(edit, items) {
  for (const target of edit.reorderTargets ?? []) {
    const matches = items.filter(row => sku(row) === sku(target));
    if (matches.length !== 1 || matches[0].quantity !== target.quantity) fail("A reordered ordinary item is unavailable in this warehouse");
  }
}
