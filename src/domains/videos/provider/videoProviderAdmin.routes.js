import { Router } from "express";
import { protect, allowedTo, enabledControls as requireControl } from "../../auth/auth.middleware.js";
import { roles, enabledControls } from "../../../shared/constants/enums.js";
import { createVideoProviderAdminController } from "./videoProviderAdmin.controller.js";
import { operationListValidator, operationRetryValidator } from "./videoProviderAdmin.validators.js";

export function createVideoProviderAdminRouter({ getService } = {}) {
  const router = Router();
  const controller = createVideoProviderAdminController({ getService });
  router.use(protect, allowedTo(roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS));
  router.get("/", operationListValidator, controller.list);
  router.post("/:operationId/retry", operationRetryValidator, controller.retry);
  return router;
}

export default createVideoProviderAdminRouter();
