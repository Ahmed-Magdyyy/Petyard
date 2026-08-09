import { OrderModel } from "../order/order.model.js";
import { SubstitutionRequestModel } from "./substitutionRequest.model.js";

function withSession(query, session) {
  return session ? query.session(session) : query;
}

export function findOrderForSubstitution({ orderId, session, lean = false }) {
  const query = OrderModel.findById(orderId);
  withSession(query, session);
  return lean ? query.lean() : query;
}

export function findSubstitutionRequest({
  orderId,
  requestId,
  userId,
  guestId,
  session,
  lean = false,
}) {
  const filter = { order: orderId, _id: requestId };
  if (userId) filter.user = userId;
  if (guestId) filter.guestId = guestId;

  const query = SubstitutionRequestModel.findOne(filter);
  withSession(query, session);
  return lean ? query.lean() : query;
}

export function findSubstitutionRequestByOfferKey({
  orderId,
  offerIdempotencyKey,
  session,
}) {
  return withSession(
    SubstitutionRequestModel.findOne({
      order: orderId,
      offerIdempotencyKey,
    }),
    session,
  );
}

export function listSubstitutionRequests({
  orderId,
  userId,
  guestId,
  session,
}) {
  const filter = { order: orderId };
  if (userId) filter.user = userId;
  if (guestId) filter.guestId = guestId;

  return withSession(
    SubstitutionRequestModel.find(filter).sort({ requestSequence: -1 }).lean(),
    session,
  );
}

export async function createSubstitutionRequest(document, { session } = {}) {
  const [created] = await SubstitutionRequestModel.create([document], {
    ...(session ? { session } : {}),
  });
  return created;
}

