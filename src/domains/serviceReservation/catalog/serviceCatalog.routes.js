import { Router } from "express";
import {
  protect,
  optionalProtect,
  allowedTo,
} from "../../auth/auth.middleware.js";
import { roles } from "../../../shared/constants/enums.js";
import {
  getServiceCatalog,
  getServiceByType,
  createServiceAdmin,
  updateServiceAdmin,
  deleteServiceAdmin,
} from "./serviceCatalog.controller.js";
import {
  createServiceValidator,
  updateServiceValidator,
  serviceTypeParamValidator,
} from "./serviceCatalog.validators.js";
import { uploadSingleImage } from "../../../shared/middlewares/uploadMiddleware.js";

const router = Router();

// Public (optionalProtect populates req.user for admins → dual-language response)
router.get("/", optionalProtect, getServiceCatalog);
router.get(
  "/:type",
  optionalProtect,
  serviceTypeParamValidator,
  getServiceByType,
);

// Admin-only
router.use(protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN));

router.post(
  "/",
  uploadSingleImage("image"),
  createServiceValidator,
  createServiceAdmin,
);

router
  .route("/:type")
  .patch(uploadSingleImage("image"), updateServiceValidator, updateServiceAdmin)
  .delete(serviceTypeParamValidator, deleteServiceAdmin);

export default router;
