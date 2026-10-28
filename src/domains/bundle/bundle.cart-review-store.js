import mongoose from "mongoose";
import { AssistantCartProposal } from "../assistant/shared/assistant.cart-proposal.model.js";
import { reject } from "../assistant/shared/assistant.errors.js";

export async function assertBundleCartProposalStore() {
  let indexes;
  try { indexes = await AssistantCartProposal.collection.indexes(); } catch { reject("bundle_cart_review_store_unavailable", 503); }
  if (!indexes.some(row => JSON.stringify(row.key) === '{"owner":1,"key":1}' && row.unique === true &&
      !row.sparse && !row.partialFilterExpression && (!row.collation || row.collation.locale === "simple")) ||
      indexes.some(row => row.expireAfterSeconds !== undefined)) reject("bundle_cart_review_store_unavailable", 503);
}

// Storage only: no assistant access check or store initializer belongs in a shopping transaction.
export async function runBundleCartReviewTransaction(callback) {
  const session = await mongoose.startSession();
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await session.withTransaction(() => callback(session), {
        readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
      }); } catch (error) { if (error.code !== 11000 || attempt === 1) throw error; }
    }
  } finally { await session.endSession(); }
}
