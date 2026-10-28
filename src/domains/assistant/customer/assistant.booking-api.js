import { ApiError } from "../../../shared/utils/ApiError.js";
import { AssistantAccount } from "../shared/assistant.models.js";
import { requireBookingReads, requireBookingActions } from "../shared/assistant.config.js";
import { transaction } from "../shared/assistant.store.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { assertBookingReadAccess } from "./assistant.booking-reads.js";
import { prepareBookingProposal, getBookingProposalState, confirmBookingProposal } from "./assistant.booking-proposals.js";
import { getBookingLiveStatus } from "./assistant.booking-status.js";
import { BOOKING_REVIEW_SECONDS, BOOKING_UNUSED_DETAILS_SECONDS, assertBookingRetentionStore } from "./assistant.booking-lifecycle.js";
import { bookingReviewPresentation } from "./assistant.booking-messages.js";

async function operation(ownerValue, config, mutation, callback) {
  (mutation ? requireBookingActions : requireBookingReads)(config);
  if (mutation) await assertBookingRetentionStore();
  const owner = objectId(String(ownerValue));
  await transaction(async session => {
    const account = await assertBookingReadAccess(owner, config, session), now = new Date();
    if (!Number.isSafeInteger(config.rateMax) || config.rateMax < 1 || !Number.isSafeInteger(config.rateWindowSeconds) || config.rateWindowSeconds < 1) reject("assistant_configuration_required", 503);
    const reset = account.bookingActionRateStart ? new Date(new Date(account.bookingActionRateStart).getTime() + config.rateWindowSeconds * 1000) : now;
    const count = reset <= now ? 0 : account.bookingActionRateCount ?? 0;
    if (!Number.isFinite(reset.getTime()) || !Number.isSafeInteger(count) || count < 0) reject("booking_action_rate_unavailable", 503);
    if (count >= config.rateMax) reject("booking_action_rate_limit", 429, reset);
    const updated = await AssistantAccount.updateOne({ _id: account._id, owner }, { $set: {
      bookingActionRateStart: reset <= now ? now : account.bookingActionRateStart, bookingActionRateCount: count + 1,
    } }, { session });
    if (updated.matchedCount !== 1) reject("context_changed", 409);
  });
  try { return await callback(owner); }
  catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof ApiError && [400, 404, 409].includes(error.statusCode)) reject("booking_proposal_changed", 409);
    throw error;
  }
}
export const prepareBookingReview = (owner, body, key, config) => operation(owner, config, true, async principal => {
  const now = Date.now();
  const prepared = await prepareBookingProposal(principal, body, key, config, { expiresAt: new Date(now + BOOKING_REVIEW_SECONDS * 1000),
    detailsExpireAt: new Date(now + BOOKING_UNUSED_DETAILS_SECONDS * 1000) });
  const state = { ...await getBookingProposalState(principal, prepared.proposal.id, config), duplicate: prepared.duplicate };
  return bookingReviewPresentation(principal, state, config, { publish: true });
});
export const getBookingReview = (owner, id, config) => operation(owner, config, false, async principal =>
  bookingReviewPresentation(principal, await getBookingProposalState(principal, id, config), config));
export const confirmBookingReview = (owner, id, body, config) => operation(owner, config, true, async principal =>
  bookingReviewPresentation(principal, await confirmBookingProposal(principal, id, body, config), config, { publish: true }));
export const getBookingReviewStatus = (owner, id, config) => operation(owner, config, false, principal => getBookingLiveStatus(principal, id, config));
