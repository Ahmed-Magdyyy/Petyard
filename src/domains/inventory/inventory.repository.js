import { ProductModel } from "../product/product.model.js";
import { InventoryAuditModel } from "./inventoryAudit.model.js";

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function revisionMatch(revision) {
  return revision === undefined ? { $exists: false } : revision;
}

export async function findInventoryAudit({ operationId, skuKey, action, session }) {
  return withSession(
    InventoryAuditModel.findOne({ operationId, skuKey, action }).lean(),
    session,
  );
}

export async function createInventoryAudit(audit, { session } = {}) {
  const [created] = await InventoryAuditModel.create([audit], { session });
  return created;
}

export async function findInventoryStockRow({ sku, warehouseId, session }) {
  const product = await withSession(
    ProductModel.findById(sku.productId)
      .select("_id type warehouseStocks variants._id variants.warehouseStocks")
      .lean(),
    session,
  );

  if (!product) return null;

  if (sku.productType === "SIMPLE") {
    const row = (product.warehouseStocks || []).find(
      (stock) => String(stock.warehouse) === String(warehouseId),
    );
    return row ? { product, row } : null;
  }

  const variant = (product.variants || []).find(
    (entry) => String(entry._id) === String(sku.variantId),
  );
  const row = (variant?.warehouseStocks || []).find(
    (stock) => String(stock.warehouse) === String(warehouseId),
  );
  return row ? { product, variant, row } : null;
}

export async function updateInventoryStockCAS({
  sku,
  warehouseId,
  quantity,
  expectedRevision,
  expectedQuantity,
  direction,
  session,
}) {
  const stockMatch = {
    warehouse: warehouseId,
    revision: revisionMatch(expectedRevision),
  };
  // A staff shortage correction is an absolute compare-and-set: both the
  // revision and the stock count observed by the staff member must still
  // match. Reservations/restores only need the normal decrement guard.
  if (Number.isInteger(expectedQuantity)) {
    stockMatch.quantity = expectedQuantity;
  } else if (direction < 0) {
    stockMatch.quantity = { $gte: quantity };
  }

  if (sku.productType === "SIMPLE") {
    return ProductModel.updateOne(
      {
        _id: sku.productId,
        type: "SIMPLE",
        warehouseStocks: { $elemMatch: stockMatch },
      },
      {
        $inc: {
          "warehouseStocks.$.quantity": direction * quantity,
          "warehouseStocks.$.revision": 1,
        },
      },
      { session },
    );
  }

  return ProductModel.updateOne(
    {
      _id: sku.productId,
      type: "VARIANT",
      variants: {
        $elemMatch: {
          _id: sku.variantId,
          warehouseStocks: { $elemMatch: stockMatch },
        },
      },
    },
    {
      $inc: {
        "variants.$[variant].warehouseStocks.$[stock].quantity": direction * quantity,
        "variants.$[variant].warehouseStocks.$[stock].revision": 1,
      },
    },
    {
      arrayFilters: [
        { "variant._id": sku.variantId },
        {
          "stock.warehouse": warehouseId,
          "stock.revision": revisionMatch(expectedRevision),
          ...(Number.isInteger(expectedQuantity)
            ? { "stock.quantity": expectedQuantity }
            : direction < 0
              ? { "stock.quantity": { $gte: quantity } }
              : {}),
        },
      ],
      session,
    },
  );
}
