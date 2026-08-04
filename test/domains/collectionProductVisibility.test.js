import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { getCollectionWithProductsService } from "../../src/domains/collection/collection.service.js";
import { ProductModel } from "../../src/domains/product/product.model.js";

function queryResult(value) {
  const query = {
    select() {
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
    sort() {
      return query;
    },
    skip() {
      return query;
    },
    limit() {
      return query;
    },
    populate() {
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

test("collection product results only include active products", async (t) => {
  const collectionId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const collection = {
    _id: collectionId,
    slug: "featured-products",
    name_en: "Featured products",
    name_ar: "منتجات مميزة",
    desc_en: "Featured products",
    desc_ar: "منتجات مميزة",
    isVisible: true,
    selector: { productIds: [productId] },
    image: null,
    position: 0,
    promotion: null,
  };
  let productFilter;

  t.mock.method(CollectionModel, "findOne", () => queryResult(collection));
  t.mock.method(CollectionModel, "findById", () =>
    queryResult({
      isVisible: true,
      selector: collection.selector,
    }),
  );
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(ProductModel, "countDocuments", async (filter) => {
    productFilter = filter;
    return 0;
  });
  t.mock.method(ProductModel, "find", () => queryResult([]));

  const result = await getCollectionWithProductsService(
    String(collectionId),
  );

  assert.equal(result.products.results, 0);
  assert.equal(productFilter.isActive, true);
});
