import asyncHandler from "express-async-handler";
import { getMyRestockSubscribedProductsService } from "../product/product.service.js";
import {
  getRestockSubscriptionStatusService,
  subscribeToRestockService,
  unsubscribeFromRestockService,
} from "./restockSubscription.service.js";

export const getMyRestockSubscriptions = asyncHandler(async (req, res) => {
  const data = await getMyRestockSubscribedProductsService({
    userId: req.user?._id,
    guestId: req.guestId,
    lang: req.lang,
  });
  res.status(200).json({ data });
});

export const subscribeToRestock = asyncHandler(async (req, res) => {
  const data = await subscribeToRestockService({
    userId: req.user?._id,
    guestId: req.guestId,
    productId: req.body.productId,
    warehouseId: req.body.warehouseId,
  });
  res.status(200).json({ data });
});

export const unsubscribeFromRestock = asyncHandler(async (req, res) => {
  const data = await unsubscribeFromRestockService({
    userId: req.user?._id,
    guestId: req.guestId,
    productId: req.params.productId,
    warehouseId: req.query.warehouse,
  });
  res.status(200).json({ data });
});

export const getRestockSubscriptionStatus = asyncHandler(async (req, res) => {
  const data = await getRestockSubscriptionStatusService({
    userId: req.user?._id,
    guestId: req.guestId,
    productId: req.params.productId,
    warehouseId: req.query.warehouse,
  });
  res.status(200).json({ data });
});
