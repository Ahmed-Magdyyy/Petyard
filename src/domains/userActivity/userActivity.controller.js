// src/domains/userActivity/userActivity.controller.js
import asyncHandler from "express-async-handler";
import {
  getUserActivityService,
  getProductOrderHistoryService,
} from "./userActivity.service.js";

// GET /users/:id/activity
export const getUserActivity = asyncHandler(async (req, res) => {
  const data = await getUserActivityService(req.params.id, req.lang);
  res.status(200).json({ message: "Success", data });
});

// GET /users/product/:productId/order-history
export const getProductOrderHistory = asyncHandler(async (req, res) => {
  const data = await getProductOrderHistoryService(req.params.productId);
  res.status(200).json({ message: "Success", data });
});
