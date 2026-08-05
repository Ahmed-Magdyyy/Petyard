import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import {
  analyzeWarehouseCoverage,
  EXPECTED_WAREHOUSES,
  verifyNormalization,
} from "../../scripts/normalizeProductWarehouseStocks.js";
import { productStockSnapshot } from "../../scripts/setWarehouseStockZero.js";

function id() {
  return new mongoose.Types.ObjectId();
}

test("coverage analysis reports only genuinely missing simple entries", () => {
  const snapshot = productStockSnapshot({
    _id: id(),
    type: "SIMPLE",
    warehouseStocks: [
      { warehouse: EXPECTED_WAREHOUSES[0].id, quantity: 8 },
      { warehouse: EXPECTED_WAREHOUSES[2].id, quantity: 0 },
    ],
  });

  const analysis = analyzeWarehouseCoverage([snapshot]);
  assert.equal(analysis.summary.missingSimpleEntries, 2);
  assert.equal(analysis.summary.productsRequiringChange, 1);
  assert.deepEqual(analysis.changes[0].simpleMissingWarehouseIds, [
    EXPECTED_WAREHOUSES[1].id,
    EXPECTED_WAREHOUSES[3].id,
  ]);
});

test("normalization verification preserves existing quantities and accepts zero defaults", () => {
  const productId = id();
  const before = productStockSnapshot({
    _id: productId,
    type: "VARIANT",
    variants: [
      {
        _id: id(),
        sku: "V-1",
        warehouseStocks: [
          { warehouse: EXPECTED_WAREHOUSES[0].id, quantity: 14 },
        ],
      },
    ],
  });
  const after = structuredClone(before);
  after.variants[0].warehouseStocks.push(
    ...EXPECTED_WAREHOUSES.slice(1).map((warehouse) => ({
      index: after.variants[0].warehouseStocks.length,
      warehouseId: warehouse.id,
      quantity: 0,
    })),
  );
  after.variants[0].warehouseStocks.forEach((stock, index) => {
    stock.index = index;
  });

  assert.doesNotThrow(() => verifyNormalization([before], [after]));
  assert.equal(after.variants[0].warehouseStocks[0].quantity, 14);
});

test("normalization verification rejects changes to existing warehouse quantities", () => {
  const before = productStockSnapshot({
    _id: id(),
    type: "SIMPLE",
    warehouseStocks: EXPECTED_WAREHOUSES.map((warehouse) => ({
      warehouse: warehouse.id,
      quantity: 5,
    })),
  });
  const after = structuredClone(before);
  after.warehouseStocks[0].quantity = 0;

  assert.throws(
    () => verifyNormalization([before], [after]),
    /existing stock entry changed/,
  );
});
