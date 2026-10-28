import mongoose from "mongoose";

const { Schema } = mongoose;
const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true, immutable: true },
  owner: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  resultJson: { type: String, required: true, immutable: true, maxlength: 65536 },
  resultHash: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  recordedAt: { type: Date, required: true, immutable: true },
  notificationPending: { type: Boolean, required: true, default: true },
  notificationQueuedAt: Date,
  notificationAttemptedAt: Date,
}, { strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });

schema.index({ notificationPending: 1, notificationAttemptedAt: 1, recordedAt: 1, _id: 1 });

// Proposal ID is the receipt ID; never expire the creation/recovery boundary.
export const AssistantBookingReceipt = mongoose.models.AssistantBookingReceipt ?? mongoose.model("AssistantBookingReceipt", schema);
