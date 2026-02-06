import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  createUserReviewService,
  createGuestReviewService,
  listProductReviewsService,
  deleteReviewService,
} from "./review.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const listProductReviews = asyncHandler(async (req, res) => {
  const productId = req.params.id;

  const { page, limit } = req.query;

  const result = await listProductReviewsService({
    productId,
    page,
    limit,
  });

  res.status(200).json(result);
});

export const createGuestReview = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const guestId = getGuestId(req);

  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { rating, comment } = req.body;

  const review = await createGuestReviewService({
    productId,
    guestId,
    rating,
    comment,
  });

  res.status(201).json({ data: review });
});

export const createUserReview = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const userId = req.user._id;
  const { rating, comment } = req.body;

  const review = await createUserReviewService({
    productId,
    userId,
    rating,
    comment,
  });

  res.status(201).json({ data: review });
});

export const deleteReview = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const reviewId = req.params.reviewId;

  await deleteReviewService({
    productId,
    reviewId,
    currentUser: req.user,
  });

  res.status(200).json({});
});
