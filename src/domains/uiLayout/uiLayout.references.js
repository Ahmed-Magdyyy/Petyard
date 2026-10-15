import mongoose from "mongoose";
import { ProductModel } from "../product/product.model.js";
import { CategoryModel } from "../category/category.model.js";
import { BrandModel } from "../brand/brand.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { UiLayoutAssetModel } from "./uiLayout.model.js";
import { collectLayoutReferences } from "./uiLayout.productReferences.js";
import { UI_LAYOUT_PRODUCT_REFERENCE_FORMAT } from "./uiLayout.constants.js";
import { PRODUCT_BATCH_QUERY_TIMEOUT_MS } from "../product/productBatch.constants.js";

export async function inspectLayoutReferences(content, {
  productModel = ProductModel,
  categoryModel = CategoryModel,
  brandModel = BrandModel,
  subcategoryModel = SubcategoryModel,
  assetModel = UiLayoutAssetModel,
  session,
} = {}) {
  const errors = [];
  const references = collectLayoutReferences(content);
  const unique = new Map(references.map((entry) => [`${entry.type}:${entry.value}`, entry]));
  const existence = new Map();
  const idOnly = content.product_reference_format === UI_LAYOUT_PRODUCT_REFERENCE_FORMAT;
  if (idOnly) {
    const values = (type) => [...unique.values()].filter((entry) => entry.type === type).map((entry) => entry.value);
    const find = (model, filter, selection) => model.find(filter).select(selection)
      .session(session ?? null).maxTimeMS(PRODUCT_BATCH_QUERY_TIMEOUT_MS).lean();
    // Use bounded set queries, sequentially within the transaction, rather than one lookup per block.
    for (const [type, model] of [["product", productModel], ["category", categoryModel],
      ["brand", brandModel], ["subcategory", subcategoryModel]]) {
      const ids = values(type);
      if (!ids.length) continue;
      const rows = await find(model, { _id: { $in: ids }, ...(type === "product" ? { isActive: true } : {}) }, "_id");
      const available = new Set(rows.map((row) => String(row._id)));
      ids.forEach((id) => existence.set(`${type}:${id}`, available.has(id)));
    }
    const urls = values("asset");
    if (urls.length) {
      const assets = await find(assetModel, { url: { $in: urls }, status: "ready" }, "url");
      const ready = new Set(assets.map((asset) => asset.url));
      const pending = urls.filter((url) => !ready.has(url));
      if (pending.length) {
        const products = await find(productModel, { isActive: true, $or: [
          { "images.url": { $in: pending } }, { "variants.images.url": { $in: pending } },
        ] }, "images.url variants.images.url");
        for (const product of products) {
          for (const image of [...(product.images ?? []), ...(product.variants ?? []).flatMap((variant) => variant.images ?? [])]) ready.add(image.url);
        }
        for (const model of [categoryModel, brandModel, subcategoryModel]) {
          const rows = await find(model, { "image.url": { $in: pending } }, "image.url");
          rows.forEach((row) => ready.add(row.image?.url));
        }
      }
      urls.forEach((url) => existence.set(`asset:${url}`, ready.has(url)));
    }
  }
  for (const [key, entry] of unique) {
    if (existence.has(key)) continue;
    if (entry.type === "screen" || entry.type === "url") {
      existence.set(key, true);
      continue;
    }
    if (entry.type !== "asset" && !mongoose.isValidObjectId(entry.value)) {
      existence.set(key, false);
      continue;
    }
    const filter = { _id: entry.value };
    let model;
    if (entry.type === "product") {
      model = productModel;
      filter.isActive = true;
    } else if (entry.type === "category") model = categoryModel;
    else if (entry.type === "brand") model = brandModel;
    else if (entry.type === "subcategory") model = subcategoryModel;
    else if (entry.type === "asset") {
      model = assetModel;
      delete filter._id;
      filter.url = entry.value;
      filter.status = "ready";
    }
    if (!model) {
      existence.set(key, false);
      continue;
    }
    const found = Boolean(await model.exists(filter).session(session ?? null));
    if (found || entry.type !== "asset") {
      existence.set(key, found);
      continue;
    }
    // Existing public catalog media can be selected without duplicating the image.
    const productImage = await productModel.exists({ isActive: true, $or: [
      { "images.url": entry.value }, { "variants.images.url": entry.value },
    ] }).session(session ?? null);
    const categoryImage = productImage ? null :
      await categoryModel.exists({ "image.url": entry.value }).session(session ?? null);
    const brandImage = productImage || categoryImage ? null :
      await brandModel.exists({ "image.url": entry.value }).session(session ?? null);
    const subcategoryImage = productImage || categoryImage || brandImage ? null :
      await subcategoryModel.exists({ "image.url": entry.value }).session(session ?? null);
    existence.set(key, Boolean(productImage || categoryImage || brandImage || subcategoryImage));
  }
  for (const entry of references) {
    if (!existence.get(`${entry.type}:${entry.value}`)) {
      errors.push({
        path: entry.path,
        code: entry.type === "asset" ? "ASSET_NOT_READY" :
          idOnly && entry.type === "product" ? "PRODUCT_REFERENCE_UNAVAILABLE" : "REFERENCE_NOT_PUBLIC",
        message: entry.type === "asset"
          ? "Image must be a ready UI Builder asset."
          : "Referenced catalog item is missing or unavailable.",
      });
    }
  }
  return errors;
}
