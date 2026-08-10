import { ApiError } from "../../shared/utils/ApiError.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

const STOCK_REVISION_CONFLICT = "STOCK_REVISION_CONFLICT";

function storedRevision(stock) {
  return Number.isInteger(stock?.revision) && stock.revision >= 0
    ? stock.revision
    : 0;
}

function submittedExpectedRevision(stock) {
  const expectedRevision =
    Number.isInteger(stock?.expectedRevision) && stock.expectedRevision >= 0
      ? stock.expectedRevision
      : undefined;
  const revision =
    Number.isInteger(stock?.revision) && stock.revision >= 0
      ? stock.revision
      : undefined;

  if (
    expectedRevision !== undefined &&
    revision !== undefined &&
    expectedRevision !== revision
  ) {
    const error = new ApiError(
      "revision and expectedRevision must match when both are provided",
      400,
    );
    error.code = "STOCK_REVISION_INPUT_CONFLICT";
    throw error;
  }

  return expectedRevision ?? revision;
}

function revisionFilter(expectedRevision) {
  if (expectedRevision !== 0) return { revision: expectedRevision };
  return {
    $or: [{ revision: 0 }, { revision: { $exists: false } }],
  };
}

function conflictError(expectations, { raced = false } = {}) {
  const error = new ApiError(
    raced
      ? "Stock changed while this update was being saved. Refresh and try again."
      : "Stock changed after this product was loaded. Refresh and try again.",
    409,
    expectations.map((expectation) => ({
      code: STOCK_REVISION_CONFLICT,
      product: String(expectation.product),
      variantId: expectation.variantId
        ? String(expectation.variantId)
        : null,
      warehouse: String(expectation.warehouse),
      expectedRevision: expectation.expectedRevision,
      currentRevision:
        raced || expectation.currentRevision === undefined
          ? null
          : expectation.currentRevision,
      currentQuantity:
        raced || expectation.currentQuantity === undefined
          ? null
          : expectation.currentQuantity,
    })),
  );
  error.code = STOCK_REVISION_CONFLICT;
  return error;
}

function findWarehouseStock(stocks, warehouse) {
  return (Array.isArray(stocks) ? stocks : []).find(
    (stock) => String(stock?.warehouse) === String(warehouse),
  );
}

function collectSimpleExpectations(product, payload) {
  const expectations = [];
  for (const submitted of Array.isArray(payload?.warehouseStocks)
    ? payload.warehouseStocks
    : []) {
    const expectedRevision = submittedExpectedRevision(submitted);
    if (expectedRevision === undefined || !submitted?.warehouse) continue;

    const current = findWarehouseStock(
      product.warehouseStocks,
      submitted.warehouse,
    );
    expectations.push({
      product: product._id,
      variantId: null,
      warehouse: submitted.warehouse,
      expectedRevision,
      currentRevision: current ? storedRevision(current) : null,
      currentQuantity: current?.quantity,
      current,
    });
  }
  return expectations;
}

function collectVariantExpectations(product, payload) {
  const expectations = [];
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  for (const submittedVariant of Array.isArray(payload?.variants)
    ? payload.variants
    : []) {
    const variantId = submittedVariant?._id || submittedVariant?.id;
    if (!variantId) continue;
    const currentVariant = variants.find(
      (variant) => String(variant?._id) === String(variantId),
    );

    for (const submitted of Array.isArray(submittedVariant?.warehouseStocks)
      ? submittedVariant.warehouseStocks
      : []) {
      const expectedRevision = submittedExpectedRevision(submitted);
      if (expectedRevision === undefined || !submitted?.warehouse) continue;

      const current = findWarehouseStock(
        currentVariant?.warehouseStocks,
        submitted.warehouse,
      );
      expectations.push({
        product: product._id,
        variantId,
        warehouse: submitted.warehouse,
        expectedRevision,
        currentRevision: current ? storedRevision(current) : null,
        currentQuantity: current?.quantity,
        current,
      });
    }
  }
  return expectations;
}

function guardForExpectation(expectation) {
  const stockMatch = {
    warehouse: expectation.current?.warehouse || expectation.warehouse,
    ...revisionFilter(expectation.expectedRevision),
  };

  if (!expectation.variantId) {
    return { warehouseStocks: { $elemMatch: stockMatch } };
  }

  return {
    variants: {
      $elemMatch: {
        _id: expectation.variantId,
        warehouseStocks: { $elemMatch: stockMatch },
      },
    },
  };
}

export function prepareProductStockRevisionGuard(product, payload) {
  const expectations =
    product?.type === productTypeEnum.VARIANT
      ? collectVariantExpectations(product, payload)
      : collectSimpleExpectations(product, payload);

  const stale = expectations.filter(
    (expectation) =>
      expectation.currentRevision !== expectation.expectedRevision,
  );
  if (stale.length > 0) throw conflictError(stale);

  if (expectations.length > 0) {
    const guards = expectations.map(guardForExpectation);
    product.$where = product.$where
      ? { $and: [product.$where, ...guards] }
      : { $and: guards };
  }

  return expectations;
}

export function translateStockRevisionSaveError(error, expectations) {
  if (
    expectations.length > 0 &&
    error?.name === "DocumentNotFoundError"
  ) {
    throw conflictError(expectations, { raced: true });
  }
  throw error;
}

export { STOCK_REVISION_CONFLICT };
