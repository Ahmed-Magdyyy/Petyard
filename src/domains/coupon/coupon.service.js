import { CouponModel } from "./coupon.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";

function normalizeCouponCode(code) {
  if (code == null) return "";
  const str = String(code).trim();
  return str ? str.toUpperCase() : "";
}

function ensureCouponInvariants(payload) {
  const {
    discountType,
    discountValue,
    maxDiscountAmount,
    freeShipping,
    minOrderTotal,
    maxOrderTotal,
  } = payload;

  const hasDiscountType = !!discountType;
  const hasFreeShipping = !!freeShipping;

  if (!hasDiscountType && !hasFreeShipping) {
    throw new ApiError(
      "Coupon must have at least one effect: discountType or freeShipping",
      400
    );
  }

  if (hasDiscountType) {
    if (discountValue == null || Number(discountValue) <= 0) {
      throw new ApiError(
        "discountValue must be greater than 0 when discountType is set",
        400
      );
    }
  } else {
    if (discountValue != null || maxDiscountAmount != null) {
      throw new ApiError(
        "discountValue and maxDiscountAmount must be omitted when discountType is not set",
        400
      );
    }
  }

  if (minOrderTotal != null && maxOrderTotal != null) {
    const minVal = Number(minOrderTotal);
    const maxVal = Number(maxOrderTotal);
    if (!Number.isNaN(minVal) && !Number.isNaN(maxVal) && minVal > maxVal) {
      throw new ApiError(
        "minOrderTotal cannot be greater than maxOrderTotal",
        400
      );
    }
  }
}

export async function getCouponsService(query = {}) {
  const { page, limit, sort, isActive, ...rest } = query;

  const filter = {};

  if (isActive !== undefined) {
    if (isActive === true || isActive === "true") filter.isActive = true;
    else if (isActive === false || isActive === "false")
      filter.isActive = false;
  }

  const extraFilter = buildRegexFilter(rest, [
    "page",
    "limit",
    "sort",
    "isActive",
  ]);
  Object.assign(filter, extraFilter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const sortObj = buildSort({ sort }, "-createdAt");

  const totalCount = await CouponModel.countDocuments(filter);
  const coupons = await CouponModel.find(filter)
    .sort(sortObj)
    .skip(skip)
    .limit(limitNum);

  const data = coupons.map((c) => ({
    id: c._id,
    code: c.code,
    discountType: c.discountType || null,
    discountValue:
      typeof c.discountValue === "number" ? c.discountValue : null,
    maxDiscountAmount:
      typeof c.maxDiscountAmount === "number" ? c.maxDiscountAmount : null,
    freeShipping: !!c.freeShipping,
    minOrderTotal:
      typeof c.minOrderTotal === "number" ? c.minOrderTotal : null,
    maxOrderTotal:
      typeof c.maxOrderTotal === "number" ? c.maxOrderTotal : null,
    isActive: !!c.isActive,
    startsAt: c.startsAt || null,
    expiresAt: c.expiresAt || null,
    maxUsageTotal:
      typeof c.maxUsageTotal === "number" ? c.maxUsageTotal : null,
    maxUsagePerUser:
      typeof c.maxUsagePerUser === "number" ? c.maxUsagePerUser : null,
    usageCount: typeof c.usageCount === "number" ? c.usageCount : 0,
    firstOrderOnly: !!c.firstOrderOnly,
  }));

  const totalPages = Math.ceil(totalCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

export async function getCouponByIdService(id) {
  const coupon = await CouponModel.findById(id);
  if (!coupon) {
    throw new ApiError(`No coupon found for this id: ${id}`, 404);
  }
  return coupon;
}

export async function createCouponService(payload) {
  const {
    code,
    discountType,
    discountValue,
    maxDiscountAmount,
    freeShipping,
    minOrderTotal,
    maxOrderTotal,
    isActive,
    startsAt,
    expiresAt,
    maxUsageTotal,
    maxUsagePerUser,
    firstOrderOnly,
    allowedUserIds,
  } = payload;

  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) {
    throw new ApiError("code is required", 400);
  }

  ensureCouponInvariants({
    discountType,
    discountValue,
    maxDiscountAmount,
    freeShipping,
    minOrderTotal,
    maxOrderTotal,
  });

  const existing = await CouponModel.findOne({ code: normalizedCode });
  if (existing) {
    throw new ApiError(
      `Coupon with code '${normalizedCode}' already exists`,
      409
    );
  }

  const doc = {
    code: normalizedCode,
    discountType: discountType || undefined,
    discountValue:
      discountValue != null ? Number(discountValue) || 0 : undefined,
    maxDiscountAmount:
      maxDiscountAmount != null ? Number(maxDiscountAmount) || 0 : undefined,
    freeShipping: !!freeShipping,
    minOrderTotal:
      minOrderTotal != null ? Number(minOrderTotal) || 0 : undefined,
    maxOrderTotal:
      maxOrderTotal != null ? Number(maxOrderTotal) || 0 : undefined,
    isActive:
      typeof isActive === "boolean" ? isActive : isActive === "true" || true,
    startsAt: startsAt ? new Date(startsAt) : undefined,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    maxUsageTotal:
      maxUsageTotal != null ? Number(maxUsageTotal) || 0 : undefined,
    maxUsagePerUser:
      maxUsagePerUser != null ? Number(maxUsagePerUser) || 0 : undefined,
    firstOrderOnly: !!firstOrderOnly,
    allowedUserIds: Array.isArray(allowedUserIds) ? allowedUserIds : [],
  };

  const coupon = await CouponModel.create(doc);
  return coupon;
}

export async function updateCouponService(id, payload) {
  const coupon = await CouponModel.findById(id);
  if (!coupon) {
    throw new ApiError(`No coupon found for this id: ${id}`, 404);
  }

  const {
    discountType,
    discountValue,
    maxDiscountAmount,
    freeShipping,
    minOrderTotal,
    maxOrderTotal,
    isActive,
    startsAt,
    expiresAt,
    maxUsageTotal,
    maxUsagePerUser,
    firstOrderOnly,
    allowedUserIds,
    allowedEmails,
  } = payload;

  const next = {
    discountType:
      discountType !== undefined ? discountType || undefined : coupon.discountType,
    discountValue:
      discountValue !== undefined
        ? discountValue != null
          ? Number(discountValue) || 0
          : undefined
        : coupon.discountValue,
    maxDiscountAmount:
      maxDiscountAmount !== undefined
        ? maxDiscountAmount != null
          ? Number(maxDiscountAmount) || 0
          : undefined
        : coupon.maxDiscountAmount,
    freeShipping:
      freeShipping !== undefined ? !!freeShipping : coupon.freeShipping,
    minOrderTotal:
      minOrderTotal !== undefined
        ? minOrderTotal != null
          ? Number(minOrderTotal) || 0
          : undefined
        : coupon.minOrderTotal,
    maxOrderTotal:
      maxOrderTotal !== undefined
        ? maxOrderTotal != null
          ? Number(maxOrderTotal) || 0
          : undefined
        : coupon.maxOrderTotal,
  };

  ensureCouponInvariants(next);

  if (discountType !== undefined) {
    coupon.discountType = next.discountType;
  }
  if (discountValue !== undefined) {
    coupon.discountValue = next.discountValue;
  }
  if (maxDiscountAmount !== undefined) {
    coupon.maxDiscountAmount = next.maxDiscountAmount;
  }
  if (freeShipping !== undefined) {
    coupon.freeShipping = next.freeShipping;
  }
  if (minOrderTotal !== undefined) {
    coupon.minOrderTotal = next.minOrderTotal;
  }
  if (maxOrderTotal !== undefined) {
    coupon.maxOrderTotal = next.maxOrderTotal;
  }

  if (isActive !== undefined) {
    if (isActive === true || isActive === "true") coupon.isActive = true;
    else if (isActive === false || isActive === "false")
      coupon.isActive = false;
  }

  if (startsAt !== undefined) {
    coupon.startsAt = startsAt ? new Date(startsAt) : undefined;
  }

  if (expiresAt !== undefined) {
    coupon.expiresAt = expiresAt ? new Date(expiresAt) : undefined;
  }

  if (maxUsageTotal !== undefined) {
    coupon.maxUsageTotal =
      maxUsageTotal != null ? Number(maxUsageTotal) || 0 : undefined;
  }

  if (maxUsagePerUser !== undefined) {
    coupon.maxUsagePerUser =
      maxUsagePerUser != null ? Number(maxUsagePerUser) || 0 : undefined;
  }

  if (firstOrderOnly !== undefined) {
    coupon.firstOrderOnly = !!firstOrderOnly;
  }

  if (allowedUserIds !== undefined) {
    coupon.allowedUserIds = Array.isArray(allowedUserIds)
      ? allowedUserIds
      : [];
  }

  const updated = await coupon.save();
  return updated;
}

export async function deleteCouponService(id) {
  const coupon = await CouponModel.findById(id);
  if (!coupon) {
    throw new ApiError(`No coupon found for this id: ${id}`, 404);
  }

  await coupon.deleteOne();
}

export async function findActiveCouponByCodeService(code, now = new Date()) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) {
    throw new ApiError("code is required", 400);
  }

  const orStart = [{ startsAt: { $lte: now } }, { startsAt: { $exists: false } }];
  const orEnd = [
    { expiresAt: { $gte: now } },
    { expiresAt: { $exists: false } },
  ];

  const coupon = await CouponModel.findOne({
    code: normalizedCode,
    isActive: true,
    $and: [{ $or: orStart }, { $or: orEnd }],
  });

  if (!coupon) {
    throw new ApiError("Expired or Invalid coupon code", 404);
  }

  return coupon;
}

export function computeCouponEffect(coupon, { orderSubtotal, shippingFee }) {
  const subtotal = Math.max(0, Number(orderSubtotal) || 0);
  const baseShipping = Math.max(0, Number(shippingFee) || 0);

  let discountAmount = 0;
  let shippingDiscount = 0;

  if (coupon.discountType === "PERCENT") {
    const percent =
      typeof coupon.discountValue === "number" ? coupon.discountValue : 0;
    if (percent > 0) {
      let raw = (subtotal * percent) / 100;
      const maxCap =
        typeof coupon.maxDiscountAmount === "number"
          ? coupon.maxDiscountAmount
          : null;
      if (maxCap != null && maxCap >= 0) {
        raw = Math.min(raw, maxCap);
      }
      discountAmount = Math.max(0, Math.min(subtotal, raw));
    }
  } else if (coupon.discountType === "FIXED") {
    const value =
      typeof coupon.discountValue === "number" ? coupon.discountValue : 0;
    if (value > 0) {
      discountAmount = Math.max(0, Math.min(subtotal, value));
    }
  }

  let shippingAfter = baseShipping;

  if (coupon.freeShipping) {
    if (baseShipping > 0) {
      shippingDiscount = baseShipping;
      shippingAfter = 0;
    } else {
      shippingDiscount = 0;
      shippingAfter = baseShipping;
    }
  }

  const finalSubtotal = subtotal - discountAmount;
  const totalDiscount = discountAmount + shippingDiscount;
  const finalTotal = finalSubtotal + shippingAfter;

  return {
    subtotal,
    shippingBefore: baseShipping,
    discountAmount,
    shippingDiscount,
    shippingAfter,
    totalDiscount,
    finalSubtotal,
    finalTotal,
  };
}
