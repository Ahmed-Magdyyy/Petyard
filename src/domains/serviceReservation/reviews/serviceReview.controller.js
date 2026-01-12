import asyncHandler from "express-async-handler";
import { ApiError } from "../../../shared/utils/ApiError.js";
import {
  createUserServiceReviewService,
  createGuestServiceReviewService,
  getMyReviewForReservationService,
  deleteServiceReviewService,
  listLocationReviewsService,
} from "./serviceReview.service.js";

/**
 * Create or update review for a reservation (User)
 * POST /:reservationId/review
 */
export const createUserServiceReview = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { reservationId } = req.params;
  const { rating, comment } = req.body;

  const review = await createUserServiceReviewService({
    reservationId,
    userId: req.user._id,
    rating,
    comment,
  });

  res.status(201).json({
    data: {
      id: review._id,
      rating: review.rating,
      comment: review.comment || "",
      createdAt: review.createdAt,
    },
  });
});

/**
 * Create or update review for a reservation (Guest)
 * POST /:reservationId/review/guest
 */
export const createGuestServiceReview = asyncHandler(async (req, res) => {
  const guestId = req.headers["x-guest-id"];
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { reservationId } = req.params;
  const { rating, comment } = req.body;

  const review = await createGuestServiceReviewService({
    reservationId,
    guestId,
    rating,
    comment,
  });

  res.status(201).json({
    data: {
      id: review._id,
      rating: review.rating,
      comment: review.comment || "",
      createdAt: review.createdAt,
    },
  });
});

/**
 * Get my review for a reservation (User or Guest)
 * GET /:reservationId/review
 */
export const getMyServiceReview = asyncHandler(async (req, res) => {
  const { reservationId } = req.params;
  const userId = req.user?._id;
  const guestId = req.headers["x-guest-id"];

  if (!userId && !guestId) {
    throw new ApiError("Authentication required", 401);
  }

  const review = await getMyReviewForReservationService({
    reservationId,
    userId,
    guestId,
    lang: req.lang,
  });

  if (!review) {
    throw new ApiError("Review not found", 404);
  }

  res.status(200).json({ data: review });
});

/**
 * Delete my review for a reservation (User or Guest)
 * DELETE /:reservationId/review
 */
export const deleteMyServiceReview = asyncHandler(async (req, res) => {
  const { reservationId } = req.params;
  const userId = req.user?._id;
  const guestId = req.headers["x-guest-id"];

  if (!userId && !guestId) {
    throw new ApiError("Authentication required", 401);
  }

  await deleteServiceReviewService({
    reservationId,
    userId,
    guestId,
  });

  res.status(200).json({ data: { message: "Review deleted" } });
});

/**
 * List reviews for a service location (includes averageRating and totalReviews)
 * GET /service-locations/:locationId/reviews
 */
export const listLocationReviews = asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const { page = 1, limit = 10, serviceType } = req.query;

  const result = await listLocationReviewsService({
    locationId,
    lang: req.lang,
    page: parseInt(page, 10) || 1,
    limit: Math.min(parseInt(limit, 10) || 10, 50),
    serviceType,
  });

  res.status(200).json(result);
});
