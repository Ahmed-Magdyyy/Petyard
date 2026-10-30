import mongoose from "mongoose";
import { requireBundleUser } from "./bundle.access.js";
import { bundleId, bundleInputError } from "./bundle.draft-input.js";

export function bundleCartIdentity({ userId, guestId } = {}) {
  if (guestId != null) {
    if (userId != null || typeof guestId !== "string" || !guestId.trim()) {
      bundleInputError("A single valid cart owner is required");
    }
    return { owner: null, guestId: guestId.trim() };
  }
  return { owner: bundleId(String(userId)) };
}

export function bundleCartActorIdentity(actor) {
  return actor?.guestId != null
    ? bundleCartIdentity({ userId: actor._id, guestId: actor.guestId })
    : { owner: requireBundleUser(actor) };
}

export function bundleCartOwnerFilter(identity) {
  return identity.guestId != null
    ? { user: null, guestId: identity.guestId }
    : { user: new mongoose.Types.ObjectId(identity.owner) };
}

export function bundleCartMatchesOwner(cart, identity) {
  return identity.guestId != null
    ? cart?.user == null && cart?.guestId === identity.guestId
    : String(cart?.user?._id ?? cart?.user).toLowerCase() === identity.owner && cart?.guestId == null;
}
