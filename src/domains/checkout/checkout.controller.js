import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getCheckoutSummaryService } from "./checkout.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const getCheckoutSummaryForGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { couponCode } = req.query;

  const result = await getCheckoutSummaryService({
    userId: null,
    guestId,
    couponCode,
    lang: req.lang,
  });

  res.status(200).json({ data: result });
});

export const getCheckoutSummaryForUser = asyncHandler(async (req, res) => {
  const { couponCode } = req.query;

  const result = await getCheckoutSummaryService({
    userId: req.user._id,
    guestId: null,
    couponCode,
    lang: req.lang,
  });

  res.status(200).json({ data: result });
});
