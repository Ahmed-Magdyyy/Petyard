import { cairoTimestampReplacer } from "../../../shared/utils/egyptTimezone.js";

export class AssistantError extends Error {
  constructor(code, status = 400, retryAt = null) {
    super(code);
    Object.assign(this, { code, status, retryAt });
  }
}

export function reject(code, status = 400, retryAt = null) {
  throw new AssistantError(code, status, retryAt);
}

export const notices = Object.freeze({
  unavailable: "Petyard's assistant is currently unavailable. You can continue shopping and booking in the app.",
  limited: "The assistant's allowance has been reached. You can continue shopping and booking in the app.",
  restricted: "AI access is restricted. You can continue shopping and booking in the app.",
  uncertain: "This request could not be confirmed. Please do not resend it as a new message. It needs review.",
  failed: "The assistant could not complete this request. Check its status before sending another message.",
});
export const businessNotices = Object.freeze({
  unavailable: "Petyard's business assistant is currently unavailable. You can use the standard analytics dashboard.",
  limited: "The assistant's allowance has been reached. You can use the standard analytics dashboard.",
  restricted: "AI access is restricted. Standard dashboard permissions still apply.",
});

// This boundary also covers auth/parser/database errors; never serialize raw errors, even in development.
export function assistantErrorHandler(error, req, res, _next, { business = false } = {}) {
  const known = error instanceof AssistantError;
  const status = known ? error.status : [401, 403, 413].includes(error.statusCode ?? error.status)
    ? (error.statusCode ?? error.status) : 503;
  const code = known ? error.code : status === 401 ? "authentication_required"
    : status === 403 ? "access_denied" : status === 413 ? "payload_too_large" : "assistant_unavailable";
  const retryAt = known && error.retryAt ? new Date(error.retryAt).toISOString() : null;
  if (retryAt) res.set("Retry-After", String(Math.max(1, Math.ceil((new Date(retryAt) - Date.now()) / 1000))));
  const messages = { active_request: "An assistant request is already in progress. Reconnect using its run ID.",
    booking_reads_unavailable: "Assistant booking information is currently unavailable.",
    booking_region_unavailable: "Petyard booking services are currently available only in Alexandria.",
    booking_preview_invalid: "Review the selected branch, services, appointment time and pet details.",
    booking_request_rate_limit: "Too many booking information requests. Please wait and try again.",
    booking_read_timeout: "Booking information took too long. Please refresh it.",
    booking_actions_unavailable: "Assistant booking actions are unavailable. You can use normal app booking.",
    booking_action_rate_limit: "Too many booking requests. Please wait before trying again.",
    booking_review_removed: "This unused booking review was removed. Start and review a new booking.",
    booking_proposal_expired: "This booking review expired. Start and review a new booking.",
    booking_proposal_changed: "Booking details or availability changed. Review a new proposal before confirming.",
    booking_slot_unavailable: "The selected appointment is no longer available. Choose another time.",
    cart_actions_unavailable: "Assistant cart actions are unavailable. You can use the normal app cart.",
    cart_requote_required: "The cart or product availability changed. Review a new proposal before confirming.",
    cart_proposal_expired: "This cart proposal expired. Request and review a new proposal.",
    cart_proposal_changed: "This confirmation does not match the saved proposal. Reload its status.",
    cart_request_rate_limit: "Too many cart requests. Wait before checking or submitting again.",
    idempotency_conflict: "This message key was already used for different content. Check the original request.",
    context_changed: business ? "The business context changed. Check the request status before sending another message."
      : "The pet or memory context changed. Check the request status before sending another message." };
  const selectedNotices = business ? businessNotices : notices;
  const body = { status: "error", error: { code, message: messages[code] ?? (status === 429 ? selectedNotices.limited
    : status === 403 ? selectedNotices.restricted : status === 400 ? "The assistant request is invalid."
      : status === 404 ? "The requested assistant record was not found." : selectedNotices.unavailable), retryAt },
    fallback: business ? { analytics: true } : { shopping: true, booking: true } };
  if (business) res.status(status).type("application/json").send(JSON.stringify(body, cairoTimestampReplacer));
  else res.status(status).json(body);
}
