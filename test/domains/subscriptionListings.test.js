import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { FavoriteModel } from "../../src/domains/favorite/favorite.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { getMyRestockSubscribedProductsService } from "../../src/domains/product/product.service.js";
import {
  RestockSubscriptionModel,
  restockSubscriptionStatus,
} from "../../src/domains/restockSubscription/restockSubscription.model.js";
import { SubcategoryModel } from "../../src/domains/subcategory/subcategory.model.js";
import { getMySubscribedSubcategoriesService } from "../../src/domains/subcategory/subcategory.service.js";
import { SubcategorySubscriptionModel } from "../../src/domains/subcategorySubscription/subcategorySubscription.model.js";

function id() {
  return new mongoose.Types.ObjectId();
}

function queryResult(value) {
  return {
    populate() {
      return this;
    },
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => value,
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

test("product subscription listing returns the normal warehouse-aware product card", async (t) => {
  const guestId = "guest-product-listing";
  const productId = id();
  const warehouseId = id();
  const categoryId = id();
  const subcategoryId = id();
  const brandId = id();
  const imageUrl = "https://media.petyardstores.com/products/royal-canin.webp";
  const product = {
    _id: productId,
    slug: "royal-canin",
    type: "SIMPLE",
    isActive: true,
    name_en: "Royal Canin",
    name_ar: "رويال كانين",
    price: 120,
    discountedPrice: 100,
    images: [{ url: imageUrl, isMain: true }],
    warehouseStocks: [{ warehouse: warehouseId, quantity: 0 }],
    variants: [],
    ratingAverage: 4.5,
    ratingCount: 8,
    category: {
      _id: categoryId,
      slug: "cats",
      name_en: "Cats",
      name_ar: "قطط",
    },
    subcategory: {
      _id: subcategoryId,
      slug: "cat-food",
      name_en: "Cat Food",
      name_ar: "طعام القطط",
    },
    brand: {
      _id: brandId,
      slug: "royal-canin",
      name_en: "Royal Canin",
      name_ar: "رويال كانين",
    },
  };

  t.mock.method(RestockSubscriptionModel, "find", (filter) => {
    assert.equal(filter.guestId, guestId);
    assert.deepEqual(filter.status.$in, ["ACTIVE", "PROCESSING"]);
    return queryResult([
      {
        product: productId,
        warehouse: warehouseId,
        status: restockSubscriptionStatus.ACTIVE,
      },
    ]);
  });
  t.mock.method(ProductModel, "find", (filter) => {
    assert.equal(filter.isActive, true);
    return queryResult([product]);
  });
  t.mock.method(FavoriteModel, "findOne", (filter) => {
    assert.equal(filter.guestId, guestId);
    return queryResult({ items: [{ product: productId }] });
  });
  t.mock.method(SubcategoryModel, "find", (_filter, projection) => {
    if (projection?.parent === 1) {
      return queryResult([{ _id: subcategoryId, parent: null }]);
    }
    return queryResult([]);
  });
  t.mock.method(CollectionModel, "find", () => queryResult([]));

  const data = await getMyRestockSubscribedProductsService({
    guestId,
    lang: "en",
  });

  assert.equal(data.length, 1);
  assert.deepEqual(data[0], {
    id: productId,
    slug: "royal-canin",
    name: "Royal Canin",
    type: "SIMPLE",
    isActive: true,
    category: { id: categoryId, slug: "cats", name: "Cats" },
    subcategory: {
      id: subcategoryId,
      slug: "cat-food",
      name: "Cat Food",
    },
    brand: {
      id: brandId,
      slug: "royal-canin",
      name: "Royal Canin",
    },
    price: 120,
    discountedPrice: 100,
    promotion: null,
    stock: 0,
    inStock: false,
    image: imageUrl,
    hasVariants: false,
    ratingAverage: 4.5,
    ratingCount: 8,
    warehouseId: String(warehouseId),
    isFavorite: true,
    isRestockNotificationRequested: true,
  });
});

test("subcategory subscription listing returns the normal localized subcategory tile", async (t) => {
  const userId = id();
  const subcategoryId = id();
  const categoryId = id();
  const updatedAt = new Date("2026-08-05T12:00:00.000Z");
  const imageUrl = "https://media.petyardstores.com/subcategories/cat-food.webp";

  t.mock.method(SubcategorySubscriptionModel, "find", (filter) => {
    assert.equal(String(filter.user), String(userId));
    return queryResult([{ subcategory: subcategoryId }]);
  });
  t.mock.method(SubcategoryModel, "find", (filter) => {
    assert.deepEqual(filter._id.$in, [String(subcategoryId)]);
    return queryResult([
      {
        _id: subcategoryId,
        category: { _id: categoryId },
        parent: null,
        slug: "cat-food",
        name_en: "Cat Food",
        name_ar: "طعام القطط",
        desc_en: "Food for cats",
        desc_ar: "طعام مخصص للقطط",
        image: { url: imageUrl },
        updatedAt,
      },
    ]);
  });

  const data = await getMySubscribedSubcategoriesService({
    userId,
    lang: "ar",
  });

  assert.deepEqual(data, [
    {
      id: subcategoryId,
      category: categoryId,
      slug: "cat-food",
      updatedAt,
      name: "طعام القطط",
      desc: "طعام مخصص للقطط",
      image: imageUrl,
      parent: null,
      children: [],
      isSubscribed: true,
    },
  ]);
});
