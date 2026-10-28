import mongoose from "mongoose";

const { Schema } = mongoose;
const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  owner: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  cartId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  resultJson: { type: String, required: true, immutable: true, maxlength: 65536 },
  resultHash: { type: String, required: true, immutable: true },
  recordedAt: { type: Date, required: true, immutable: true },
}, { strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });

// The proposal ID is the receipt ID; its built-in unique index must never expire.
export const AssistantCartReceipt = mongoose.models.AssistantCartReceipt ?? mongoose.model("AssistantCartReceipt", schema);
