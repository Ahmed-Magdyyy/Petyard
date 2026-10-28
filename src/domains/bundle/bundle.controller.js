import asyncHandler from "express-async-handler";

export function createBundleManagementController(application) {
  return {
    create: asyncHandler(async (req, res) => res.status(201).json({ data: await application.create(req.user, req.body) })),
    get: asyncHandler(async (req, res) => res.json({ data: await application.get(req.user, req.params.bundleId) })),
    list: asyncHandler(async (req, res) => res.json({ data: await application.list(req.user, req.query) })),
    replace: asyncHandler(async (req, res) => res.json({ data: await application.replace(req.user, req.params.bundleId, req.body) })),
    remove: asyncHandler(async (req, res) => { await application.remove(req.user, req.params.bundleId, req.body); res.status(204).end(); }),
    publish: asyncHandler(async (req, res) => res.json({ data: await application.publish(req.user, req.params.bundleId, req.body) })),
    pause: asyncHandler(async (req, res) => res.json({ data: await application.pause(req.user, req.params.bundleId, req.body) })),
    reject: asyncHandler(async (req, res) => res.json({ data: await application.reject(req.user, req.params.bundleId, req.body) })),
  };
}
