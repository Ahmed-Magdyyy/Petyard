import crypto from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import { escapeRegex } from "../../shared/utils/escapeRegex.js";
import { toPiastres } from "../../shared/utils/money.js";
import {
  orderLineKindEnum,
  orderPaymentAttemptStatusEnum,
  orderStatusEnum,
  orderSubstitutionStateEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
  substitutionRequestStatusEnum,
} from "../../shared/constants/enums.js";
import { invalidateProductCaches } from "../product/productCache.service.js";
import {
  countSubstitutionCandidateProducts,
  findProductsByIdsWithOptions,
  findSubstitutionCandidateProducts,
} from "../product/product.repository.js";
import {
  buildWarehouseSkuSnapshot,
  resolveActiveProductPromotion,
} from "../product/productPricing.service.js";
import { findActivePromotionsForProducts } from "../collection/collection.promotion.js";
import { UserModel } from "../user/user.model.js";
import { presentSubstitutionCandidateProduct } from "./substitutionCandidate.presenter.js";
import {
  correctUnallocatedInventoryCAS,
  reserveInventoryAtomically,
} from "../inventory/inventory.service.js";
import {
  assertSettlementInvariant,
  createOrFindSettlementLedger,
  createSettlementOperationId,
} from "../settlement/settlement.service.js";
import {
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
  uploadImage,
  validateImageFile,
} from "../../shared/utils/imageUpload.js";
import {
  getSubstitutionExpiryMinutes,
  isOrderSubstitutionEnabledForOrder,
} from "./substitution.config.js";
import { calculateSubstitutionQuote } from "./substitution.pricing.js";
import {
  enqueueSubstitutionCustomerNotification,
  enqueueSubstitutionStaffNotification,
} from "./substitution.notification.js";
import {
  applyQuoteToLegacyOrderAmounts,
  buildSubstituteOrderLines,
} from "./substitution.order.js";
import { applySubstitutionSettlement } from "./substitution.settlement.js";
import { hasPreAwardedCardLoyalty } from "./substitution.loyalty.js";
import { SubstitutionRequestModel } from "./substitutionRequest.model.js";
import {
  createOrFindRefundOperation,
  createOrFindSubstitutionPaymentAttempt,
  initializeSubstitutionPaymentAttempt,
  markSubstitutionPaymentAttemptSuperseded,
} from "../payment/substitutionPayment.service.js";
import { OrderPaymentAttemptModel } from "../payment/orderPaymentAttempt.model.js";
import {
  createSubstitutionRequest,
  findOrderForSubstitution,
  findSubstitutionRequest,
  findSubstitutionRequestByOfferKey,
  listSubstitutionRequests,
} from "./substitution.repository.js";

function substitutionError(message, statusCode, code) {
  const error = new ApiError(message, statusCode, code ? [{ code }] : []);
  if (code) error.code = code;
  return error;
}

function assertWarehouseScope(order, warehouseScope) {
  if (
    Array.isArray(warehouseScope) &&
    !warehouseScope.some(
      (warehouseId) => String(warehouseId) === String(order?.warehouse),
    )
  ) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
}

function assertFeatureEnabled(order) {
  if (!isOrderSubstitutionEnabledForOrder(order)) {
    throw substitutionError(
      "Product substitutions are not enabled for this order",
      409,
      "SUBSTITUTIONS_DISABLED",
    );
  }
}

export function assertStaffOrderEligible(
  order,
  warehouseScope,
  { requireFeature = true } = {},
) {
  if (!order) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  assertWarehouseScope(order, warehouseScope);
  if (requireFeature) assertFeatureEnabled(order);

  if (
    order.status !== orderStatusEnum.PENDING ||
    order.sideEffectsCommitted === false
  ) {
    throw substitutionError(
      "Only committed pending orders can receive substitutions",
      409,
      "SUBSTITUTION_ORDER_NOT_ELIGIBLE",
    );
  }
  if (!order.settlement || order.settlement.migrationState === "manual_review") {
    throw substitutionError(
      "This order requires settlement backfill before it can be modified",
      409,
      "SUBSTITUTION_SETTLEMENT_NOT_READY",
    );
  }
  if (hasPreAwardedCardLoyalty(order)) {
    throw substitutionError(
      "This paid card order requires loyalty reconciliation before it can be modified",
      409,
      "SUBSTITUTION_LOYALTY_RECONCILIATION_REQUIRED",
    );
  }
}

function assertOrderOwner(order, { userId, guestId }) {
  const ownsOrder = userId
    ? String(order?.user || "") === String(userId)
    : guestId && order?.guestId === guestId;
  if (!order || !ownsOrder) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
}

function getLineId(item) {
  return typeof item?.lineId === "string" ? item.lineId.trim() : "";
}

function getFulfillmentQuantity(item) {
  return Number.isInteger(item?.fulfillmentQuantity)
    ? item.fulfillmentQuantity
    : item?.quantity;
}

function sameSku(left, right) {
  return (
    String(left?.product || left?.productId || "") ===
      String(right?.product || right?.productId || "") &&
    String(left?.variantId || "") === String(right?.variantId || "")
  );
}

function getProductImage(product, item) {
  return (
    item?.productImageUrl ||
    product?.images?.find?.((image) => image?.isMain)?.url ||
    product?.images?.[0]?.url ||
    null
  );
}

function getOriginalVariantOptions(product, item) {
  if (Array.isArray(item?.variantOptions) && item.variantOptions.length) {
    return item.variantOptions.map((option) => ({
      name: option.name,
      value: option.value,
    }));
  }
  const variant = (product?.variants || []).find(
    (entry) => String(entry?._id) === String(item?.variantId || ""),
  );
  return (variant?.options || []).map((option) => ({
    name: option.name,
    value: option.value,
  }));
}

async function buildCandidateSnapshot({
  product,
  variantId,
  warehouseId,
  maxQuantity,
  unavailableQuantity,
}) {
  if (!product?.isActive) {
    throw substitutionError(
      "A substitute product is inactive",
      409,
      "SUBSTITUTE_NOT_AVAILABLE",
    );
  }

  const promotion = await resolveActiveProductPromotion(product);
  const snapshot = buildWarehouseSkuSnapshot({
    product,
    variantId,
    warehouseId,
    promotion,
  });
  const allowedMaximum = Math.min(
    snapshot.stockQuantity,
    unavailableQuantity,
  );
  if (
    !Number.isInteger(maxQuantity) ||
    maxQuantity <= 0 ||
    maxQuantity > allowedMaximum
  ) {
    throw substitutionError(
      "A substitute maximum quantity exceeds exact warehouse stock or shortage",
      409,
      "SUBSTITUTE_NOT_AVAILABLE",
    );
  }

  return {
    candidateId: crypto.randomUUID(),
    product: snapshot.product,
    variantId: snapshot.variantId,
    productType: snapshot.productType,
    productName_en: snapshot.productName_en,
    productName_ar: snapshot.productName_ar,
    productImageUrl: snapshot.productImageUrl || undefined,
    variantOptions: snapshot.variantOptions,
    unitPricePiastres: snapshot.unitPricePiastres,
    maxQuantity,
    stockQuantitySnapshot: snapshot.stockQuantity,
    stockRevisionSnapshot: snapshot.stockRevision,
  };
}

function mapCandidateProduct(product, warehouseId, promotion) {
  const snapshots = [];
  if (product.type === "SIMPLE") {
    try {
      snapshots.push(
        buildWarehouseSkuSnapshot({ product, warehouseId, promotion }),
      );
    } catch (error) {
      if (error?.statusCode !== 409) throw error;
    }
    return snapshots;
  }

  for (const variant of product.variants || []) {
    try {
      snapshots.push(
        buildWarehouseSkuSnapshot({
          product,
          variantId: variant._id,
          warehouseId,
          promotion,
        }),
      );
    } catch (error) {
      if (error?.statusCode !== 409) throw error;
    }
  }
  return snapshots;
}

export async function listSubstitutionCandidatesService({
  orderId,
  lineId,
  warehouseScope,
  lang,
  q,
  page = 1,
  limit = 20,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  assertStaffOrderEligible(order, warehouseScope, { requireFeature: false });

  const sourceLine = (order.items || []).find(
    (item) => getLineId(item) === String(lineId || ""),
  );
  if (!sourceLine || getFulfillmentQuantity(sourceLine) <= 0) {
    throw substitutionError("Order line not found", 404, "ORDER_LINE_NOT_FOUND");
  }

  const [sourceProduct] = await findProductsByIdsWithOptions(
    [sourceLine.product],
    { select: "_id subcategory", lean: true },
  );
  const sourceSubcategoryId =
    sourceProduct?.subcategory?._id || sourceProduct?.subcategory;
  if (!sourceSubcategoryId) {
    throw substitutionError(
      "The source product subcategory is unavailable",
      409,
      "SUBSTITUTION_SOURCE_SUBCATEGORY_MISSING",
    );
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);
  const pageSize = Math.min(limitNum, 50);
  const normalizedSearch = typeof q === "string" ? q.trim() : "";
  const searchRegex = normalizedSearch
    ? new RegExp(escapeRegex(normalizedSearch), "i")
    : undefined;

  const candidateQuery = {
    warehouseId: order.warehouse,
    subcategoryId: sourceSubcategoryId,
    searchRegex,
    excludeProductId: sourceLine.product,
    excludeVariantId: sourceLine.variantId || undefined,
  };
  const [products, totalProducts] = await Promise.all([
    findSubstitutionCandidateProducts(candidateQuery),
    countSubstitutionCandidateProducts(candidateQuery),
  ]);

  const promotionsByProductId =
    await findActivePromotionsForProducts(products);
  const sourceUnitPricePiastres = Number.isSafeInteger(
    sourceLine.itemPricePiastres,
  )
    ? sourceLine.itemPricePiastres
    : toPiastres(sourceLine.itemPrice, "sourceLine.itemPrice");
  const rankedCandidates = [];
  for (const product of products) {
    const promotion =
      promotionsByProductId.get(String(product._id)) || null;
    const snapshots = mapCandidateProduct(product, order.warehouse, promotion)
      .filter((snapshot) => !sameSku(sourceLine, snapshot))
      .sort((left, right) => {
        const priceDifference =
          Math.abs(left.unitPricePiastres - sourceUnitPricePiastres) -
          Math.abs(right.unitPricePiastres - sourceUnitPricePiastres);
        if (priceDifference !== 0) return priceDifference;
        return String(left.variantId || "").localeCompare(
          String(right.variantId || ""),
        );
      });
    const candidate = presentSubstitutionCandidateProduct(snapshots, lang);
    if (!candidate) continue;
    rankedCandidates.push({
      candidate,
      sameProduct: String(product._id) === String(sourceLine.product),
      priceDifference: Math.min(
        ...snapshots.map((snapshot) =>
          Math.abs(snapshot.unitPricePiastres - sourceUnitPricePiastres),
        ),
      ),
    });
  }

  rankedCandidates.sort((left, right) => {
    if (left.sameProduct !== right.sameProduct) {
      return left.sameProduct ? -1 : 1;
    }
    if (left.priceDifference !== right.priceDifference) {
      return left.priceDifference - right.priceDifference;
    }
    const nameDifference = String(left.candidate.name || "").localeCompare(
      String(right.candidate.name || ""),
    );
    if (nameDifference !== 0) return nameDifference;
    return String(left.candidate.product).localeCompare(
      String(right.candidate.product),
    );
  });
  const data = rankedCandidates
    .slice(skip, skip + pageSize)
    .map(({ candidate }) => candidate);

  return {
    totalPages: Math.ceil(totalProducts / pageSize) || 1,
    page: pageNum,
    results: data.length,
    totalProducts,
    warehouseId: order.warehouse,
    sourceLineId: sourceLine.lineId,
    data,
  };
}

export async function createSubstitutionOfferService({
  orderId,
  actorUserId,
  warehouseScope,
  idempotencyKey,
  expiresInMinutes,
  shortages,
}) {
  const normalizedKey = String(idempotencyKey || "").trim();
  const scopedOrder = await findOrderForSubstitution({ orderId, lean: true });
  if (!scopedOrder) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  assertWarehouseScope(scopedOrder, warehouseScope);
  assertFeatureEnabled(scopedOrder);
  const existing = await findSubstitutionRequestByOfferKey({
    orderId,
    offerIdempotencyKey: normalizedKey,
  });
  if (existing) return { request: existing, idempotent: true };

  const session = await mongoose.startSession();
  const affectedProductIds = new Set();
  let createdRequest;
  let wasReplay = false;

  try {
    await session.withTransaction(async () => {
      const order = await findOrderForSubstitution({ orderId, session });
      assertStaffOrderEligible(order, warehouseScope);

      const replay = await findSubstitutionRequestByOfferKey({
        orderId,
        offerIdempotencyKey: normalizedKey,
        session,
      });
      if (replay) {
        createdRequest = replay;
        wasReplay = true;
        return;
      }

      if (order.activeSubstitutionRequest || order.requiresCustomerAction) {
        throw substitutionError(
          "This order already has an active substitution request",
          409,
          "SUBSTITUTION_ALREADY_ACTIVE",
        );
      }

      const submittedShortages = Array.isArray(shortages) ? shortages : [];
      const uniqueLineIds = new Set(
        submittedShortages.map((shortage) => String(shortage?.lineId || "")),
      );
      if (
        !submittedShortages.length ||
        uniqueLineIds.size !== submittedShortages.length
      ) {
        throw substitutionError(
          "Each shortage must reference a unique order line",
          400,
          "SUBSTITUTION_SHORTAGE_INVALID",
        );
      }

      const referencedProductIds = new Set();
      for (const shortage of submittedShortages) {
        for (const alternative of shortage.alternatives || []) {
          referencedProductIds.add(String(alternative.productId));
        }
      }
      for (const item of order.items || []) {
        referencedProductIds.add(String(item.product));
      }

      const products = await findProductsByIdsWithOptions(
        [...referencedProductIds],
      ).session(session);
      const productById = new Map(
        products.map((product) => [String(product._id), product]),
      );

      const normalizedShortages = [];
      const corrections = [];
      let alternativeCount = 0;

      for (const submitted of submittedShortages) {
        const line = (order.items || []).find(
          (item) => getLineId(item) === String(submitted.lineId),
        );
        if (!line) {
          throw substitutionError(
            "Order line not found",
            404,
            "ORDER_LINE_NOT_FOUND",
          );
        }

        const currentFulfillment = getFulfillmentQuantity(line);
        const deliverable = submitted.deliverableOriginalQuantity;
        if (
          !Number.isInteger(deliverable) ||
          deliverable < 0 ||
          deliverable >= currentFulfillment
        ) {
          throw substitutionError(
            "Deliverable original quantity must be lower than its current quantity",
            409,
            "SUBSTITUTION_SHORTAGE_INVALID",
          );
        }

        const unavailableQuantity = currentFulfillment - deliverable;
        if (
          submitted.correctedUnallocatedQuantity >
          submitted.expectedUnallocatedQuantity
        ) {
          throw substitutionError(
            "A stock correction cannot add unavailable stock",
            409,
            "SUBSTITUTION_STOCK_CORRECTION_INVALID",
          );
        }

        const originalProduct = productById.get(String(line.product));
        if (!originalProduct) {
          throw substitutionError(
            "Original product not found",
            409,
            "SUBSTITUTION_ORIGINAL_PRODUCT_MISSING",
          );
        }

        const seenAlternativeSkus = new Set();
        const alternatives = [];
        for (const submittedAlternative of submitted.alternatives || []) {
          const product = productById.get(
            String(submittedAlternative.productId),
          );
          if (!product) {
            throw substitutionError(
              "A substitute product was not found",
              404,
              "SUBSTITUTE_NOT_AVAILABLE",
            );
          }
          const candidateDescriptor = {
            product: product._id,
            variantId: submittedAlternative.variantId || null,
          };
          if (sameSku(line, candidateDescriptor)) {
            throw substitutionError(
              "The unavailable SKU cannot substitute itself",
              409,
              "SUBSTITUTION_SELF_REFERENCE",
            );
          }
          const skuKey = `${product.type}:${product._id}:${
            submittedAlternative.variantId || ""
          }`;
          if (seenAlternativeSkus.has(skuKey)) {
            throw substitutionError(
              "A substitute SKU may only appear once per shortage",
              400,
              "SUBSTITUTION_DUPLICATE_CANDIDATE",
            );
          }
          seenAlternativeSkus.add(skuKey);

          alternatives.push(
            await buildCandidateSnapshot({
              product,
              variantId: submittedAlternative.variantId,
              warehouseId: order.warehouse,
              maxQuantity: submittedAlternative.maxQuantity,
              unavailableQuantity,
            }),
          );
          alternativeCount += 1;
        }

        const finalizedUnavailableStart = Number.isInteger(
          line.finalizedUnavailableQuantity,
        )
          ? line.finalizedUnavailableQuantity
          : 0;
        const shortageId = crypto.randomUUID();
        normalizedShortages.push({
          shortageId,
          lineId: line.lineId,
          product: line.product,
          variantId: line.variantId,
          productType: line.productType,
          productName_en: originalProduct.name_en || line.productName,
          productName_ar: originalProduct.name_ar || line.productName,
          productImageUrl: getProductImage(originalProduct, line) || undefined,
          variantOptions: getOriginalVariantOptions(originalProduct, line),
          quantityBefore: currentFulfillment,
          deliverableOriginalQuantity: deliverable,
          unavailableQuantity,
          finalizedUnavailableStart,
          finalizedUnavailableEnd:
            finalizedUnavailableStart + unavailableQuantity,
          originalUnitPricePiastres: Number.isSafeInteger(line.itemPricePiastres)
            ? line.itemPricePiastres
            : toPiastres(line.itemPrice || 0),
          expectedUnallocatedQuantity: submitted.expectedUnallocatedQuantity,
          expectedStockRevision: submitted.expectedStockRevision,
          correctedUnallocatedQuantity:
            submitted.correctedUnallocatedQuantity,
          correctionReason: "offline_sale",
          correctionNote: submitted.note || undefined,
          alternatives,
        });

        corrections.push({
          product: line.product,
          productType: line.productType,
          variantId: line.variantId,
          expectedQuantity: submitted.expectedUnallocatedQuantity,
          expectedRevision: submitted.expectedStockRevision,
          correctedQuantity: submitted.correctedUnallocatedQuantity,
        });
        affectedProductIds.add(String(line.product));

        line.fulfillmentQuantity = deliverable;
        line.finalizedUnavailableQuantity =
          finalizedUnavailableStart + unavailableQuantity;
        line.lineId ||= crypto.randomUUID();
        line.lineKind ||= orderLineKindEnum.ORIGINAL;
      }

      if (!alternativeCount) {
        throw substitutionError(
          "At least one substitute must be offered",
          400,
          "SUBSTITUTION_ALTERNATIVE_REQUIRED",
        );
      }

      await correctUnallocatedInventoryCAS({
        demands: corrections,
        warehouseId: order.warehouse,
        operationId: `substitution-offer:${order._id}:${normalizedKey}`,
        actorUserId,
        orderId: order._id,
        metadata: { source: "product_substitution_offer" },
        session,
      });

      const requestSequence = (order.substitutionRevision || 0) + 1;
      const offerPresetMinutes = getSubstitutionExpiryMinutes(
        expiresInMinutes,
      );
      const offerExpiresAt = new Date(
        Date.now() + offerPresetMinutes * 60 * 1000,
      );

      createdRequest = await createSubstitutionRequest(
        {
          order: order._id,
          orderNumber: order.orderNumber,
          warehouse: order.warehouse,
          user: order.user || undefined,
          guestId: order.guestId || undefined,
          requestSequence,
          paymentMethod: order.paymentMethod,
          status: substitutionRequestStatusEnum.OFFERED,
          isActive: true,
          revision: 0,
          offerPresetMinutes,
          offerExpiresAt,
          offeredBy: actorUserId,
          offerIdempotencyKey: normalizedKey,
          shortages: normalizedShortages,
          lifecycle: [
            {
              at: new Date(),
              to: substitutionRequestStatusEnum.OFFERED,
              reason: "shortage_confirmed",
              actorType: "staff",
              actorUser: actorUserId,
            },
          ],
        },
        { session },
      );

      order.activeSubstitutionRequest = createdRequest._id;
      order.substitutionState = orderSubstitutionStateEnum.AWAITING_CUSTOMER;
      order.requiresCustomerAction = true;
      order.substitutionRevision = requestSequence;
      order.history.push({
        at: new Date(),
        description: `Substitute choices offered for order ${order.orderNumber}`,
        byUserId: actorUserId,
        visibleToUser: true,
      });
      await order.save({ session });
      await enqueueSubstitutionCustomerNotification({
        order,
        request: createdRequest,
        event: "offered",
        session,
      });
    });
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await findSubstitutionRequestByOfferKey({
        orderId,
        offerIdempotencyKey: normalizedKey,
      });
      if (replay) return { request: replay, idempotent: true };
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (!wasReplay) {
    await invalidateProductCaches([...affectedProductIds]);
  }
  return { request: createdRequest, idempotent: wasReplay };
}

export async function listSubstitutionRequestsForStaffService({
  orderId,
  warehouseScope,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  if (!order) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  assertWarehouseScope(order, warehouseScope);
  return listSubstitutionRequests({ orderId });
}

export async function getSubstitutionRequestForStaffService({
  orderId,
  requestId,
  warehouseScope,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  if (!order) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  assertWarehouseScope(order, warehouseScope);
  const request = await findSubstitutionRequest({
    orderId,
    requestId,
    lean: true,
  });
  if (!request) {
    throw substitutionError(
      "Substitution request not found",
      404,
      "SUBSTITUTION_NOT_FOUND",
    );
  }
  return request;
}

export async function listSubstitutionRequestsForOwnerService({
  orderId,
  userId,
  guestId,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  assertOrderOwner(order, { userId, guestId });
  return listSubstitutionRequests({ orderId, userId, guestId });
}

export async function getSubstitutionRequestForOwnerService({
  orderId,
  requestId,
  userId,
  guestId,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  assertOrderOwner(order, { userId, guestId });
  const request = await findSubstitutionRequest({
    orderId,
    requestId,
    userId,
    guestId,
    lean: true,
  });
  if (!request) {
    throw substitutionError(
      "Substitution request not found",
      404,
      "SUBSTITUTION_NOT_FOUND",
    );
  }
  return request;
}

export async function quoteSubstitutionService({
  orderId,
  requestId,
  userId,
  guestId,
  requestRevision,
  selections,
}) {
  const order = await findOrderForSubstitution({ orderId, lean: true });
  assertOrderOwner(order, { userId, guestId });
  const request = await findSubstitutionRequest({
    orderId,
    requestId,
    userId,
    guestId,
    lean: true,
  });
  if (!request) {
    throw substitutionError(
      "Substitution request not found",
      404,
      "SUBSTITUTION_NOT_FOUND",
    );
  }
  if (
    !request.isActive ||
    request.status !== substitutionRequestStatusEnum.OFFERED
  ) {
    throw substitutionError(
      "This substitution request is no longer actionable",
      409,
      "SUBSTITUTION_NOT_ACTIONABLE",
    );
  }
  if (new Date(request.offerExpiresAt).getTime() <= Date.now()) {
    throw substitutionError(
      "This substitution offer has expired",
      409,
      "SUBSTITUTION_OFFER_EXPIRED",
    );
  }
  if (request.revision !== requestRevision) {
    throw substitutionError(
      "This substitution request changed; refresh before continuing",
      409,
      "SUBSTITUTION_REVISION_CONFLICT",
    );
  }

  let walletBalancePiastres = 0;
  if (userId) {
    const user = await UserModel.findById(userId).select("walletBalance").lean();
    walletBalancePiastres = toPiastres(user?.walletBalance || 0);
  }

  return calculateSubstitutionQuote({
    order,
    request,
    selections,
    walletBalancePiastres,
    registeredCustomer: Boolean(userId),
  });
}

function assertActionableRequest(request, requestRevision) {
  if (
    !request?.isActive ||
    request.status !== substitutionRequestStatusEnum.OFFERED
  ) {
    throw substitutionError(
      "This substitution request is no longer actionable",
      409,
      "SUBSTITUTION_NOT_ACTIONABLE",
    );
  }
  if (new Date(request.offerExpiresAt).getTime() <= Date.now()) {
    throw substitutionError(
      "This substitution offer has expired",
      409,
      "SUBSTITUTION_OFFER_EXPIRED",
    );
  }
  if (request.revision !== requestRevision) {
    throw substitutionError(
      "This substitution request changed; refresh before continuing",
      409,
      "SUBSTITUTION_REVISION_CONFLICT",
    );
  }
}

function responseActionForStatus(status) {
  if (status === substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT) {
    return "requires_card_payment";
  }
  if (status === substitutionRequestStatusEnum.INSTAPAY_SUBMITTED) {
    return "instapay_submitted";
  }
  return "completed";
}

function presentPaymentAttempt(attempt) {
  if (!attempt) return null;
  return {
    id: attempt._id || attempt.id,
    status: attempt.status,
    amountPiastres: attempt.amountPiastres,
    currency: attempt.currency,
    expiresAt: attempt.expiresAt,
    attemptNumber: attempt.attemptNumber,
    errorCode: attempt.errorCode || null,
  };
}

async function buildPaymentBillingData(order, userId) {
  const user = userId
    ? await UserModel.findById(userId).select("name email phone").lean()
    : null;
  const displayName = String(
    user?.name || order?.deliveryAddress?.name || "Customer",
  ).trim();
  const [firstName, ...lastParts] = displayName.split(/\s+/);
  return {
    firstName: firstName || "Customer",
    lastName: lastParts.join(" ") || "N/A",
    email: user?.email || "na@na.com",
    phone: user?.phone || order?.deliveryAddress?.phone || "N/A",
  };
}

async function ensureCardPaymentAttempt({
  order,
  request,
  userId,
  guestId,
  idempotencyKey,
  savedCardId,
  attemptNumber,
}) {
  const amountPiastres = request?.pricingSnapshot?.additionalPaymentPiastres;
  if (
    request?.status !== substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT ||
    !Number.isSafeInteger(amountPiastres) ||
    amountPiastres <= 0
  ) {
    return null;
  }

  const attemptResult = await createOrFindSubstitutionPaymentAttempt({
    orderId: order._id,
    substitutionRequestId: request._id,
    userId: userId || null,
    guestId: guestId || null,
    requestIdempotencyKey: idempotencyKey,
    amountPiastres,
    currency: order.currency || "EGP",
    paymentExpiresAt: request.paymentExpiresAt,
    attemptNumber,
  });
  const attempt = attemptResult.attempt;

  await SubstitutionRequestModel.updateOne(
    { _id: request._id, status: substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT },
    {
      $set: { activePaymentAttempt: attempt._id },
      $addToSet: { paymentAttempts: attempt._id },
    },
  );
  request.activePaymentAttempt = attempt._id;
  request.paymentAttempts = [
    ...new Set([
      ...(request.paymentAttempts || []).map(String),
      String(attempt._id),
    ]),
  ];

  try {
    const initialized = await initializeSubstitutionPaymentAttempt({
      attemptId: attempt._id,
      billingData: await buildPaymentBillingData(order, userId),
      savedCardId: savedCardId || null,
      orderNumber: order.orderNumber,
    });
    return {
      attempt: presentPaymentAttempt(initialized.attempt),
      clientSecret: initialized.clientSecret,
      publicKey: initialized.publicKey,
      initializationInProgress: Boolean(initialized.initializationInProgress),
      alreadyInitialized: Boolean(initialized.alreadyInitialized),
      expired: Boolean(initialized.expired),
    };
  } catch (error) {
    return {
      attempt: presentPaymentAttempt(attempt),
      clientSecret: null,
      publicKey: null,
      initializationFailed: true,
      errorCode: error?.code || "PAYMENT_INITIALIZATION_FAILED",
    };
  }
}

export async function ensureRefundOperation({
  order,
  request,
  userId,
  guestId,
  refundRequired = null,
  session = null,
  createRefundOperation = createOrFindRefundOperation,
}) {
  if (userId || !guestId) return null;
  if (
    ![paymentMethodEnum.CARD, paymentMethodEnum.INSTAPAY].includes(
      order.paymentMethod,
    )
  ) {
    return null;
  }
  const amountPiastres =
    refundRequired?.amountPiastres ??
    request?.pricingSnapshot?.refundOrCreditPiastres;
  if (!Number.isSafeInteger(amountPiastres) || amountPiastres <= 0) return null;
  const cardRefund =
    order.paymentMethod === paymentMethodEnum.CARD &&
    Boolean(order.paymobTransactionId);
  if (request?.refundOperation) {
    return {
      id: request.refundOperation,
      method: cardRefund ? "card" : "manual",
      status: null,
      amountPiastres,
    };
  }
  if (
    !Number.isSafeInteger(order?.settlement?.pendingRefundLiabilityPiastres) ||
    order.settlement.pendingRefundLiabilityPiastres < amountPiastres
  ) {
    throw substitutionError(
      "The guest refund is not backed by a pending settlement liability",
      409,
      "SUBSTITUTION_REFUND_LIABILITY_MISMATCH",
    );
  }
  const result = await createRefundOperation({
    orderId: order._id,
    substitutionRequestId: request._id,
    guestId,
    method: cardRefund ? "card" : "manual",
    amountPiastres,
    currency: order.currency || "EGP",
    originalTransactionId: cardRefund
      ? order.paymobTransactionId
      : null,
    session,
  });
  request.refundOperation = result.operation._id;
  return {
    id: result.operation._id || result.operation.id,
    method: result.operation.method,
    status: result.operation.status,
    amountPiastres: result.operation.amountPiastres,
  };
}

export function resolveRetryReplayAttempt({
  replayAttempt,
  activePaymentAttempt,
}) {
  if (!replayAttempt) return null;
  if (String(replayAttempt._id) !== String(activePaymentAttempt)) {
    throw substitutionError(
      "The payment attempt changed; refresh before retrying",
      409,
      "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
    );
  }
  return replayAttempt;
}

async function ensurePostResponseOperations({
  result,
  userId,
  guestId,
  idempotencyKey,
  savedCardId,
}) {
  if (!result?.order || !result?.request) return result;
  if (
    result.request.status ===
    substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT
  ) {
    result.payment = await ensureCardPaymentAttempt({
      order: result.order,
      request: result.request,
      userId,
      guestId,
      idempotencyKey: `response:${idempotencyKey}`,
      savedCardId,
      attemptNumber: 1,
    });
  } else if (!result.request.isActive) {
    result.refund = await ensureRefundOperation({
      order: result.order,
      request: result.request,
      userId,
      guestId,
    });
  }
  return result;
}

function toReservationDemands(inventoryDemands) {
  return inventoryDemands.map((demand) => ({
    productId: demand.productId,
    productType: demand.snapshot.productType,
    variantId: demand.variantId || undefined,
    quantity: demand.quantity,
    expectedRevision: demand.snapshot.stockRevisionSnapshot,
  }));
}

async function getWalletBalancePiastres(userId, session) {
  if (!userId) return 0;
  const user = await UserModel.findById(userId)
    .session(session)
    .select("walletBalance")
    .lean();
  if (!user) {
    throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  return toPiastres(user.walletBalance || 0);
}

async function uploadAdditionalInstapayProof(file) {
  if (!file) {
    throw substitutionError(
      "An additional InstaPay screenshot is required",
      400,
      "ADDITIONAL_INSTAPAY_PROOF_REQUIRED",
    );
  }
  validateImageFile(file);
  return uploadImage(file, {
    folder: "instapay_screenshots/substitutions",
    visibility: IMAGE_VISIBILITY.PRIVATE,
    profile: IMAGE_UPLOAD_PROFILES.PROOF,
  });
}

export async function respondToSubstitutionService({
  orderId,
  requestId,
  userId,
  guestId,
  idempotencyKey,
  requestRevision,
  selections,
  quoteRevision,
  quotedWalletBalancePiastres,
  savedCardId,
  additionalInstapayScreenshotFile,
}) {
  const normalizedKey = String(idempotencyKey || "").trim();
  const preflightOrder = await findOrderForSubstitution({
    orderId,
    lean: true,
  });
  assertOrderOwner(preflightOrder, { userId, guestId });
  assertFeatureEnabled(preflightOrder);
  if (savedCardId && !userId) {
    throw substitutionError(
      "Saved cards are only available to registered users",
      400,
      "SUBSTITUTION_SAVED_CARD_NOT_ALLOWED",
    );
  }
  const preflightRequest = await findSubstitutionRequest({
    orderId,
    requestId,
    userId,
    guestId,
    lean: true,
  });
  if (!preflightRequest) {
    throw substitutionError(
      "Substitution request not found",
      404,
      "SUBSTITUTION_NOT_FOUND",
    );
  }
  if (preflightRequest.responseIdempotencyKey === normalizedKey) {
    return ensurePostResponseOperations({
      result: {
      order: preflightOrder,
      request: preflightRequest,
      action: responseActionForStatus(preflightRequest.status),
      idempotent: true,
      },
      userId,
      guestId,
      idempotencyKey: normalizedKey,
      savedCardId,
    });
  }
  assertActionableRequest(preflightRequest, requestRevision);

  const preview = await quoteSubstitutionService({
    orderId,
    requestId,
    userId,
    guestId,
    requestRevision,
    selections,
  });
  if (preview.quoteRevision !== quoteRevision) {
    throw substitutionError(
      "The submitted quote is stale; request a fresh quote",
      409,
      "SUBSTITUTION_QUOTE_CONFLICT",
    );
  }

  let uploadedProof = null;
  if (preview.quote.requiresAdditionalInstapayScreenshot) {
    uploadedProof = await uploadAdditionalInstapayProof(
      additionalInstapayScreenshotFile,
    );
  } else if (additionalInstapayScreenshotFile) {
    throw substitutionError(
      "An additional InstaPay screenshot is not required for this response",
      400,
      "ADDITIONAL_INSTAPAY_PROOF_NOT_ALLOWED",
    );
  }

  const session = await mongoose.startSession();
  const affectedProductIds = new Set();
  let responseResult;
  let proofAdopted = false;

  try {
    await session.withTransaction(async () => {
      const order = await findOrderForSubstitution({ orderId, session });
      assertOrderOwner(order, { userId, guestId });
      assertFeatureEnabled(order);
      const request = await findSubstitutionRequest({
        orderId,
        requestId,
        userId,
        guestId,
        session,
      });
      if (!request) {
        throw substitutionError(
          "Substitution request not found",
          404,
          "SUBSTITUTION_NOT_FOUND",
        );
      }
      if (request.responseIdempotencyKey === normalizedKey) {
        responseResult = {
          order,
          request,
          action: responseActionForStatus(request.status),
          idempotent: true,
        };
        return;
      }
      assertActionableRequest(request, requestRevision);

      const walletBalancePiastres = await getWalletBalancePiastres(
        userId,
        session,
      );
      const calculated = calculateSubstitutionQuote({
        order,
        request,
        selections,
        walletBalancePiastres,
        registeredCustomer: Boolean(userId),
      });
      if (
        calculated.quoteRevision !== quoteRevision ||
        (quotedWalletBalancePiastres !== undefined &&
          quotedWalletBalancePiastres !== calculated.walletBalancePiastres)
      ) {
        throw substitutionError(
          "The submitted quote is stale; request a fresh quote",
          409,
          "SUBSTITUTION_QUOTE_CONFLICT",
        );
      }

      const reservationDemands = toReservationDemands(
        calculated.inventoryDemands,
      );
      const reservationOperationId =
        `substitution-reserve:${request._id}:${normalizedKey}`;
      if (reservationDemands.length) {
        await reserveInventoryAtomically({
          demands: reservationDemands,
          warehouseId: order.warehouse,
          operationId: reservationOperationId,
          orderId: order._id,
          requestId: request._id,
          metadata: { source: "product_substitution_response" },
          session,
        });
        reservationDemands.forEach((demand) =>
          affectedProductIds.add(String(demand.productId)),
        );
      }

      const substituteLines = buildSubstituteOrderLines({
        request,
        selections: calculated.selections,
      });
      order.items.push(...substituteLines);

      const settlementResult = await applySubstitutionSettlement({
        order,
        request,
        quote: calculated.quote,
        userId,
        idempotencyKey: normalizedKey,
        session,
      });
      applyQuoteToLegacyOrderAmounts({
        order,
        quote: calculated.quote,
        walletDebitPiastres: settlementResult.walletDebitedPiastres,
      });

      const selectedQuantity = calculated.selections.reduce(
        (total, selection) =>
          total +
          selection.choices.reduce(
            (choiceTotal, choice) => choiceTotal + choice.quantity,
            0,
          ),
        0,
      );
      const awaitingCard =
        order.paymentMethod === paymentMethodEnum.CARD &&
        calculated.quote.additionalPaymentPiastres > 0;
      const awaitingInstapay =
        order.paymentMethod === paymentMethodEnum.INSTAPAY &&
        calculated.quote.additionalPaymentPiastres > 0;
      const terminal = !awaitingCard && !awaitingInstapay;
      const nextStatus = awaitingCard
        ? substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT
        : awaitingInstapay
          ? substitutionRequestStatusEnum.INSTAPAY_SUBMITTED
          : selectedQuantity > 0
            ? substitutionRequestStatusEnum.COMPLETED
            : substitutionRequestStatusEnum.REJECTED;

      request.selections = calculated.selections;
      request.pricingSnapshot = calculated.quote;
      const refund = settlementResult.refundRequired
        ? await ensureRefundOperation({
            order,
            request,
            userId,
            guestId,
            refundRequired: settlementResult.refundRequired,
            session,
          })
        : null;
      request.responseIdempotencyKey = normalizedKey;
      request.responseSubmittedAt = new Date();
      request.additionalInstapayScreenshot = uploadedProof?.url || undefined;
      request.paymentExpiresAt = awaitingCard
        ? new Date(Date.now() + request.offerPresetMinutes * 60 * 1000)
        : undefined;
      request.reservation = {
        operationId: reservationDemands.length
          ? reservationOperationId
          : undefined,
        state:
          selectedQuantity === 0
            ? "none"
            : terminal
              ? "finalized"
              : "held",
        items: calculated.inventoryDemands.map((demand) => ({
          product: demand.productId,
          variantId: demand.variantId || undefined,
          quantity: demand.quantity,
        })),
      };
      request.status = nextStatus;
      request.isActive = !terminal;
      request.terminalReason = terminal
        ? selectedQuantity > 0
          ? "customer_response_completed"
          : "customer_rejected_all"
        : undefined;
      request.finalizedAt = terminal ? new Date() : undefined;
      request.revision += 1;
      request.lifecycle.push({
        at: new Date(),
        from: substitutionRequestStatusEnum.OFFERED,
        to: nextStatus,
        reason:
          selectedQuantity > 0
            ? "customer_selected_substitutes"
            : "customer_rejected_substitutes",
        actorType: userId ? "user" : "guest",
        actorUser: userId || undefined,
      });

      if (terminal) {
        order.activeSubstitutionRequest = null;
        order.substitutionState = orderSubstitutionStateEnum.NONE;
        order.requiresCustomerAction = false;
      } else if (awaitingCard) {
        order.substitutionState =
          orderSubstitutionStateEnum.AWAITING_CARD_PAYMENT;
        order.requiresCustomerAction = true;
      } else {
        order.substitutionState = orderSubstitutionStateEnum.INSTAPAY_SUBMITTED;
        order.requiresCustomerAction = false;
      }

      order.history.push({
        at: new Date(),
        description:
          selectedQuantity > 0
            ? `Customer selected substitutes for order ${order.orderNumber}`
            : `Customer continued without substitutes for order ${order.orderNumber}`,
        byUserId: userId || undefined,
        visibleToUser: true,
      });

      await request.save({ session });
      await order.save({ session });

      const customerEvent = awaitingCard
        ? "awaiting_card_payment"
        : awaitingInstapay
          ? "instapay_submitted"
          : selectedQuantity > 0
            ? "completed"
            : "rejected";
      await enqueueSubstitutionCustomerNotification({
        order,
        request,
        event: customerEvent,
        session,
      });
      await enqueueSubstitutionStaffNotification({
        order,
        request,
        event:
          selectedQuantity > 0 ? "customer_accepted" : "customer_rejected",
        session,
      });
      if (awaitingInstapay) {
        await enqueueSubstitutionStaffNotification({
          order,
          request,
          event: "instapay_submitted",
          session,
        });
      }

      responseResult = {
        order,
        request,
        quote: calculated,
        settlement: settlementResult,
        refund,
        action: responseActionForStatus(nextStatus),
        idempotent: false,
      };
    });
    proofAdopted = Boolean(
      uploadedProof &&
        !responseResult?.idempotent &&
        responseResult?.request?.additionalInstapayScreenshot ===
          uploadedProof.url,
    );
  } finally {
    await session.endSession();
    if (uploadedProof && !proofAdopted) {
      await deleteImage(uploadedProof);
    }
  }

  await invalidateProductCaches([...affectedProductIds]);
  return ensurePostResponseOperations({
    result: responseResult,
    userId,
    guestId,
    idempotencyKey: normalizedKey,
    savedCardId,
  });
}

export async function retrySubstitutionCardPaymentService({
  orderId,
  requestId,
  attemptId,
  userId,
  guestId,
  idempotencyKey,
  savedCardId,
}) {
  const preflightOrder = await findOrderForSubstitution({ orderId, lean: true });
  assertOrderOwner(preflightOrder, { userId, guestId });
  assertFeatureEnabled(preflightOrder);
  if (savedCardId && !userId) {
    throw substitutionError(
      "Saved cards are only available to registered users",
      400,
      "SUBSTITUTION_SAVED_CARD_NOT_ALLOWED",
    );
  }
  const preflightRequest = await findSubstitutionRequest({
    orderId,
    requestId,
    userId,
    guestId,
    lean: true,
  });
  if (!preflightRequest) {
    throw substitutionError(
      "This substitution payment is no longer retryable",
      409,
      "SUBSTITUTION_PAYMENT_NOT_RETRYABLE",
    );
  }
  const session = await mongoose.startSession();
  let retryResult;
  try {
    await session.withTransaction(async () => {
      const order = await findOrderForSubstitution({ orderId, session });
      assertOrderOwner(order, { userId, guestId });
      assertFeatureEnabled(order);
      const request = await findSubstitutionRequest({
        orderId,
        requestId,
        userId,
        guestId,
        session,
      });
      if (
        !request ||
        request.status !== substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT ||
        !request.isActive
      ) {
        throw substitutionError(
          "This substitution payment is no longer retryable",
          409,
          "SUBSTITUTION_PAYMENT_NOT_RETRYABLE",
        );
      }
      if (new Date(request.paymentExpiresAt).getTime() <= Date.now()) {
        throw substitutionError(
          "The substitution payment deadline has expired",
          409,
          "SUBSTITUTION_PAYMENT_EXPIRED",
        );
      }
      const retryKey = `retry:${String(idempotencyKey).trim()}`;
      const replayAttempt = await OrderPaymentAttemptModel.findOne({
        substitutionRequest: request._id,
        requestIdempotencyKey: retryKey,
      }).session(session);
      if (replayAttempt) {
        retryResult = {
          order,
          request,
          attempt: resolveRetryReplayAttempt({
            replayAttempt,
            activePaymentAttempt: request.activePaymentAttempt,
          }),
        };
        return;
      }
      if (
        !request.activePaymentAttempt ||
        String(request.activePaymentAttempt) !== String(attemptId)
      ) {
        throw substitutionError(
          "The payment attempt changed; refresh before retrying",
          409,
          "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
        );
      }

      const currentAttempt = await OrderPaymentAttemptModel.findById(
        request.activePaymentAttempt,
      ).session(session);
      if (
        !currentAttempt ||
        String(currentAttempt.substitutionRequest) !== String(request._id)
      ) {
        throw substitutionError(
          "The active payment attempt is inconsistent",
          409,
          "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
        );
      }
      if (
        currentAttempt.successAccepted ||
        [
          orderPaymentAttemptStatusEnum.SUCCEEDED,
          orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
          orderPaymentAttemptStatusEnum.REFUNDED,
        ].includes(currentAttempt.status)
      ) {
        throw substitutionError(
          "A payment was already received for this substitution",
          409,
          "SUBSTITUTION_PAYMENT_ALREADY_SUCCEEDED",
        );
      }

      const attemptNumber = (request.paymentAttempts || []).length + 1;
      const created = await createOrFindSubstitutionPaymentAttempt({
        orderId: order._id,
        substitutionRequestId: request._id,
        userId: userId || null,
        guestId: guestId || null,
        requestIdempotencyKey: retryKey,
        amountPiastres: request.pricingSnapshot.additionalPaymentPiastres,
        currency: order.currency || "EGP",
        paymentExpiresAt: request.paymentExpiresAt,
        attemptNumber,
        session,
      });

      if (String(created.attempt._id) !== String(request.activePaymentAttempt)) {
        const superseded = await markSubstitutionPaymentAttemptSuperseded({
          attemptId: request.activePaymentAttempt,
          session,
        });
        if (
          !superseded &&
          [
            orderPaymentAttemptStatusEnum.INITIALIZING,
            orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
          ].includes(currentAttempt.status)
        ) {
          throw substitutionError(
            "The payment attempt changed; refresh before retrying",
            409,
            "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
          );
        }
        const switched = await SubstitutionRequestModel.updateOne(
          {
            _id: request._id,
            status: substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT,
            isActive: true,
            activePaymentAttempt: currentAttempt._id,
          },
          {
            $set: { activePaymentAttempt: created.attempt._id },
            $addToSet: { paymentAttempts: created.attempt._id },
          },
          { session },
        );
        if (switched.modifiedCount !== 1) {
          throw substitutionError(
            "The payment attempt changed; refresh before retrying",
            409,
            "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
          );
        }
        request.activePaymentAttempt = created.attempt._id;
        request.paymentAttempts = [
          ...(request.paymentAttempts || []),
          created.attempt._id,
        ];
      }

      retryResult = { order, request, attempt: created.attempt };
    });
  } finally {
    await session.endSession();
  }

  const initialized = await initializeSubstitutionPaymentAttempt({
    attemptId: retryResult.attempt._id,
    billingData: await buildPaymentBillingData(retryResult.order, userId),
    savedCardId: savedCardId || null,
    orderNumber: retryResult.order.orderNumber,
  });
  return {
    request: retryResult.request,
    payment: {
      attempt: presentPaymentAttempt(initialized.attempt),
      clientSecret: initialized.clientSecret,
      publicKey: initialized.publicKey,
      initializationInProgress: Boolean(initialized.initializationInProgress),
      alreadyInitialized: Boolean(initialized.alreadyInitialized),
    },
  };
}

export async function confirmSubstitutionCardPaymentService({ attempt }) {
  if (!attempt?.successAccepted) {
    throw substitutionError(
      "Substitution payment attempt was not accepted",
      409,
      "SUBSTITUTION_PAYMENT_NOT_ACCEPTED",
    );
  }

  const session = await mongoose.startSession();
  let finalized;
  try {
    await session.withTransaction(async () => {
      const request = await SubstitutionRequestModel.findById(
        attempt.substitutionRequest,
      ).session(session);
      if (!request) {
        throw substitutionError(
          "Substitution request not found",
          404,
          "SUBSTITUTION_NOT_FOUND",
        );
      }
      const order = await findOrderForSubstitution({
        orderId: request.order,
        session,
      });
      if (!order) {
        throw substitutionError("Order not found", 404, "ORDER_NOT_FOUND");
      }

      if (
        !request.isActive &&
        request.status === substitutionRequestStatusEnum.COMPLETED
      ) {
        finalized = { order, request, idempotent: true };
        return;
      }
      if (
        request.status !==
          substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT ||
        String(request.activePaymentAttempt || "") !== String(attempt._id)
      ) {
        if (
          attempt.status === orderPaymentAttemptStatusEnum.REFUNDED &&
          attempt.successAccepted
        ) {
          finalized = { order, request, idempotent: true };
          return;
        }
        if (attempt.successAccepted) {
          const lateAttempt = await OrderPaymentAttemptModel.findOneAndUpdate(
            {
              _id: attempt._id,
              successAccepted: true,
              status: {
                $in: [
                  orderPaymentAttemptStatusEnum.SUCCEEDED,
                  orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
                ],
              },
            },
            {
              $set: {
                status:
                  orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
                lateSuccessAt: new Date(),
              },
            },
            { returnDocument: "after", session },
          );
          if (!lateAttempt) {
            throw substitutionError(
              "The substitution payment state is inconsistent",
              409,
              "SUBSTITUTION_PAYMENT_NOT_APPLICABLE",
            );
          }
          finalized = {
            order,
            request,
            attempt: lateAttempt,
            lateSuccessRefundRequired: true,
          };
          return;
        }
        throw substitutionError(
          "This substitution payment is no longer applicable",
          409,
          "SUBSTITUTION_PAYMENT_NOT_APPLICABLE",
        );
      }

      const amountPiastres = Number(attempt.amountPiastres);
      if (
        !Number.isSafeInteger(amountPiastres) ||
        amountPiastres <= 0 ||
        (order.settlement?.cardDuePiastres || 0) < amountPiastres
      ) {
        throw substitutionError(
          "Substitution card settlement does not match the payment",
          409,
          "SUBSTITUTION_PAYMENT_SETTLEMENT_MISMATCH",
        );
      }

      order.settlement.cardDuePiastres -= amountPiastres;
      order.settlement.cardCapturedPiastres =
        (order.settlement.cardCapturedPiastres || 0) + amountPiastres;
      order.settlement.revision = (order.settlement.revision || 0) + 1;
      assertSettlementInvariant(order.settlement);

      const settlementOperationId = createSettlementOperationId({
        orderId: order._id,
        requestId: request._id,
        kind: settlementOperationKindEnum.CARD_CAPTURE,
        idempotencyKey: `paymob:${attempt.paymobTransactionId}`,
      });
      await createOrFindSettlementLedger({
        operationId: settlementOperationId,
        order: order._id,
        request: request._id,
        kind: settlementOperationKindEnum.CARD_CAPTURE,
        status: settlementOperationStatusEnum.APPLIED,
        amountPiastres,
        currency: attempt.currency || order.currency || "EGP",
        providerReference: attempt.paymobTransactionId,
        session,
      });

      request.status = substitutionRequestStatusEnum.COMPLETED;
      request.isActive = false;
      request.reservation.state = "finalized";
      request.settlementOperationId = settlementOperationId;
      request.terminalReason = "additional_card_payment_received";
      request.finalizedAt = new Date();
      request.revision += 1;
      request.lifecycle.push({
        at: new Date(),
        from: substitutionRequestStatusEnum.AWAITING_CARD_PAYMENT,
        to: substitutionRequestStatusEnum.COMPLETED,
        reason: "additional_card_payment_received",
        actorType: "payment_provider",
      });

      order.activeSubstitutionRequest = null;
      order.substitutionState = orderSubstitutionStateEnum.NONE;
      order.requiresCustomerAction = false;
      order.history.push({
        at: new Date(),
        description: `Additional card payment received for substitutes on order ${order.orderNumber}`,
        visibleToUser: true,
      });

      await request.save({ session });
      await order.save({ session });
      await enqueueSubstitutionCustomerNotification({
        order,
        request,
        event: "completed",
        session,
      });
      await enqueueSubstitutionStaffNotification({
        order,
        request,
        event: "card_payment_received",
        session,
      });
      finalized = { order, request, idempotent: false };
    });
  } finally {
    await session.endSession();
  }
  return finalized;
}

export async function finalizeSubstitutionInstapayOnOrderAcceptance({
  order,
  actorUserId,
  session,
}) {
  if (
    order?.substitutionState !==
      orderSubstitutionStateEnum.INSTAPAY_SUBMITTED ||
    !order.activeSubstitutionRequest
  ) {
    return null;
  }

  const request = await SubstitutionRequestModel.findById(
    order.activeSubstitutionRequest,
  ).session(session);
  if (
    !request ||
    request.status !== substitutionRequestStatusEnum.INSTAPAY_SUBMITTED ||
    !request.isActive
  ) {
    throw substitutionError(
      "The active InstaPay substitution request is inconsistent",
      409,
      "SUBSTITUTION_INSTAPAY_STATE_CONFLICT",
    );
  }

  const amountPiastres =
    request.pricingSnapshot?.additionalPaymentPiastres || 0;
  if (
    !Number.isSafeInteger(amountPiastres) ||
    amountPiastres <= 0 ||
    (order.settlement?.instapaySubmittedPiastres || 0) < amountPiastres
  ) {
    throw substitutionError(
      "The additional InstaPay settlement does not match the request",
      409,
      "SUBSTITUTION_INSTAPAY_SETTLEMENT_MISMATCH",
    );
  }

  order.settlement.instapaySubmittedPiastres -= amountPiastres;
  order.settlement.instapayConfirmedPiastres =
    (order.settlement.instapayConfirmedPiastres || 0) + amountPiastres;
  order.settlement.revision = (order.settlement.revision || 0) + 1;
  assertSettlementInvariant(order.settlement);

  const settlementOperationId = createSettlementOperationId({
    orderId: order._id,
    requestId: request._id,
    kind: settlementOperationKindEnum.INSTAPAY_CONFIRMED,
    idempotencyKey: `staff-accept:${actorUserId}`,
  });
  await createOrFindSettlementLedger({
    operationId: settlementOperationId,
    order: order._id,
    request: request._id,
    kind: settlementOperationKindEnum.INSTAPAY_CONFIRMED,
    status: settlementOperationStatusEnum.APPLIED,
    amountPiastres,
    currency: order.currency || "EGP",
    actor: actorUserId,
    session,
  });

  request.status = substitutionRequestStatusEnum.COMPLETED;
  request.isActive = false;
  request.reservation.state = "finalized";
  request.settlementOperationId = settlementOperationId;
  request.terminalReason = "additional_instapay_verified";
  request.finalizedAt = new Date();
  request.revision += 1;
  request.lifecycle.push({
    at: new Date(),
    from: substitutionRequestStatusEnum.INSTAPAY_SUBMITTED,
    to: substitutionRequestStatusEnum.COMPLETED,
    reason: "additional_instapay_verified",
    actorType: "staff",
    actorUser: actorUserId,
  });
  await request.save({ session });

  order.activeSubstitutionRequest = null;
  order.substitutionState = orderSubstitutionStateEnum.NONE;
  order.requiresCustomerAction = false;
  await enqueueSubstitutionCustomerNotification({
    order,
    request,
    event: "completed",
    session,
  });
  return request;
}

export async function cancelActiveSubstitutionForOrder({
  order,
  actorUserId,
  session,
  reason = "order_cancelled",
}) {
  if (!order?.activeSubstitutionRequest) return null;
  const request = await SubstitutionRequestModel.findById(
    order.activeSubstitutionRequest,
  ).session(session);
  if (!request || !request.isActive) {
    order.activeSubstitutionRequest = null;
    order.substitutionState = orderSubstitutionStateEnum.NONE;
    order.requiresCustomerAction = false;
    return request;
  }

  const previousStatus = request.status;
  request.status = substitutionRequestStatusEnum.CANCELLED;
  request.isActive = false;
  if (request.reservation?.state === "held") {
    request.reservation.state = "released";
  }
  request.terminalReason = reason;
  request.finalizedAt = new Date();
  request.revision += 1;
  request.lifecycle.push({
    at: new Date(),
    from: previousStatus,
    to: substitutionRequestStatusEnum.CANCELLED,
    reason,
    actorType: "staff",
    actorUser: actorUserId,
  });
  await request.save({ session });

  order.activeSubstitutionRequest = null;
  order.substitutionState = orderSubstitutionStateEnum.NONE;
  order.requiresCustomerAction = false;
  await enqueueSubstitutionCustomerNotification({
    order,
    request,
    event: "cancelled",
    session,
  });
  return request;
}
