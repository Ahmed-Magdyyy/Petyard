import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { AddressModel } from '../../src/domains/address/address.model.js';
import { CartModel } from '../../src/domains/cart/cart.model.js';
import { resolveCartPrimeLocation, buildCartDeliveryAddressSnapshot } from '../../src/domains/cart/cartAddressSnapshot.js';
import { mapCartToResponse } from '../../src/domains/cart/cart.service.js';

const warehouse = () => ({
  _id: new mongoose.Types.ObjectId(), active: true, defaultShippingPrice: 50, primeShippingPrice: 20,
  fulfillment: { status: 'OPERATIONAL' },
  boundaryGeometry: { type: 'Polygon', coordinates: [[[31,29],[32,29],[32,31],[31,31],[31,29]]] },
  primeBoundaryGeometry: { type: 'MultiPolygon', coordinates: [[[[31.4,29.9],[31.6,29.9],[31.6,30.1],[31.4,30.1],[31.4,29.9]]]] },
});
const location = { lat: 30, lng: 31.5 };
function query(value, captureSession = () => {}) {
  const result = {
    select() { return result; },
    session(session) { captureSession(session); return result; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return result;
}

test('new cart snapshots retain the source internally without changing public address fields', async () => {
  const wh = warehouse();
  const address = { _id: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId(), warehouse: wh._id, location };
  const snapshot = buildCartDeliveryAddressSnapshot(address);
  const cart = new CartModel({ user: address.user, warehouse: wh._id, deliveryAddress: snapshot });
  assert.equal(String(cart.deliveryAddress.warehouse), String(wh._id));
  assert.equal(await resolveCartPrimeLocation(cart, wh), true);
  const response = mapCartToResponse(cart, { isPrimeLocation: true });
  assert.equal(response.isPrimeLocation, true);
  assert.equal(response.shippingFee, 0); // Legacy mapper default is unchanged.
  assert.equal(Object.hasOwn(response.deliveryAddress, 'warehouse'), false);
});

test('rerouted snapshots never adopt a matching fallback prime area', async (t) => {
  const source = warehouse(), fallback = warehouse();
  t.mock.method(AddressModel, 'findOne', () => assert.fail('known source needs no recovery lookup'));
  assert.equal(await resolveCartPrimeLocation({ deliveryAddress: { warehouse: source._id, location } }, fallback), false);
});

test('legacy recovery proves user ownership, coordinate equality, and uses order session', async (t) => {
  const wh = warehouse(), userId = new mongoose.Types.ObjectId(), addressId = new mongoose.Types.ObjectId();
  const session = {};
  let capturedFilter, capturedSession;
  t.mock.method(AddressModel, 'findOne', (filter) => {
    capturedFilter = filter;
    return query({ warehouse: wh._id, location }, (value) => { capturedSession = value; });
  });
  // A transferred guest-address reference still requires current user ownership.
  const cart = { user: { _id: userId }, deliveryAddress: { guestAddressId: addressId, location } };
  assert.equal(await resolveCartPrimeLocation(cart, wh, { session }), true);
  assert.equal(String(capturedFilter.user), String(userId));
  assert.equal(String(capturedFilter._id), String(addressId));
  assert.equal(capturedFilter.guestId, undefined);
  assert.equal(capturedSession, session);
});

test('legacy recovery scopes guest ownership and rejects stale or missing addresses', async (t) => {
  const wh = warehouse(), addressId = new mongoose.Types.ObjectId();
  let address = { warehouse: wh._id, location };
  t.mock.method(AddressModel, 'findOne', (filter) => {
    assert.equal(filter.guestId, 'guest');
    assert.equal(filter.user, undefined);
    return query(address);
  });
  const cart = { guestId: 'guest', deliveryAddress: { guestAddressId: addressId, location } };
  assert.equal(await resolveCartPrimeLocation(cart, wh), true);
  address = { warehouse: wh._id, location: { lat: 30.05, lng: 31.5 } };
  assert.equal(await resolveCartPrimeLocation(cart, wh), false);
  address = null;
  assert.equal(await resolveCartPrimeLocation(cart, wh), false);
});

test('unconfigured warehouses and unreferenced legacy carts do not query addresses or claim Prime', async (t) => {
  t.mock.method(AddressModel, 'findOne', () => assert.fail('no recoverable source'));
  const wh = warehouse();
  assert.equal(await resolveCartPrimeLocation({ guestId: 'guest', deliveryAddress: { location } }, wh), false);
  assert.equal(await resolveCartPrimeLocation({ deliveryAddress: { warehouse: wh._id, location } }, { ...wh, primeShippingPrice: null }), false);
});
