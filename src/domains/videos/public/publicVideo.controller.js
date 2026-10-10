import { videoIdentityTypeEnum } from "../../../shared/constants/enums.js";
import asyncHandler from "express-async-handler";

import { getPublicVideoService } from "./publicVideo.service.js";
import { getPublicReelPlaybackService } from "./publicReelPlayback.service.js";

function identityFromRequest(req) {
  if (req.user?._id) return { type: videoIdentityTypeEnum.USER, id: String(req.user._id) };
  const guestId = req.guestId ?? req.headers["x-guest-id"];
  if (typeof guestId === "string" && guestId.trim()) {
    return { type: videoIdentityTypeEnum.GUEST, id: guestId.trim() };
  }
  return null;
}

export function createPublicVideoController({
  getService = getPublicVideoService, getPlaybackService = getPublicReelPlaybackService
} = {}) {
  return Object.freeze({
    reportPlayerError: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.reportPlayerError({ id: req.params.id,
        identity: identityFromRequest(req), body: req.body });
      res.status(202).json({ data });
    }),
    listYouTube: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.listYouTube({ page: req.query.page, limit: req.query.limit,
        lang: req.lang, identity: identityFromRequest(req) });
      res.status(200).json({ data });
    }),
    listFeed: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.listFeed({ page: req.query.page, limit: req.query.limit,
        kind: req.query.kind, lang: req.lang, identity: identityFromRequest(req) });
      res.status(200).json({ data });
    }),
    listSaved: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.listSaved({ identity: identityFromRequest(req),
        page: req.query.page, limit: req.query.limit, lang: req.lang, kind: req.query.kind });
      res.status(200).json({ data });
    }),
    save: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.save({ id: req.params.videoId, identity: identityFromRequest(req) });
      res.status(200).json({ data });
    }),
    unsave: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.unsave({ id: req.params.videoId, identity: identityFromRequest(req) });
      res.status(200).json({ data });
    }),
    grantPlayback: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getPlaybackService();
      const data = await app.grant({ id: req.params.id });
      res.status(200).json({ data });
    }),
    getVideo: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const app = await getService();
      const data = await app.getVideo({ id: req.params.id, lang: req.lang,
        identity: identityFromRequest(req) });
      res.status(200).json({ data });
    }),
  });
}
