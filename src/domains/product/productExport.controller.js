import asyncHandler from "express-async-handler";
import { BrandModel } from "../brand/brand.model.js";
import { CategoryModel } from "../category/category.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ProductModel } from "./product.model.js";
import { buildProductClientExport } from "./productExport.service.js";

export const exportProductsForSuperAdmin = asyncHandler(async (_req, res) => {
  const generatedAt = new Date();
  const [products, categories, subcategories, brands, warehouses] = await Promise.all([
    ProductModel.find({}).lean().exec(),
    CategoryModel.find({}).lean().exec(),
    SubcategoryModel.find({}).lean().exec(),
    BrandModel.find({}).lean().exec(),
    WarehouseModel.find({}).lean().exec(),
  ]);
  const buffer = await buildProductClientExport(
    { products, categories, subcategories, brands, warehouses },
    generatedAt,
  );
  const filename = `petyard-products-${generatedAt.toISOString().slice(0, 10)}.xlsx`;
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "Content-Length": buffer.length,
  });
  res.status(200).send(buffer);
});
