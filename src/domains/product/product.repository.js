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

export function findProductIds(filter = {}) {
  return ProductModel.find(filter).select("_id").lean();
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

export function findSubstitutionCandidateProducts({
  warehouseId,
  searchRegex,
  skip = 0,
  limit = 20,
}) {
  const stockFilter = {
    $or: [
      {
        type: "SIMPLE",
        warehouseStocks: {
          $elemMatch: {
            warehouse: warehouseId,
            quantity: { $gt: 0 },
          },
        },
      },
      {
        type: "VARIANT",
        variants: {
          $elemMatch: {
            warehouseStocks: {
              $elemMatch: {
                warehouse: warehouseId,
                quantity: { $gt: 0 },
              },
            },
          },
        },
      },
    ],
  };

  const filter = searchRegex
    ? {
        isActive: true,
        $and: [
          stockFilter,
          {
            $or: [
              { name_en: searchRegex },
              { name_ar: searchRegex },
              { slug: searchRegex },
              { sku: searchRegex },
              { "variants.sku": searchRegex },
            ],
          },
        ],
      }
    : { isActive: true, ...stockFilter };

  return ProductModel.find(filter)
    .select(
      "_id slug type name_en name_ar subcategory brand price discountedPrice " +
        "images warehouseStocks variants._id variants.sku variants.price " +
        "variants.discountedPrice variants.options variants.images " +
        "variants.warehouseStocks",
    )
    .sort({ name_en: 1, _id: 1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export function countSubstitutionCandidateProducts({ warehouseId, searchRegex }) {
  const stockFilter = {
    $or: [
      {
        type: "SIMPLE",
        warehouseStocks: {
          $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } },
        },
      },
      {
        type: "VARIANT",
        variants: {
          $elemMatch: {
            warehouseStocks: {
              $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } },
            },
          },
        },
      },
    ],
  };

  const filter = searchRegex
    ? {
        isActive: true,
        $and: [
          stockFilter,
          {
            $or: [
              { name_en: searchRegex },
              { name_ar: searchRegex },
              { slug: searchRegex },
              { sku: searchRegex },
              { "variants.sku": searchRegex },
            ],
          },
        ],
      }
    : { isActive: true, ...stockFilter };

  return ProductModel.countDocuments(filter);
}
