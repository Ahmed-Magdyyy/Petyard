import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { inventoryAuditReasonEnum } from "../../shared/constants/enums.js";
import {
  createInventoryAudit,
  findInventoryAudit,
  findInventoryStockRow,
  updateInventoryStockCAS,
} from "./inventory.repository.js";

const SIMPLE = "SIMPLE";
const VARIANT = "VARIANT";

function inventoryError(message, statusCode, code) {
  const error = new ApiError(message, statusCode);
  error.code = code;
  return error;
}

function requireObjectId(value, field) {
  if (!mongoose.isValidObjectId(value)) {
    throw inventoryError(`${field} must be a valid id`, 400, "INVENTORY_INVALID_DEMAND");
  }
  return String(value);
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw inventoryError(
      `${field} must be a positive integer`,
      400,
      "INVENTORY_INVALID_QUANTITY",
    );
  }
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw inventoryError(
      `${field} must be a non-negative integer`,
      400,
      "INVENTORY_INVALID_QUANTITY",
    );
  }
  return value;
}

function normalizeRevision(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw inventoryError(
      "expectedRevision must be a non-negative integer",
      400,
      "INVENTORY_INVALID_REVISION",
    );
  }
  return value;
}

function normalizeReason(reason) {
  if (!Object.values(inventoryAuditReasonEnum).includes(reason)) {
    throw inventoryError("Invalid inventory audit reason", 400, "INVENTORY_INVALID_REASON");
  }
  return reason;
}

function getDemandList(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.demands)) return input.demands;
  if (Array.isArray(input?.items)) return input.items;
  return [];
}

function correctionExpectedQuantity(demand) {
  const value =
    demand.expectedQuantity ??
    demand.currentQuantity ??
    demand.expectedCurrentQuantity;

  return requireNonNegativeInteger(value, "expectedQuantity");
}

export function normalizeInventoryDemand(demand) {
  if (!demand || typeof demand !== "object") {
    throw inventoryError("Inventory demand is required", 400, "INVENTORY_INVALID_DEMAND");
  }

  const productId = requireObjectId(demand.productId ?? demand.product, "productId");
  const productType = String(demand.productType || demand.type || "").toUpperCase();
  const quantity = requirePositiveInteger(demand.quantity, "quantity");

  if (productType === SIMPLE) {
    return {
      productId,
      productType,
      variantId: null,
      quantity,
      expectedRevision: normalizeRevision(demand.expectedRevision),
      skuKey: `simple:${productId}`,
    };
  }

  if (productType === VARIANT) {
    const variantId = requireObjectId(demand.variantId, "variantId");
    return {
      productId,
      productType,
      variantId,
      quantity,
      expectedRevision: normalizeRevision(demand.expectedRevision),
      skuKey: `variant:${productId}:${variantId}`,
    };
  }

  throw inventoryError(
    "productType must be SIMPLE or VARIANT",
    400,
    "INVENTORY_INVALID_DEMAND",
  );
}

export function aggregateInventoryDemands(input) {
  const aggregated = new Map();

  for (const rawDemand of getDemandList(input)) {
    const demand = normalizeInventoryDemand(rawDemand);
    const existing = aggregated.get(demand.skuKey);
    if (!existing) {
      aggregated.set(demand.skuKey, demand);
      continue;
    }

    if (
      existing.expectedRevision !== undefined &&
      demand.expectedRevision !== undefined &&
      existing.expectedRevision !== demand.expectedRevision
    ) {
      throw inventoryError(
        `Conflicting expected revisions for ${demand.skuKey}`,
        400,
        "INVENTORY_INVALID_REVISION",
      );
    }

    existing.quantity += demand.quantity;
    existing.expectedRevision ??= demand.expectedRevision;
  }

  return [...aggregated.values()].sort((left, right) =>
    left.skuKey.localeCompare(right.skuKey),
  );
}

function normalizeCorrectionDemand(rawDemand) {
  const demand = normalizeInventoryDemand({
    ...rawDemand,
    // A correction uses an absolute target, while normalizeInventoryDemand
    // deliberately validates mutation quantities as positive.
    quantity: 1,
  });
  const expectedQuantity = correctionExpectedQuantity(rawDemand);
  const correctedQuantity = requireNonNegativeInteger(
    rawDemand?.correctedQuantity,
    "correctedQuantity",
  );

  if (demand.expectedRevision === undefined) {
    throw inventoryError(
      "expectedRevision is required for an inventory correction",
      400,
      "INVENTORY_INVALID_REVISION",
    );
  }
  if (correctedQuantity > expectedQuantity) {
    throw inventoryError(
      "correctedQuantity cannot increase unallocated stock",
      400,
      "INVENTORY_CORRECTION_CANNOT_ADD_STOCK",
    );
  }

  return {
    ...demand,
    expectedQuantity,
    correctedQuantity,
    quantity: expectedQuantity - correctedQuantity,
  };
}

function normalizeCorrectionDemands(input) {
  const demands = getDemandList(input).map(normalizeCorrectionDemand);
  if (!demands.length) {
    throw inventoryError("At least one inventory demand is required", 400, "INVENTORY_INVALID_DEMAND");
  }

  const seenSkuKeys = new Set();
  for (const demand of demands) {
    if (seenSkuKeys.has(demand.skuKey)) {
      throw inventoryError(
        `Duplicate correction demand for ${demand.skuKey}`,
        400,
        "INVENTORY_INVALID_DEMAND",
      );
    }
    seenSkuKeys.add(demand.skuKey);
  }
  return demands.sort((left, right) => left.skuKey.localeCompare(right.skuKey));
}

function normalizeOperationContext({
  warehouseId,
  operationId,
  actorId,
  actorUserId,
  orderId,
  requestId,
  metadata,
}) {
  if (!warehouseId || !mongoose.isValidObjectId(warehouseId)) {
    throw inventoryError("warehouseId must be a valid id", 400, "INVENTORY_INVALID_WAREHOUSE");
  }
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw inventoryError("operationId is required", 400, "INVENTORY_INVALID_OPERATION");
  }

  return {
    warehouseId: String(warehouseId),
    operationId: operationId.trim(),
    actor: actorId || actorUserId || undefined,
    order: orderId || undefined,
    request: requestId || undefined,
    metadata: metadata && typeof metadata === "object" ? metadata : undefined,
  };
}

function storedRevision(row) {
  return row?.revision === undefined ? undefined : row.revision;
}

function displayRevision(row) {
  return storedRevision(row) === undefined ? 0 : row.revision;
}

async function runInTransactionIfNeeded(session, callback) {
  if (session) return callback(session);

  const ownedSession = await mongoose.startSession();
  try {
    let result;
    await ownedSession.withTransaction(async () => {
      result = await callback(ownedSession);
    });
    return result;
  } finally {
    await ownedSession.endSession();
  }
}

async function applyInventoryMutation({
  demands,
  direction,
  reason,
  session,
  ...contextInput
}) {
  const context = normalizeOperationContext(contextInput);
  const action = normalizeReason(reason);
  const normalizedDemands = aggregateInventoryDemands(demands);

  if (!normalizedDemands.length) {
    throw inventoryError("At least one inventory demand is required", 400, "INVENTORY_INVALID_DEMAND");
  }

  return runInTransactionIfNeeded(session, async (activeSession) => {
    const results = [];

    for (const sku of normalizedDemands) {
      const existingAudit = await findInventoryAudit({
        operationId: context.operationId,
        skuKey: sku.skuKey,
        action,
        session: activeSession,
      });
      if (existingAudit) {
        results.push({ skuKey: sku.skuKey, idempotent: true, audit: existingAudit });
        continue;
      }

      const current = await findInventoryStockRow({
        sku,
        warehouseId: context.warehouseId,
        session: activeSession,
      });
      if (!current) {
        throw inventoryError(
          `No exact warehouse stock row exists for ${sku.skuKey}`,
          409,
          "INVENTORY_STOCK_CONFLICT",
        );
      }

      const actualRevision = displayRevision(current.row);
      if (
        sku.expectedRevision !== undefined &&
        sku.expectedRevision !== actualRevision
      ) {
        throw inventoryError(
          `Inventory revision changed for ${sku.skuKey}`,
          409,
          "INVENTORY_REVISION_CONFLICT",
        );
      }

      if (direction < 0 && current.row.quantity < sku.quantity) {
        throw inventoryError(
          `Insufficient unallocated stock for ${sku.skuKey}`,
          409,
          "INVENTORY_STOCK_CONFLICT",
        );
      }

      const updateResult = await updateInventoryStockCAS({
        sku,
        warehouseId: context.warehouseId,
        quantity: sku.quantity,
        expectedRevision: storedRevision(current.row),
        expectedQuantity: undefined,
        direction,
        session: activeSession,
      });

      if (updateResult.modifiedCount !== 1) {
        const latest = await findInventoryStockRow({
          sku,
          warehouseId: context.warehouseId,
          session: activeSession,
        });
        const latestRevision = latest ? displayRevision(latest.row) : null;
        const code =
          latestRevision !== actualRevision
            ? "INVENTORY_REVISION_CONFLICT"
            : "INVENTORY_STOCK_CONFLICT";
        throw inventoryError(`Inventory compare-and-set failed for ${sku.skuKey}`, 409, code);
      }

      const audit = await createInventoryAudit(
        {
          operationId: context.operationId,
          skuKey: sku.skuKey,
          action,
          product: sku.productId,
          variantId: sku.variantId || undefined,
          warehouse: context.warehouseId,
          quantity: sku.quantity,
          quantityBefore: current.row.quantity,
          quantityAfter: current.row.quantity + direction * sku.quantity,
          revisionBefore: actualRevision,
          revisionAfter: actualRevision + 1,
          actor: context.actor,
          order: context.order,
          request: context.request,
          metadata: context.metadata,
        },
        { session: activeSession },
      );

      results.push({
        skuKey: sku.skuKey,
        idempotent: false,
        quantityBefore: current.row.quantity,
        quantityAfter: current.row.quantity + direction * sku.quantity,
        revisionBefore: actualRevision,
        revisionAfter: actualRevision + 1,
        audit,
      });
    }

    return { warehouseId: context.warehouseId, operationId: context.operationId, results };
  });
}

export async function reserveInventoryAtomically({
  demands,
  session,
  reason = inventoryAuditReasonEnum.SUBSTITUTION_RESERVE,
  ...context
}) {
  return applyInventoryMutation({
    demands,
    direction: -1,
    reason,
    session,
    ...context,
  });
}

export async function releaseInventoryAtomically({
  demands,
  session,
  reason = inventoryAuditReasonEnum.SUBSTITUTION_RELEASE,
  ...context
}) {
  return applyInventoryMutation({
    demands,
    direction: 1,
    reason,
    session,
    ...context,
  });
}

// A shortage correction can only remove currently sellable, exact-warehouse
// inventory. It deliberately cannot recreate missing/offline-sold original
// units.
export async function correctUnallocatedInventoryCAS({
  demands,
  session,
  reason = inventoryAuditReasonEnum.SUBSTITUTION_ORIGINAL_CORRECTION,
  ...context
}) {
  const action = normalizeReason(reason);
  const normalizedDemands = normalizeCorrectionDemands(demands);
  const normalizedContext = normalizeOperationContext(context);

  return runInTransactionIfNeeded(session, async (activeSession) => {
    const results = [];

    for (const sku of normalizedDemands) {
      const existingAudit = await findInventoryAudit({
        operationId: normalizedContext.operationId,
        skuKey: sku.skuKey,
        action,
        session: activeSession,
      });
      if (existingAudit) {
        results.push({ skuKey: sku.skuKey, idempotent: true, audit: existingAudit });
        continue;
      }

      const current = await findInventoryStockRow({
        sku,
        warehouseId: normalizedContext.warehouseId,
        session: activeSession,
      });
      if (!current) {
        throw inventoryError(
          `No exact warehouse stock row exists for ${sku.skuKey}`,
          409,
          "INVENTORY_STOCK_CONFLICT",
        );
      }

      const actualRevision = displayRevision(current.row);
      if (
        actualRevision !== sku.expectedRevision ||
        current.row.quantity !== sku.expectedQuantity
      ) {
        throw inventoryError(
          `Inventory changed for ${sku.skuKey}`,
          409,
          actualRevision !== sku.expectedRevision
            ? "INVENTORY_REVISION_CONFLICT"
            : "INVENTORY_STOCK_CONFLICT",
        );
      }

      // An already-correct value is intentionally a verified no-op: it never
      // creates an audit row or bumps revision, and therefore cannot later be
      // mistaken for an inventory reservation.
      if (sku.quantity === 0) {
        results.push({
          skuKey: sku.skuKey,
          idempotent: false,
          noOp: true,
          quantityBefore: current.row.quantity,
          quantityAfter: current.row.quantity,
          revisionBefore: actualRevision,
          revisionAfter: actualRevision,
        });
        continue;
      }

      const updateResult = await updateInventoryStockCAS({
        sku,
        warehouseId: normalizedContext.warehouseId,
        quantity: sku.quantity,
        expectedRevision: storedRevision(current.row),
        expectedQuantity: sku.expectedQuantity,
        direction: -1,
        session: activeSession,
      });
      if (updateResult.modifiedCount !== 1) {
        throw inventoryError(
          `Inventory compare-and-set failed for ${sku.skuKey}`,
          409,
          "INVENTORY_STOCK_CONFLICT",
        );
      }

      const audit = await createInventoryAudit(
        {
          operationId: normalizedContext.operationId,
          skuKey: sku.skuKey,
          action,
          product: sku.productId,
          variantId: sku.variantId || undefined,
          warehouse: normalizedContext.warehouseId,
          quantity: sku.quantity,
          quantityBefore: sku.expectedQuantity,
          quantityAfter: sku.correctedQuantity,
          revisionBefore: actualRevision,
          revisionAfter: actualRevision + 1,
          actor: normalizedContext.actor,
          order: normalizedContext.order,
          request: normalizedContext.request,
          metadata: normalizedContext.metadata,
        },
        { session: activeSession },
      );

      results.push({
        skuKey: sku.skuKey,
        idempotent: false,
        quantityBefore: sku.expectedQuantity,
        quantityAfter: sku.correctedQuantity,
        revisionBefore: actualRevision,
        revisionAfter: actualRevision + 1,
        audit,
      });
    }

    return {
      warehouseId: normalizedContext.warehouseId,
      operationId: normalizedContext.operationId,
      results,
    };
  });
}

export async function restoreFinalOrderInventory({
  order,
  warehouseId,
  operationId,
  actorId,
  actorUserId,
  requestId,
  metadata,
  reason = inventoryAuditReasonEnum.CANCEL_RESTORE,
  session,
}) {
  const orderId = order?._id || order?.id || order;
  const items = Array.isArray(order?.items) ? order.items : [];
  // New orders persist final fulfillmentQuantity. For legacy orders without
  // it, quantity is the only safe historical fallback. In either case we
  // never add finalizedUnavailableQuantity back into sellable inventory.
  const demands = items
    .map((item) => ({
      product: item.product,
      productType: item.productType,
      variantId: item.variantId,
      quantity:
        item.fulfillmentQuantity === undefined || item.fulfillmentQuantity === null
          ? item.quantity
          : item.fulfillmentQuantity,
    }))
    .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);

  if (!demands.length) {
    return { warehouseId: String(warehouseId), operationId, results: [] };
  }

  return applyInventoryMutation({
    demands,
    direction: 1,
    reason,
    session,
    warehouseId,
    operationId,
    actorId,
    actorUserId,
    orderId,
    requestId,
    metadata,
  });
}
