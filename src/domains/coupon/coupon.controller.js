import asyncHandler from "express-async-handler";
import {
  getCouponsService,
  getCouponByIdService,
  createCouponService,
  updateCouponService,
  deleteCouponService,
} from "./coupon.service.js";

export const getCoupons = asyncHandler(async (req, res) => {
  const result = await getCouponsService(req.query);
  res.status(200).json(result);
});

export const getCoupon = asyncHandler(async (req, res) => {
  const data = await getCouponByIdService(req.params.id);
  res.status(200).json({ data });
});

export const createCoupon = asyncHandler(async (req, res) => {
  const coupon = await createCouponService(req.body);
  res.status(201).json({ data: coupon });
});

export const updateCoupon = asyncHandler(async (req, res) => {
  const updated = await updateCouponService(req.params.id, req.body);
  res.status(200).json({ data: updated });
});

export const deleteCoupon = asyncHandler(async (req, res) => {
  await deleteCouponService(req.params.id);
  res.status(204).json({ message: "Coupon deleted successfully" });
});
