import express from "express";
import { protect } from "../auth/auth.middleware.js";
import { requireBundleUser } from "./bundle.access.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { bundleCatalogService } from "./bundle.customer-service.js";
import { createBundleCatalogController } from "./bundle.customer-controller.js";
import { listBundleCatalogValidator, getBundleCatalogValidator } from "./bundle.customer-validators.js";

// Mounted after management paths so /admin is never treated as a customer bundle ID.
export function createBundleCatalogRouter({ authenticate = protect, application = bundleCatalogService } = {}) {
  const router = express.Router(), controller = createBundleCatalogController(application);
  router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.use(authenticate, (req, _res, next) => {
    try {
      requireBundleUser(req.user);
      if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) > 0) throw new ApiError("Bundle catalog requests must not have a body", 400);
      next();
    } catch (error) { next(error); }
  });
  router.get("/", listBundleCatalogValidator, controller.list);
  router.get("/:bundleId", getBundleCatalogValidator, controller.get);
  return router;
}
