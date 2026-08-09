import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { InventoryAuditModel } from "../../../src/domains/inventory/inventoryAudit.model.js";
import {
  aggregateInventoryDemands,
  correctUnallocatedInventoryCAS,
  releaseInventoryAtomically,
  reserveInventoryAtomically,
  restoreFinalOrderInventory,
} from "../../../src/domains/inventory/inventory.service.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { updateProductStockService } from "../../../src/domains/product/product.service.js";

function queryResult(value) {
  const query = {
    select() {
      return query;
    },
    lean() {
      return query;
    },
    session() {
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

function productDocument({
  id = new mongoose.Types.ObjectId(),
  warehouseId = new mongoose.Types.ObjectId(),
  quantity = 8,
  revision = 2,
  variantId = new mongoose.Types.ObjectId(),
  type = "SIMPLE",
  legacyRevision = false,
} = {}) {
  const stock = {
    warehouse: warehouseId,
    quantity,
    ...(legacyRevision ? {} : { revision }),
  };
  return {
    _id: id,
    type,
    warehouseStocks: type === "SIMPLE" ? [stock] : [],
    variants:
      type === "VARIANT"
        ? [{ _id: variantId, warehouseStocks: [stock] }]
        : [],
  };
}

function installInventoryStoreMocks(t, products) {
  const audits = [];
  const updates = [];
  const productById = new Map(products.map((product) => [String(product._id), product]));

  t.mock.method(ProductModel, "findById", (id) =>
    queryResult(productById.get(String(id)) || null),
  );
  t.mock.method(InventoryAuditModel, "findOne", (filter) =>
    queryResult(
      audits.find(
        (audit) =>
          audit.operationId === filter.operationId &&
          audit.skuKey === filter.skuKey &&
          audit.action === filter.action,
      ) || null,
    ),
  );
  t.mock.method(InventoryAuditModel, "create", async ([audit]) => {
    audits.push(audit);
    return [audit];
  });
  t.mock.method(ProductModel, "updateOne", async (filter, update, options) => {
    updates.push({ filter, update, options });
    return { modifiedCount: 1 };
  });

  return { audits, updates };
}

function context(warehouseId, operationId = "substitution-operation") {
  return {
    warehouseId,
    operationId,
    orderId: new mongoose.Types.ObjectId(),
    requestId: new mongoose.Types.ObjectId(),
    actorId: new mongoose.Types.ObjectId(),
  };
}

test("aggregates identical SKU demands and rejects conflicting snapshots", () => {
  const productId = new mongoose.Types.ObjectId();
  const aggregated = aggregateInventoryDemands([
    { productId, productType: "SIMPLE", quantity: 2, expectedRevision: 3 },
    { productId, productType: "SIMPLE", quantity: 1, expectedRevision: 3 },
  ]);

  assert.deepEqual(aggregated.map(({ skuKey, quantity, expectedRevision }) => ({ skuKey, quantity, expectedRevision })), [
    { skuKey: `simple:${productId}`, quantity: 3, expectedRevision: 3 },
  ]);
  assert.throws(
    () =>
      aggregateInventoryDemands([
        { productId, productType: "SIMPLE", quantity: 1, expectedRevision: 1 },
        { productId, productType: "SIMPLE", quantity: 1, expectedRevision: 2 },
      ]),
    (error) => error.code === "INVENTORY_INVALID_REVISION",
  );
});

test("reservation uses the supplied warehouse exactly and stays in the caller transaction", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const otherWarehouse = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 4, revision: 5 });
  const { updates } = installInventoryStoreMocks(t, [product]);
  const session = { label: "caller transaction" };

  await reserveInventoryAtomically({
    ...context(warehouseId),
    session,
    demands: [{ productId: product._id, productType: "SIMPLE", quantity: 2, expectedRevision: 5 }],
  });

  assert.equal(updates.length, 1);
  assert.equal(String(updates[0].filter.warehouseStocks.$elemMatch.warehouse), String(warehouseId));
  assert.equal(updates[0].options.session, session);

  await assert.rejects(
    reserveInventoryAtomically({
      ...context(otherWarehouse, "wrong-warehouse-operation"),
      session,
      demands: [{ productId: product._id, productType: "SIMPLE", quantity: 1 }],
    }),
    (error) => error.code === "INVENTORY_STOCK_CONFLICT",
  );
  assert.equal(updates.length, 1);
});

test("variant reservations use nested warehouse CAS filters", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  const product = productDocument({
    warehouseId,
    variantId,
    type: "VARIANT",
    quantity: 3,
    revision: 7,
  });
  const { updates } = installInventoryStoreMocks(t, [product]);

  await reserveInventoryAtomically({
    ...context(warehouseId),
    session: {},
    demands: [{
      productId: product._id,
      productType: "VARIANT",
      variantId,
      quantity: 2,
      expectedRevision: 7,
    }],
  });

  const update = updates[0];
  assert.equal(String(update.filter.variants.$elemMatch._id), String(variantId));
  assert.equal(String(update.options.arrayFilters[1]["stock.warehouse"]), String(warehouseId));
  assert.equal(update.options.arrayFilters[1]["stock.revision"], 7);
  assert.equal(update.update.$inc["variants.$[variant].warehouseStocks.$[stock].quantity"], -2);
});

test("legacy rows use a missing-revision CAS and increment revision on mutation", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 2, legacyRevision: true });
  const { updates } = installInventoryStoreMocks(t, [product]);

  await reserveInventoryAtomically({
    ...context(warehouseId),
    session: {},
    demands: [{ productId: product._id, productType: "SIMPLE", quantity: 1, expectedRevision: 0 }],
  });

  assert.deepEqual(updates[0].filter.warehouseStocks.$elemMatch.revision, { $exists: false });
  assert.equal(updates[0].update.$inc["warehouseStocks.$.revision"], 1);
});

test("inventory operations are idempotent through the operation, SKU, and action audit key", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 4, revision: 1 });
  const { audits, updates } = installInventoryStoreMocks(t, [product]);
  const input = {
    ...context(warehouseId, "idempotent-reservation"),
    session: {},
    demands: [{ productId: product._id, productType: "SIMPLE", quantity: 1 }],
  };

  const first = await reserveInventoryAtomically(input);
  const replay = await reserveInventoryAtomically(input);

  assert.equal(audits.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(first.results[0].idempotent, false);
  assert.equal(replay.results[0].idempotent, true);
});

test("staff correction is an absolute CAS, cannot add inventory, and has a verified no-op", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 7, revision: 4 });
  const { audits, updates } = installInventoryStoreMocks(t, [product]);

  const result = await correctUnallocatedInventoryCAS({
    ...context(warehouseId, "correct-original-stock"),
    session: {},
    demands: [{
      productId: product._id,
      productType: "SIMPLE",
      expectedRevision: 4,
      expectedQuantity: 7,
      correctedQuantity: 5,
    }],
  });

  assert.equal(result.results[0].quantityBefore, 7);
  assert.equal(result.results[0].quantityAfter, 5);
  assert.equal(updates[0].filter.warehouseStocks.$elemMatch.quantity, 7);
  assert.equal(updates[0].update.$inc["warehouseStocks.$.quantity"], -2);
  assert.equal(audits[0].quantity, 2);

  await assert.rejects(
    correctUnallocatedInventoryCAS({
      ...context(warehouseId, "cannot-add-original-stock"),
      session: {},
      demands: [{
        productId: product._id,
        productType: "SIMPLE",
        expectedRevision: 4,
        expectedQuantity: 7,
        correctedQuantity: 8,
      }],
    }),
    (error) => error.code === "INVENTORY_CORRECTION_CANNOT_ADD_STOCK",
  );

  const noOp = await correctUnallocatedInventoryCAS({
    ...context(warehouseId, "already-correct"),
    session: {},
    demands: [{
      productId: product._id,
      productType: "SIMPLE",
      expectedRevision: 4,
      currentQuantity: 7,
      correctedQuantity: 7,
    }],
  });
  assert.equal(noOp.results[0].noOp, true);
  assert.equal(updates.length, 1);
  assert.equal(audits.length, 1);
});

test("stock correction rejects stale quantity or revision before it mutates", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 5, revision: 6 });
  const { updates } = installInventoryStoreMocks(t, [product]);

  await assert.rejects(
    correctUnallocatedInventoryCAS({
      ...context(warehouseId),
      session: {},
      demands: [{
        productId: product._id,
        productType: "SIMPLE",
        expectedRevision: 5,
        expectedQuantity: 5,
        correctedQuantity: 4,
      }],
    }),
    (error) => error.code === "INVENTORY_REVISION_CONFLICT",
  );
  await assert.rejects(
    correctUnallocatedInventoryCAS({
      ...context(warehouseId, "stale-quantity"),
      session: {},
      demands: [{
        productId: product._id,
        productType: "SIMPLE",
        expectedRevision: 6,
        expectedQuantity: 6,
        correctedQuantity: 4,
      }],
    }),
    (error) => error.code === "INVENTORY_STOCK_CONFLICT",
  );
  assert.equal(updates.length, 0);
});

test("restore uses final fulfillment quantities and includes accepted substitute lines", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const original = productDocument({ warehouseId, quantity: 1, revision: 1 });
  const variantId = new mongoose.Types.ObjectId();
  const substitute = productDocument({
    warehouseId,
    type: "VARIANT",
    variantId,
    quantity: 1,
    revision: 1,
  });
  const { audits } = installInventoryStoreMocks(t, [original, substitute]);

  await restoreFinalOrderInventory({
    order: {
      _id: new mongoose.Types.ObjectId(),
      items: [
        {
          product: original._id,
          productType: "SIMPLE",
          quantity: 3,
          fulfillmentQuantity: 1,
          finalizedUnavailableQuantity: 2,
          lineKind: "ORIGINAL",
        },
        {
          product: substitute._id,
          productType: "VARIANT",
          variantId,
          quantity: 2,
          fulfillmentQuantity: 2,
          lineKind: "SUBSTITUTE",
        },
      ],
    },
    ...context(warehouseId, "cancel-final-order"),
    session: {},
  });

  assert.deepEqual(
    audits.map((audit) => ({ skuKey: audit.skuKey, quantity: audit.quantity })).sort((a, b) => a.skuKey.localeCompare(b.skuKey)),
    [
      { skuKey: `simple:${original._id}`, quantity: 1 },
      { skuKey: `variant:${substitute._id}:${variantId}`, quantity: 2 },
    ],
  );
});

test("product warehouse revisions are retained and duplicate new stock rows are rejected", async () => {
  const warehouseId = new mongoose.Types.ObjectId();
  const category = new mongoose.Types.ObjectId();
  const fields = {
    slug: `inventory-revision-${warehouseId}`,
    type: "SIMPLE",
    category,
    name_en: "Inventory test",
    name_ar: "اختبار المخزون",
    desc_en: "Inventory test",
    desc_ar: "اختبار المخزون",
    price: 10,
    warehouseStocks: [{ warehouse: warehouseId, quantity: 2, revision: 9 }],
  };
  const product = new ProductModel(fields);
  await product.validate();
  assert.equal(product.warehouseStocks[0].revision, 9);

  const invalid = new ProductModel({
    ...fields,
    slug: `inventory-duplicate-${warehouseId}`,
    warehouseStocks: [
      { warehouse: warehouseId, quantity: 1 },
      { warehouse: warehouseId, quantity: 2 },
    ],
  });
  await assert.rejects(invalid.validate(), /warehouseStocks cannot contain duplicate warehouses/);
});

test("legacy duplicate stock rows remain readable when unrelated fields change", async () => {
  const warehouseId = new mongoose.Types.ObjectId();
  const legacy = ProductModel.hydrate({
    _id: new mongoose.Types.ObjectId(),
    slug: `legacy-duplicate-${warehouseId}`,
    type: "SIMPLE",
    category: new mongoose.Types.ObjectId(),
    name_en: "Legacy stock",
    name_ar: "مخزون قديم",
    desc_en: "Legacy duplicate stock rows",
    desc_ar: "صفوف مخزون قديمة مكررة",
    price: 10,
    warehouseStocks: [
      { warehouse: warehouseId, quantity: 1 },
      { warehouse: warehouseId, quantity: 2 },
    ],
  });
  legacy.name_en = "Legacy stock renamed";
  await legacy.validate();
});

test("product stock writes preserve unchanged revisions and increment changed rows", async (t) => {
  const firstWarehouse = new mongoose.Types.ObjectId();
  const secondWarehouse = new mongoose.Types.ObjectId();
  const product = {
    _id: new mongoose.Types.ObjectId(),
    type: "SIMPLE",
    warehouseStocks: [
      { warehouse: firstWarehouse, quantity: 2, revision: 5 },
      { warehouse: secondWarehouse, quantity: 1, revision: 9 },
    ],
    async save() {
      return this;
    },
  };
  t.mock.method(ProductModel, "findById", () => product);
  t.mock.method(WarehouseModel, "countDocuments", async () => 2);

  await updateProductStockService(
    product._id,
    {
      warehouseStocks: [
        { warehouse: firstWarehouse, quantity: 2 },
        { warehouse: secondWarehouse, quantity: 4 },
      ],
    },
    null,
  );

  assert.equal(product.warehouseStocks[0].revision, 5);
  assert.equal(product.warehouseStocks[1].revision, 10);
  assert.equal(product.warehouseStocks[1].quantity, 4);
});

test("release accepts a positive mutation without requiring an expected snapshot", async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const product = productDocument({ warehouseId, quantity: 0, revision: 2 });
  const { updates } = installInventoryStoreMocks(t, [product]);

  await releaseInventoryAtomically({
    ...context(warehouseId, "release-reservation"),
    session: {},
    demands: [{ productId: product._id, productType: "SIMPLE", quantity: 1 }],
  });
  assert.equal(updates[0].update.$inc["warehouseStocks.$.quantity"], 1);
  assert.equal(updates[0].filter.warehouseStocks.$elemMatch.quantity, undefined);
});
