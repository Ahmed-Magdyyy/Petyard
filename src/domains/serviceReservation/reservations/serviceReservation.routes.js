import { Router } from "express";
import { protect, allowedTo } from "../../auth/auth.middleware.js";
import { roles } from "../../../shared/constants/enums.js";
import {
  adminListReservationsByDate,
  adminUpdateReservationStatus,
  cancelReservationForGuest,
  cancelReservationForUser,
  createReservationForGuest,
  createReservationForUser,
  getServiceCatalog,
  getAvailability,
  listGuestReservations,
  listMyReservations,
} from "./serviceReservation.controller.js";
import {
  adminListReservationsByDateQueryValidator,
  adminUpdateReservationStatusValidator,
  availabilityQueryValidator,
  createReservationValidator,
  listReservationsQueryValidator,
  reservationIdParamValidator,
} from "./serviceReservation.validators.js";
import serviceReviewRoutes from "../reviews/serviceReview.routes.js";

const router = Router();

router.get("/catalog", getServiceCatalog);
router.get("/availability", availabilityQueryValidator, getAvailability);

router.post("/guest", createReservationValidator, createReservationForGuest);
router.get("/guest", listReservationsQueryValidator, listGuestReservations);
router.patch(
  "/guest/:id/cancel",
  reservationIdParamValidator,
  cancelReservationForGuest
);

router.use("/admin", protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN));

router.get(
  "/admin",
  adminListReservationsByDateQueryValidator,
  adminListReservationsByDate
);

router.patch(
  "/admin/:id/status",
  adminUpdateReservationStatusValidator,
  adminUpdateReservationStatus
);

// Mount review routes on /:reservationId
router.use("/:reservationId", serviceReviewRoutes);
router.use(protect);

router.get(
  "/me",
  // allowedTo(roles.USER),
  listReservationsQueryValidator,
  listMyReservations
);
router.post(
  "/",
  // allowedTo(roles.USER),
  createReservationValidator,
  createReservationForUser
);
router.patch(
  "/:id/cancel",
  // allowedTo(roles.USER),
  reservationIdParamValidator,
  cancelReservationForUser
);


export default router;
