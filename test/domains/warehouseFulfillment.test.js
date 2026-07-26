import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

import { warehouseFulfillmentStatusEnum } from '../../src/shared/constants/enums.js';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';
import {
  isWarehouseOperational,
  resolveEffectiveWarehouse,
  validateFallbackWarehouse,
} from '../../src/domains/warehouse/warehouse.fulfillment.js';

function makeWarehouse({
  id = new mongoose.Types.ObjectId(),
  active = true,
  status = warehouseFulfillmentStatusEnum.OPERATIONAL,
  fallbackWarehouse = null,
  isDefault = false,
} = {}) {
  return {
    _id: id,
    active,
    isDefault,
    fulfillment: {
      status,
      fallbackWarehouse,
    },
  };
}

test('warehouse model defaults fulfillment status to OPERATIONAL', () => {
  const warehouse = new WarehouseModel({ name: 'Alexandria', code: 'ALEX' });

  assert.equal(
    warehouse.fulfillment.status,
    warehouseFulfillmentStatusEnum.OPERATIONAL,
  );
  assert.equal(warehouse.fulfillment.fallbackWarehouse, null);
});

test('operational warehouse fulfills its own zone', async () => {
  const sourceWarehouse = makeWarehouse();

  const result = await resolveEffectiveWarehouse(sourceWarehouse);

  assert.equal(result.zoneWarehouse, sourceWarehouse);
  assert.equal(result.effectiveWarehouse, sourceWarehouse);
  assert.equal(result.rerouted, false);
});

test('ObjectId input is loaded as an id rather than treated as a warehouse document', async (t) => {
  const warehouse = makeWarehouse();
  t.mock.method(WarehouseModel, 'findById', async (id) => {
    assert.equal(String(id), String(warehouse._id));
    return warehouse;
  });

  const result = await resolveEffectiveWarehouse(warehouse._id);

  assert.equal(result.effectiveWarehouse, warehouse);
  assert.equal(result.rerouted, false);
});

test('maintenance warehouse uses its configured operational fallback', async (t) => {
  const fallbackWarehouse = makeWarehouse();
  const sourceWarehouse = makeWarehouse({
    status: warehouseFulfillmentStatusEnum.MAINTENANCE,
    fallbackWarehouse: fallbackWarehouse._id,
  });

  t.mock.method(WarehouseModel, 'findById', async (id) => {
    assert.equal(String(id), String(fallbackWarehouse._id));
    return fallbackWarehouse;
  });

  const result = await resolveEffectiveWarehouse(sourceWarehouse);

  assert.equal(result.zoneWarehouse, sourceWarehouse);
  assert.equal(result.effectiveWarehouse, fallbackWarehouse);
  assert.equal(result.rerouted, true);
});

test('maintenance warehouse uses the operational default when no fallback is configured', async (t) => {
  const sourceWarehouse = makeWarehouse({
    status: warehouseFulfillmentStatusEnum.MAINTENANCE,
  });
  const defaultWarehouse = makeWarehouse({ isDefault: true });

  t.mock.method(WarehouseModel, 'findOne', async () => defaultWarehouse);

  const result = await resolveEffectiveWarehouse(sourceWarehouse);

  assert.equal(result.effectiveWarehouse, defaultWarehouse);
  assert.equal(result.rerouted, true);
});

test('closed warehouse rejects fulfillment instead of silently rerouting', async () => {
  const sourceWarehouse = makeWarehouse({
    status: warehouseFulfillmentStatusEnum.CLOSED,
  });

  await assert.rejects(
    resolveEffectiveWarehouse(sourceWarehouse),
    (error) => error.statusCode === 409 && /closed/i.test(error.message),
  );
});

test('inactive delivery zone rejects fulfillment', async () => {
  const sourceWarehouse = makeWarehouse({ active: false });

  assert.equal(isWarehouseOperational(sourceWarehouse), false);
  await assert.rejects(
    resolveEffectiveWarehouse(sourceWarehouse),
    (error) => error.statusCode === 409 && /inactive/i.test(error.message),
  );
});

test('fallback warehouse cannot reference the source warehouse', async () => {
  const sourceWarehouseId = new mongoose.Types.ObjectId();

  await assert.rejects(
    validateFallbackWarehouse({
      sourceWarehouseId,
      fallbackWarehouseId: sourceWarehouseId,
    }),
    (error) => error.statusCode === 400 && /itself/i.test(error.message),
  );
});
