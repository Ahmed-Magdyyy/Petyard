import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { ProductModel } from "../src/domains/product/product.model.js";
import { WarehouseModel } from "../src/domains/warehouse/warehouse.model.js";
import {
  clearProductCaches,
  productStockSnapshot,
} from "./setWarehouseStockZero.js";

export const EXPECTED_WAREHOUSES = Object.freeze([
  {
    id: "692a52009ce4d95e70dd70f3",
    code: "OCTOBERO01",
    name: "6 of october",
  },
  {
    id: "692b62312e775dc97b7ec634",
    code: "ALEXO01",
    name: "Alexandria",
  },
  {
    id: "692b72009e529a970828e5d1",
    code: "5TH_SETTELMENT",
    name: "5th settelment New Cairo",
  },
  {
    id: "692bbc429f57e4ac405c8ca0",
    code: "3RD_SETTELMENT",
    name: "3rd settelment (El-andalus)",
  },
]);

const BACKUP_VERSION = 1;
const BACKUP_DIRECTORY = path.resolve("scripts/warehouse-stock-backups");
const EXPECTED_IDS = EXPECTED_WAREHOUSES.map((warehouse) => warehouse.id);
const CONFIRMATION_VALUE = EXPECTED_IDS.join(",");

function countWarehouseIds(stocks) {
  const counts = new Map();
  for (const stock of Array.isArray(stocks) ? stocks : []) {
    if (!stock.warehouseId) continue;
    counts.set(stock.warehouseId, (counts.get(stock.warehouseId) || 0) + 1);
  }
  return counts;
}

function missingWarehouseIds(stocks, expectedIds = EXPECTED_IDS) {
  const existingIds = new Set(
    (Array.isArray(stocks) ? stocks : [])
      .map((stock) => stock.warehouseId)
      .filter(Boolean),
  );
  return expectedIds.filter((warehouseId) => !existingIds.has(warehouseId));
}

function duplicateWarehouseIds(stocks) {
  return [...countWarehouseIds(stocks).entries()]
    .filter(([, count]) => count > 1)
    .map(([warehouseId, count]) => ({ warehouseId, count }));
}

export function analyzeWarehouseCoverage(
  snapshots,
  expectedWarehouses = EXPECTED_WAREHOUSES,
) {
  const expectedIds = expectedWarehouses.map((warehouse) => warehouse.id);
  const missingByWarehouse = Object.fromEntries(
    expectedIds.map((warehouseId) => [
      warehouseId,
      { simpleEntries: 0, variantEntries: 0 },
    ]),
  );
  const changes = [];
  const duplicates = [];
  const summary = {
    totalProducts: snapshots.length,
    simpleProducts: 0,
    variantProducts: 0,
    totalVariants: 0,
    simpleProductsMissingAtLeastOneWarehouse: 0,
    variantsMissingAtLeastOneWarehouse: 0,
    missingSimpleEntries: 0,
    missingVariantEntries: 0,
    productsRequiringChange: 0,
    duplicateStockScopes: 0,
    missingByWarehouse,
  };

  for (const snapshot of snapshots) {
    const change = {
      productId: snapshot.productId,
      type: snapshot.type,
      simpleMissingWarehouseIds: [],
      variantChanges: [],
    };

    if (snapshot.type === "SIMPLE") {
      summary.simpleProducts += 1;
      change.simpleMissingWarehouseIds = missingWarehouseIds(
        snapshot.warehouseStocks,
        expectedIds,
      );
      if (change.simpleMissingWarehouseIds.length) {
        summary.simpleProductsMissingAtLeastOneWarehouse += 1;
        summary.missingSimpleEntries += change.simpleMissingWarehouseIds.length;
        for (const warehouseId of change.simpleMissingWarehouseIds) {
          missingByWarehouse[warehouseId].simpleEntries += 1;
        }
      }
      const duplicateIds = duplicateWarehouseIds(snapshot.warehouseStocks);
      if (duplicateIds.length) {
        duplicates.push({
          productId: snapshot.productId,
          scope: "simple",
          duplicateIds,
        });
      }
    } else if (snapshot.type === "VARIANT") {
      summary.variantProducts += 1;
      summary.totalVariants += snapshot.variants.length;

      for (const variant of snapshot.variants) {
        const missingIds = missingWarehouseIds(
          variant.warehouseStocks,
          expectedIds,
        );
        if (missingIds.length) {
          summary.variantsMissingAtLeastOneWarehouse += 1;
          summary.missingVariantEntries += missingIds.length;
          for (const warehouseId of missingIds) {
            missingByWarehouse[warehouseId].variantEntries += 1;
          }
          change.variantChanges.push({
            variantIndex: variant.variantIndex,
            variantId: variant.variantId,
            missingWarehouseIds: missingIds,
          });
        }

        const duplicateIds = duplicateWarehouseIds(variant.warehouseStocks);
        if (duplicateIds.length) {
          duplicates.push({
            productId: snapshot.productId,
            scope: "variant",
            variantIndex: variant.variantIndex,
            variantId: variant.variantId,
            duplicateIds,
          });
        }
      }
    }

    if (
      change.simpleMissingWarehouseIds.length ||
      change.variantChanges.length
    ) {
      changes.push(change);
    }
  }

  summary.productsRequiringChange = changes.length;
  summary.duplicateStockScopes = duplicates.length;
  return { summary, changes, duplicates };
}

function assertOriginalPrefix(beforeStocks, afterStocks, label) {
  if (afterStocks.length < beforeStocks.length) {
    throw new Error(`${label}: stock entries were removed`);
  }
  for (let index = 0; index < beforeStocks.length; index += 1) {
    if (JSON.stringify(beforeStocks[index]) !== JSON.stringify(afterStocks[index])) {
      throw new Error(`${label}: an existing stock entry changed at index ${index}`);
    }
  }
}

export function verifyNormalization(
  beforeSnapshots,
  afterSnapshots,
  expectedWarehouses = EXPECTED_WAREHOUSES,
) {
  const expectedIds = expectedWarehouses.map((warehouse) => warehouse.id);
  const afterById = new Map(
    afterSnapshots.map((snapshot) => [snapshot.productId, snapshot]),
  );

  for (const before of beforeSnapshots) {
    const after = afterById.get(before.productId);
    if (!after) throw new Error(`Product disappeared: ${before.productId}`);
    if (after.type !== before.type) {
      throw new Error(`Product type changed: ${before.productId}`);
    }

    if (before.type === "SIMPLE") {
      assertOriginalPrefix(
        before.warehouseStocks,
        after.warehouseStocks,
        `Product ${before.productId}`,
      );
      const counts = countWarehouseIds(after.warehouseStocks);
      for (const warehouseId of expectedIds) {
        if (counts.get(warehouseId) !== 1) {
          throw new Error(
            `Product ${before.productId} does not have exactly one ${warehouseId} entry`,
          );
        }
      }
      const originalIds = new Set(
        before.warehouseStocks.map((stock) => stock.warehouseId),
      );
      for (const stock of after.warehouseStocks) {
        if (!originalIds.has(stock.warehouseId) && stock.quantity !== 0) {
          throw new Error(
            `Product ${before.productId} received a non-zero default quantity`,
          );
        }
      }
      continue;
    }

    if (after.variants.length !== before.variants.length) {
      throw new Error(`Variant count changed: ${before.productId}`);
    }
    for (const beforeVariant of before.variants) {
      const afterVariant = after.variants[beforeVariant.variantIndex];
      if (!afterVariant || afterVariant.variantId !== beforeVariant.variantId) {
        throw new Error(
          `Variant identity changed: ${before.productId}/${beforeVariant.variantId}`,
        );
      }
      assertOriginalPrefix(
        beforeVariant.warehouseStocks,
        afterVariant.warehouseStocks,
        `Variant ${before.productId}/${beforeVariant.variantId}`,
      );
      const counts = countWarehouseIds(afterVariant.warehouseStocks);
      for (const warehouseId of expectedIds) {
        if (counts.get(warehouseId) !== 1) {
          throw new Error(
            `Variant ${beforeVariant.variantId} does not have exactly one ${warehouseId} entry`,
          );
        }
      }
      const originalIds = new Set(
        beforeVariant.warehouseStocks.map((stock) => stock.warehouseId),
      );
      for (const stock of afterVariant.warehouseStocks) {
        if (!originalIds.has(stock.warehouseId) && stock.quantity !== 0) {
          throw new Error(
            `Variant ${beforeVariant.variantId} received a non-zero default quantity`,
          );
        }
      }
    }
  }
}

function checksum(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function writeBackup({ warehouses, snapshots, summary }) {
  await fs.mkdir(BACKUP_DIRECTORY, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(
    BACKUP_DIRECTORY,
    `normalize-all-warehouse-stocks-${timestamp}.json`,
  );
  const payload = {
    backupVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    warehouses,
    summary,
    products: snapshots,
  };
  const backup = { ...payload, checksum: checksum(payload) };
  await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, {
    flag: "wx",
  });
  return { backupPath, backup };
}

async function markBackupApplied(backupPath, backup) {
  const { checksum: _oldChecksum, ...payload } = backup;
  payload.appliedAt = new Date().toISOString();
  const appliedBackup = { ...payload, checksum: checksum(payload) };
  await fs.writeFile(backupPath, `${JSON.stringify(appliedBackup, null, 2)}\n`);
}

async function verifyWarehouseSet() {
  const warehouses = await WarehouseModel.find({})
    .select("_id name code active fulfillment.status")
    .sort({ createdAt: 1 })
    .lean();

  if (warehouses.length !== EXPECTED_WAREHOUSES.length) {
    throw new Error(
      `Warehouse safety check failed: expected exactly ${EXPECTED_WAREHOUSES.length}, found ${warehouses.length}`,
    );
  }

  const warehouseById = new Map(
    warehouses.map((warehouse) => [String(warehouse._id), warehouse]),
  );
  for (const expected of EXPECTED_WAREHOUSES) {
    const actual = warehouseById.get(expected.id);
    if (
      !actual ||
      actual.code !== expected.code ||
      actual.name !== expected.name
    ) {
      throw new Error(
        `Warehouse safety check failed for ${expected.id}: expected ${expected.name} (${expected.code})`,
      );
    }
  }

  return warehouses.map((warehouse) => ({
    id: String(warehouse._id),
    name: warehouse.name,
    code: warehouse.code,
    active: warehouse.active,
    fulfillmentStatus: warehouse.fulfillment?.status || null,
  }));
}

async function readSnapshots({ session, productIds } = {}) {
  const filter = productIds ? { _id: { $in: productIds } } : {};
  let query = ProductModel.find(filter)
    .select(
      "_id slug name_en type warehouseStocks.warehouse warehouseStocks.quantity variants._id variants.sku variants.warehouseStocks.warehouse variants.warehouseStocks.quantity",
    )
    .sort({ _id: 1 })
    .lean();
  if (session) query = query.session(session);
  return (await query).map(productStockSnapshot);
}

function buildBulkOperations(changes) {
  return changes.map((change) => {
    const push = {};
    if (change.type === "SIMPLE") {
      push.warehouseStocks = {
        $each: change.simpleMissingWarehouseIds.map((warehouseId) => ({
          warehouse: new mongoose.Types.ObjectId(warehouseId),
          quantity: 0,
        })),
      };
    } else {
      for (const variantChange of change.variantChanges) {
        push[`variants.${variantChange.variantIndex}.warehouseStocks`] = {
          $each: variantChange.missingWarehouseIds.map((warehouseId) => ({
            warehouse: new mongoose.Types.ObjectId(warehouseId),
            quantity: 0,
          })),
        };
      }
    }
    return {
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(change.productId) },
        update: { $push: push },
      },
    };
  });
}

async function dryRun() {
  const warehouses = await verifyWarehouseSet();
  const snapshots = await readSnapshots();
  const analysis = analyzeWarehouseCoverage(snapshots, warehouses);
  return {
    mode: "dry-run",
    warehouses,
    summary: analysis.summary,
    duplicateExamples: analysis.duplicates.slice(0, 20),
    note: "Apply only appends missing warehouse entries with quantity 0; existing entries and quantities are preserved.",
  };
}

async function applyNormalization() {
  const warehouses = await verifyWarehouseSet();
  const session = await mongoose.startSession();
  let backupPath;
  let backup;
  let changedSnapshots;
  let summary;
  let bulkResult;

  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    const allSnapshots = await readSnapshots({ session });
    const analysis = analyzeWarehouseCoverage(allSnapshots, warehouses);
    summary = analysis.summary;

    if (analysis.duplicates.length) {
      throw new Error(
        `Refusing to normalize while duplicate warehouse entries exist in ${analysis.duplicates.length} stock scopes`,
      );
    }
    if (!analysis.changes.length) {
      await session.abortTransaction();
      return {
        mode: "apply",
        changed: false,
        warehouses,
        summary,
        message: "All products and variants already contain all four warehouses.",
      };
    }

    const snapshotById = new Map(
      allSnapshots.map((snapshot) => [snapshot.productId, snapshot]),
    );
    changedSnapshots = analysis.changes.map((change) =>
      snapshotById.get(change.productId),
    );
    ({ backupPath, backup } = await writeBackup({
      warehouses,
      snapshots: changedSnapshots,
      summary,
    }));

    bulkResult = await ProductModel.collection.bulkWrite(
      buildBulkOperations(analysis.changes),
      { session, ordered: true },
    );

    const productIds = changedSnapshots.map((snapshot) => snapshot.productId);
    const afterSnapshots = await readSnapshots({ session, productIds });
    verifyNormalization(changedSnapshots, afterSnapshots, warehouses);
    const afterAnalysis = analyzeWarehouseCoverage(afterSnapshots, warehouses);
    if (
      afterAnalysis.summary.missingSimpleEntries ||
      afterAnalysis.summary.missingVariantEntries ||
      afterAnalysis.summary.duplicateStockScopes
    ) {
      throw new Error("Coverage verification still found missing or duplicate entries");
    }

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
  const committedSnapshots = await readSnapshots({ productIds });
  verifyNormalization(changedSnapshots, committedSnapshots, warehouses);
  const finalSnapshots = await readSnapshots();
  const finalAnalysis = analyzeWarehouseCoverage(finalSnapshots, warehouses);
  if (
    finalAnalysis.summary.missingSimpleEntries ||
    finalAnalysis.summary.missingVariantEntries ||
    finalAnalysis.summary.duplicateStockScopes
  ) {
    throw new Error("Post-commit coverage verification failed");
  }

  const cache = await clearProductCaches();
  return {
    mode: "apply",
    changed: true,
    warehouses,
    backupPath,
    summaryBefore: summary,
    databaseResult: {
      matchedProducts: bulkResult.matchedCount || 0,
      modifiedProducts: bulkResult.modifiedCount || 0,
    },
    verification: {
      missingSimpleEntries: 0,
      missingVariantEntries: 0,
      duplicateStockScopes: 0,
      existingStockEntriesUnchanged: true,
      addedEntriesDefaultToZero: true,
    },
    cache,
  };
}

function parseArguments(argv) {
  const apply = argv.includes("--apply");
  const confirmation = argv.find((arg) =>
    arg.startsWith("--confirm-warehouse-set="),
  );
  return {
    apply,
    confirmedWarehouseSet: confirmation?.slice(
      "--confirm-warehouse-set=".length,
    ),
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const { apply, confirmedWarehouseSet } = parseArguments(argv);
  if (apply && confirmedWarehouseSet !== CONFIRMATION_VALUE) {
    throw new Error(
      `Apply requires --confirm-warehouse-set=${CONFIRMATION_VALUE}`,
    );
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    const result = apply ? await applyNormalization() : await dryRun();
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
    console.error("[Warehouse Stock Normalization] Failed:", error.message);
    process.exitCode = 1;
  });
}
