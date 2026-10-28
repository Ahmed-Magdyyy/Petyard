import mongoose from "mongoose";
import { reject } from "./assistant.errors.js";

const { Schema } = mongoose;
const digest = { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ };
const schema = new Schema({
  owner: { type: Schema.Types.ObjectId, required: true, immutable: true },
  key: { type: String, required: true, immutable: true, match: /^[a-zA-Z0-9._:-]{8,128}$/ },
  requestHash: digest,
  inputJson: { type: String, required() { return !this.detailsRemovedAt; }, immutable: true, maxlength: 65536 },
  binding: { ...digest, required() { return !this.detailsRemovedAt; } },
  quoteJson: { type: String, required() { return !this.detailsRemovedAt; }, immutable: true, maxlength: 65536 },
  fingerprint: digest,
  version: { type: Number, required: true, default: 1, enum: [1], immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  detailsExpireAt: Date,
  detailsRemovedAt: Date,
  detailsCleanupAttemptedAt: Date,
  chatMessageExpiresAt: Date,
}, { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });

schema.index({ owner: 1, key: 1 }, { unique: true });
schema.index({ detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 });
// No TTL: expiry must not free an idempotency key for another appointment.
export const AssistantBookingProposal = mongoose.models.AssistantBookingProposal ?? mongoose.model("AssistantBookingProposal", schema);

export async function assertBookingProposalStore() {
  let indexes;
  try { indexes = await AssistantBookingProposal.collection.indexes(); } catch { reject("booking_proposal_store_unavailable", 503); }
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"owner":1,"key":1}' && entry.unique === true &&
    !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
    indexes.some(entry => entry.expireAfterSeconds !== undefined)) reject("booking_proposal_store_unavailable", 503);
  return indexes;
}
