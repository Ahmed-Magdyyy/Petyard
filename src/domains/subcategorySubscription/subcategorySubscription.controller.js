import asyncHandler from "express-async-handler";
import { getMySubscribedSubcategoriesService } from "../subcategory/subcategory.service.js";
import {
  getAdminSubcategoryDemand,
  getAdminSubcategoryDemandSubscribers,
  isUserSubscribedToSubcategory,
  subscribeToSubcategory,
  unsubscribeFromSubcategory,
} from "./subcategorySubscription.service.js";

function requestIdentity(req) {
  return {
    userId: req.user?._id,
    guestId: req.guestId,
  };
}

export const getMySubcategorySubscriptions = asyncHandler(async (req, res) => {
  const data = await getMySubscribedSubcategoriesService({
    ...requestIdentity(req),
    lang: req.lang,
  });
  res.status(200).json({ data });
});

export const getSubcategorySubscriptionStatus = asyncHandler(async (req, res) => {
  const subscribed = await isUserSubscribedToSubcategory({
    ...requestIdentity(req),
    subcategoryId: req.params.subcategoryId,
    warehouseId: req.query.warehouse,
  });
  res.status(200).json({ data: { subscribed } });
});

export const subscribe = asyncHandler(async (req, res) => {
  const data = await subscribeToSubcategory({
    ...requestIdentity(req),
    subcategoryId: req.params.subcategoryId,
    warehouseId: req.body.warehouseId,
  });
  res.status(200).json({ data });
});

export const unsubscribe = asyncHandler(async (req, res) => {
  const data = await unsubscribeFromSubcategory({
    ...requestIdentity(req),
    subcategoryId: req.params.subcategoryId,
    warehouseId: req.query.warehouse,
  });
  res.status(200).json({ data });
});

export const getAdminDemand = asyncHandler(async (req, res) => {
  const result = await getAdminSubcategoryDemand({
    warehouseId: req.query.warehouse,
    warehouseScope: req.productWarehouseScope,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
    lang: req.lang,
  });
  res.status(200).json(result);
});

export const getAdminDemandSubscribers = asyncHandler(async (req, res) => {
  const result = await getAdminSubcategoryDemandSubscribers({
    subcategoryId: req.params.subcategoryId,
    warehouseId: req.query.warehouse,
    warehouseScope: req.productWarehouseScope,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});
