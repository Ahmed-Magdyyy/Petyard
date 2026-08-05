import assert from "node:assert/strict";
import test from "node:test";

import { completeWarehouseStocks } from "../../src/domains/product/productWarehouseStocks.js";

const warehouseIds = ["warehouse-a", "warehouse-b", "warehouse-c"];

test("fills omitted warehouse stock records with zero", () => {
  assert.deepEqual(
    completeWarehouseStocks(
      [{ warehouse: "warehouse-b", quantity: 7 }],
      warehouseIds,
    ),
    [
      { warehouse: "warehouse-a", quantity: 0 },
      { warehouse: "warehouse-b", quantity: 7 },
      { warehouse: "warehouse-c", quantity: 0 },
    ],
  );
});

test("allows all warehouse stocks to be omitted", () => {
  assert.deepEqual(completeWarehouseStocks(undefined, warehouseIds), [
    { warehouse: "warehouse-a", quantity: 0 },
    { warehouse: "warehouse-b", quantity: 0 },
    { warehouse: "warehouse-c", quantity: 0 },
  ]);
});

test("rejects duplicate warehouse stock records", () => {
  assert.throws(
    () =>
      completeWarehouseStocks(
        [
          { warehouse: "warehouse-a", quantity: 1 },
          { warehouse: "warehouse-a", quantity: 2 },
        ],
        warehouseIds,
      ),
    (error) =>
      error.statusCode === 400 && /duplicate warehouses/i.test(error.message),
  );
});

test("rejects stock records for unknown warehouses", () => {
  assert.throws(
    () =>
      completeWarehouseStocks(
        [{ warehouse: "warehouse-unknown", quantity: 1 }],
        warehouseIds,
      ),
    (error) =>
      error.statusCode === 400 && /do not exist/i.test(error.message),
  );
});
