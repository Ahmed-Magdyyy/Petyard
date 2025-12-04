import { ReviewModel } from "./review.model.js";
import { findProductById } from "../product/product.repository.js";
import { ApiError } from "../../shared/ApiError.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import {roles} from "../../shared/constants/enums.js"

async function assertProductExists(productId) {
  const product = await findProductById(productId);
  if (!product) {
    throw new ApiError(`No product found for this id: ${productId}`, 404);
  }
}

async function applyRatingDelta(productId, deltaCount, deltaSum) {
  const product = await findProductById(productId);

  if (!product) {
    return;
  }

  const currentCount =
    typeof product.ratingCount === "number" ? product.ratingCount : 0;
  const currentAverage =
    typeof product.ratingAverage === "number" ? product.ratingAverage : 0;

  const newCount = currentCount + deltaCount;

  if (newCount <= 0) {
    product.ratingCount = 0;
    product.ratingAverage = 0;
  } else {
    const totalBefore = currentAverage * currentCount;
    const totalAfter = totalBefore + deltaSum;
    product.ratingCount = newCount;
    product.ratingAverage = totalAfter / newCount;
  }

  await product.save();
}

export async function createUserReviewService({
  productId,
  userId,
  rating,
  comment,
}) {
  await assertProductExists(productId);

  const review = await ReviewModel.create({
    product: productId,
    user: userId,
    rating,
    comment,
    isVerifiedBuyer: false,
  });

  await applyRatingDelta(productId, 1, rating);

  return review;
}

export async function createGuestReviewService({
  productId,
  guestId,
  rating,
  comment,
}) {
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  await assertProductExists(productId);

  const review = await ReviewModel.create({
    product: productId,
    guestId,
    rating,
    comment,
    isVerifiedBuyer: false,
  });

  await applyRatingDelta(productId, 1, rating);

  return review;
}

export async function listProductReviewsService({ productId, page, limit }) {
  await assertProductExists(productId);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);

  const filter = { product: productId };

  const totalCount = await ReviewModel.countDocuments(filter);

  const reviews = await ReviewModel.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate({ path: "user", select: "name" });

  const data = reviews.map((r) => ({
    id: r._id,
    rating: r.rating,
    comment: r.comment || "",
    isVerifiedBuyer: !!r.isVerifiedBuyer,
    authorName:
      r.user && typeof r.user.name === "string" && r.user.name.trim()
        ? r.user.name
        : "Guest",
    createdAt: r.createdAt,
  }));

  const totalPages = Math.ceil(totalCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

export async function deleteReviewService({
  productId,
  reviewId,
  currentUser,
}) {
  const review = await ReviewModel.findOne({
    _id: reviewId,
    product: productId,
  });

  if (!review) {
    throw new ApiError("Review not found", 404);
  }

  const isAdminOrSuper =
    currentUser &&
    (currentUser.role === roles.ADMIN || currentUser.role === roles.SUPER_ADMIN);

  const isOwner =
    review.user &&
    currentUser &&
    String(review.user) === String(currentUser._id);

  if (!isAdminOrSuper && !isOwner) {
    throw new ApiError("You are not allowed to delete this review", 403);
  }

  const rating = review.rating;

  await review.deleteOne();
  await applyRatingDelta(productId, -1, -rating);
}
