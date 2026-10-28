import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { CartModel } from "./cart.model.js";
import { readCartWithBundles } from "./cart.service.js";
import { loadBundleCartUser, fenceBundleCartUser, prepareBundleCartChange } from "../bundle/bundle.cart-transaction.js";
import { fenceBundleCartAddress } from "../bundle/bundle.cart-edits.js";
import { bundleId, bundleInputError } from "../bundle/bundle.draft-input.js";

const conflict = () => bundleInputError("Your cart changed. Refresh it before trying again.", "BUNDLE_CART_REVIEW_REQUIRED", 409);

async function requireUniqueCartStore() {
  const indexes = await CartModel.collection.indexes();
  if (!indexes.some(row => JSON.stringify(row.key) === '{"user":1}' && row.unique === true && !row.sparse &&
      (!row.collation || row.collation.locale === "simple") &&
      (!row.partialFilterExpression || JSON.stringify(row.partialFilterExpression) === '{"user":{"$type":"objectId"}}'))) {
    bundleInputError("Cart storage is unavailable", "BUNDLE_CART_STORE_UNAVAILABLE", 503);
  }
}

// Direct app cart writes share bundle validation; assistant confirmations keep their own authorization boundary.
export async function changeCartWithBundles({ userId, warehouseId, change, lang = "en" }) {
  if (process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") {
    bundleInputError("Bundle cart is unavailable", "BUNDLE_CART_UNAVAILABLE", 503);
  }
  const owner = bundleId(String(userId)), selectedWarehouse = bundleId(String(warehouseId));
  const language = lang === "ar" ? "ar" : "en";
  await requireUniqueCartStore();
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const actor = await loadBundleCartUser(owner, session);
      const raw = await CartModel.findOne({ user: new mongoose.Types.ObjectId(owner) }).session(session).lean();
      if (raw && (String(raw.user) !== owner || raw.guestId != null || !Number.isSafeInteger(raw.__v) || raw.__v < 0 || raw.__v >= Number.MAX_SAFE_INTEGER)) conflict();
      if (change.action === "clear") {
        if (!raw) return { success: true };
        await fenceBundleCartUser(actor, session);
        const deleted = await CartModel.collection.deleteOne({ _id: raw._id, user: raw.user, __v: raw.__v,
          $expr: { $eq: ["$$ROOT", { $literal: raw }] } }, { session });
        if (deleted.deletedCount !== 1) conflict();
        return { success: true };
      }
      if (!raw && change.action !== "add") bundleInputError("Cart not found", "BUNDLE_CART_NOT_FOUND", 404);
      const edit = { ...change };
      if (["ordinary_add", "ordinary_set", "ordinary_remove", "rebind", "address"].includes(edit.action)) {
        Object.assign(edit, { cartId: String(raw._id), expectedCartVersion: raw.__v });
      }
      if (edit.action === "add") edit.newGroupId = String(new mongoose.Types.ObjectId());
      if (edit.action === "ordinary_add") edit.newItemId = String(new mongoose.Types.ObjectId());
      const prepared = await prepareBundleCartChange(actor,
        { warehouseId: selectedWarehouse, language, change: edit }, { session });
      if (raw && (!prepared.raw || !mongoose.mongo.BSON.serialize(raw).equals(mongoose.mongo.BSON.serialize(prepared.raw)))) conflict();
      const { quote, slice } = prepared, now = new Date();
      const draft = raw ? CartModel.hydrate(raw) : new CartModel({ user: owner, warehouse: selectedWarehouse, currency: "EGP", __v: 0, createdAt: now });
      draft.items = slice.items; draft.bundles = quote.patch.bundles; draft.totalCartPrice = quote.patch.totalCartPrice;
      if (prepared.edit) { draft.warehouse = prepared.edit.candidate.warehouse; draft.deliveryAddress = prepared.edit.candidate.deliveryAddress; }
      draft.checkoutKey ||= randomUUID(); draft.status = "ACTIVE"; draft.lastActivityAt = now; draft.updatedAt = now; draft.abandonedAt = undefined;
      await draft.validate();
      await fenceBundleCartUser(actor, session);
      await fenceBundleCartAddress(prepared.edit?.address, session);
      if (raw) {
        const document = draft.toObject();
        const set = { items: document.items, totalCartPrice: draft.totalCartPrice, warehouse: draft.warehouse,
          checkoutKey: draft.checkoutKey, status: draft.status, lastActivityAt: now, updatedAt: now };
        const unset = { abandonedAt: "" };
        if (draft.bundles.length) set.bundles = document.bundles; else unset.bundles = "";
        if (document.deliveryAddress) set.deliveryAddress = document.deliveryAddress; else unset.deliveryAddress = "";
        const written = await CartModel.collection.updateOne({ _id: raw._id, user: raw.user, __v: raw.__v,
          $expr: { $eq: ["$$ROOT", { $literal: raw }] } }, { $set: set, $unset: unset, $inc: { __v: 1 } }, { session });
        if (written.matchedCount !== 1 || written.modifiedCount !== 1) conflict();
      } else {
        await CartModel.collection.insertOne(draft.toObject(), { session });
      }
      return readCartWithBundles({ userId: owner, warehouseId: selectedWarehouse, lang: language, session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000 });
  } catch (error) {
    if (error?.code === 11000 && error.keyPattern?.user === 1) conflict();
    // A lost commit response is not proof of rollback; additions must be recovered by reading the cart.
    if (error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      bundleInputError("Cart result is unknown. Refresh the cart before making another change.", "BUNDLE_CART_OUTCOME_UNKNOWN", 503);
    }
    throw error;
  } finally { await session.endSession(); }
}
