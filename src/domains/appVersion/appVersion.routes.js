import { Router } from "express";
import {
  checkAppVersion,
  createAppVersionReleases,
  getAppVersions,
} from "./appVersion.controller.js";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  checkAppVersionValidator,
  createAppVersionReleasesValidator,
} from "./appVersion.validators.js";

const router = Router();

router.get("/", getAppVersions);
router.get("/check", checkAppVersionValidator, checkAppVersion);

router.use(protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN));

router.post(
  "/releases",
  createAppVersionReleasesValidator,
  createAppVersionReleases,
);

export default router;
