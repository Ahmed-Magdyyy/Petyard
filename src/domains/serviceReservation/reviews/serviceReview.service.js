import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { buildPagination } from "../../../shared/utils/apiFeatures.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { ServiceReviewModel } from "./serviceReview.model.js";
import { ServiceReservationModel } from "../reservations/serviceReservation.model.js";
import { serviceReservationStatusEnum } from "../../../shared/constants/enums.js";

/**
 * Validate reservation exists, is COMPLETED, and owned by user
 */
async function getReservationForUserReview(reservationId, userId) {
  const reservation = await ServiceReservationModel.findById(reservationId)
    .select("_id status user guestId location serviceType serviceName_en serviceName_ar")
    .lean();

  if (!reservation) {
    throw new ApiError("Reservation not found", 404);
  }

  if (!reservation.user || String(reservation.user) !== String(userId)) {
    throw new ApiError("You can only review your own reservations", 403);
  }

  if (reservation.status !== serviceReservationStatusEnum.COMPLETED) {
    throw new ApiError("Only completed reservations can be reviewed", 400);
  }

  return reservation;
}

/**
 * Validate reservation exists, is COMPLETED, and owned by guest
 */
async function getReservationForGuestReview(reservationId, guestId) {
  const reservation = await ServiceReservationModel.findById(reservationId)
    .select("_id status user guestId location serviceType serviceName_en serviceName_ar")
    .lean();

  if (!reservation) {
    throw new ApiError("Reservation not found", 404);
  }

  if (!reservation.guestId || reservation.guestId !== guestId) {
    throw new ApiError("You can only review your own reservations", 403);
  }

  if (reservation.status !== serviceReservationStatusEnum.COMPLETED) {
    throw new ApiError("Only completed reservations can be reviewed", 400);
  }

  return reservation;
}

/**
 * Create or update review for a reservation (User)
 */
export async function createUserServiceReviewService({
  reservationId,
  userId,
  rating,
  comment,
}) {
  const reservation = await getReservationForUserReview(reservationId, userId);

  // Check if review already exists
  const existingReview = await ServiceReviewModel.findOne({
    reservation: reservationId,
  });

  if (existingReview) {
    existingReview.rating = rating;
    existingReview.comment = comment || "";
    await existingReview.save();
    return existingReview;
  }

  const review = await ServiceReviewModel.create({
    reservation: reservationId,
    user: userId,
    rating,
    comment: comment || "",
    location: reservation.location,
    serviceType: reservation.serviceType,
    serviceName_en: reservation.serviceName_en,
    serviceName_ar: reservation.serviceName_ar,
  });

  return review;
}

/**
 * Create or update review for a reservation (Guest)
 */
export async function createGuestServiceReviewService({
  reservationId,
  guestId,
  rating,
  comment,
}) {
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const reservation = await getReservationForGuestReview(reservationId, guestId);

  // Check if review already exists
  const existingReview = await ServiceReviewModel.findOne({
    reservation: reservationId,
  });

  if (existingReview) {
    existingReview.rating = rating;
    existingReview.comment = comment || "";
    await existingReview.save();
    return existingReview;
  }

  const review = await ServiceReviewModel.create({
    reservation: reservationId,
    guestId,
    rating,
    comment: comment || "",
    location: reservation.location,
    serviceType: reservation.serviceType,
    serviceName_en: reservation.serviceName_en,
    serviceName_ar: reservation.serviceName_ar,
  });

  return review;
}

/**
 * Get user's or guest's review for a specific reservation
 */
export async function getMyReviewForReservationService({
  reservationId,
  userId,
  guestId,
  lang = "en",
}) {
  const filter = { reservation: reservationId };
  
  if (userId) {
    filter.user = userId;
  } else if (guestId) {
    filter.guestId = guestId;
  } else {
    return null;
  }

  const review = await ServiceReviewModel.findOne(filter).lean();

  if (!review) {
    return null;
  }

  return {
    id: review._id,
    rating: review.rating,
    comment: review.comment || "",
    serviceName: pickLocalizedField(review, "serviceName", lang),
    createdAt: review.createdAt,
  };
}

/**
 * List reviews for a service location
 */
export async function listLocationReviewsService({
  locationId,
  lang = "en",
  page = 1,
  limit = 10,
  serviceType,
}) {
  const locationObjectId = new mongoose.Types.ObjectId(locationId);
  const filter = { location: locationObjectId };

  if (serviceType) {
    filter.serviceType = serviceType;
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);

  // Fetch reviews, count, and stats in parallel
  const [reviews, totalCount, statsResult] = await Promise.all([
    ServiceReviewModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate({ path: "user", select: "name" })
      .lean(),
    ServiceReviewModel.countDocuments(filter),
    ServiceReviewModel.aggregate([
      { $match: { location: locationObjectId } },
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          totalReviews: { $sum: 1 },
        },
      },
    ]),
  ]);

  const stats = statsResult.length
    ? {
        averageRating: Math.round(statsResult[0].averageRating * 10) / 10,
        totalReviews: statsResult[0].totalReviews,
      }
    : { averageRating: 0, totalReviews: 0 };

  const data = reviews.map((r) => ({
    id: r._id,
    rating: r.rating,
    comment: r.comment || "",
    authorName: r.user?.name || "Guest",
    serviceName: pickLocalizedField(r, "serviceName", lang),
    serviceType: r.serviceType,
    createdAt: r.createdAt,
  }));

  return {
    averageRating: stats.averageRating,
    totalReviews: stats.totalReviews,
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: data.length,
    data,
  };
}

/**
 * Delete user's or guest's review for a reservation
 */
export async function deleteServiceReviewService({ reservationId, userId, guestId }) {
  const filter = { reservation: reservationId };
  
  if (userId) {
    filter.user = userId;
  } else if (guestId) {
    filter.guestId = guestId;
  } else {
    throw new ApiError("Authentication required", 401);
  }

  const review = await ServiceReviewModel.findOne(filter);

  if (!review) {
    throw new ApiError("Review not found", 404);
  }

  await review.deleteOne();
}

