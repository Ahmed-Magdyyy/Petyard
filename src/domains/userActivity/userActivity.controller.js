// src/domains/userActivity/userActivity.controller.js
import asyncHandler from "express-async-handler";
import { getUserActivityService } from "./userActivity.service.js";

// GET /users/:id/activity
export const getUserActivity = asyncHandler(async (req, res) => {
  const data = await getUserActivityService(req.params.id);
  res.status(200).json({ message: "Success", data });
});
