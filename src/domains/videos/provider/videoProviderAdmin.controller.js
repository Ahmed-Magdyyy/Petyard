import asyncHandler from "express-async-handler";
import { getVideoProviderAdminService } from "./videoProviderAdmin.service.js";

export function createVideoProviderAdminController({ getService = getVideoProviderAdminService } = {}) {
  return Object.freeze({
    list: asyncHandler(async (req, res) => {
      const service = await getService();
      const data = await service.list({ actor: { id: req.user?._id, role: req.user?.role }, query: req.query });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    retry: asyncHandler(async (req, res) => {
      const service = await getService();
      const data = await service.retry({ actor: { id: req.user?._id, role: req.user?.role },
        operationId: req.params.operationId, input: req.body });
      res.set("Cache-Control", "private, no-store");
      res.status(202).json({ data });
    }),
  });
}
