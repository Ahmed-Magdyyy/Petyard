import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import {
  mapProductToDetailDto,
  updateProductStockService,
} from "../../../src/domains/product/product.service.js";
import { mergeWarehouseStocks } from "../../../src/domains/product/product.middleware.js";
import productRoutes from "../../../src/domains/product/product.routes.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import {
  prepareProductStockRevisionGuard,
  translateStockRevisionSaveError,
} from "../../../src/domains/product/productStockRevision.js";

function simpleProduct({ warehouse, quantity = 8, revision = 6 } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: "revision-product",
    type: "SIMPLE",
    isActive: true,
    name_en: "Revision product",
    name_ar: "Revision product ar",
    desc_en: "Description",
    desc_ar: "Description ar",
    price: 100,
    discountedPrice: null,
    images: [],
    tags: [],
    warehouseStocks: [{ warehouse, quantity, revision }],
    ratingAverage: 0,
    ratingCount: 0,
  };
}

test("staff product details expose stock revisions while shared details keep hiding them", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse });

  const shared = mapProductToDetailDto(product, {
    lang: "en",
    warehouseId: warehouse,
    includeAllLanguages: true,
  });
  const staff = mapProductToDetailDto(product, {
    lang: "en",
    warehouseId: warehouse,
    includeAllLanguages: true,
    includeStockRevisions: true,
  });

  assert.deepEqual(shared.warehouseStocks, [
    { warehouse, quantity: 8 },
  ]);
  assert.deepEqual(staff.warehouseStocks, [
    { warehouse, quantity: 8, revision: 6 },
  ]);

  const sharedShape = JSON.parse(JSON.stringify(shared));
  const staffWithoutRevision = JSON.parse(JSON.stringify(staff));
  for (const stock of staffWithoutRevision.warehouseStocks) {
    delete stock.revision;
  }
  assert.deepEqual(staffWithoutRevision, sharedShape);
});

test("variant staff details expose each warehouse stock revision", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  const product = {
    ...simpleProduct({ warehouse }),
    type: "VARIANT",
    price: undefined,
    warehouseStocks: [],
    options: [{ name: "Size", values: ["1kg"] }],
    variants: [
      {
        _id: variantId,
        price: 120,
        options: [{ name: "Size", value: "1kg" }],
        images: [],
        warehouseStocks: [{ warehouse, quantity: 3, revision: 4 }],
      },
    ],
  };

  const staff = mapProductToDetailDto(product, {
    lang: "en",
    warehouseId: warehouse,
    includeStockRevisions: true,
  });

  assert.deepEqual(staff.variants[0].warehouseStocks, [
    { warehouse, quantity: 3, revision: 4 },
  ]);
});

test("moderator revision scope adds revisions without filtering existing stock rows", () => {
  const firstWarehouse = new mongoose.Types.ObjectId();
  const secondWarehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse: firstWarehouse });
  product.warehouseStocks.push({
    warehouse: secondWarehouse,
    quantity: 5,
    revision: 2,
  });

  const detail = mapProductToDetailDto(product, {
    lang: "en",
    includeStockRevisions: true,
    stockRevisionWarehouseScope: [firstWarehouse],
  });

  assert.equal(detail.stock, 13);
  assert.deepEqual(detail.warehouseStocks, [
    { warehouse: firstWarehouse, quantity: 8, revision: 6 },
    { warehouse: secondWarehouse, quantity: 5 },
  ]);
});

test("legacy stock bodies remain unguarded and valid", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse });

  const expectations = prepareProductStockRevisionGuard(product, {
    warehouseStocks: [{ warehouse, quantity: 7 }],
  });

  assert.deepEqual(expectations, []);
  assert.equal(product.$where, undefined);
});

test("matching expectedRevision adds an atomic save guard", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse, quantity: 8, revision: 6 });

  const expectations = prepareProductStockRevisionGuard(product, {
    warehouseStocks: [
      { warehouse, quantity: 7, expectedRevision: 6 },
    ],
  });

  assert.equal(expectations.length, 1);
  assert.deepEqual(product.$where, {
    $and: [
      {
        warehouseStocks: {
          $elemMatch: { warehouse, revision: 6 },
        },
      },
    ],
  });
});

test("stale expectedRevision fails with the current stock snapshot", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse, quantity: 8, revision: 6 });

  assert.throws(
    () =>
      prepareProductStockRevisionGuard(product, {
        warehouseStocks: [
          { warehouse, quantity: 9, expectedRevision: 5 },
        ],
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "STOCK_REVISION_CONFLICT");
      assert.equal(error.errors[0].expectedRevision, 5);
      assert.equal(error.errors[0].currentRevision, 6);
      assert.equal(error.errors[0].currentQuantity, 8);
      return true;
    },
  );
});

test("a save-time guard miss is translated to a stock conflict", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = simpleProduct({ warehouse });
  const expectations = prepareProductStockRevisionGuard(product, {
    warehouseStocks: [
      { warehouse, quantity: 7, expectedRevision: 6 },
    ],
  });
  const race = new Error("No document matched");
  race.name = "DocumentNotFoundError";

  assert.throws(
    () => translateStockRevisionSaveError(race, expectations),
    (error) =>
      error.statusCode === 409 &&
      error.code === "STOCK_REVISION_CONFLICT",
  );
});

test("moderator stock sanitization preserves optional expectedRevision", () => {
  const warehouse = new mongoose.Types.ObjectId();
  const merged = mergeWarehouseStocks(
    [{ warehouse, quantity: 8 }],
    [{ warehouse, quantity: 7, expectedRevision: 6 }],
    new Set([String(warehouse)]),
  );

  assert.deepEqual(merged, [
    { warehouse, quantity: 7, expectedRevision: 6 },
  ]);
});

test("the existing shared product detail route remains the only id detail route", () => {
  const detailGetRoutes = productRoutes.stack.filter(
    (layer) => layer.route?.path === "/:id" && layer.route.methods.get,
  );
  const paths = productRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);

  assert.equal(paths.includes("/admin/:id"), false);
  assert.equal(detailGetRoutes.length, 1);
});

test("stock service accepts a matching optional revision and advances it", async (t) => {
  const warehouse = new mongoose.Types.ObjectId();
  const product = {
    ...simpleProduct({ warehouse, quantity: 8, revision: 6 }),
    async save() {
      return this;
    },
  };
  t.mock.method(ProductModel, "findById", () => product);
  t.mock.method(WarehouseModel, "countDocuments", async () => 1);

  await updateProductStockService(
    product._id,
    {
      warehouseStocks: [
        { warehouse, quantity: 7, expectedRevision: 6 },
      ],
    },
    null,
  );

  assert.equal(product.warehouseStocks[0].quantity, 7);
  assert.equal(product.warehouseStocks[0].revision, 7);
  assert.ok(product.$where);
});

test("stock service rejects a stale optional revision before saving", async (t) => {
  const warehouse = new mongoose.Types.ObjectId();
  let saveCalls = 0;
  const product = {
    ...simpleProduct({ warehouse, quantity: 8, revision: 6 }),
    async save() {
      saveCalls += 1;
      return this;
    },
  };
  t.mock.method(ProductModel, "findById", () => product);

  await assert.rejects(
    updateProductStockService(
      product._id,
      {
        warehouseStocks: [
          { warehouse, quantity: 9, expectedRevision: 5 },
        ],
      },
      null,
    ),
    (error) =>
      error.statusCode === 409 &&
      error.code === "STOCK_REVISION_CONFLICT",
  );
  assert.equal(saveCalls, 0);
  assert.equal(product.warehouseStocks[0].quantity, 8);
  assert.equal(product.warehouseStocks[0].revision, 6);
});
