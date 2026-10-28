import { AssistantBookingProposal, assertBookingProposalStore } from "../shared/assistant.booking-proposal.model.js";
import { AssistantBookingReceipt } from "../shared/assistant.booking-receipt.model.js";
import { transaction } from "../shared/assistant.store.js";
import { reject } from "../shared/assistant.errors.js";

// Owner-approved review and unused-detail lifetimes; neither is a reservation hold.
export const BOOKING_REVIEW_SECONDS = 600;
export const BOOKING_UNUSED_DETAILS_SECONDS = 86400;

export async function assertBookingRetentionStore() {
  const indexes = await assertBookingProposalStore();
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"detailsCleanupAttemptedAt":1,"detailsExpireAt":1,"_id":1}' &&
    !entry.hidden && !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple"))) reject("booking_retention_store_unavailable", 503);
  const receiptIndexes = await AssistantBookingReceipt.collection.indexes();
  if (!receiptIndexes.some(entry => entry.name === "_id_" && JSON.stringify(entry.key) === '{"_id":1}' && !entry.partialFilterExpression &&
    !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
    receiptIndexes.some(entry => entry.expireAfterSeconds !== undefined)) reject("booking_retention_store_unavailable", 503);
}
export async function removeExpiredBookingReviews(config) {
  const result = { enabled: false, removed: 0, confirmed: 0, failed: 0 };
  if (config.bookingRetentionEnabled !== true) return result;
  result.enabled = true; await assertBookingRetentionStore();
  const now = new Date(), due = { detailsExpireAt: { $lte: now }, detailsRemovedAt: { $exists: false } };
  const candidates = await AssistantBookingProposal.find(due).select("_id").sort({ detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 })
    .limit(25).maxTimeMS(5000).lean();
  for (const candidate of candidates) {
    try {
      const attempted = await AssistantBookingProposal.collection.updateOne({ _id: candidate._id, ...due },
        { $set: { detailsCleanupAttemptedAt: new Date() } });
      if (attempted.matchedCount !== 1) continue;
      const outcome = await transaction(async session => {
        const record = await AssistantBookingProposal.findOne({ _id: candidate._id, ...due }).select("_id owner expiresAt detailsExpireAt")
          .maxTimeMS(5000).session(session).lean();
        if (!record) return null;
        if (!record.owner || !(record.expiresAt instanceof Date) || !Number.isFinite(record.expiresAt.getTime()) || record.expiresAt > now ||
          !(record.detailsExpireAt instanceof Date) || !Number.isFinite(record.detailsExpireAt.getTime()) || record.detailsExpireAt <= record.expiresAt) reject("booking_retention_record_unavailable", 503);
        const receipt = await AssistantBookingReceipt.findOne({ _id: record._id }).select("owner").maxTimeMS(5000).session(session).lean();
        if (receipt && String(receipt.owner) !== String(record.owner)) reject("booking_retention_record_unavailable", 503);
        // Both this write and confirmation touch the proposal, so receipt absence cannot race a new commit.
        const update = receipt ? { $unset: { detailsExpireAt: 1, detailsCleanupAttemptedAt: 1 }, $inc: { __v: 1 } }
          : { $unset: { inputJson: 1, quoteJson: 1, binding: 1, detailsExpireAt: 1, detailsCleanupAttemptedAt: 1 },
            $set: { detailsRemovedAt: new Date(), updatedAt: new Date() }, $inc: { __v: 1 } };
        const written = await AssistantBookingProposal.collection.updateOne({ _id: record._id, owner: record.owner, ...due }, update, { session });
        return written.matchedCount === 1 && written.modifiedCount === 1 ? receipt ? "confirmed" : "removed" : null;
      });
      if (outcome) result[outcome]++;
    } catch { result.failed++; }
  }
  return result;
}
