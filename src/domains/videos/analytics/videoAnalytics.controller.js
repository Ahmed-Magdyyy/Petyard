import { videoIdentityTypeEnum } from "../../../shared/constants/enums.js";
import asyncHandler from "express-async-handler";
import { getVideoAnalyticsService } from "./videoAnalytics.service.js";

const requestIdentity = req => req.user?._id ? { type: videoIdentityTypeEnum.USER, id: String(req.user._id) }
  : { type: videoIdentityTypeEnum.GUEST, id: req.guestId };

export function createVideoAnalyticsController({ getService = getVideoAnalyticsService } = {}) {
  return Object.freeze({
    listDailyReport: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const service = await getService();
      const data = await service.listDailyReport({ query: req.query,
        actor: { id: String(req.user._id), role: req.user.role, enabledControls: req.user.enabledControls } });
      res.status(200).json(data);
    }),
    ingestEvents: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const service = await getService();
      const data = await service.ingestEvents({ body: req.body, identity: requestIdentity(req) });
      res.status(200).json({ data });
    }),
    issueSession: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const service = await getService();
      const data = await service.issueSession({ body: req.body, identity: requestIdentity(req) });
      res.status(201).json({ data });
    }),
  });
}
