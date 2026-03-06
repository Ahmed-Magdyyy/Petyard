import asyncHandler from "express-async-handler";
import {
  getHomeLayoutService,
  updateHomeLayoutService,
} from "./homeLayout.service.js";

export const getHomeLayout = asyncHandler(async (req, res) => {
  const result = await getHomeLayoutService(req.lang, req.user);
  res.status(200).json({ data: result });
});

export const updateHomeLayout = asyncHandler(async (req, res) => {
  const result = await updateHomeLayoutService(req.body.sections);
  res.status(200).json({ data: result });
});
