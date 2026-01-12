import { Router } from "express";
import { protect, optionalProtect } from "../../auth/auth.middleware.js";
import {
  createUserServiceReview,
  createGuestServiceReview,
  getMyServiceReview,
  deleteMyServiceReview,
} from "./serviceReview.controller.js";
import {
  reservationIdParamValidator,
  createReviewValidator,
} from "./serviceReview.validators.js";

const router = Router({ mergeParams: true });

// =====================
// Reservation Review Routes
// These routes are mounted on /service-reservations/:reservationId
// =====================

// POST /service-reservations/:reservationId/review - Create user review
router.post(
  "/review",
  protect,
  reservationIdParamValidator,
  createReviewValidator,
  createUserServiceReview
);

// POST /service-reservations/:reservationId/review/guest - Create guest review (no auth needed)
router.post(
  "/review/guest",
  reservationIdParamValidator,
  createReviewValidator,
  createGuestServiceReview
);

// GET /service-reservations/:reservationId/review - Get my review (user or guest)
router.get(
  "/review",
  optionalProtect,
  reservationIdParamValidator,
  getMyServiceReview
);

// DELETE /service-reservations/:reservationId/review - Delete my review
router.delete(
  "/review",
  optionalProtect,
  reservationIdParamValidator,
  deleteMyServiceReview
);

export default router;
