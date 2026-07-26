import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

import { warehouseFulfillmentStatusEnum } from '../../src/shared/constants/enums.js';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';
import {
  createWarehouseService,
  deleteWarehouseService,
  toggleWarehouseActiveService,
  updateWarehouseService,
} from '../../src/domains/warehouse/warehouse.service.js';

function makeWarehouse({
  id = new mongoose.Types.ObjectId(),
  active = true,
  isDefault = false,
  status = warehouseFulfillmentStatusEnum.OPERATIONAL,
  fallbackWarehouse = null,
} = {}) {
  return {
    _id: id,
    active,
    isDefault,
    fulfillment: { status, fallbackWarehouse, statusReason: null },
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
}

test('PATCH cannot deactivate the default warehouse', async (t) => {
  const warehouse = makeWarehouse({ isDefault: true });
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);

  await assert.rejects(
    updateWarehouseService(warehouse._id, { active: false }),
    (error) => error.statusCode === 400 && /default warehouse/i.test(error.message),
  );
  assert.equal(warehouse.saveCalls, 0);
});

test('POST cannot create an inactive default warehouse', async () => {
  await assert.rejects(
    createWarehouseService({
      name: 'Invalid default',
      code: 'INVALID_DEFAULT',
      isDefault: true,
      active: false,
    }),
    (error) => error.statusCode === 400 && /default warehouse/i.test(error.message),
  );
});

test('POST cannot create an inactive maintenance warehouse', async () => {
  await assert.rejects(
    createWarehouseService({
      name: 'Invalid maintenance',
      code: 'INVALID_MAINTENANCE',
      active: false,
      fulfillment: {
        status: warehouseFulfillmentStatusEnum.MAINTENANCE,
        fallbackWarehouse: new mongoose.Types.ObjectId(),
      },
    }),
    (error) => error.statusCode === 400 && /must remain active/i.test(error.message),
  );
});

test('PATCH cannot deactivate a maintenance delivery zone', async (t) => {
  const warehouse = makeWarehouse({
    status: warehouseFulfillmentStatusEnum.MAINTENANCE,
    fallbackWarehouse: new mongoose.Types.ObjectId(),
  });
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);

  await assert.rejects(
    updateWarehouseService(warehouse._id, { active: false }),
    (error) => error.statusCode === 400 && /must remain active/i.test(error.message),
  );
  assert.equal(warehouse.saveCalls, 0);
});

test('toggle-active cannot deactivate a warehouse used by maintenance', async (t) => {
  const fallbackWarehouse = makeWarehouse();
  t.mock.method(WarehouseModel, 'findById', async () => fallbackWarehouse);
  t.mock.method(WarehouseModel, 'exists', async () => ({ _id: new mongoose.Types.ObjectId() }));

  await assert.rejects(
    toggleWarehouseActiveService(fallbackWarehouse._id),
    (error) => error.statusCode === 409 && /maintenance fallback/i.test(error.message),
  );
  assert.equal(fallbackWarehouse.saveCalls, 0);
});

test('toggle-active cannot deactivate the default warehouse', async (t) => {
  const warehouse = makeWarehouse({ isDefault: true });
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);

  await assert.rejects(
    toggleWarehouseActiveService(warehouse._id),
    (error) => error.statusCode === 400 && /default warehouse/i.test(error.message),
  );
  assert.equal(warehouse.saveCalls, 0);
});

test('PATCH cannot make an in-use fallback non-operational', async (t) => {
  const fallbackWarehouse = makeWarehouse();
  const itsFallback = makeWarehouse();

  t.mock.method(WarehouseModel, 'findById', async (id) =>
    String(id) === String(fallbackWarehouse._id) ? fallbackWarehouse : itsFallback,
  );
  t.mock.method(WarehouseModel, 'exists', async () => ({ _id: new mongoose.Types.ObjectId() }));

  await assert.rejects(
    updateWarehouseService(fallbackWarehouse._id, {
      fulfillment: {
        status: warehouseFulfillmentStatusEnum.MAINTENANCE,
        fallbackWarehouse: itsFallback._id,
      },
    }),
    (error) => error.statusCode === 409 && /maintenance fallback/i.test(error.message),
  );
  assert.equal(fallbackWarehouse.saveCalls, 0);
});

test('DELETE cannot remove the default warehouse', async (t) => {
  const warehouse = makeWarehouse({ isDefault: true });
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);

  await assert.rejects(
    deleteWarehouseService(warehouse._id),
    (error) => error.statusCode === 409 && /cannot be deleted/i.test(error.message),
  );
});

test('DELETE cannot remove an in-use maintenance fallback', async (t) => {
  const warehouse = makeWarehouse();
  t.mock.method(WarehouseModel, 'findById', async () => warehouse);
  t.mock.method(WarehouseModel, 'exists', async () => ({ _id: new mongoose.Types.ObjectId() }));

  await assert.rejects(
    deleteWarehouseService(warehouse._id),
    (error) => error.statusCode === 409 && /maintenance fallback/i.test(error.message),
  );
});
