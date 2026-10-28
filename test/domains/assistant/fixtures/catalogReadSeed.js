import assert from "node:assert/strict";
import mongoose from "mongoose";
import { CategoryModel } from "../../../../src/domains/category/category.model.js";
import { SubcategoryModel } from "../../../../src/domains/subcategory/subcategory.model.js";
import { BrandModel } from "../../../../src/domains/brand/brand.model.js";
import { WarehouseModel } from "../../../../src/domains/warehouse/warehouse.model.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../../src/domains/collection/collection.model.js";

export async function catalogReadSeed(manifest) {
  assert.equal(manifest.suite, "catalogRead");
  const ids = Object.fromEntries(Object.entries(manifest.records).map(([name, values]) => [name, values.map((id) => new mongoose.Types.ObjectId(id))]));
  const seed = [];
  const add = async (Model, value) => {
    const document = new Model(value); await document.validate();
    seed.push({ collection: Model.collection.name, document: document.toObject() });
  };
  const label = (name, index) => ({ _id: ids[name][index], slug: `${manifest.marker}-${name}-${index}`,
    name_en: `Synthetic ${name} ${index}`, name_ar: `اختبار ${index}` });
  for (let i = 0; i < 3; i++) await add(CategoryModel, label("categories", i));
  for (let i = 0; i < 2; i++) await add(SubcategoryModel, { ...label("subcategories", i), category: ids.categories[1], parent: i ? ids.subcategories[0] : null });
  await add(BrandModel, { ...label("brands", 0), name_en: "NativeBrand Royal Canin", name_ar: "علامة تجريبية" });
  for (let i = 0; i < 4; i++) await add(WarehouseModel, { _id: ids.warehouses[i], name: `Synthetic warehouse ${i}`,
    code: `${manifest.marker}-${i}`, active: true, isDefault: false,
    location: { type: "Point", coordinates: [31, 30] },
    fulfillment: { status: i === 1 ? "MAINTENANCE" : i === 3 ? "CLOSED" : "OPERATIONAL", fallbackWarehouse: i === 1 ? ids.warehouses[2] : null } });
  const stock = (warehouse = 0, quantity = 1) => [{ warehouse: ids.warehouses[warehouse], quantity, revision: 0 }];
  const variant = (price, weight, color, warehouse = 0) => ({ price, options: [{ name: "Weight", value: weight }, { name: "Color", value: color }], warehouseStocks: stock(warehouse) });
  const overrides = [
    { name_en: "Native cat toy .*", name_ar: "لعبة قطط", tags: ["tagonly", "alpha", "beta"] },
    { name_en: "Other accessory", brand: ids.brands[0] },
    { name_en: "Native offer", type: "VARIANT", variants: [variant(400, "1kg", "Blue"), variant(1200.5, "3kg", "Pink", 2)] },
    { name_en: "Native mystery", type: "VARIANT", variants: [{ price: 100, options: [{ name: "Odd Product Label", value: "Pink" }], warehouseStocks: stock() }] },
    { name_en: "Native feed cat dry food", category: ids.categories[0], type: "VARIANT",
      variants: [{ price: 950, options: [{ name: "Weight", value: "3kg" }], warehouseStocks: stock() }] },
    { name_en: "Native unknown", category: ids.categories[2] },
    { name_en: "Native cat toy inactive", isActive: false },
    { name_en: "Native cat toy unavailable", warehouseStocks: stock(0, 0) },
    { name_en: "Native split", type: "VARIANT", variants: [variant(900, "3kg", "Blue"), variant(400, "1kg", "Pink")] },
    { name_en: "Native lineage", subcategory: ids.subcategories[1] },
  ];
  for (let i = 0; i < overrides.length; i++) await add(ProductModel, { ...label("products", i), type: "SIMPLE", price: 100,
    category: ids.categories[1], desc_en: "Synthetic description excluded from search and snapshots", desc_ar: "وصف تجريبي",
    isActive: true, warehouseStocks: stock(), ...overrides[i] });
  const now = Date.now();
  for (let i = 0; i < 3; i++) await add(CollectionModel, { ...label("collections", i), isVisible: true,
    selector: i === 1 ? { subcategoryIds: [ids.subcategories[0]] } : { productIds: [ids.products[i === 0 ? 2 : 0]] },
    promotion: { enabled: true, isActive: true, discountPercent: i === 0 ? 20 : i === 1 ? 15 : 90,
      startsAt: new Date(now - 3600000), endsAt: new Date(now + (i === 2 ? -1800000 : 3600000)) } });
  const classification = { version: "synthetic-native-read-v1", foodCategoryIds: [String(ids.categories[0])],
    nonFoodCategoryIds: [String(ids.categories[1])], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] };
  return { ids, seed, classification };
}
