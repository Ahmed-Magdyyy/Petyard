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

export default router;
