import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

import { AddressModel } from '../../src/domains/address/address.model.js';
import { addMyAddressService } from '../../src/domains/address/address.service.js';
import { CartModel } from '../../src/domains/cart/cart.model.js';
import { getCartService } from '../../src/domains/cart/cart.service.js';
import { getCheckoutSummaryService } from '../../src/domains/checkout/checkout.service.js';
import { CollectionModel } from '../../src/domains/collection/collection.model.js';
import { resolveLocationByCoordinatesService } from '../../src/domains/location/location.service.js';
import { resolveOrderCartWarehouse } from '../../src/domains/order/order.service.js';
import { ProductModel } from '../../src/domains/product/product.model.js';
import { getProductsService } from '../../src/domains/product/product.service.js';
import { warehouseFulfillmentStatusEnum } from '../../src/shared/constants/enums.js';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';

function queryResult(value) {
  const query = {
    select() {
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
    sort() {
      return query;
    },
    skip() {
      return query;
    },
    limit() {
      return query;
    },
    populate() {
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

function makeWarehousePair() {
  const fallback = {
    _id: new mongoose.Types.ObjectId(),
    name: '5th Settlement New Cairo',
    code: '5TH_SETTELMENT',
    governorate: 'cairo',
    active: true,
    isDefault: true,
    defaultShippingPrice: 60,
    fulfillment: {
      status: warehouseFulfillmentStatusEnum.OPERATIONAL,
      fallbackWarehouse: null,
    },
  };
  const source = {
    _id: new mongoose.Types.ObjectId(),
    name: 'El-Andalus',
    code: '3RD_SETTELMENT',
    governorate: 'cairo',
    active: true,
    isDefault: false,
    defaultShippingPrice: 50,
    location: { type: 'Point', coordinates: [31.5, 29.95] },
    boundaryGeometry: {
      type: 'Polygon',
      coordinates: [
        [
          [31.45, 29.9],
          [31.55, 29.9],
          [31.55, 30],
          [31.45, 30],
          [31.45, 29.9],
        ],
      ],
    },
    fulfillment: {
      status: warehouseFulfillmentStatusEnum.MAINTENANCE,
      fallbackWarehouse: fallback._id,
    },
  };
  return { source, fallback };
}

function mockWarehouseLookup(t, source, fallback) {
  t.mock.method(WarehouseModel, 'findById', (id) =>
    queryResult(
      String(id) === String(source._id)
        ? source
        : String(id) === String(fallback._id)
          ? fallback
          : null,
    ),
  );
}

function makeEmptyCart(source) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user: null,
    guestId: 'guest-routing-test',
    warehouse: source._id,
    currency: 'EGP',
    items: [],
    totalCartPrice: 0,
    status: 'ACTIVE',
    checkoutKey: 'checkout-routing-test',
    async save() {
      return this;
    },
  };
}

test('location keeps the zone warehouse and returns the effective warehouse', async (t) => {
  const { source, fallback } = makeWarehousePair();
  t.mock.method(WarehouseModel, 'find', () => queryResult([source]));
  mockWarehouseLookup(t, source, fallback);

  const result = await resolveLocationByCoordinatesService({
    lat: 29.95,
    lng: 31.5,
  });

  assert.equal(String(result.zoneWarehouse.id), String(source._id));
  assert.equal(String(result.warehouse.id), String(fallback._id));
  assert.equal(result.warehouseRouting.rerouted, true);
  assert.equal(result.delivery.shippingFee, fallback.defaultShippingPrice);
});

test('saved address stores the geographic zone warehouse during maintenance', async (t) => {
  const { source, fallback } = makeWarehousePair();
  let createdFields = null;

  t.mock.method(WarehouseModel, 'find', () => queryResult([source]));
  mockWarehouseLookup(t, source, fallback);
  t.mock.method(AddressModel, 'countDocuments', async () => 0);
  t.mock.method(AddressModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(AddressModel, 'create', async (fields) => {
    createdFields = fields;
    return fields;
  });
  t.mock.method(AddressModel, 'find', () => queryResult([]));

  await addMyAddressService({
    userId: new mongoose.Types.ObjectId(),
    payload: {
      label: 'Home',
      location: { lat: 29.95, lng: 31.5 },
    },
  });

  assert.equal(String(createdFields.warehouse), String(source._id));
  assert.notEqual(String(createdFields.warehouse), String(fallback._id));
});

test('public products use fallback warehouse stock', async (t) => {
  const { source, fallback } = makeWarehousePair();
  let productFilter = null;

  mockWarehouseLookup(t, source, fallback);
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(ProductModel, 'countDocuments', async (filter) => {
    productFilter = filter;
    return 0;
  });
  t.mock.method(ProductModel, 'find', () => queryResult([]));

  const result = await getProductsService({ warehouse: String(source._id) });
  const serializedFilter = JSON.stringify(productFilter);

  assert.equal(result.results, 0);
  assert.match(serializedFilter, new RegExp(String(fallback._id)));
  assert.doesNotMatch(serializedFilter, new RegExp(String(source._id)));
});

test('new guest cart is assigned to the effective warehouse', async (t) => {
  const { source, fallback } = makeWarehousePair();
  const cart = makeEmptyCart(source);

  mockWarehouseLookup(t, source, fallback);
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));

  const result = await getCartService({
    userId: null,
    guestId: cart.guestId,
    warehouseId: source._id,
  });

  assert.equal(String(result.warehouseId), String(fallback._id));
  assert.equal(result.shippingFee, fallback.defaultShippingPrice);
  assert.equal(String(cart.warehouse), String(fallback._id));
});

test('checkout rebinds stock and shipping to the effective warehouse', async (t) => {
  const { source, fallback } = makeWarehousePair();
  const productId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  const cart = makeEmptyCart(source);
  cart.items = [
    {
      _id: itemId,
      product: productId,
      productType: 'SIMPLE',
      productName: 'Test product',
      quantity: 1,
      itemPrice: 100,
    },
  ];
  cart.deliveryAddress = {
    name: 'Test User',
    governorate: 'Cairo',
    area: 'New Cairo',
    phone: '01012345678',
    building: '1',
    floor: '2',
    apartment: '3',
    location: { lat: 29.95, lng: 31.5 },
    details: 'Near the main gate',
  };

  const product = {
    _id: productId,
    type: 'SIMPLE',
    name_en: 'Test product',
    name_ar: 'Test product',
    price: 100,
    discountedPrice: null,
    images: [],
    subcategory: null,
    brand: null,
    warehouseStocks: [{ warehouse: fallback._id, quantity: 10 }],
    variants: [],
  };

  mockWarehouseLookup(t, source, fallback);
  t.mock.method(CartModel, 'findOne', () => queryResult(cart));
  t.mock.method(ProductModel, 'find', () => queryResult([product]));
  t.mock.method(CollectionModel, 'updateMany', async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, 'findOne', () => queryResult(null));

  const result = await getCheckoutSummaryService({
    userId: null,
    guestId: cart.guestId,
    lang: 'en',
  });

  assert.equal(String(result.warehouseId), String(fallback._id));
  assert.equal(result.items.length, 1);
  assert.equal(result.pricing.shippingFee, fallback.defaultShippingPrice);
  assert.equal(String(cart.warehouse), String(fallback._id));
});

test('order finalization resolves a stale source warehouse to the fallback', async (t) => {
  const { source, fallback } = makeWarehousePair();
  const cart = { warehouse: source._id };

  mockWarehouseLookup(t, source, fallback);

  const warehouseId = await resolveOrderCartWarehouse(cart);

  assert.equal(String(warehouseId), String(fallback._id));
  assert.equal(String(cart.warehouse), String(fallback._id));
});
