import { Router } from "express";
import {
  checkAppVersion,
  createAppVersionReleases,
  getAppVersions,
  listAppVersionReleases,
  updateAppVersionPolicy,
  updateAppVersionRelease,
} from "./appVersion.controller.js";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  checkAppVersionValidator,
  createAppVersionReleasesValidator,
  platformParamValidator,
  updateAppVersionPolicyValidator,
  updateAppVersionReleaseValidator,
} from "./appVersion.validators.js";

const router = Router();

router.get("/", getAppVersions);
router.get("/check", checkAppVersionValidator, checkAppVersion);
router.get("/:platform/check", checkAppVersionValidator, checkAppVersion);

router.use(protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN));

router.post(
  "/releases",
  createAppVersionReleasesValidator,
  createAppVersionReleases,
);
router.get("/:platform/releases", platformParamValidator, listAppVersionReleases);
router.patch(
  "/:platform/releases/:version",
  updateAppVersionReleaseValidator,
  updateAppVersionRelease,
);
router.patch(
  "/:platform/policy",
  updateAppVersionPolicyValidator,
  updateAppVersionPolicy,
);

export default router;
