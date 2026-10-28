import mongoose from "mongoose";

const integer = minimum => ({ type: Number, required: true, min: minimum, validate: Number.isSafeInteger });
const id = { type: String, required: true, match: /^[a-f\d]{24}$/ };
const options = new mongoose.Schema({ name: { type: String, required: true }, value: { type: String, required: true } }, { _id: false });
const allocation = new mongoose.Schema({ quantity: integer(1), unitPricePiastres: integer(0) }, { _id: false, strict: "throw" });
const component = new mongoose.Schema({
  productId: id, productType: { type: String, required: true, enum: ["SIMPLE", "VARIANT"] },
  variantId: { type: String, match: /^[a-f\d]{24}$/, default: null }, quantity: integer(1),
  name: { type: String, required: true }, image: { type: String, default: null },
  variantOptions: { type: [options], default: [] }, regularUnitPricePiastres: integer(0),
  allocations: { type: [allocation], required: true, default: undefined },
}, { _id: false, strict: "throw" });

export const bundleOrderGroupSchema = new mongoose.Schema({
  id, bundleId: id, bundleRevision: integer(1), warehouseId: id,
  currency: { type: String, required: true, enum: ["EGP"] }, language: { type: String, required: true, enum: ["en", "ar"] },
  name: { type: String, required: true }, image: { type: String, default: null }, quantity: integer(1),
  unitPricePiastres: integer(1), originalUnitPricePiastres: integer(1), lineTotalPiastres: integer(1),
  components: { type: [component], required: true, default: undefined },
}, { _id: false, id: false, strict: "throw" });

const pendingShortage = new mongoose.Schema({
  lineId: { type: String, required: true }, productId: id,
  productType: { type: String, required: true, enum: ["SIMPLE", "VARIANT"] },
  variantId: { type: String, default: null, match: /^[a-f\d]{24}$/ },
  quantityBefore: integer(1), deliverableOriginalQuantity: integer(0), finalizedUnavailableStart: integer(0),
  finalizedUnavailableEnd: integer(1), originalUnitPricePiastres: integer(0),
}, { _id: false, strict: "throw" });
export const bundlePendingSubstitutionSchema = new mongoose.Schema({
  requestId: id, orderId: id, warehouseId: id, settlementRevision: integer(0), subtotalPiastres: integer(0),
  shortages: { type: [pendingShortage], required: true, default: undefined },
}, { _id: false, strict: "throw" });
