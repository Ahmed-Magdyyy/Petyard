import { Router } from "express";
import { protect, allowedTo } from "../../auth/auth.middleware.js";
import { roles } from "../../../shared/constants/enums.js";
import {
  adminCreateServiceLocation,
  adminDeleteServiceLocation,
  adminGetServiceLocation,
  adminListServiceLocations,
  adminToggleServiceLocationActive,
  adminUpdateServiceLocation,
  listServiceLocations,
} from "./serviceLocation.controller.js";
import {
  adminListServiceLocationsQueryValidator,
  createServiceLocationValidator,
  serviceLocationIdParamValidator,
  updateServiceLocationValidator,
} from "./serviceLocation.validators.js";
import { listLocationReviews } from "../reviews/serviceReview.controller.js";
import { locationIdParamValidator, listReviewsQueryValidator } from "../reviews/serviceReview.validators.js";

const router = Router();

router.get("/", listServiceLocations);

router.use("/admin", protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN));

router
  .route("/admin")
  .get(adminListServiceLocationsQueryValidator, adminListServiceLocations)
  .post(createServiceLocationValidator, adminCreateServiceLocation);

router
  .route("/admin/:id")
  .get(serviceLocationIdParamValidator, adminGetServiceLocation)
  .patch(updateServiceLocationValidator, adminUpdateServiceLocation)
  .delete(serviceLocationIdParamValidator, adminDeleteServiceLocation);

router.patch(
  "/admin/:id/toggle-active",
  serviceLocationIdParamValidator,
  adminToggleServiceLocationActive
);

// Public review routes for locations (includes averageRating and totalReviews)
router.get(
  "/:locationId/reviews",
  locationIdParamValidator,
  listReviewsQueryValidator,
  listLocationReviews
);

export default router;
