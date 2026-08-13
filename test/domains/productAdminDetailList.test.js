import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import {
  getProductsService,
  mapProductToCardDto,
} from "../../src/domains/product/product.service.js";
import { SubcategoryModel } from "../../src/domains/subcategory/subcategory.model.js";

function queryResult(value, { onSelect } = {}) {
  const query = {
    populate() { return query; },
    select(selection) { onSelect?.(selection); return query; },
    sort() { return query; },
    skip() { return query; },
    limit() { return query; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

test("admin product lists add details without changing the legacy card contract", async (t) => {
  const productId = new mongoose.Types.ObjectId();
  const warehouseId = new mongoose.Types.ObjectId();
  const variantId = new mongoose.Types.ObjectId();
  const product = {
    _id: productId,
    slug: "complete-product",
    type: "VARIANT",
    isActive: false,
    name_en: "Complete product",
    name_ar: "منتج كامل",
    desc_en: "English description",
    desc_ar: "وصف عربي",
    sku: "PRODUCT-SKU",
    tags: ["cat", "food"],
    category: { _id: new mongoose.Types.ObjectId(), slug: "cats", name_en: "Cats", name_ar: "قطط" },
    subcategory: { _id: new mongoose.Types.ObjectId(), slug: "dry-food", name_en: "Dry food", name_ar: "طعام جاف" },
    brand: { _id: new mongoose.Types.ObjectId(), slug: "brand", name_en: "Brand", name_ar: "علامة" },
    images: [{ public_id: "product/main", url: "https://example.test/main.jpg", isMain: true }],
    options: [{ name: "Size", values: ["Small", "Large"] }],
    variants: [{
      _id: variantId,
      sku: "VARIANT-SKU",
      price: 200,
      discountedPrice: 150,
      options: [{ name: "Size", value: "Large" }],
      images: [{ public_id: "product/main", url: "https://example.test/main.jpg" }],
      warehouseStocks: [{ warehouse: warehouseId, quantity: 7, revision: 3 }],
      isDefault: true,
    }],
    warehouseStocks: [],
    ratingAverage: 4.5,
    ratingCount: 12,
  };
  let selectCalls = 0;

  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, "find", () => queryResult([]));
  t.mock.method(SubcategoryModel, "find", () => queryResult([]));
  t.mock.method(ProductModel, "countDocuments", async () => 1);
  t.mock.method(ProductModel, "find", () => queryResult([product], {
    onSelect: () => { selectCalls += 1; },
  }));

  const result = await getProductsService({}, "en", {
    includeZeroStockInWarehouse: true,
    includeDetails: true,
    includeAllLanguages: true,
    includeStockRevisions: true,
  });

  const legacyCard = mapProductToCardDto(product, {
    lang: "en",
    promotion: null,
  });

  // Every field known to the released app retains exactly the same value/type.
  for (const [key, value] of Object.entries(legacyCard)) {
    assert.deepEqual(result.data[0][key], value, `legacy field changed: ${key}`);
  }

  assert.equal(selectCalls, 0);
  assert.equal(result.data[0].image, "https://example.test/main.jpg");
  assert.equal(result.data[0].mainImage, "https://example.test/main.jpg");
  assert.equal(result.data[0].desc_en, "English description");
  assert.equal(result.data[0].sku, "PRODUCT-SKU");
  assert.equal(result.data[0].variants[0].warehouseStocks[0].revision, 3);
});
