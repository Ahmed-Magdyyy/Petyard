import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

import { CartModel } from '../../src/domains/cart/cart.model.js';
import { getCartService } from '../../src/domains/cart/cart.service.js';
import { AddressModel } from '../../src/domains/address/address.model.js';
import { getGuestAddressesService, getMyAddressesService } from '../../src/domains/address/address.service.js';
import { getCheckoutSummaryService } from '../../src/domains/checkout/checkout.service.js';
import { applyCouponAtCheckoutService } from '../../src/domains/checkout/checkout.service.js';
import { CollectionModel } from '../../src/domains/collection/collection.model.js';
import { CouponModel } from '../../src/domains/coupon/coupon.model.js';
import { ProductModel } from '../../src/domains/product/product.model.js';
import { SubcategoryModel } from '../../src/domains/subcategory/subcategory.model.js';
import { resolveLocationByCoordinatesService } from '../../src/domains/location/location.service.js';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';
import { warehouseFulfillmentStatusEnum } from '../../src/shared/constants/enums.js';
import { OrderModel } from '../../src/domains/order/order.model.js';
import { createOrderForGuestService } from '../../src/domains/order/order.service.js';
import { createOrderForUserService } from '../../src/domains/order/order.service.js';
import { UserModel } from '../../src/domains/user/user.model.js';
import { SavedCardModel } from '../../src/domains/payment/savedCard.model.js';
import { WalletTransactionModel } from '../../src/domains/wallet/walletTransaction.model.js';

function queryResult(value) {
  const query = {
    select() { return query; },
    lean() { return Promise.resolve(value); },
    sort() { return query; },
    skip() { return query; },
    limit() { return query; },
    populate() { return query; },
    session() { return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

function makeWarehouse({ prime = true, operational = true } = {}) {
  const id = new mongoose.Types.ObjectId();
  return {
    _id: id,
    name: 'Prime test warehouse',
    code: 'PRIME_TEST',
    governorate: 'cairo',
    active: true,
    isDefault: true,
    defaultShippingPrice: 50,
    ...(prime ? {
      primeShippingPrice: 20,
      primeBoundaryGeometry: {
        type: 'MultiPolygon',
        coordinates: [[[[31.48, 29.93], [31.52, 29.93], [31.52, 29.97], [31.48, 29.97], [31.48, 29.93]]]],
      },
    } : {}),
    boundaryGeometry: {
      type: 'Polygon',
      coordinates: [[[31.4, 29.85], [31.6, 29.85], [31.6, 30.05], [31.4, 30.05], [31.4, 29.85]]],
    },
    fulfillment: {
      status: operational ? warehouseFulfillmentStatusEnum.OPERATIONAL : warehouseFulfillmentStatusEnum.MAINTENANCE,
      fallbackWarehouse: null,
    },
  };
}

function makeCart(warehouse, { subtotal = 100, userId = null, guestId = 'prime-flow-guest' } = {}) {
  const productId = new mongoose.Types.ObjectId();
  return {
    _id: new mongoose.Types.ObjectId(),
    user: userId,
    guestId: userId ? undefined : guestId,
    warehouse: warehouse._id,
    currency: 'EGP',
    items: [{
      _id: new mongoose.Types.ObjectId(),
      product: productId,
      productType: 'SIMPLE',
      productName: 'Prime flow item',
      quantity: subtotal / 100,
      itemPrice: 100,
    }],
    totalCartPrice: subtotal,
    status: 'ACTIVE',
    checkoutKey: 'prime-flow-checkout',
    deliveryAddress: {
      warehouse: warehouse._id,
      name: 'Test customer',
      governorate: 'Cairo',
      area: 'New Cairo',
      phone: '01012345678',
      building: '1',
      floor: '2',
      apartment: '3',
      location: { lat: 29.95, lng: 31.5 },
      details: 'Near the main gate',
    },
    async save() { return this; },
  };
}

function mockCartModels(t, warehouse, cart) {
  t.mock.method(WarehouseModel, 'findById', () => queryResult(warehouse));
  t.mock.method(WarehouseModel, 'findOne', () => queryResult(warehouse));
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(CartModel, 'updateOne', async () => ({ acknowledged: true }));
  t.mock.method(CartModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CartModel, 'findById', () => queryResult(cart));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, 'findOne', () => queryResult(null));
  t.mock.method(SubcategoryModel, 'find', () => queryResult([]));
  t.mock.method(ProductModel, 'find', () => queryResult([{
    _id: cart.items[0].product,
    type: 'SIMPLE',
    name_en: 'Prime flow item',
    name_ar: 'Prime flow item',
    price: 100,
    discountedPrice: null,
    images: [],
    subcategory: null,
    brand: null,
    warehouseStocks: [{ warehouse: warehouse._id, quantity: 100 }],
    variants: [],
  }]));
}

test('coordinate resolution marks Prime only inside the operational warehouse sub-area', async (t) => {
  const warehouse = makeWarehouse();
  t.mock.method(WarehouseModel, 'find', () => queryResult([warehouse]));
  t.mock.method(WarehouseModel, 'findById', () => queryResult(warehouse));

  const result = await resolveLocationByCoordinatesService({ lat: 29.95, lng: 31.5 });
  assert.equal(result.isPrimeLocation, true, JSON.stringify(result));
  assert.equal(result.delivery.shippingFee, 20);
  assert.equal(String(result.zoneWarehouse.id), String(warehouse._id));
  assert.equal(String(result.warehouse.id), String(warehouse._id));
});

test('manual resolver preserves the existing response and cannot grant Prime', async (t) => {
  const warehouse = makeWarehouse();
  t.mock.method(WarehouseModel, 'findOne', () => queryResult(warehouse));
  const result = await resolveLocationByCoordinatesService({ governorateCode: 'alexandria', areaCode: 'agami' });
  assert.equal(result.isPrimeLocation, false);
  const summary = {
    id: warehouse._id, name: warehouse.name, code: warehouse.code,
    governorate: warehouse.governorate, isDefault: true, defaultShippingPrice: 50,
  };
  const stripAdditions = (value) => {
    const { isPrimeLocation, warehouse, zoneWarehouse, ...rest } = value;
    const { primeShippingPrice: price, ...oldWarehouse } = warehouse;
    const { primeShippingPrice: zonePrice, ...oldZone } = zoneWarehouse;
    return { ...rest, warehouse: oldWarehouse, zoneWarehouse: oldZone };
  };
  assert.deepEqual(stripAdditions(result), {
    warehouse: summary, zoneWarehouse: summary, warehouseRouting: { rerouted: false },
    location: {
      source: 'manual', coordinates: { lat: null, lng: null },
      governorate: { name: 'alexandria', isSupported: true }, area: { code: 'agami' },
    },
    delivery: {
      canDeliver: false, coverageStatus: 'GOVERNORATE_ONLY_SUPPORTED',
      reasonCode: 'PRECISE_LOCATION_REQUIRED',
      reasonMessage: 'Exact location is required to confirm delivery availability.',
      requiresPreciseLocation: true, effectiveShippingPrice: 50, shippingFee: 50, defaultShippingPrice: 50,
    },
  });
});

test('user and guest address responses derive Prime status from current warehouse configuration', async (t) => {
  const warehouse = makeWarehouse();
  const userId = new mongoose.Types.ObjectId();
  const addresses = [
    { _id: new mongoose.Types.ObjectId(), user: userId, warehouse: warehouse._id, location: { lat: 29.95, lng: 31.5 } },
    { _id: new mongoose.Types.ObjectId(), guestId: 'prime-address-guest', warehouse: warehouse._id, location: { lat: 29.95, lng: 31.5 } },
  ];
  t.mock.method(AddressModel, 'find', (filter) => queryResult(addresses.filter((address) =>
    filter.user ? String(address.user) === String(filter.user) : address.guestId === filter.guestId,
  )));
  t.mock.method(WarehouseModel, 'find', () => queryResult([warehouse]));

  const userAddresses = await getMyAddressesService({ userId });
  const guestAddresses = await getGuestAddressesService({ guestId: 'prime-address-guest' });
  assert.equal(userAddresses[0].isPrimeLocation, true);
  assert.equal(guestAddresses[0].isPrimeLocation, true);
  assert.equal(userAddresses[0].warehouse, warehouse._id);
  // Stored flags cannot survive a current configuration/status change.
  addresses[0].isPrimeLocation = true;
  warehouse.fulfillment.status = 'MAINTENANCE';
  const refreshed = await getMyAddressesService({ userId });
  assert.equal(refreshed[0].isPrimeLocation, false);
});

test('cart and checkout use the Prime fee while preserving threshold and address contract', async (t) => {
  const warehouse = makeWarehouse();
  const cart = makeCart(warehouse, { subtotal: 100 });
  mockCartModels(t, warehouse, cart);
  const productId = cart.items[0].product;
  assert.ok(productId);

  const cartResponse = await getCartService({ userId: null, guestId: cart.guestId, warehouseId: warehouse._id });
  assert.equal(cartResponse.isPrimeLocation, true);
  assert.equal(cartResponse.shippingFee, 20);
  assert.equal(cartResponse.deliveryAddress.warehouse, undefined);
  assert.equal(cartResponse.deliveryAddress.location.lat, 29.95);

  const checkout = await getCheckoutSummaryService({ userId: null, guestId: cart.guestId });
  assert.equal(checkout.isPrimeLocation, true);
  assert.equal(checkout.pricing.shippingFee, 20);
  assert.equal(checkout.pricing.total, 120);

  cart.totalCartPrice = 3000;
  cart.items[0].quantity = 30;
  const threshold = await getCheckoutSummaryService({ userId: null, guestId: cart.guestId });
  assert.equal(threshold.pricing.shippingFee, 0);

  cart.totalCartPrice = 3001;
  cart.items[0].quantity = 30.01;
  const overThreshold = await getCheckoutSummaryService({ userId: null, guestId: cart.guestId });
  assert.equal(overThreshold.pricing.shippingFee, 0);
});

test('zero and default-equal Prime prices are retained below the threshold', async (t) => {
  const warehouse = makeWarehouse();
  const cart = makeCart(warehouse, { subtotal: 100 });
  mockCartModels(t, warehouse, cart);
  for (const primeShippingPrice of [0, 50]) {
    warehouse.primeShippingPrice = primeShippingPrice;
    const response = await getCartService({ userId: null, guestId: cart.guestId, warehouseId: warehouse._id });
    assert.equal(response.isPrimeLocation, true);
    assert.equal(response.shippingFee, primeShippingPrice);
  }
});

test('legacy or disabled Prime configuration retains default shipping price', async (t) => {
  const warehouse = makeWarehouse({ prime: false });
  const cart = makeCart(warehouse);
  mockCartModels(t, warehouse, cart);

  const result = await getCartService({ userId: null, guestId: cart.guestId, warehouseId: warehouse._id });
  assert.equal(result.isPrimeLocation, false);
  assert.equal(result.shippingFee, 50);
});

test('Prime shipping combines with fixed, percent, and free-shipping coupons', async (t) => {
  const warehouse = makeWarehouse();
  const cart = makeCart(warehouse, { subtotal: 100 });
  mockCartModels(t, warehouse, cart);
  let activeCoupon;
  t.mock.method(CouponModel, 'findOne', () => queryResult(activeCoupon));

  for (const [coupon, expected] of [
    [{ code: 'FIXED', discountType: 'FIXED', discountValue: 10, freeShipping: false }, { total: 110, discount: 10, shippingDiscount: 0 }],
    [{ code: 'PERCENT', discountType: 'PERCENT', discountValue: 10, freeShipping: false }, { total: 110, discount: 10, shippingDiscount: 0 }],
    [{ code: 'FREESHIP', freeShipping: true }, { total: 100, discount: 0, shippingDiscount: 20 }],
  ]) {
    activeCoupon = { ...coupon, _id: new mongoose.Types.ObjectId() };
    const result = await applyCouponAtCheckoutService({ guestId: cart.guestId, couponCode: coupon.code });
    assert.equal(result.isPrimeLocation, true);
    assert.equal(result.pricing.shippingBefore, 20);
    assert.equal(result.pricing.finalTotal, expected.total);
    assert.equal(result.pricing.discountAmount, expected.discount);
    assert.equal(result.pricing.shippingDiscount, expected.shippingDiscount);
  }
});

test('guest card order persists Prime fee and sends that total to the mocked payment gateway', async (t) => {
  const warehouse = makeWarehouse();
  const cart = makeCart(warehouse, { subtotal: 100 });
  cart.deliveryAddress.guestAddressId = new mongoose.Types.ObjectId();
  let savedOrder;
  let paymentBody;
  const session = { async withTransaction(callback) { return callback(); }, endSession() {} };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(WarehouseModel, 'findById', () => queryResult(warehouse));
  t.mock.method(ProductModel, 'find', () => queryResult([{
    _id: cart.items[0].product,
    type: 'SIMPLE',
    price: 100,
    discountedPrice: null,
    subcategory: null,
    brand: null,
    variants: [],
    images: [],
    warehouseStocks: [{ warehouse: warehouse._id, quantity: 10 }],
  }]));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, 'findOne', () => queryResult(null));
  t.mock.method(SubcategoryModel, 'find', () => queryResult([]));
  t.mock.method(OrderModel, 'findOne', () => queryResult(null));
  t.mock.method(OrderModel, 'create', async ([doc]) => {
    savedOrder = { ...doc, _id: new mongoose.Types.ObjectId() };
    return [savedOrder];
  });
  t.mock.method(OrderModel, 'updateOne', async () => ({ acknowledged: true }));

  const oldEnv = {
    secret: process.env.PAYMOB_SECRET_KEY,
    public: process.env.PAYMOB_PUBLIC_KEY,
    integration: process.env.PAYMOB_INTEGRATION_ID,
  };
  process.env.PAYMOB_SECRET_KEY = 'test-secret';
  process.env.PAYMOB_PUBLIC_KEY = 'test-public';
  process.env.PAYMOB_INTEGRATION_ID = '123';
  t.after(() => {
    if (oldEnv.secret === undefined) delete process.env.PAYMOB_SECRET_KEY;
    else process.env.PAYMOB_SECRET_KEY = oldEnv.secret;
    if (oldEnv.public === undefined) delete process.env.PAYMOB_PUBLIC_KEY;
    else process.env.PAYMOB_PUBLIC_KEY = oldEnv.public;
    if (oldEnv.integration === undefined) delete process.env.PAYMOB_INTEGRATION_ID;
    else process.env.PAYMOB_INTEGRATION_ID = oldEnv.integration;
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    paymentBody = JSON.parse(options.body);
    return { ok: true, async json() { return { client_secret: 'test-client-secret', intention_order_id: 'test-order' }; } };
  });

  const result = await createOrderForGuestService({ guestId: cart.guestId, paymentMethod: 'CARD' });
  assert.equal(result.order, savedOrder);
  assert.equal(savedOrder.isPrimeLocation, true);
  assert.equal(savedOrder.shippingFee, 20);
  assert.equal(savedOrder.total, 120);
  assert.equal(savedOrder.settlement.lockedNetShippingPiastres, 2000);
  assert.equal(paymentBody.amount, 12000);
  assert.equal(paymentBody.items[0].amount, 12000);
});

test('user card order applies wallet only to merchandise and persists remaining Prime shipping', async (t) => {
  const warehouse = makeWarehouse();
  const userId = new mongoose.Types.ObjectId();
  const cart = makeCart(warehouse, { subtotal: 100, userId });
  cart.user = { _id: userId, name: 'Prime Test', phone: '01012345678' };
  cart.deliveryAddress.userAddressId = new mongoose.Types.ObjectId();
  let savedOrder;
  let paymentBody;
  const session = { async withTransaction(callback) { return callback(); }, endSession() {} };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(WarehouseModel, 'findById', () => queryResult(warehouse));
  t.mock.method(ProductModel, 'find', () => queryResult([{
    _id: cart.items[0].product,
    type: 'SIMPLE',
    price: 100,
    discountedPrice: null,
    subcategory: null,
    brand: null,
    variants: [],
    images: [],
    warehouseStocks: [{ warehouse: warehouse._id, quantity: 10 }],
  }]));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, 'findOne', () => queryResult(null));
  t.mock.method(SubcategoryModel, 'find', () => queryResult([]));
  t.mock.method(OrderModel, 'findOne', () => queryResult(null));
  t.mock.method(OrderModel, 'create', async ([doc]) => {
    savedOrder = { ...doc, _id: new mongoose.Types.ObjectId() };
    return [savedOrder];
  });
  t.mock.method(OrderModel, 'updateOne', async () => ({ acknowledged: true }));
  t.mock.method(UserModel, 'findById', () => queryResult({ walletBalance: 1000, name: 'Prime Test', email: 'test@example.invalid' }));
  t.mock.method(SavedCardModel, 'find', () => queryResult([]));

  const oldEnv = {
    secret: process.env.PAYMOB_SECRET_KEY,
    public: process.env.PAYMOB_PUBLIC_KEY,
    integration: process.env.PAYMOB_INTEGRATION_ID,
  };
  process.env.PAYMOB_SECRET_KEY = 'test-secret';
  process.env.PAYMOB_PUBLIC_KEY = 'test-public';
  process.env.PAYMOB_INTEGRATION_ID = '123';
  t.after(() => {
    if (oldEnv.secret === undefined) delete process.env.PAYMOB_SECRET_KEY;
    else process.env.PAYMOB_SECRET_KEY = oldEnv.secret;
    if (oldEnv.public === undefined) delete process.env.PAYMOB_PUBLIC_KEY;
    else process.env.PAYMOB_PUBLIC_KEY = oldEnv.public;
    if (oldEnv.integration === undefined) delete process.env.PAYMOB_INTEGRATION_ID;
    else process.env.PAYMOB_INTEGRATION_ID = oldEnv.integration;
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    paymentBody = JSON.parse(options.body);
    return { ok: true, async json() { return { client_secret: 'test-client-secret', intention_order_id: 'test-order' }; } };
  });

  const result = await createOrderForUserService({ userId, paymentMethod: 'CARD' });
  assert.equal(result.order, savedOrder);
  assert.equal(savedOrder.isPrimeLocation, true);
  assert.equal(savedOrder.shippingFee, 20);
  assert.equal(savedOrder.walletUsed, 100);
  assert.equal(savedOrder.total, 20);
  assert.equal(savedOrder.settlement.lockedNetShippingPiastres, 2000);
  assert.equal(paymentBody.amount, 2000);
  assert.equal(paymentBody.items[0].amount, 2000);
});

test('guest COD order persists coupon shipping discount and decrements stock', async (t) => {
  const warehouse = makeWarehouse();
  const cart = makeCart(warehouse, { subtotal: 100 });
  cart.deliveryAddress.guestAddressId = new mongoose.Types.ObjectId();
  let savedOrder;
  let storedStock;
  const product = {
    _id: cart.items[0].product,
    type: 'SIMPLE',
    price: 100,
    discountedPrice: null,
    subcategory: null,
    brand: null,
    variants: [],
    images: [],
    warehouseStocks: [{ warehouse: warehouse._id, quantity: 10 }],
    async save() { storedStock = this.warehouseStocks[0].quantity; },
  };
  const session = { async withTransaction(callback) { return callback(); }, endSession() {} };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(WarehouseModel, 'findById', () => queryResult(warehouse));
  t.mock.method(ProductModel, 'find', () => queryResult([product]));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, 'findOne', () => queryResult(null));
  t.mock.method(SubcategoryModel, 'find', () => queryResult([]));
  t.mock.method(CouponModel, 'findOne', () => queryResult({
    _id: new mongoose.Types.ObjectId(),
    code: 'FREESHIP',
    isActive: true,
    usageCount: 0,
    freeShipping: true,
  }));
  t.mock.method(CouponModel, 'updateOne', async () => ({ acknowledged: true }));
  t.mock.method(OrderModel, 'findOne', () => queryResult(null));
  t.mock.method(OrderModel, 'create', async ([doc]) => {
    savedOrder = { ...doc, _id: new mongoose.Types.ObjectId() };
    return [savedOrder];
  });
  t.mock.method(UserModel, 'find', () => queryResult([]));
  t.mock.method(WalletTransactionModel, 'create', async () => []);

  const result = await createOrderForGuestService({ guestId: cart.guestId, paymentMethod: 'COD', couponCode: 'FREESHIP' });
  assert.equal(result.order, savedOrder);
  assert.equal(savedOrder.isPrimeLocation, true);
  assert.equal(savedOrder.shippingFee, 20);
  assert.equal(savedOrder.shippingDiscount, 20);
  assert.equal(savedOrder.total, 100);
  assert.equal(savedOrder.settlement.lockedNetShippingPiastres, 0);
  assert.equal(storedStock, 9);
});

test('immediate orders preserve merchandise, wallet, stock and locked shipping across the pricing matrix', async (t) => {
  const cases = [
    { name: 'ordinary Prime', subtotal: 100, shipping: 20 },
    { name: 'fixed coupon with partial wallet', subtotal: 100, shipping: 20, wallet: 30, discount: 10, coupon: { discountType: 'FIXED', discountValue: 10 } },
    { name: 'percent coupon with full merchandise wallet', subtotal: 100, shipping: 20, wallet: 1000, discount: 10, coupon: { discountType: 'PERCENT', discountValue: 10 } },
    { name: 'free shipping with wallet', subtotal: 100, shipping: 20, wallet: 30, coupon: { freeShipping: true } },
    { name: 'zero Prime price', subtotal: 100, shipping: 0, primePrice: 0 },
    { name: 'both prices zero', subtotal: 100, shipping: 0, primePrice: 0, defaultPrice: 0 },
    { name: 'equal Prime price', subtotal: 100, shipping: 50, primePrice: 50 },
    { name: 'below threshold', subtotal: 2999, shipping: 20 },
    { name: 'at threshold before coupon', subtotal: 3000, shipping: 0, discount: 10, coupon: { discountType: 'FIXED', discountValue: 10 } },
    { name: 'above threshold', subtotal: 3001, shipping: 0 },
    { name: 'disabled Prime', subtotal: 100, shipping: 50, prime: false },
    { name: 'nonprime point', subtotal: 100, shipping: 50, outside: true },
    { name: 'maintenance fallback with matching Prime', subtotal: 100, shipping: 50, rerouted: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const warehouse = makeWarehouse({ prime: scenario.prime !== false });
      warehouse.defaultShippingPrice = scenario.defaultPrice ?? 50;
      if (scenario.primePrice !== undefined) warehouse.primeShippingPrice = scenario.primePrice;
      const userId = new mongoose.Types.ObjectId();
      const cart = makeCart(warehouse, { userId });
      cart.user = { _id: userId, name: 'Prime customer', phone: '01012345678' };
      cart.items[0].itemPrice = scenario.subtotal;
      cart.totalCartPrice = scenario.subtotal;
      if (scenario.outside) cart.deliveryAddress.location = { lat: 30, lng: 31.55 };
      const source = scenario.rerouted ? {
        ...warehouse, _id: new mongoose.Types.ObjectId(),
        fulfillment: { status: 'MAINTENANCE', fallbackWarehouse: warehouse._id },
      } : warehouse;
      cart.warehouse = source._id;
      cart.deliveryAddress.warehouse = source._id;
      let savedOrder, walletTransaction, walletDebit, couponUses = 0;
      let walletBalance = scenario.wallet || 0;
      const product = {
        _id: cart.items[0].product, type: 'SIMPLE', price: scenario.subtotal,
        name_en: 'Item', images: [], variants: [],
        warehouseStocks: [{ warehouse: warehouse._id, quantity: 10, revision: 0 }],
        async save() {},
      };
      const session = { async withTransaction(callback) { return callback(); }, endSession() {} };
      t.mock.method(mongoose, 'startSession', async () => session);
      t.mock.method(CartModel, 'findOne', () => queryResult(cart));
      t.mock.method(WarehouseModel, 'findById', (id) => queryResult(String(id) === String(source._id) ? source : warehouse));
      t.mock.method(ProductModel, 'find', () => queryResult([product]));
      t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
      t.mock.method(CollectionModel, 'findOne', () => queryResult(null));
      t.mock.method(SubcategoryModel, 'find', () => queryResult([]));
      t.mock.method(OrderModel, 'create', async ([doc]) => {
        savedOrder = { ...doc, _id: new mongoose.Types.ObjectId() };
        return [savedOrder];
      });
      t.mock.method(UserModel, 'findById', () => queryResult({ walletBalance }));
      t.mock.method(UserModel, 'find', () => queryResult([]));
      t.mock.method(UserModel, 'updateOne', async (filter, update, options) => {
        assert.equal(options.session, session);
        assert.equal(filter.walletBalance.$gte, -update.$inc.walletBalance);
        walletDebit = -update.$inc.walletBalance;
        walletBalance -= walletDebit;
        return { matchedCount: 1 };
      });
      t.mock.method(WalletTransactionModel, 'create', async ([doc], options) => {
        assert.equal(options.session, session);
        walletTransaction = doc;
        return [doc];
      });
      t.mock.method(CouponModel, 'findOne', () => queryResult({
        _id: new mongoose.Types.ObjectId(), code: 'TEST', isActive: true, ...scenario.coupon,
      }));
      t.mock.method(CouponModel, 'updateOne', async () => { couponUses++; return { matchedCount: 1 }; });
      const paymentMethod = scenario.wallet ? 'POS_ON_DELIVERY' : 'COD';
      const { order } = await createOrderForUserService({ userId, paymentMethod, couponCode: scenario.coupon ? 'TEST' : undefined });
      const discount = scenario.discount || 0;
      const netShipping = scenario.coupon?.freeShipping ? 0 : scenario.shipping;
      const walletUsed = Math.min(scenario.wallet || 0, scenario.subtotal - discount);
      const total = scenario.subtotal - discount - walletUsed + netShipping;
      assert.equal(order, savedOrder);
      assert.equal(order.isPrimeLocation, scenario.prime !== false && !scenario.outside && !scenario.rerouted);
      assert.equal(order.subtotal, scenario.subtotal);
      assert.equal(order.shippingFee, scenario.shipping);
      assert.equal(order.discountAmount, discount);
      assert.equal(order.shippingDiscount, scenario.shipping - netShipping);
      assert.equal(order.totalDiscount, discount + scenario.shipping - netShipping);
      assert.equal(order.walletUsed, walletUsed);
      assert.equal(order.total, total);
      assert.equal(order.settlement.lockedNetShippingPiastres, netShipping * 100);
      assert.equal(order.settlement.currentOrderValuePiastres, (scenario.subtotal - discount + netShipping) * 100);
      assert.equal(order.settlement.walletDebitedPiastres, walletUsed * 100);
      assert.equal(order.settlement.deliveryDuePiastres, total * 100);
      assert.equal(order.settlement.cardDuePiastres, 0);
      assert.equal(product.warehouseStocks[0].quantity, 9);
      assert.equal(product.warehouseStocks[0].revision, 1);
      assert.equal(couponUses, scenario.coupon ? 1 : 0);
      assert.deepEqual(cart.items, []);
      if (walletUsed) {
        assert.equal(walletDebit, walletUsed);
        assert.equal(walletTransaction.amount, -walletUsed);
        assert.equal(walletTransaction.balanceAfter, walletBalance);
      } else {
        assert.equal(walletDebit, undefined);
        assert.equal(walletTransaction, undefined);
      }
    });
  }
});
