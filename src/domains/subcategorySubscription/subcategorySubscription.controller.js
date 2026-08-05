import asyncHandler from "express-async-handler";
import { getMySubscribedSubcategoriesService } from "../subcategory/subcategory.service.js";
import {
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
  });
  res.status(200).json({ data: { subscribed } });
});

export const subscribe = asyncHandler(async (req, res) => {
  const data = await subscribeToSubcategory({
    ...requestIdentity(req),
    subcategoryId: req.params.subcategoryId,
  });
  res.status(200).json({ data });
});

export const unsubscribe = asyncHandler(async (req, res) => {
  const data = await unsubscribeFromSubcategory({
    ...requestIdentity(req),
    subcategoryId: req.params.subcategoryId,
  });
  res.status(200).json({ data });
});
