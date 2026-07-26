import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { validationResult } from 'express-validator';

import { updateWarehouseValidator } from '../../src/domains/warehouse/warehouse.validators.js';

test('warehouse PATCH validator accepts the complete supported body', async () => {
  const request = {
    params: { id: String(new mongoose.Types.ObjectId()) },
    body: {
      name: '3rd settlement El-Andalus',
      code: '3RD_SETTLEMENT',
      country: 'egypt',
      governorate: 'cairo',
      address: 'New Cairo',
      email: 'warehouse@example.com',
      phone: '01012345678',
      location: {
        type: 'Point',
        coordinates: [31.51959, 29.96928],
      },
      boundaryGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [31.5, 29.9],
            [31.6, 29.9],
            [31.6, 30],
            [31.5, 29.9],
          ],
        ],
      },
      defaultShippingPrice: 50,
      isDefault: false,
      active: true,
      moderators: [],
      fulfillment: {
        status: 'MAINTENANCE',
        fallbackWarehouse: String(new mongoose.Types.ObjectId()),
        statusReason: 'Maintenance and restocking',
      },
    },
  };

  for (const validator of updateWarehouseValidator.slice(0, -1)) {
    await validator.run(request);
  }

  assert.deepEqual(validationResult(request).array(), []);
});

test('warehouse PATCH validator normalizes boolean strings', async () => {
  const request = {
    params: { id: String(new mongoose.Types.ObjectId()) },
    body: { active: 'false', isDefault: 'true' },
  };

  for (const validator of updateWarehouseValidator.slice(0, -1)) {
    await validator.run(request);
  }

  assert.deepEqual(validationResult(request).array(), []);
  assert.equal(request.body.active, false);
  assert.equal(request.body.isDefault, true);
});
