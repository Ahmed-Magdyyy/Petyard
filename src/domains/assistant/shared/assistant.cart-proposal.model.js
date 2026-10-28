import mongoose from "mongoose";

const { Schema } = mongoose;
const id = Schema.Types.ObjectId;
const schema = new Schema({
  owner: { type: id, required: true, immutable: true },
  key: { type: String, required: true, immutable: true, maxlength: 128 },
  requestHash: { type: String, required: true, immutable: true },
  inputJson: { type: String, required: true, immutable: true, maxlength: 2048 },
  binding: { type: String, required: true, immutable: true },
  quoteJson: { type: String, required: true, immutable: true, maxlength: 65536 },
  fingerprint: { type: String, required: true, immutable: true },
  version: { type: Number, required: true, default: 1, enum: [1], immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });

schema.index({ owner: 1, key: 1 }, { unique: true });
// No TTL: deleting a proposal must not silently free its idempotency key.
export const AssistantCartProposal = mongoose.models.AssistantCartProposal ?? mongoose.model("AssistantCartProposal", schema);
