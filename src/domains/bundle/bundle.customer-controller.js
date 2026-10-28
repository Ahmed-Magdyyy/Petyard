import asyncHandler from "express-async-handler";

export function createBundleCatalogController(application) {
  return {
    list: asyncHandler(async (req, res) => {
      const { bundles, nextCursor } = await application.list(req.user, req.query);
      res.json({ data: bundles, results: bundles.length, nextCursor });
    }),
    get: asyncHandler(async (req, res) => {
      const { bundle } = await application.get(req.user, req.params.bundleId, req.query);
      res.json({ data: bundle });
    }),
  };
}
