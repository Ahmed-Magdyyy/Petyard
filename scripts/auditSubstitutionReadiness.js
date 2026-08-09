import "@dotenvx/dotenvx/config";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import {
  databaseIdentity,
  findDuplicateWarehouseStockRows,
  findInvalidWarehouseStockRevisions,
  redactReportValue,
  validateSettlementInvariant,
  writeSubstitutionReport,
} from "./backfillSubstitutionReadiness.js";

const SAMPLE_LIMIT = 100;
const ACTIVE_REQUEST_STATUSES = new Set([
  "offered",
  "awaiting_card_payment",
  "instapay_submitted",
]);

function configuredRolloutWarehouses() {
  return new Set(
    String(process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isLegacyCardLoyaltyRiskOrder(order, rolloutWarehouses = new Set()) {
  if (
    order?.status !== "pending" ||
    order?.sideEffectsCommitted !== true ||
    !order?.user ||
    String(order.paymentMethod || "").toLowerCase() !== "card" ||
    !(Number(order.loyaltyPointsAwarded) > 0)
  ) {
    return false;
  }
  return (
    rolloutWarehouses.size === 0 ||
    rolloutWarehouses.has(String(order.warehouse || ""))
  );
}

function addSample(report, key, sample) {
  if (report.samples[key].length < SAMPLE_LIMIT) report.samples[key].push(sample);
}

export function findOrderLineReadinessProblems(order) {
  const problems = [];
  const seenLineIds = new Set();
  if (!Array.isArray(order?.items) || order.items.length === 0) {
    return ["items is missing or empty"];
  }

  order.items.forEach((item, index) => {
    const prefix = `items.${index}`;
  const validKind = item?.lineKind === "original" || item?.lineKind === "substitute";
  const validSubstitutionLine =
    item?.lineKind !== "substitute" ||
    (typeof item.sourceLineId === "string" && item.sourceLineId.trim());
    if (typeof item?.lineId !== "string" || !item.lineId.trim()) {
      problems.push(`${prefix}.lineId is missing`);
    } else if (seenLineIds.has(item.lineId.trim())) {
      problems.push(`${prefix}.lineId is duplicated`);
    } else {
      seenLineIds.add(item.lineId.trim());
    }
    if (!validKind) problems.push(`${prefix}.lineKind is invalid`);
    if (!validSubstitutionLine) problems.push(`${prefix}.sourceLineId is missing`);
    if (item?.lineKind === "original" && (item.sourceLineId || item.sourceSubstitutionRequest)) {
      problems.push(`${prefix} original line has substitution lineage`);
    }
    if (!Number.isInteger(item?.quantity) || item.quantity < 1) {
      problems.push(`${prefix}.quantity is invalid`);
    }
    if (!Number.isInteger(item?.fulfillmentQuantity) || item.fulfillmentQuantity < 0) {
      problems.push(`${prefix}.fulfillmentQuantity is invalid`);
    }
    if (!Number.isInteger(item?.finalizedUnavailableQuantity) || item.finalizedUnavailableQuantity < 0) {
      problems.push(`${prefix}.finalizedUnavailableQuantity is invalid`);
    }
    if (Number.isInteger(item?.quantity) && Number.isInteger(item?.fulfillmentQuantity) &&
      Number.isInteger(item?.finalizedUnavailableQuantity) &&
      item.fulfillmentQuantity + item.finalizedUnavailableQuantity !== item.quantity) {
      problems.push(`${prefix} fulfillment quantities do not reconcile`);
    }
    if (!Number.isSafeInteger(item?.itemPricePiastres) || item.itemPricePiastres < 0) {
      problems.push(`${prefix}.itemPricePiastres is invalid`);
    }
    if (!Number.isSafeInteger(item?.lineTotalPiastres) || item.lineTotalPiastres < 0) {
      problems.push(`${prefix}.lineTotalPiastres is invalid`);
    }
  });
  return problems;
}

function requestOwnerMatchesOrder(request, order) {
  if (request?.user) return String(request.user) === String(order?.user) && !order?.guestId;
  if (request?.guestId) return request.guestId === order?.guestId && !order?.user;
  return false;
}

export function findOrderRequestCoherenceProblems(order, request) {
  if (!request) {
    return order?.activeSubstitutionRequest
      ? ["order pointer does not reference an active request"]
      : order?.substitutionState !== "none" || order?.requiresCustomerAction !== false
        ? ["order has substitution state without an active request"]
        : [];
  }

  const expectedByStatus = {
    offered: { substitutionState: "awaiting_customer", requiresCustomerAction: true },
    awaiting_card_payment: { substitutionState: "awaiting_card_payment", requiresCustomerAction: true },
    instapay_submitted: { substitutionState: "instapay_submitted", requiresCustomerAction: false },
  };
  const expected = expectedByStatus[request.status];
  const problems = [];
  if (!expected) problems.push("active request has a terminal or invalid status");
  if (String(request.order) !== String(order?._id)) problems.push("request order does not match pointer order");
  if (String(request.warehouse) !== String(order?.warehouse)) problems.push("request warehouse does not match stored order warehouse");
  if (!requestOwnerMatchesOrder(request, order)) problems.push("request owner does not match order owner");
  if (expected && order?.substitutionState !== expected.substitutionState) {
    problems.push("order substitutionState does not match active request status");
  }
  if (expected && order?.requiresCustomerAction !== expected.requiresCustomerAction) {
    problems.push("order requiresCustomerAction does not match active request status");
  }
  return problems;
}

function isReadySettlement(settlement) {
  if (
    !settlement ||
    !["native", "backfilled"].includes(settlement.migrationState) ||
    !Number.isInteger(settlement.schemaVersion) ||
    !Number.isInteger(settlement.revision)
  ) {
    return false;
  }
  const amountFields = [
    "currentMerchandiseGrossPiastres",
    "originalCouponDiscountPiastres",
    "preservedCouponDiscountPiastres",
    "lockedNetShippingPiastres",
    "currentOrderValuePiastres",
    "walletDebitedPiastres",
    "walletCreditedPiastres",
    "cardCapturedPiastres",
    "cardRefundedPiastres",
    "cardDuePiastres",
    "instapaySubmittedPiastres",
    "instapayConfirmedPiastres",
    "deliveryDuePiastres",
    "pendingRefundLiabilityPiastres",
  ];
  if (amountFields.some((field) => !Object.hasOwn(settlement, field))) return false;
  return validateSettlementInvariant(settlement).valid;
}

export async function runSubstitutionReadinessAudit(connection) {
  const products = connection.connection.db.collection("products");
  const orders = connection.connection.db.collection("orders");
  const requests = connection.connection.db.collection("substitutionrequests");
  const rolloutWarehouses = configuredRolloutWarehouses();
  const report = {
    mode: "read-only-substitution-readiness-audit",
    database: databaseIdentity(connection),
    startedAt: new Date().toISOString(),
    scannedProducts: 0,
    scannedOrders: 0,
    scannedSubstitutionRequests: 0,
    eligiblePendingCommittedOrders: 0,
    eligibleOrdersMissingSafeSettlement: 0,
    eligibleOrdersMissingLineReadiness: 0,
    invalidSettlementInvariants: 0,
    manualReviewOrders: 0,
    ordersWithInvalidStoredWarehouse: 0,
    ordersWithInvalidLineReadiness: 0,
    duplicateWarehouseStockProducts: 0,
    productsWithInvalidStockRevisions: 0,
    activeRequestIndexConflicts: 0,
    activeRequestStatusConflicts: 0,
    activeRequestPointerConflicts: 0,
    missingRequiredIndexes: 0,
    featureConfiguration: {
      enabled: process.env.ORDER_SUBSTITUTIONS_ENABLED === "true",
      rolloutWarehouseAllowlist: [...rolloutWarehouses],
    },
    legacyCardLoyaltyRisk: {
      rolloutWarehouseScope:
        rolloutWarehouses.size === 0 ? "all-warehouses" : [...rolloutWarehouses],
      pendingCommittedRegisteredCardOrdersWithAwardedPoints: 0,
    },
    samples: {
      eligibleOrdersMissingSafeSettlement: [],
      eligibleOrdersMissingLineReadiness: [],
      invalidSettlementInvariants: [],
      manualReviewOrders: [],
      invalidStoredWarehouses: [],
      invalidLineReadiness: [],
      duplicateWarehouseStocks: [],
      invalidStockRevisions: [],
      activeRequestIndexConflicts: [],
      activeRequestStatusConflicts: [],
      activeRequestPointerConflicts: [],
      missingRequiredIndexes: [],
      legacyCardLoyaltyRiskOrders: [],
    },
  };

  const productCursor = products.find({}).sort({ _id: 1 });
  for await (const product of productCursor) {
    report.scannedProducts += 1;
    const duplicateRows = findDuplicateWarehouseStockRows(product);
    if (duplicateRows.length) {
      report.duplicateWarehouseStockProducts += 1;
      addSample(report, "duplicateWarehouseStocks", {
        productId: String(product._id),
        rows: duplicateRows,
      });
    }
    const invalidRevisions = findInvalidWarehouseStockRevisions(product);
    if (invalidRevisions.length) {
      report.productsWithInvalidStockRevisions += 1;
      addSample(report, "invalidStockRevisions", {
        productId: String(product._id),
        rows: invalidRevisions,
      });
    }
  }

  const orderCursor = orders.find({}).sort({ _id: 1 });
  for await (const order of orderCursor) {
    report.scannedOrders += 1;
    const lineProblems = findOrderLineReadinessProblems(order);
    const lineReady = lineProblems.length === 0;
    const settlementReady = isReadySettlement(order.settlement);
    const invariant = order.settlement
      ? validateSettlementInvariant(order.settlement)
      : { valid: false, reason: "settlement is missing" };

    if (order.settlement?.migrationState === "manual_review") {
      report.manualReviewOrders += 1;
      addSample(report, "manualReviewOrders", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
      });
    }
    if (!mongoose.isObjectIdOrHexString(order.warehouse)) {
      report.ordersWithInvalidStoredWarehouse += 1;
      addSample(report, "invalidStoredWarehouses", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        storedWarehouse: order.warehouse == null ? null : String(order.warehouse),
      });
    }
    if (!lineReady) {
      report.ordersWithInvalidLineReadiness += 1;
      addSample(report, "invalidLineReadiness", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        problems: lineProblems,
      });
    }
    if (!order.activeSubstitutionRequest) {
      const coherenceProblems = findOrderRequestCoherenceProblems(order, null);
      if (coherenceProblems.length) {
        report.activeRequestPointerConflicts += 1;
        addSample(report, "activeRequestPointerConflicts", {
          orderId: String(order._id), orderNumber: order.orderNumber || null, problems: coherenceProblems,
        });
      }
    }
    if (isLegacyCardLoyaltyRiskOrder(order, rolloutWarehouses)) {
      report.legacyCardLoyaltyRisk.pendingCommittedRegisteredCardOrdersWithAwardedPoints += 1;
      addSample(report, "legacyCardLoyaltyRiskOrders", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        warehouseId: String(order.warehouse || ""),
        loyaltyPointsAwarded: order.loyaltyPointsAwarded,
      });
    }
    if (order.settlement?.migrationState !== "manual_review" && order.settlement && !invariant.valid) {
      report.invalidSettlementInvariants += 1;
      addSample(report, "invalidSettlementInvariants", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        reason: invariant.reason,
      });
    }

    if (order.status !== "pending" || order.sideEffectsCommitted !== true) continue;
    report.eligiblePendingCommittedOrders += 1;
    if (!settlementReady) {
      report.eligibleOrdersMissingSafeSettlement += 1;
      addSample(report, "eligibleOrdersMissingSafeSettlement", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        migrationState: order.settlement?.migrationState || null,
      });
    }
    if (!lineReady) {
      report.eligibleOrdersMissingLineReadiness += 1;
      addSample(report, "eligibleOrdersMissingLineReadiness", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || null,
        problems: lineProblems,
      });
    }
  }

  const requestCursor = requests.find({}).sort({ _id: 1 });
  const activeRequestsById = new Map();
  for await (const request of requestCursor) {
    report.scannedSubstitutionRequests += 1;
    const statusIsActive = ACTIVE_REQUEST_STATUSES.has(request.status);
    if (request.isActive === true) activeRequestsById.set(String(request._id), request);
    if (Boolean(request.isActive) !== statusIsActive) {
      report.activeRequestStatusConflicts += 1;
      addSample(report, "activeRequestStatusConflicts", {
        requestId: String(request._id), status: request.status || null, isActive: Boolean(request.isActive),
      });
    }
  }

  const pointerOrderIdsByRequest = new Map();
  const pointerCursor = orders.find(
    { activeSubstitutionRequest: { $type: "objectId" } },
    { projection: { _id: 1, orderNumber: 1, user: 1, guestId: 1, warehouse: 1, activeSubstitutionRequest: 1, substitutionState: 1, requiresCustomerAction: 1 } },
  );
  for await (const order of pointerCursor) {
    const requestId = String(order.activeSubstitutionRequest);
    const request = activeRequestsById.get(requestId);
    const ids = pointerOrderIdsByRequest.get(requestId) || [];
    ids.push(String(order._id));
    pointerOrderIdsByRequest.set(requestId, ids);
    const coherenceProblems = findOrderRequestCoherenceProblems(order, request);
    if (coherenceProblems.length) {
      report.activeRequestPointerConflicts += 1;
      addSample(report, "activeRequestPointerConflicts", {
        orderId: String(order._id), orderNumber: order.orderNumber || null, requestId, problems: coherenceProblems,
      });
    }
  }
  for (const [requestId, request] of activeRequestsById) {
    const pointerOrderIds = pointerOrderIdsByRequest.get(requestId) || [];
    if (!pointerOrderIds.includes(String(request.order))) {
      report.activeRequestPointerConflicts += 1;
      addSample(report, "activeRequestPointerConflicts", {
        requestId, orderId: String(request.order), reason: "active request has no matching order pointer",
      });
    }
  }

  const activeRequestGroups = await requests
    .aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$order", count: { $sum: 1 }, requestIds: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  report.activeRequestIndexConflicts = activeRequestGroups.length;
  for (const group of activeRequestGroups.slice(0, SAMPLE_LIMIT)) {
    addSample(report, "activeRequestIndexConflicts", {
      orderId: String(group._id),
      requestIds: group.requestIds.map(String),
      count: group.count,
    });
  }

  try {
    const indexesByCollection = await Promise.all([orders.indexes(), requests.indexes()]);
    const requiredIndexes = [
      { collection: "orders", key: { activeSubstitutionRequest: 1 } },
      { collection: "substitutionrequests", key: { order: 1 }, unique: true, activeOnly: true },
      { collection: "substitutionrequests", key: { order: 1, requestSequence: 1 }, unique: true },
      { collection: "substitutionrequests", key: { order: 1, offerIdempotencyKey: 1 }, unique: true },
      { collection: "substitutionrequests", key: { status: 1, offerExpiresAt: 1 } },
      { collection: "substitutionrequests", key: { status: 1, paymentExpiresAt: 1 } },
    ];
    for (const required of requiredIndexes) {
      const indexes = required.collection === "orders" ? indexesByCollection[0] : indexesByCollection[1];
      const found = indexes.some((index) =>
        JSON.stringify(index.key) === JSON.stringify(required.key) &&
        (!required.unique || index.unique === true) &&
        (!required.activeOnly || index.partialFilterExpression?.isActive === true),
      );
      if (!found) {
        report.missingRequiredIndexes += 1;
        addSample(report, "missingRequiredIndexes", required);
      }
    }
  } catch (error) {
    report.missingRequiredIndexes += 1;
    addSample(report, "missingRequiredIndexes", {
      reason: "index inspection failed", error: redactReportValue(error?.message || String(error)),
    });
  }

  report.completedAt = new Date().toISOString();
  return report;
}

export async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  try {
    const report = await runSubstitutionReadinessAudit(connection);
    const output = await writeSubstitutionReport(report, "readiness-audit");
    console.log(`Substitution readiness audit report written: ${output}`);
    if (
      report.activeRequestIndexConflicts ||
      report.activeRequestStatusConflicts ||
      report.activeRequestPointerConflicts ||
      report.invalidSettlementInvariants ||
      report.duplicateWarehouseStockProducts ||
      report.productsWithInvalidStockRevisions ||
      report.ordersWithInvalidStoredWarehouse ||
      report.ordersWithInvalidLineReadiness ||
      report.missingRequiredIndexes
    ) {
      process.exitCode = 1;
    }
    return report;
  } finally {
    await mongoose.disconnect();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(redactReportValue(error?.stack || error?.message || String(error)));
    process.exitCode = 1;
  });
}
