import { ProductModel } from "./product.model.js";

export async function countProducts(filter = {}) {
  return ProductModel.countDocuments(filter);
}

export function findProducts(
  filter = {},
  { skip, limit, sort, select, lean } = {}
) {
  const query = ProductModel.find(filter)
    .populate("category", "_id slug name_en name_ar")
    .populate("subcategory", "_id slug name_en name_ar")
    .populate("brand", "_id slug name_en name_ar");

  if (select) {
    query.select(select);
  }

  if (lean) {
    query.lean();
  }

  if (typeof skip === "number" && skip > 0) {
    query.skip(skip);
  }

  if (typeof limit === "number" && limit > 0) {
    query.limit(limit);
  }

  if (sort) {
    query.sort(sort);
  }

  return query;
}

export function findProductById(id) {
  return ProductModel.findById(id);
}

export function findProductByIdWithRefs(id) {
  return ProductModel.findById(id)
    .populate("category", "_id slug name_en name_ar")
    .populate("subcategory", "_id slug name_en name_ar")
    .populate("brand", "_id slug name_en name_ar");
}

export function findProductBySlug(slug) {
  return ProductModel.findOne({ slug });
}

export async function createProduct(doc) {
  return ProductModel.create(doc);
}

export async function deleteProductById(id) {
  return ProductModel.deleteOne({ _id: id });
}

export function findProductsByIds(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  return ProductModel.find({ _id: { $in: ids } });
}

export function findProductsByIdsWithOptions(
  ids = [],
  { select, lean } = {}
) {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const query = ProductModel.find({ _id: { $in: ids } });

  if (select) {
    query.select(select);
  }

  if (lean) {
    query.lean();
  }

  return query;
}
