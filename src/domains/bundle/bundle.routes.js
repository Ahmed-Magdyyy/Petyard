import express from "express";
import { protect } from "../auth/auth.middleware.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { requireBundleSuperAdmin } from "./bundle.access.js";
import { bundleManagementService } from "./bundle.service.js";
import { createBundleCatalogRouter } from "./bundle.customer-routes.js";
import { createBundleManagementController } from "./bundle.controller.js";
import { createBundleDraftValidator, replaceBundleDraftValidator, deleteBundleDraftValidator,
  getBundleDraftValidator, listBundleDraftsValidator, changeBundleAvailabilityValidator } from "./bundle.validators.js";

const parseJson = express.json({ limit: "16kb" });
export function bundleJsonBody(req, res, next) {
  res.set("Cache-Control", "no-store");
  return parseJson(req, res, error => {
    if (error?.type === "entity.too.large") return next(new ApiError("Bundle draft request is too large", 413));
    if (error?.type === "entity.parse.failed") return next(new ApiError("Invalid bundle draft JSON", 400));
    next(error);
  });
}

export function createBundleManagementRouter({ authenticate = protect, application = bundleManagementService } = {}) {
  const router = express.Router(), controller = createBundleManagementController(application);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(authenticate, (req, _res, next) => {
    try { requireBundleSuperAdmin(req.user); next(); } catch (error) { next(error); }
  });
  router.use(bundleJsonBody);
  router.use((req, _res, next) => {
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16384) return next(new ApiError("Bundle draft request is too large", 413));
    next();
  });
  router.get("/", listBundleDraftsValidator, controller.list);
  router.post("/", createBundleDraftValidator, controller.create);
  router.get("/:bundleId", getBundleDraftValidator, controller.get);
  router.put("/:bundleId", replaceBundleDraftValidator, controller.replace);
  router.delete("/:bundleId", deleteBundleDraftValidator, controller.remove);
  router.post("/:bundleId/publish", changeBundleAvailabilityValidator, controller.publish);
  router.post("/:bundleId/pause", changeBundleAvailabilityValidator, controller.pause);
  router.post("/:bundleId/reject", changeBundleAvailabilityValidator, controller.reject);
  return router;
}

export function createBundleRouter() {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") return next(new ApiError("Bundles are currently unavailable", 503));
    next();
  });
  router.use("/admin", createBundleManagementRouter());
  router.use("/", createBundleCatalogRouter());
  return router;
}

export default createBundleRouter();
