import { AddressModel } from "./address.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

function pickAddressFields(payload) {
  const {
    label,
    name,
    governorate,
    area,
    phone,
    building,
    floor,
    apartment,
    location,
    details,
    isDefault,
  } = payload;

  const doc = {};
  if (label !== undefined) doc.label = label;
  if (name !== undefined) doc.name = name;
  if (governorate !== undefined) doc.governorate = governorate;
  if (area !== undefined) doc.area = area;
  if (phone !== undefined) doc.phone = phone;
  if (building !== undefined) doc.building = building;
  if (floor !== undefined) doc.floor = floor;
  if (apartment !== undefined) doc.apartment = apartment;
  if (details !== undefined) doc.details = details;
  if (isDefault !== undefined) doc.isDefault = isDefault;

  if (location !== undefined) {
    if (location && typeof location === "object") {
      doc.location = { lat: location.lat, lng: location.lng };
    } else {
      doc.location = undefined;
    }
  }

  return doc;
}

async function allAddresses(ownerFilter) {
  return AddressModel.find(ownerFilter)
    .select("-createdAt -user -guestId -__v")
    .sort({ createdAt: 1 })
    .lean();
}

function sanitize(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.createdAt;
  delete obj.user;
  delete obj.guestId;
  delete obj.__v;
  return obj;
}

// ── User address services (called from user.controller.js) ─────────────────

export async function getMyAddressesService({ userId }) {
  return allAddresses({ user: userId });
}

export async function addMyAddressService({ userId, payload }) {
  const ownerFilter = { user: userId };
  const existing = await AddressModel.countDocuments(ownerFilter);

  const fields = pickAddressFields(payload);
  fields.user = userId;

  // First address auto-becomes default
  if (existing === 0 && fields.isDefault !== true) {
    fields.isDefault = true;
  }

  // If setting as default, unset others
  if (fields.isDefault) {
    await AddressModel.updateMany(ownerFilter, { isDefault: false });
  }

  await AddressModel.create(fields);
  return allAddresses(ownerFilter);
}

export async function updateMyAddressService({ userId, addressId, payload }) {
  const address = await AddressModel.findOne({ _id: addressId, user: userId });
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  const fields = pickAddressFields(payload);
  Object.assign(address, fields);
  await address.save({ validateModifiedOnly: true });

  return allAddresses({ user: userId });
}

export async function deleteMyAddressService({ userId, addressId }) {
  const address = await AddressModel.findOne({ _id: addressId, user: userId });
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  const wasDefault = address.isDefault === true;
  await address.deleteOne();

  if (wasDefault) {
    const first = await AddressModel.findOne({ user: userId }).sort({
      createdAt: 1,
    });
    if (first) {
      first.isDefault = true;
      await first.save({ validateModifiedOnly: true });
    }
  }

  return allAddresses({ user: userId });
}

export async function setDefaultMyAddressService({ userId, addressId }) {
  const address = await AddressModel.findOne({ _id: addressId, user: userId });
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  await AddressModel.updateMany({ user: userId }, { isDefault: false });
  await AddressModel.updateOne({ _id: addressId }, { isDefault: true });

  return allAddresses({ user: userId });
}

// ── Guest address services ─────────────────────────────────────────────────

export async function getGuestAddressesService({ guestId }) {
  return allAddresses({ guestId });
}

export async function addGuestAddressService({ guestId, payload }) {
  const ownerFilter = { guestId };
  const existing = await AddressModel.countDocuments(ownerFilter);

  const fields = pickAddressFields(payload);
  fields.guestId = guestId;

  if (existing === 0 && fields.isDefault !== true) {
    fields.isDefault = true;
  }

  if (fields.isDefault) {
    await AddressModel.updateMany(ownerFilter, { isDefault: false });
  }

  const created = await AddressModel.create(fields);
  return sanitize(created);
}

export async function updateGuestAddressService({
  guestId,
  addressId,
  payload,
}) {
  const address = await AddressModel.findOne({ _id: addressId, guestId });
  if (!address) {
    throw new ApiError("Address not found", 404);
  }

  const fields = pickAddressFields(payload);
  Object.assign(address, fields);
  await address.save({ validateModifiedOnly: true });

  return sanitize(address);
}

export async function deleteGuestAddressService({ guestId, addressId }) {
  const address = await AddressModel.findOne({ _id: addressId, guestId });
  if (!address) {
    throw new ApiError("Address not found", 404);
  }

  const wasDefault = address.isDefault === true;
  await address.deleteOne();

  if (wasDefault) {
    const first = await AddressModel.findOne({ guestId }).sort({
      createdAt: 1,
    });
    if (first) {
      first.isDefault = true;
      await first.save({ validateModifiedOnly: true });
    }
  }
}

export async function setDefaultGuestAddressService({ guestId, addressId }) {
  const address = await AddressModel.findOne({ _id: addressId, guestId });
  if (!address) {
    throw new ApiError("Address not found", 404);
  }

  await AddressModel.updateMany({ guestId }, { isDefault: false });
  await AddressModel.updateOne({ _id: addressId }, { isDefault: true });

  const updated = await AddressModel.findById(addressId).lean();
  return sanitize(updated);
}

// ── Merge guest → user ─────────────────────────────────────────────────────

export async function mergeGuestAddressesService({ userId, guestId }) {
  if (!userId || !guestId) {
    throw new ApiError("Both userId and guestId are required", 400);
  }

  const guestAddresses = await AddressModel.find({ guestId });
  if (guestAddresses.length === 0) {
    return allAddresses({ user: userId });
  }

  // Transfer ownership: guest → user
  await AddressModel.updateMany(
    { guestId },
    { $set: { user: userId }, $unset: { guestId: "" } },
  );

  // Ensure only one default among all user addresses
  const userAddresses = await AddressModel.find({ user: userId }).sort({
    createdAt: 1,
  });

  const defaults = userAddresses.filter((a) => a.isDefault);
  if (defaults.length > 1) {
    // Keep only the first default
    for (let i = 1; i < defaults.length; i++) {
      defaults[i].isDefault = false;
      await defaults[i].save({ validateModifiedOnly: true });
    }
  } else if (defaults.length === 0 && userAddresses.length > 0) {
    userAddresses[0].isDefault = true;
    await userAddresses[0].save({ validateModifiedOnly: true });
  }

  return allAddresses({ user: userId });
}

// ── Lookup helper for cart service ─────────────────────────────────────────

export async function findAddressByIdForUser({ addressId, userId }) {
  const address = await AddressModel.findOne({ _id: addressId, user: userId });
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }
  return address;
}

export async function findAddressByIdForGuest({ addressId, guestId }) {
  const address = await AddressModel.findOne({ _id: addressId, guestId });
  if (!address) {
    throw new ApiError("Address not found for this guest", 404);
  }
  return address;
}
