import mongoose from "mongoose";

const positive = { type: Number, required: true, min: 1, validate: Number.isSafeInteger };
const identifier = { type: String, required: true, match: /^[a-f\d]{24}$/, lowercase: true };

// Compact cart references; immutable purchased contents belong to the future order snapshot.
export const bundleCartGroupSchema = new mongoose.Schema({
  id: identifier, bundleId: identifier, bundleRevision: positive, quantity: positive, unitPricePiastres: positive,
}, { _id: false, id: false, strict: "throw" });
