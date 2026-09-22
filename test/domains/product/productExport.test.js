import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildProductClientExport } from "../../../src/domains/product/productExport.service.js";

function fixture() {
  return {
    categories: [{ _id: "cat", name_en: "Cats", name_ar: "قطط" }],
    subcategories: [
      { _id: "food", name_en: "Cat Food", name_ar: "طعام القطط" },
      { _id: "dry", parent: "food", name_en: "Dry Food", name_ar: "طعام جاف" },
    ],
    brands: [{ _id: "brand", name_en: "Brand", name_ar: "علامة" }],
    warehouses: [{ _id: "wh", name: "Main Warehouse", code: "MAIN" }],
    products: [
      {
        _id: "simple", name_en: "A Simple Product", name_ar: "منتج", type: "SIMPLE",
        category: "cat", subcategory: "dry", brand: "brand", price: 100,
        discountedPrice: 90, sku: "S-1", slug: "simple", desc_en: "x".repeat(33000),
        desc_ar: "وصف", tags: ["cat"], images: [
          { url: "https://example.com/a.jpg", public_id: "a", isMain: true },
          { url: "https://example.com/b.jpg", public_id: "b", isMain: false },
        ],
        warehouseStocks: [{ warehouse: "wh", quantity: 5, revision: 2 }],
        options: [], variants: [], isActive: true, isFeatured: false,
        ratingAverage: 4.5, ratingCount: 2, __v: 3,
      },
      {
        _id: "parent", name_en: "B Variant Product", name_ar: "متغير", type: "VARIANT",
        category: "cat", subcategory: "food", brand: "brand", slug: "variant",
        desc_en: "description", desc_ar: "وصف", tags: [],
        images: [{ url: "https://example.com/parent.jpg", public_id: "parent", isMain: true }],
        options: [{ name: "Size", values: ["Small", "Large"] }],
        variants: [
          { _id: "small", sku: "V-S", price: 200, discountedPrice: 0,
            options: [{ name: "Size", value: "Small" }],
            images: [{ url: "https://example.com/small.jpg", public_id: "small", isMain: true }],
            warehouseStocks: [{ warehouse: "wh", quantity: 3, revision: 1 }], isDefault: true },
          { _id: "large", sku: "V-L", price: 300, discountedPrice: 0,
            options: [{ name: "Size", value: "Large" }], images: [],
            warehouseStocks: [], isDefault: false },
        ],
        isActive: true, isFeatured: true,
      },
    ],
  };
}

test("one-sheet export groups variants and preserves full product details within Excel limits", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildProductClientExport(fixture()));
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet("Products");
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(1).values.slice(1, 13), [
    "Product Name EN", "Product Name AR", "Category Name EN", "Category Name AR",
    "Subcategory EN", "Subcategory AR", "Nested Subcategory EN",
    "Nested Subcategory AR", "Variant", "Price +15%",
    "Product Image URLs", "Variant Image URLs",
  ]);
  assert.equal(sheet.getCell("J2").value, 115);
  assert.equal(sheet.getCell("K2").value, "https://example.com/a.jpg | https://example.com/b.jpg");
  assert.equal(sheet.getCell("L2").value ?? "", "");
  assert.equal(sheet.getCell("S2").value, 5);
  assert.equal(sheet.getCell("T2").value, "Main Warehouse: 5");
  assert.equal(sheet.getCell("I3").value, "Size: Small");
  assert.equal(sheet.getCell("I4").value, "Size: Large");
  assert.equal(sheet.getCell("J3").value, 230);
  assert.equal(sheet.getCell("L3").value, "https://example.com/small.jpg");
  assert.equal(sheet.getCell("L4").value ?? "", "");
  assert.equal(sheet.getCell("Z2").value.length, 30000);
  assert.equal(sheet.getCell("AA2").value.length, 3000);
  assert.equal(sheet.getColumn(sheet.columnCount).hidden, true);
  assert.ok(sheet.getRow(2).values.slice(1).every((value) =>
    typeof value !== "string" || value.length <= 32767));
});

test("export endpoint reads product collections on every request", async (t) => {
  const { ProductModel } = await import("../../../src/domains/product/product.model.js");
  const { CategoryModel } = await import("../../../src/domains/category/category.model.js");
  const { SubcategoryModel } = await import("../../../src/domains/subcategory/subcategory.model.js");
  const { BrandModel } = await import("../../../src/domains/brand/brand.model.js");
  const { WarehouseModel } = await import("../../../src/domains/warehouse/warehouse.model.js");
  const { exportProductsForSuperAdmin } = await import("../../../src/domains/product/productExport.controller.js");
  const { default: router } = await import("../../../src/domains/product/product.routes.js");
  const exportRoute = router.stack.find((layer) => layer.route?.path === "/admin/export" && layer.route.methods.get)?.route;
  assert.ok(exportRoute);
  assert.equal(exportRoute.stack.length, 3);
  let denied;
  await exportRoute.stack[1].handle({ user: { role: "admin" } }, {}, (error) => { denied = error; });
  assert.equal(denied.statusCode, 403);
  let allowed = false;
  await exportRoute.stack[1].handle({ user: { role: "superAdmin" } }, {}, (error) => { assert.equal(error, undefined); allowed = true; });
  assert.equal(allowed, true);

  const source = fixture();
  let currentProducts = source.products.slice(0, 1);
  let readCount = 0;
  const query = (value) => ({ lean: () => ({ exec: async () => value }) });
  t.mock.method(ProductModel, "find", () => { readCount += 1; return query(currentProducts); });
  t.mock.method(CategoryModel, "find", () => query(source.categories));
  t.mock.method(SubcategoryModel, "find", () => query(source.subcategories));
  t.mock.method(BrandModel, "find", () => query(source.brands));
  t.mock.method(WarehouseModel, "find", () => query(source.warehouses));

  async function request() {
    const response = {
      headers: null, code: null, body: null,
      set(headers) { this.headers = headers; return this; },
      status(code) { this.code = code; return this; },
      send(body) { this.body = body; return this; },
    };
    await exportProductsForSuperAdmin({}, response, (error) => { throw error; });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body);
    return { response, workbook };
  }

  const first = await request();
  assert.equal(first.response.code, 200);
  assert.equal(first.response.headers["Cache-Control"], "no-store");
  assert.match(first.response.headers["Content-Disposition"], /attachment; filename="petyard-products-.*\.xlsx"/);
  assert.equal(first.workbook.getWorksheet("Products").rowCount - 1, 1);

  currentProducts = source.products;
  const second = await request();
  assert.equal(second.workbook.getWorksheet("Products").rowCount - 1, 3);
  assert.equal(readCount, 2);
});
