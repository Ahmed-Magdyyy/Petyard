import { CartModel } from "./cart.model.js";
import { resolveEffectiveWarehouse } from "../warehouse/warehouse.fulfillment.js";
import { cartStatusEnum } from "../../shared/constants/enums.js";
import { AddressModel } from "../address/address.model.js";
import { isPrimeLocation } from "../warehouse/warehouse.delivery.js";

function addressOwnership(address) {
  if (address?.user) {
    return {
      cartOwnerFilter: { user: address.user },
      referenceField: "userAddressId",
    };
  }

  if (address?.guestId) {
    return {
      cartOwnerFilter: { guestId: address.guestId },
      referenceField: "guestAddressId",
    };
  }

  throw new TypeError("A cart address must belong to a user or guest");
}

export function buildCartDeliveryAddressSnapshot(address) {
  if (!address?._id) {
    throw new TypeError("A persisted address is required");
  }

  const { referenceField } = addressOwnership(address);

  return {
    [referenceField]: address._id,
    warehouse: address.warehouse || undefined,
    label: address.label || undefined,
    name: address.name || undefined,
    governorate: address.governorate || undefined,
    area: address.area || undefined,
    phone: address.phone || undefined,
    building: address.building || undefined,
    floor: address.floor || undefined,
    apartment: address.apartment || undefined,
    location: address.location
      ? {
          lat: address.location.lat,
          lng: address.location.lng,
        }
      : undefined,
    details: address.details || undefined,
  };
}

/** Resolve legacy source context using an owned address, never a client flag. */
export async function resolveCartPrimeLocation(cart, effectiveWarehouse, { session } = {}) {
  if (!effectiveWarehouse?.primeBoundaryGeometry?.coordinates?.length ||
      effectiveWarehouse.primeShippingPrice == null || !cart?.deliveryAddress) {
    return false;
  }

  const snapshot = cart.deliveryAddress;
  let sourceId = snapshot.warehouse;
  if (!sourceId) {
    const addressId = snapshot.userAddressId || snapshot.guestAddressId;
    const owner = cart.user
      ? { user: cart.user._id || cart.user }
      : cart.guestId ? { guestId: cart.guestId } : null;
    if (!addressId || !owner) return false;
    let query = AddressModel.findOne({ _id: addressId, ...owner })
      .select("warehouse location");
    if (session) query = query.session(session);
    const address = await query;
    // A legacy snapshot cannot borrow the zone of a different coordinate pair.
    if (!address || address.location?.lat !== snapshot.location?.lat ||
        address.location?.lng !== snapshot.location?.lng) return false;
    sourceId = address.warehouse;
  }

  if (!sourceId || String(sourceId) !== String(effectiveWarehouse._id)) return false;
  return isPrimeLocation({
    zoneWarehouse: effectiveWarehouse,
    effectiveWarehouse,
    location: snapshot.location,
  });
}

/**
 * Keeps denormalized delivery-address snapshots current without selecting an
 * address for carts that do not already reference it.
 */
export async function syncActiveCartAddressSnapshots(address) {
  const { cartOwnerFilter, referenceField } = addressOwnership(address);
  const cartFilter = {
    ...cartOwnerFilter,
    status: cartStatusEnum.ACTIVE,
    [`deliveryAddress.${referenceField}`]: address._id,
  };
  const hasReferencedCart = await CartModel.exists(cartFilter);

  if (!hasReferencedCart) {
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  }

  const deliveryAddress = buildCartDeliveryAddressSnapshot(address);
  const setFields = {
    deliveryAddress,
    lastActivityAt: new Date(),
  };

  if (address.warehouse) {
    const { effectiveWarehouse } = await resolveEffectiveWarehouse(
      address.warehouse,
    );
    setFields.warehouse = effectiveWarehouse._id;
  }

  return CartModel.updateMany(cartFilter, { $set: setFields });
}
