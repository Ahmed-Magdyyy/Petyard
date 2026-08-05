import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import {
  getTargetStockEntries,
  productStockSnapshot,
  summarizeSnapshots,
  TARGET_WAREHOUSE,
} from "../../scripts/setWarehouseStockZero.js";

function objectId() {
  return new mongoose.Types.ObjectId();
}

test("stock snapshot keeps warehouse identity separate for simple products", () => {
  const otherWarehouse = objectId();
  const snapshot = productStockSnapshot({
    _id: objectId(),
    type: "SIMPLE",
    warehouseStocks: [
      { warehouse: TARGET_WAREHOUSE.id, quantity: 12 },
      { warehouse: otherWarehouse, quantity: 7 },
    ],
  });

  assert.deepEqual(
    getTargetStockEntries(snapshot, TARGET_WAREHOUSE.id).map((entry) => ({
      kind: entry.kind,
      quantity: entry.quantity,
    })),
    [{ kind: "simple", quantity: 12 }],
  );
  assert.equal(snapshot.warehouseStocks[1].warehouseId, String(otherWarehouse));
  assert.equal(snapshot.warehouseStocks[1].quantity, 7);
});

test("variant summary counts every target variant entry without other warehouses", () => {
  const otherWarehouse = objectId();
  const snapshot = productStockSnapshot({
    _id: objectId(),
    type: "VARIANT",
    variants: [
      {
        _id: objectId(),
        sku: "VAR-1",
        warehouseStocks: [
          { warehouse: TARGET_WAREHOUSE.id, quantity: 4 },
          { warehouse: otherWarehouse, quantity: 9 },
        ],
      },
      {
        _id: objectId(),
        sku: "VAR-2",
        warehouseStocks: [{ warehouse: TARGET_WAREHOUSE.id, quantity: 0 }],
      },
      {
        _id: objectId(),
        sku: "VAR-3",
        warehouseStocks: [{ warehouse: otherWarehouse, quantity: 3 }],
      },
    ],
  });

  const summary = summarizeSnapshots([snapshot], TARGET_WAREHOUSE.id);
  assert.equal(summary.variantTargetEntries, 2);
  assert.equal(summary.variantEntriesChangingToZero, 1);
  assert.equal(summary.variantEntriesAlreadyZero, 1);
  assert.equal(summary.variantQuantityBefore, 4);
  assert.equal(summary.variantsWithTargetEntry, 2);
  assert.equal(summary.variantsWithoutTargetEntry, 1);
  assert.equal(summary.productsRequiringChange, 1);
});
