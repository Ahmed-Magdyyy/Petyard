import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { AddressModel } from "../../src/domains/address/address.model.js";
import {
  updateGuestAddressService,
  updateMyAddressService,
} from "../../src/domains/address/address.service.js";
import { CartModel } from "../../src/domains/cart/cart.model.js";
import {
  buildCartDeliveryAddressSnapshot,
  syncActiveCartAddressSnapshots,
} from "../../src/domains/cart/cartAddressSnapshot.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";

function queryResult(value) {
  const query = {
    select() {
      return query;
    },
    sort() {
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

function makeWarehouse() {
  return {
    _id: new mongoose.Types.ObjectId(),
    active: true,
    fulfillment: { status: "OPERATIONAL", fallbackWarehouse: null },
  };
}

function makeAddress(owner) {
  return {
    _id: new mongoose.Types.ObjectId(),
    ...owner,
    label: "Home",
    name: "Test User",
    governorate: "Cairo",
    area: "New Cairo",
    phone: "01012345678",
    building: "10",
    floor: "2",
    apartment: "4",
    location: { lat: 29.95, lng: 31.5 },
    details: "Near the main gate",
    warehouse: new mongoose.Types.ObjectId(),
    async save() {
      return this;
    },
  };
}

test("cart delivery-address snapshots use one owner-aware projection", () => {
  const userAddress = makeAddress({ user: new mongoose.Types.ObjectId() });
  const guestAddress = makeAddress({ guestId: "guest-address-sync" });

  const userSnapshot = buildCartDeliveryAddressSnapshot(userAddress);
  const guestSnapshot = buildCartDeliveryAddressSnapshot(guestAddress);

  assert.equal(String(userSnapshot.userAddressId), String(userAddress._id));
  assert.equal(userSnapshot.guestAddressId, undefined);
  assert.equal(
    String(guestSnapshot.guestAddressId),
    String(guestAddress._id),
  );
  assert.equal(guestSnapshot.userAddressId, undefined);
  assert.deepEqual(userSnapshot.location, userAddress.location);
  assert.notEqual(userSnapshot.location, userAddress.location);
});

test("sync refreshes only active user carts that reference the address", async (t) => {
  const address = makeAddress({ user: new mongoose.Types.ObjectId() });
  const effectiveWarehouse = makeWarehouse();
  let capturedFilter;
  let capturedUpdate;

  t.mock.method(WarehouseModel, "findById", () =>
    queryResult(effectiveWarehouse),
  );
  t.mock.method(CartModel, "exists", async () => ({ _id: "cart-id" }));
  t.mock.method(CartModel, "updateMany", async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  const result = await syncActiveCartAddressSnapshots(address);

  assert.equal(result.modifiedCount, 1);
  assert.equal(String(capturedFilter.user), String(address.user));
  assert.equal(capturedFilter.status, "ACTIVE");
  assert.equal(
    String(capturedFilter["deliveryAddress.userAddressId"]),
    String(address._id),
  );
  assert.equal(
    String(capturedUpdate.$set.warehouse),
    String(effectiveWarehouse._id),
  );
  assert.equal(
    String(capturedUpdate.$set.deliveryAddress.userAddressId),
    String(address._id),
  );
  assert.ok(capturedUpdate.$set.lastActivityAt instanceof Date);
});

test("sync refreshes only active guest carts that reference the address", async (t) => {
  const address = makeAddress({ guestId: "guest-address-sync" });
  const effectiveWarehouse = makeWarehouse();
  let capturedFilter;
  let capturedUpdate;

  t.mock.method(WarehouseModel, "findById", () =>
    queryResult(effectiveWarehouse),
  );
  t.mock.method(CartModel, "exists", async () => ({ _id: "cart-id" }));
  t.mock.method(CartModel, "updateMany", async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  await syncActiveCartAddressSnapshots(address);

  assert.equal(capturedFilter.guestId, address.guestId);
  assert.equal(capturedFilter.status, "ACTIVE");
  assert.equal(
    String(capturedFilter["deliveryAddress.guestAddressId"]),
    String(address._id),
  );
  assert.equal(
    String(capturedUpdate.$set.deliveryAddress.guestAddressId),
    String(address._id),
  );
});

test("sync is a no-op when no active cart references the address", async (t) => {
  const address = makeAddress({ user: new mongoose.Types.ObjectId() });

  t.mock.method(CartModel, "exists", async () => null);
  t.mock.method(CartModel, "updateMany", async () => {
    throw new Error("updateMany should not be called");
  });
  t.mock.method(WarehouseModel, "findById", () => {
    throw new Error("warehouse resolution should not be called");
  });

  const result = await syncActiveCartAddressSnapshots(address);

  assert.equal(result.matchedCount, 0);
  assert.equal(result.modifiedCount, 0);
});

test("authenticated address edits synchronize their referenced cart", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const address = makeAddress({ user: userId });
  const effectiveWarehouse = makeWarehouse();
  let synchronizedSnapshot;

  t.mock.method(AddressModel, "findOne", () => queryResult(address));
  t.mock.method(AddressModel, "find", () => queryResult([]));
  t.mock.method(WarehouseModel, "findById", () =>
    queryResult(effectiveWarehouse),
  );
  t.mock.method(CartModel, "exists", async () => ({ _id: "cart-id" }));
  t.mock.method(CartModel, "updateMany", async (_filter, update) => {
    synchronizedSnapshot = update.$set.deliveryAddress;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  await updateMyAddressService({
    userId,
    addressId: address._id,
    payload: { building: "25" },
  });

  assert.equal(address.building, "25");
  assert.equal(synchronizedSnapshot.building, "25");
});

test("guest address edits synchronize their referenced cart", async (t) => {
  const address = makeAddress({ guestId: "guest-address-sync" });
  const effectiveWarehouse = makeWarehouse();
  let synchronizedSnapshot;

  t.mock.method(AddressModel, "findOne", () => queryResult(address));
  t.mock.method(WarehouseModel, "findById", () =>
    queryResult(effectiveWarehouse),
  );
  t.mock.method(CartModel, "exists", async () => ({ _id: "cart-id" }));
  t.mock.method(CartModel, "updateMany", async (_filter, update) => {
    synchronizedSnapshot = update.$set.deliveryAddress;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  await updateGuestAddressService({
    guestId: address.guestId,
    addressId: address._id,
    payload: { floor: "7" },
  });

  assert.equal(address.floor, "7");
  assert.equal(synchronizedSnapshot.floor, "7");
});
