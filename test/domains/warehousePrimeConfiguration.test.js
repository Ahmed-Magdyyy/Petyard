import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { validationResult } from 'express-validator';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';
import { createWarehouseService, updateWarehouseService } from '../../src/domains/warehouse/warehouse.service.js';
import { createWarehouseValidator, updateWarehouseValidator } from '../../src/domains/warehouse/warehouse.validators.js';

const ring = [[31.4, 29.9], [31.6, 29.9], [31.6, 30.1], [31.4, 30.1], [31.4, 29.9]];
const primeRing = [[31.48, 29.98], [31.52, 29.98], [31.52, 30.02], [31.48, 30.02], [31.48, 29.98]];
const boundaryGeometry = { type: 'Polygon', coordinates: [ring] };
const primeBoundaryGeometry = { type: 'MultiPolygon', coordinates: [[primeRing]] };
const data = () => ({
  _id: new mongoose.Types.ObjectId(), __v: 0, name: 'Warehouse', code: 'PRIME',
  active: true, isDefault: false, defaultShippingPrice: 50,
  boundaryGeometry, primeBoundaryGeometry, primeShippingPrice: 20,
  fulfillment: { status: 'OPERATIONAL' },
});

test('warehouse validators accept Prime zero/null and retain old requests', async () => {
  for (const rules of [createWarehouseValidator, updateWarehouseValidator]) {
    for (const extra of [{}, { primeBoundaryGeometry, primeShippingPrice: 0 },
      { primeBoundaryGeometry: null, primeShippingPrice: null }]) {
      const request = { params: { id: String(new mongoose.Types.ObjectId()) }, body: { name: 'Warehouse', code: 'PRIME', ...extra } };
      for (const validator of rules.slice(0, -1)) await validator.run(request);
      assert.deepEqual(validationResult(request).array(), []);
    }
  }
});

test('invalid Prime creation cannot clear the default warehouse', async (t) => {
  t.mock.method(WarehouseModel, 'updateMany', async () => assert.fail('must validate before side effects'));
  t.mock.method(WarehouseModel, 'create', async () => assert.fail('must not create invalid configuration'));
  await assert.rejects(createWarehouseService({ name: 'Warehouse', code: 'PRIME', isDefault: true, primeShippingPrice: 20 }), { statusCode: 400 });
});

test('warehouse creation persists a zero Prime price explicitly', async (t) => {
  let captured;
  t.mock.method(WarehouseModel, 'create', async (fields) => { captured = fields; return fields; });
  await createWarehouseService({ name: 'Warehouse', code: 'PRIME', boundaryGeometry, primeBoundaryGeometry, primeShippingPrice: 0, defaultShippingPrice: 0 });
  assert.equal(captured.primeShippingPrice, 0);
  assert.deepEqual(captured.primeBoundaryGeometry, primeBoundaryGeometry);
});

test('warehouse PATCH validates merged normal price and parent geometry before saving', async (t) => {
  const warehouse = WarehouseModel.hydrate(data());
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);
  t.mock.method(WarehouseModel.collection, 'updateOne', async () => assert.fail('invalid PATCH must not save'));
  await assert.rejects(updateWarehouseService(warehouse._id, { defaultShippingPrice: 10 }), { statusCode: 400 });
  await assert.rejects(updateWarehouseService(warehouse._id, { defaultShippingPrice: null }), { statusCode: 400 });
  await assert.rejects(updateWarehouseService(warehouse._id, { boundaryGeometry: null }), { statusCode: 400 });
  assert.equal(warehouse.defaultShippingPrice, 50);
});

test('Mongoose save guards original delivery fields and clearing removes Prime geometry', async (t) => {
  const warehouse = WarehouseModel.hydrate(data());
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);
  let filter, update;
  t.mock.method(WarehouseModel.collection, 'updateOne', async (where, changes) => {
    filter = where; update = changes;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  await updateWarehouseService(warehouse._id, { primeBoundaryGeometry: null, primeShippingPrice: null });
  assert.equal(filter.primeShippingPrice, 20);
  assert.equal(filter.defaultShippingPrice, 50);
  assert.deepEqual(JSON.parse(JSON.stringify(filter.primeBoundaryGeometry)), primeBoundaryGeometry);
  assert.deepEqual(JSON.parse(JSON.stringify(filter.boundaryGeometry)), boundaryGeometry);
  assert.equal(update.$set.primeShippingPrice, null);
  assert.ok(Object.hasOwn(update.$unset, 'primeBoundaryGeometry'));
});

test('concurrent Prime edits fail with 409 when original conditions no longer match', async (t) => {
  const warehouse = WarehouseModel.hydrate(data());
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);
  t.mock.method(WarehouseModel.collection, 'updateOne', async () => ({ matchedCount: 0, modifiedCount: 0 }));
  await assert.rejects(updateWarehouseService(warehouse._id, { primeShippingPrice: 25 }), { statusCode: 409 });
});

test('legacy warehouse price edits keep the same value and guard concurrent Prime activation', async (t) => {
  const fields = data(); delete fields.primeBoundaryGeometry; delete fields.primeShippingPrice;
  const warehouse = WarehouseModel.hydrate(fields);
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);
  let filter;
  t.mock.method(WarehouseModel.collection, 'updateOne', async (where) => {
    filter = where; return { matchedCount: 1, modifiedCount: 1 };
  });
  await updateWarehouseService(warehouse._id, { defaultShippingPrice: 10 });
  assert.equal(warehouse.defaultShippingPrice, 10);
  assert.equal(filter.primeShippingPrice, null);
  assert.equal(filter.primeBoundaryGeometry, null);
  assert.equal(filter.defaultShippingPrice, 50);
});

test('a stale legacy price edit cannot invalidate newly enabled Prime', async (t) => {
  const fields = data(); delete fields.primeBoundaryGeometry; delete fields.primeShippingPrice;
  const staleWarehouse = WarehouseModel.hydrate(fields);
  t.mock.method(WarehouseModel, 'findById', async () => staleWarehouse);
  const storedPrice = 20; // Another writer has already enabled Prime.
  t.mock.method(WarehouseModel.collection, 'updateOne', async (where) => ({
    matchedCount: where.primeShippingPrice === storedPrice ? 1 : 0,
    modifiedCount: 0,
  }));
  await assert.rejects(updateWarehouseService(staleWarehouse._id, { defaultShippingPrice: 10 }), { statusCode: 409 });
});
