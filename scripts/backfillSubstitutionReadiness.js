import "@dotenvx/dotenvx/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import { validateSettlementInvariant as validateStoredSettlementInvariant } from "../src/domains/settlement/settlement.service.js";
import { toPiastres } from "../src/shared/utils/money.js";

const REPORT_DIR = path.resolve("scripts/substitution-migration-reports");
const BATCH_SIZE_DEFAULT = 100;
const SAMPLE_LIMIT = 100;

const ORDER_TERMINAL_STATUSES = new Set(["cancelled", "returned", "failed"]);
const DELIVERY_METHODS = new Set(["cod", "pos_on_delivery"]);

const SETTLEMENT_AMOUNT_FIELDS = Object.freeze([
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
]);

function hasOwn(record, key) {
  return Boolean(record) && Object.prototype.hasOwnProperty.call(record, key);
}

function getPath(record, dottedPath) {
  return dottedPath.split(".").reduce(
    (current, key) => (current == null ? undefined : current[key]),
    record,
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

// Preserve the rollout-script API while using the application's only decimal
// EGP boundary conversion.
export const toPiastresExact = toPiastres;

export function legacyOrderLineId(orderId, index) {
  const digest = crypto
    .createHash("sha256")
    .update(`petyard:order-line-v1:${String(orderId)}:${index}`)
    .digest("hex");
  return `legacy-${digest.slice(0, 32)}`;
}

export function normalizeDatabaseHost(host) {
  if (typeof host !== "string") return null;
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return null;
  const atlasMember = normalized.match(
    /^([a-z0-9-]+-shard-\d+)-\d+(\.[a-z0-9-]+\.mongodb\.net)$/,
  );
  return atlasMember ? `${atlasMember[1]}${atlasMember[2]}` : normalized;
}

export function redactReportValue(value) {
  return typeof value === "string"
    ? value.replace(/(mongodb(?:\+srv)?:\/\/)[^\s"']+/gi, "$1[redacted]")
    : value;
}

export function databaseIdentity(connection) {
  return {
    host: redactReportValue(connection.connection.host),
    name: connection.connection.name,
  };
}

export function parseBackfillArguments(argv = process.argv.slice(2)) {
  const value = (name) =>
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const apply = argv.includes("--apply");
  const batchSize = Number(value("--batch-size") || BATCH_SIZE_DEFAULT);
  const productsAfter = value("--resume-products-after") || null;
  const ordersAfter = value("--resume-orders-after") || null;

  if (apply && !argv.includes("--confirm-live-db-rewrite")) {
    throw new Error("--apply requires --confirm-live-db-rewrite");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  for (const [name, valueToValidate] of [
    ["--resume-products-after", productsAfter],
    ["--resume-orders-after", ordersAfter],
  ]) {
    if (valueToValidate && !mongoose.isObjectIdOrHexString(valueToValidate)) {
      throw new Error(`${name} must be a MongoDB ObjectId`);
    }
  }

  return { apply, batchSize, productsAfter, ordersAfter };
}

function addMissingSet(plan, document, dottedPath, value) {
  if (getPath(document, dottedPath) !== undefined) return;
  plan.set[dottedPath] = value;
  plan.expectedMissingPaths.push(dottedPath);
}

function makeCompareBeforeUpdateOperation(documentId, plan) {
  if (Object.keys(plan.set).length === 0) return null;
  const filter = { _id: documentId };
  if (plan.expectedMissingPaths.length) {
    filter.$and = plan.expectedMissingPaths.map((field) => ({
      [field]: { $exists: false },
    }));
  }
  return {
    updateOne: {
      filter,
      update: { $set: plan.set },
    },
  };
}

export function validateSettlementInvariant(summary = {}) {
  return validateStoredSettlementInvariant(summary);
}

function settlementIsCompleteAndSafe(settlement) {
  if (!settlement || typeof settlement !== "object") {
    return { complete: false, valid: false, reason: "settlement is missing" };
  }
  if (!Number.isInteger(settlement.schemaVersion) || settlement.schemaVersion < 1) {
    return { complete: false, valid: false, reason: "schemaVersion is missing" };
  }
  if (!Number.isInteger(settlement.revision) || settlement.revision < 0) {
    return { complete: false, valid: false, reason: "revision is missing" };
  }
  if (typeof settlement.currency !== "string" || !/^[A-Z]{3}$/.test(settlement.currency)) {
    return { complete: false, valid: false, reason: "currency is missing" };
  }
  if (!["native", "backfilled", "manual_review"].includes(settlement.migrationState)) {
    return { complete: false, valid: false, reason: "migrationState is missing" };
  }
  if (SETTLEMENT_AMOUNT_FIELDS.some((field) => !hasOwn(settlement, field))) {
    return { complete: false, valid: false, reason: "settlement amounts are incomplete" };
  }
  const invariant = validateSettlementInvariant(settlement);
  return { complete: true, valid: invariant.valid, reason: invariant.reason, invariant };
}

function manuallyReviewSettlement(reason) {
  return { safe: false, reason, settlement: null };
}

export function classifyLegacyOrderSettlement(order) {
  if (!order || typeof order !== "object") {
    return manuallyReviewSettlement("order is invalid");
  }
  if (ORDER_TERMINAL_STATUSES.has(order.status)) {
    return manuallyReviewSettlement(`terminal order status: ${order.status}`);
  }
  if (["refunded", "failed"].includes(order.paymentStatus)) {
    return manuallyReviewSettlement(`unsafe payment status: ${order.paymentStatus}`);
  }
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return manuallyReviewSettlement("order has no items");
  }

  let lineSubtotalPiastres = 0;
  try {
    for (const [index, item] of order.items.entries()) {
      if (!isPositiveInteger(item?.quantity)) {
        return manuallyReviewSettlement(`items.${index}.quantity is invalid`);
      }
      toPiastresExact(item.itemPrice, `items.${index}.itemPrice`);
      lineSubtotalPiastres += toPiastresExact(item.lineTotal, `items.${index}.lineTotal`);
    }

    const subtotalPiastres = toPiastresExact(order.subtotal, "subtotal");
    const couponPiastres = toPiastresExact(order.discountAmount ?? 0, "discountAmount");
    const shippingPiastres = toPiastresExact(order.shippingFee, "shippingFee");
    const shippingDiscountPiastres = toPiastresExact(
      order.shippingDiscount ?? 0,
      "shippingDiscount",
    );
    const walletDebitedPiastres = toPiastresExact(order.walletUsed ?? 0, "walletUsed");
    const legacyTotalPiastres = toPiastresExact(order.total, "total");

    if (lineSubtotalPiastres !== subtotalPiastres) {
      return manuallyReviewSettlement("item line totals do not equal subtotal");
    }
    if (couponPiastres > subtotalPiastres || shippingDiscountPiastres > shippingPiastres) {
      return manuallyReviewSettlement("legacy discounts exceed their source amount");
    }

    const lockedNetShippingPiastres = shippingPiastres - shippingDiscountPiastres;
    const currentOrderValuePiastres =
      subtotalPiastres - couponPiastres + lockedNetShippingPiastres;

    // Legacy total is already the post-wallet amount. Requiring this equality
    // prevents the migration from inventing a payment bucket for corrupt data.
    if (legacyTotalPiastres + walletDebitedPiastres !== currentOrderValuePiastres) {
      return manuallyReviewSettlement("total plus walletUsed does not balance the order value");
    }

    const paymentMethod = String(order.paymentMethod || "cod").toLowerCase();
    const settlement = {
      schemaVersion: 1,
      revision: 0,
      currency: typeof order.currency === "string" && /^[A-Za-z]{3}$/.test(order.currency)
        ? order.currency.toUpperCase()
        : "EGP",
      currentMerchandiseGrossPiastres: subtotalPiastres,
      originalCouponDiscountPiastres: couponPiastres,
      preservedCouponDiscountPiastres: couponPiastres,
      lockedNetShippingPiastres,
      currentOrderValuePiastres,
      walletDebitedPiastres,
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 0,
      cardRefundedPiastres: 0,
      cardDuePiastres: 0,
      instapaySubmittedPiastres: 0,
      instapayConfirmedPiastres: 0,
      deliveryDuePiastres: 0,
      pendingRefundLiabilityPiastres: 0,
      migrationState: "backfilled",
    };

    if (paymentMethod === "card") {
      if (order.paymentStatus === "paid") {
        settlement.cardCapturedPiastres = legacyTotalPiastres;
      } else if (
        order.paymentStatus === "pending" &&
        order.status === "awaiting_payment"
      ) {
        settlement.cardDuePiastres = legacyTotalPiastres;
      } else {
        return manuallyReviewSettlement("card order is not safely classifiable");
      }
    } else if (paymentMethod === "instapay") {
      if (order.paymentStatus === "pending") {
        settlement.instapaySubmittedPiastres = legacyTotalPiastres;
      } else if (
        order.paymentStatus === "paid" &&
        new Set(["accepted", "shipped", "delivered"]).has(order.status)
      ) {
        settlement.instapayConfirmedPiastres = legacyTotalPiastres;
      } else {
        return manuallyReviewSettlement("InstaPay order is not safely classifiable");
      }
    } else if (DELIVERY_METHODS.has(paymentMethod)) {
      settlement.deliveryDuePiastres = legacyTotalPiastres;
    } else if (legacyTotalPiastres !== 0) {
      return manuallyReviewSettlement(`unknown payment method: ${paymentMethod}`);
    }

    const invariant = validateSettlementInvariant(settlement);
    if (!invariant.valid) return manuallyReviewSettlement(invariant.reason);
    return { safe: true, reason: null, settlement };
  } catch (error) {
    return manuallyReviewSettlement(error.message);
  }
}

function addLegacyLineBackfill(plan, order, reasons) {
  const seenLineIds = new Set();
  for (const item of order.items || []) {
    if (typeof item?.lineId === "string" && item.lineId.trim()) {
      if (seenLineIds.has(item.lineId.trim())) reasons.push("duplicate existing lineId");
      seenLineIds.add(item.lineId.trim());
    }
  }

  for (const [index, item] of (order.items || []).entries()) {
    const prefix = `items.${index}`;
    if (
      item?.lineKind === "substitute" ||
      item?.sourceLineId ||
      item?.sourceSubstitutionRequest
    ) {
      reasons.push(`${prefix} already contains substitution lineage`);
      continue;
    }
    if (item?.lineKind !== undefined && item.lineKind !== "original") {
      reasons.push(`${prefix}.lineKind is invalid`);
      continue;
    }
    if (!isPositiveInteger(item?.quantity)) {
      reasons.push(`${prefix}.quantity is invalid`);
      continue;
    }
    try {
      const itemPricePiastres = toPiastresExact(item.itemPrice, `${prefix}.itemPrice`);
      const lineTotalPiastres = toPiastresExact(item.lineTotal, `${prefix}.lineTotal`);
      addMissingSet(plan, order, `${prefix}.lineId`, legacyOrderLineId(order._id, index));
      addMissingSet(plan, order, `${prefix}.lineKind`, "original");
      addMissingSet(plan, order, `${prefix}.fulfillmentQuantity`, item.quantity);
      addMissingSet(plan, order, `${prefix}.finalizedUnavailableQuantity`, 0);
      addMissingSet(plan, order, `${prefix}.itemPricePiastres`, itemPricePiastres);
      addMissingSet(plan, order, `${prefix}.lineTotalPiastres`, lineTotalPiastres);
    } catch (error) {
      reasons.push(error.message);
    }
  }
}

export function buildOrderBackfillOperation(order) {
  const plan = { set: {}, expectedMissingPaths: [] };
  const reasons = [];
  if (!order?._id) return { operation: null, reason: "order has no _id", manualReview: true };

  addLegacyLineBackfill(plan, order, reasons);
  const lineBackfillIsUnsafe = reasons.length > 0;
  addMissingSet(plan, order, "substitutionState", "none");
  addMissingSet(plan, order, "requiresCustomerAction", false);
  addMissingSet(plan, order, "substitutionRevision", 0);

  const currentSettlement = settlementIsCompleteAndSafe(order.settlement);
  if (!hasOwn(order, "settlement")) {
    const classification = classifyLegacyOrderSettlement(order);
    if (classification.safe && !lineBackfillIsUnsafe) {
      addMissingSet(plan, order, "settlement", classification.settlement);
    } else {
      addMissingSet(plan, order, "settlement.migrationState", "manual_review");
      reasons.push(classification.reason || "order lines require manual review");
    }
  } else if (!currentSettlement.valid) {
    if (order.settlement?.migrationState === "native") {
      reasons.push(`existing native settlement is invalid: ${currentSettlement.reason}`);
    } else if (order.settlement?.migrationState !== "manual_review") {
      addMissingSet(plan, order, "settlement.migrationState", "manual_review");
      reasons.push(`existing settlement requires manual review: ${currentSettlement.reason}`);
    }
  }

  const operation = makeCompareBeforeUpdateOperation(order._id, plan);
  return {
    operation,
    manualReview:
      reasons.length > 0 ||
      order.settlement?.migrationState === "manual_review" ||
      (!hasOwn(order, "settlement") && !classifyLegacyOrderSettlement(order).safe),
    reasons: [...new Set(reasons)],
    changedFields: Object.keys(plan.set),
  };
}

export function findDuplicateWarehouseStockRows(product) {
  const duplicates = [];
  const inspectRows = (rows, rowPath) => {
    if (!Array.isArray(rows)) return;
    const indexesByWarehouse = new Map();
    rows.forEach((row, index) => {
      const warehouse = row?.warehouse == null ? null : String(row.warehouse);
      if (!warehouse) {
        duplicates.push({ path: `${rowPath}.${index}`, reason: "missing-warehouse" });
        return;
      }
      const indexes = indexesByWarehouse.get(warehouse) || [];
      indexes.push(index);
      indexesByWarehouse.set(warehouse, indexes);
    });
    for (const [warehouse, indexes] of indexesByWarehouse) {
      if (indexes.length > 1) {
        duplicates.push({ path: rowPath, warehouse, indexes, reason: "duplicate-warehouse" });
      }
    }
  };

  inspectRows(product?.warehouseStocks, "warehouseStocks");
  (product?.variants || []).forEach((variant, index) => {
    inspectRows(variant?.warehouseStocks, `variants.${index}.warehouseStocks`);
  });
  return duplicates;
}

export function findInvalidWarehouseStockRevisions(product) {
  const invalid = [];
  const inspectRows = (rows, rowPath) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((row, index) => {
      if (!Number.isInteger(row?.revision) || row.revision < 0) {
        invalid.push({
          path: `${rowPath}.${index}.revision`,
          value: row?.revision ?? null,
        });
      }
    });
  };

  inspectRows(product?.warehouseStocks, "warehouseStocks");
  (product?.variants || []).forEach((variant, index) => {
    inspectRows(variant?.warehouseStocks, `variants.${index}.warehouseStocks`);
  });
  return invalid;
}

export function buildProductRevisionBackfillOperation(product) {
  if (!product?._id) return { operation: null, skipped: true, reason: "product has no _id" };
  const duplicateRows = findDuplicateWarehouseStockRows(product);
  if (duplicateRows.length) {
    return { operation: null, skipped: true, reason: "duplicate-or-invalid-warehouse-stock", duplicateRows };
  }

  const plan = { set: {}, expectedMissingPaths: [] };
  const invalidRevisions = [];
  const inspectRows = (rows, rowPath) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((row, index) => {
      const path = `${rowPath}.${index}.revision`;
      if (row?.revision === undefined) {
        addMissingSet(plan, product, path, 0);
      } else if (!Number.isInteger(row.revision) || row.revision < 0) {
        invalidRevisions.push(path);
      }
    });
  };
  inspectRows(product.warehouseStocks, "warehouseStocks");
  (product.variants || []).forEach((variant, index) => {
    inspectRows(variant?.warehouseStocks, `variants.${index}.warehouseStocks`);
  });
  if (invalidRevisions.length) {
    return { operation: null, skipped: true, reason: "invalid-stock-revision", invalidRevisions };
  }

  return {
    operation: makeCompareBeforeUpdateOperation(product._id, plan),
    skipped: false,
    changedFields: Object.keys(plan.set),
  };
}

function addSample(report, key, value) {
  if (report.samples[key].length < SAMPLE_LIMIT) report.samples[key].push(value);
}

function summarizeBulkResult(target, result, expected) {
  target.batches += 1;
  target.expected += expected;
  target.matched += result?.matchedCount || 0;
  target.modified += result?.modifiedCount || 0;
  if (!result || result.matchedCount !== expected || result.modifiedCount !== expected) {
    target.compareBeforeUpdateConflicts += expected - (result?.matchedCount || 0);
  }
}

async function flushOperations(collection, entries, apply, summary) {
  if (!entries.length) return;
  if (!apply) {
    summary.planned += entries.length;
    return;
  }
  try {
    const result = await collection.bulkWrite(entries.map((entry) => entry.operation), { ordered: false });
    summarizeBulkResult(summary, result, entries.length);
  } catch (error) {
    summary.batches += 1;
    summary.expected += entries.length;
    summary.errors += 1;
  }
}

async function processCollection({
  collection,
  filter,
  batchSize,
  apply,
  build,
  onEntry,
  summary,
}) {
  const cursor = collection.find(filter).sort({ _id: 1 });
  let batch = [];
  let lastSeenId = null;
  for await (const document of cursor) {
    summary.scanned += 1;
    lastSeenId = String(document._id);
    const entry = build(document);
    onEntry(entry, document);
    if (entry.operation) batch.push(entry);
    if (batch.length >= batchSize) {
      await flushOperations(collection, batch, apply, summary);
      batch = [];
    }
  }
  await flushOperations(collection, batch, apply, summary);
  return lastSeenId;
}

function phaseFilter(after) {
  return after ? { _id: { $gt: new mongoose.Types.ObjectId(after) } } : {};
}

export async function writeSubstitutionReport(report, prefix) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const output = path.join(
    REPORT_DIR,
    `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return output;
}

export async function runSubstitutionBackfill(connection, options) {
  const products = connection.connection.db.collection("products");
  const orders = connection.connection.db.collection("orders");
  const report = {
    mode: options.apply ? "apply" : "dry-run",
    database: databaseIdentity(connection),
    startedAt: new Date().toISOString(),
    options: {
      batchSize: options.batchSize,
      resumeProductsAfter: options.productsAfter,
      resumeOrdersAfter: options.ordersAfter,
    },
    products: {
      scanned: 0, planned: 0, batches: 0, expected: 0, matched: 0, modified: 0,
      compareBeforeUpdateConflicts: 0, errors: 0, duplicateOrInvalidStockProducts: 0,
    },
    orders: {
      scanned: 0, planned: 0, batches: 0, expected: 0, matched: 0, modified: 0,
      compareBeforeUpdateConflicts: 0, errors: 0, manualReview: 0,
    },
    samples: { duplicateStocks: [], manualReviewOrders: [], errors: [] },
    resume: { productsAfter: null, ordersAfter: null },
  };

  report.resume.productsAfter = await processCollection({
    collection: products,
    filter: phaseFilter(options.productsAfter),
    batchSize: options.batchSize,
    apply: options.apply,
    summary: report.products,
    build: buildProductRevisionBackfillOperation,
    onEntry(entry, product) {
      if (entry.skipped && entry.duplicateRows?.length) {
        report.products.duplicateOrInvalidStockProducts += 1;
        addSample(report, "duplicateStocks", {
          productId: String(product._id),
          rows: entry.duplicateRows,
        });
      }
      if (entry.skipped && entry.reason === "invalid-stock-revision") {
        report.products.duplicateOrInvalidStockProducts += 1;
        addSample(report, "duplicateStocks", {
          productId: String(product._id),
          invalidRevisions: entry.invalidRevisions,
        });
      }
    },
  });

  report.resume.ordersAfter = await processCollection({
    collection: orders,
    filter: phaseFilter(options.ordersAfter),
    batchSize: options.batchSize,
    apply: options.apply,
    summary: report.orders,
    build: buildOrderBackfillOperation,
    onEntry(entry, order) {
      if (entry.manualReview) {
        report.orders.manualReview += 1;
        addSample(report, "manualReviewOrders", {
          orderId: String(order._id),
          orderNumber: order.orderNumber || null,
          reasons: entry.reasons,
        });
      }
    },
  });

  report.completedAt = new Date().toISOString();
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBackfillArguments(argv);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  try {
    const report = await runSubstitutionBackfill(connection, options);
    const output = await writeSubstitutionReport(report, "backfill");
    console.log(`Substitution backfill report written: ${output}`);
    if (
      report.products.errors ||
      report.orders.errors ||
      report.products.compareBeforeUpdateConflicts ||
      report.orders.compareBeforeUpdateConflicts
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
