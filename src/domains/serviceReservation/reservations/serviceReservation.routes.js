import { Router } from "express";
import { protect, allowedTo } from "../../auth/auth.middleware.js";
import { roles } from "../../../shared/constants/enums.js";
import {
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
  availabilityQueryValidator,
  createReservationValidator,
  listReservationsQueryValidator,
  reservationIdParamValidator,
} from "./serviceReservation.validators.js";

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
