import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Redis from "ioredis";

import { ProductModel } from "../src/domains/product/product.model.js";
import { WarehouseModel } from "../src/domains/warehouse/warehouse.model.js";

export const TARGET_WAREHOUSE = Object.freeze({
  id: "692bbc429f57e4ac405c8ca0",
  code: "3RD_SETTELMENT",
  name: "3rd settelment (El-andalus)",
});

const BACKUP_VERSION = 1;
const BACKUP_DIRECTORY = path.resolve("scripts/warehouse-stock-backups");
const PRODUCT_CACHE_PATTERNS = [
  "product:*",
  "products:list:v2:*",
  "search:v4:*",
  "recs:home:*",
  "recs:related:*",
];

function asId(value) {
  return value == null ? null : String(value);
}

function asQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : null;
}

function stockSnapshot(stocks) {
  return (Array.isArray(stocks) ? stocks : []).map((stock, index) => ({
    index,
    warehouseId: asId(stock?.warehouse),
    quantity: asQuantity(stock?.quantity),
  }));
}

export function productStockSnapshot(product) {
  return {
    productId: asId(product?._id),
    slug: product?.slug || null,
    name_en: product?.name_en || null,
    type: product?.type || null,
    warehouseStocks: stockSnapshot(product?.warehouseStocks),
    variants: (Array.isArray(product?.variants) ? product.variants : []).map(
      (variant, variantIndex) => ({
        variantIndex,
        variantId: asId(variant?._id),
        sku: variant?.sku || null,
        warehouseStocks: stockSnapshot(variant?.warehouseStocks),
      }),
    ),
  };
}

export function getTargetStockEntries(snapshot, warehouseId) {
  const targetId = String(warehouseId);
  const entries = [];

  for (const stock of snapshot.warehouseStocks || []) {
    if (stock.warehouseId === targetId) {
      entries.push({ kind: "simple", ...stock });
    }
  }

  for (const variant of snapshot.variants || []) {
    for (const stock of variant.warehouseStocks || []) {
      if (stock.warehouseId === targetId) {
        entries.push({
          kind: "variant",
          variantIndex: variant.variantIndex,
          variantId: variant.variantId,
          sku: variant.sku,
          ...stock,
        });
      }
    }
  }

  return entries;
}

function targetTopology(snapshot, warehouseId) {
  return getTargetStockEntries(snapshot, warehouseId).map((entry) => ({
    kind: entry.kind,
    variantIndex: entry.variantIndex ?? null,
    variantId: entry.variantId ?? null,
    stockIndex: entry.index,
    warehouseId: entry.warehouseId,
  }));
}

function nonTargetState(snapshot, warehouseId) {
  const targetId = String(warehouseId);
  return {
    productId: snapshot.productId,
    type: snapshot.type,
    warehouseStocks: (snapshot.warehouseStocks || []).filter(
      (stock) => stock.warehouseId !== targetId,
    ),
    variants: (snapshot.variants || []).map((variant) => ({
      variantIndex: variant.variantIndex,
      variantId: variant.variantId,
      sku: variant.sku,
      warehouseStocks: (variant.warehouseStocks || []).filter(
        (stock) => stock.warehouseId !== targetId,
      ),
    })),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function summarizeSnapshots(snapshots, warehouseId) {
  const summary = {
    totalProducts: snapshots.length,
    totalSimpleProducts: 0,
    totalVariantProducts: 0,
    totalVariants: 0,
    simpleProductsWithTargetEntry: 0,
    simpleProductsWithoutTargetEntry: 0,
    simpleTargetEntries: 0,
    simpleEntriesChangingToZero: 0,
    simpleEntriesAlreadyZero: 0,
    simpleQuantityBefore: 0,
    variantProductsWithTargetEntry: 0,
    variantProductsWithoutTargetEntry: 0,
    variantsWithTargetEntry: 0,
    variantsWithoutTargetEntry: 0,
    variantTargetEntries: 0,
    variantEntriesChangingToZero: 0,
    variantEntriesAlreadyZero: 0,
    variantQuantityBefore: 0,
    productsRequiringChange: 0,
  };

  for (const snapshot of snapshots) {
    const entries = getTargetStockEntries(snapshot, warehouseId);
    if (snapshot.type === "SIMPLE") {
      summary.totalSimpleProducts += 1;
      if (entries.length) summary.simpleProductsWithTargetEntry += 1;
      else summary.simpleProductsWithoutTargetEntry += 1;
    } else if (snapshot.type === "VARIANT") {
      summary.totalVariantProducts += 1;
      summary.totalVariants += snapshot.variants.length;
      if (entries.length) summary.variantProductsWithTargetEntry += 1;
      else summary.variantProductsWithoutTargetEntry += 1;

      for (const variant of snapshot.variants) {
        const hasTarget = variant.warehouseStocks.some(
          (stock) => stock.warehouseId === String(warehouseId),
        );
        if (hasTarget) summary.variantsWithTargetEntry += 1;
        else summary.variantsWithoutTargetEntry += 1;
      }
    }

    let productChanges = false;
    for (const entry of entries) {
      const quantity = entry.quantity || 0;
      if (entry.kind === "simple") {
        summary.simpleTargetEntries += 1;
        summary.simpleQuantityBefore += quantity;
        if (quantity === 0) summary.simpleEntriesAlreadyZero += 1;
        else {
          summary.simpleEntriesChangingToZero += 1;
          productChanges = true;
        }
      } else {
        summary.variantTargetEntries += 1;
        summary.variantQuantityBefore += quantity;
        if (quantity === 0) summary.variantEntriesAlreadyZero += 1;
        else {
          summary.variantEntriesChangingToZero += 1;
          productChanges = true;
        }
      }
    }
    if (productChanges) summary.productsRequiringChange += 1;
  }

  return summary;
}

function verifyReset(beforeSnapshots, afterSnapshots, warehouseId) {
  const afterById = new Map(
    afterSnapshots.map((snapshot) => [snapshot.productId, snapshot]),
  );
  const errors = [];

  for (const before of beforeSnapshots) {
    const after = afterById.get(before.productId);
    if (!after) {
      errors.push(`Product disappeared during verification: ${before.productId}`);
      continue;
    }
    if (
      !sameJson(
        targetTopology(before, warehouseId),
        targetTopology(after, warehouseId),
      )
    ) {
      errors.push(`Target stock topology changed: ${before.productId}`);
    }
    if (
      !sameJson(
        nonTargetState(before, warehouseId),
        nonTargetState(after, warehouseId),
      )
    ) {
      errors.push(`A non-target warehouse changed: ${before.productId}`);
    }
    if (
      getTargetStockEntries(after, warehouseId).some(
        (entry) => entry.quantity !== 0,
      )
    ) {
      errors.push(`Target quantity is still non-zero: ${before.productId}`);
    }
  }

  if (errors.length) {
    throw new Error(`Stock verification failed:\n${errors.join("\n")}`);
  }
}

function backupChecksum(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function writeBackup({ warehouse, snapshots, summary }) {
  await fs.mkdir(BACKUP_DIRECTORY, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(
    BACKUP_DIRECTORY,
    `el-andalus-stock-${timestamp}.json`,
  );
  const payload = {
    backupVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    warehouse,
    summary,
    products: snapshots,
  };
  const backup = { ...payload, checksum: backupChecksum(payload) };
  await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, {
    flag: "wx",
  });
  return { backupPath, backup };
}

async function markBackupApplied(backupPath, backup) {
  const { checksum: _oldChecksum, ...payload } = backup;
  payload.appliedAt = new Date().toISOString();
  const appliedBackup = {
    ...payload,
    checksum: backupChecksum(payload),
  };
  await fs.writeFile(backupPath, `${JSON.stringify(appliedBackup, null, 2)}\n`);
}

async function verifyWarehouse() {
  const warehouse = await WarehouseModel.findById(TARGET_WAREHOUSE.id)
    .select("_id name code address governorate active fulfillment.status")
    .lean();

  if (!warehouse) {
    throw new Error(`Target warehouse not found: ${TARGET_WAREHOUSE.id}`);
  }
  if (
    warehouse.code !== TARGET_WAREHOUSE.code ||
    warehouse.name !== TARGET_WAREHOUSE.name
  ) {
    throw new Error(
      `Warehouse safety check failed. Expected ${TARGET_WAREHOUSE.name} (${TARGET_WAREHOUSE.code}), found ${warehouse.name} (${warehouse.code})`,
    );
  }

  return {
    id: String(warehouse._id),
    name: warehouse.name,
    code: warehouse.code,
    address: warehouse.address || null,
    governorate: warehouse.governorate || null,
    active: warehouse.active,
    fulfillmentStatus: warehouse.fulfillment?.status || null,
  };
}

async function readProductSnapshots({ session } = {}) {
  let query = ProductModel.find({ type: { $in: ["SIMPLE", "VARIANT"] } })
    .select(
      "_id slug name_en type warehouseStocks.warehouse warehouseStocks.quantity variants._id variants.sku variants.warehouseStocks.warehouse variants.warehouseStocks.quantity",
    )
    .sort({ _id: 1 })
    .lean();
  if (session) query = query.session(session);
  const products = await query;
  return products.map(productStockSnapshot);
}

async function readSnapshotsByIds(productIds, { session } = {}) {
  let query = ProductModel.find({ _id: { $in: productIds } })
    .select(
      "_id slug name_en type warehouseStocks.warehouse warehouseStocks.quantity variants._id variants.sku variants.warehouseStocks.warehouse variants.warehouseStocks.quantity",
    )
    .sort({ _id: 1 })
    .lean();
  if (session) query = query.session(session);
  const products = await query;
  return products.map(productStockSnapshot);
}

export async function clearProductCaches() {
  if (!process.env.REDIS_URL) {
    return { skipped: true, reason: "REDIS_URL is not configured" };
  }

  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    let deleted = 0;
    for (const pattern of PRODUCT_CACHE_PATTERNS) {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          200,
        );
        cursor = nextCursor;
        if (keys.length) deleted += await redis.del(...keys);
      } while (cursor !== "0");
    }
    const productListVersion = await redis.incr("products:list:version");
    await redis.quit();
    return {
      skipped: false,
      deleted,
      productListVersion: String(productListVersion),
    };
  } catch (error) {
    redis.disconnect();
    return { skipped: true, reason: error.message };
  }
}

async function dryRun() {
  const warehouse = await verifyWarehouse();
  const snapshots = await readProductSnapshots();
  const summary = summarizeSnapshots(snapshots, warehouse.id);

  return {
    mode: "dry-run",
    warehouse,
    summary,
    note: "Products or variants without a warehouse stock entry are already effectively zero and will not be modified.",
  };
}

async function applyReset() {
  const warehouse = await verifyWarehouse();
  const session = await mongoose.startSession();
  let backupPath;
  let backup;
  let updateResults;
  let changedSnapshots;

  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });

    const allSnapshots = await readProductSnapshots({ session });
    const summary = summarizeSnapshots(allSnapshots, warehouse.id);
    changedSnapshots = allSnapshots.filter((snapshot) =>
      getTargetStockEntries(snapshot, warehouse.id).some(
        (entry) => entry.quantity !== 0,
      ),
    );

    if (!changedSnapshots.length) {
      await session.abortTransaction();
      return {
        mode: "apply",
        warehouse,
        summary,
        changed: false,
        message: "Every existing target warehouse stock entry is already zero.",
      };
    }

    ({ backupPath, backup } = await writeBackup({
      warehouse,
      snapshots: changedSnapshots,
      summary,
    }));

    const targetObjectId = new mongoose.Types.ObjectId(warehouse.id);
    // MongoDB sessions do not support parallel operations inside one
    // transaction, so run the two narrowly-scoped updates sequentially.
    const simpleResult = await ProductModel.updateMany(
      {
        type: "SIMPLE",
        warehouseStocks: {
          $elemMatch: {
            warehouse: targetObjectId,
            quantity: { $ne: 0 },
          },
        },
      },
      { $set: { "warehouseStocks.$[stock].quantity": 0 } },
      {
        arrayFilters: [{ "stock.warehouse": targetObjectId }],
        session,
      },
    );
    const variantResult = await ProductModel.updateMany(
      {
        type: "VARIANT",
        variants: {
          $elemMatch: {
            warehouseStocks: {
              $elemMatch: {
                warehouse: targetObjectId,
                quantity: { $ne: 0 },
              },
            },
          },
        },
      },
      {
        $set: {
          "variants.$[].warehouseStocks.$[stock].quantity": 0,
        },
      },
      {
        arrayFilters: [{ "stock.warehouse": targetObjectId }],
        session,
      },
    );

    const productIds = changedSnapshots.map((snapshot) => snapshot.productId);
    const afterSnapshots = await readSnapshotsByIds(productIds, { session });
    verifyReset(changedSnapshots, afterSnapshots, warehouse.id);

    updateResults = {
      simple: {
        matchedProducts: simpleResult.matchedCount || 0,
        modifiedProducts: simpleResult.modifiedCount || 0,
      },
      variant: {
        matchedProducts: variantResult.matchedCount || 0,
        modifiedProducts: variantResult.modifiedCount || 0,
      },
    };

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (backupPath) {
      error.message = `${error.message}\nPrepared rollback backup: ${backupPath}`;
    }
    throw error;
  } finally {
    await session.endSession();
  }

  await markBackupApplied(backupPath, backup);

  const productIds = changedSnapshots.map((snapshot) => snapshot.productId);
  const committedSnapshots = await readSnapshotsByIds(productIds);
  verifyReset(changedSnapshots, committedSnapshots, warehouse.id);

  const targetObjectId = new mongoose.Types.ObjectId(warehouse.id);
  const [remainingSimpleNonZero, remainingVariantNonZero] = await Promise.all([
    ProductModel.countDocuments({
      type: "SIMPLE",
      warehouseStocks: {
        $elemMatch: { warehouse: targetObjectId, quantity: { $ne: 0 } },
      },
    }),
    ProductModel.countDocuments({
      type: "VARIANT",
      variants: {
        $elemMatch: {
          warehouseStocks: {
            $elemMatch: { warehouse: targetObjectId, quantity: { $ne: 0 } },
          },
        },
      },
    }),
  ]);

  if (remainingSimpleNonZero || remainingVariantNonZero) {
    throw new Error(
      `Post-commit verification found non-zero target stock: simple=${remainingSimpleNonZero}, variant=${remainingVariantNonZero}`,
    );
  }

  const cache = await clearProductCaches();
  return {
    mode: "apply",
    warehouse,
    changed: true,
    backupPath,
    changedProducts: changedSnapshots.length,
    updateResults,
    verification: {
      remainingSimpleNonZero,
      remainingVariantNonZero,
      otherWarehouseStocksUnchanged: true,
    },
    cache,
  };
}

function parseArguments(argv) {
  const apply = argv.includes("--apply");
  const confirmArg = argv.find((arg) =>
    arg.startsWith("--confirm-warehouse-id="),
  );
  return {
    apply,
    confirmedWarehouseId: confirmArg?.slice(
      "--confirm-warehouse-id=".length,
    ),
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const { apply, confirmedWarehouseId } = parseArguments(argv);

  if (apply && confirmedWarehouseId !== TARGET_WAREHOUSE.id) {
    throw new Error(
      `Apply requires --confirm-warehouse-id=${TARGET_WAREHOUSE.id}`,
    );
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    const result = apply ? await applyReset() : await dryRun();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await mongoose.disconnect();
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error("[Warehouse Stock Reset] Failed:", error.message);
    process.exitCode = 1;
  });
}
