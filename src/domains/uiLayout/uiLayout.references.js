import mongoose from "mongoose";
import { ProductModel } from "../product/product.model.js";
import { CategoryModel } from "../category/category.model.js";
import { BrandModel } from "../brand/brand.model.js";
import { UiLayoutAssetModel } from "./uiLayout.model.js";

function collect(content) {
  const references = [];
  for (const [sectionIndex, section] of content.sections.entries()) {
    const path = `content.sections[${sectionIndex}].data`;
    if (section.section_type === "admin_promo") {
      if (section.data.image_url) references.push({ type: "asset", value: section.data.image_url, path: `${path}.image_url` });
      if (section.data.action) references.push({ ...section.data.action, path: `${path}.action.value` });
    }
    if (section.section_type === "dynamic_section") {
      if (section.data.action) references.push({ ...section.data.action, path: `${path}.action.value` });
      for (const [itemIndex, item] of section.data.items.entries()) {
        const itemPath = `${path}.items[${itemIndex}]`;
        if (item.image_url) references.push({ type: "asset", value: item.image_url, path: `${itemPath}.image_url` });
        if (item.action) references.push({ ...item.action, path: `${itemPath}.action.value` });
      }
    }
  }
  return references;
}

export async function inspectLayoutReferences(content, {
  productModel = ProductModel,
  categoryModel = CategoryModel,
  brandModel = BrandModel,
  assetModel = UiLayoutAssetModel,
  session,
} = {}) {
  const errors = [];
  const references = collect(content);
  const unique = new Map(references.map((entry) => [`${entry.type}:${entry.value}`, entry]));
  const existence = new Map();
  for (const [key, entry] of unique) {
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
    existence.set(key, Boolean(productImage || categoryImage || brandImage));
  }
  for (const entry of references) {
    if (!existence.get(`${entry.type}:${entry.value}`)) {
      errors.push({
        path: entry.path,
        code: entry.type === "asset" ? "ASSET_NOT_READY" : "REFERENCE_NOT_PUBLIC",
        message: entry.type === "asset"
          ? "Image must be a ready UI Builder asset."
          : "Referenced catalog item is missing or unavailable.",
      });
    }
  }
  return errors;
}
