import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  createOrderForUserService,
  createOrderForGuestService,
  getMyOrdersService,
  getMyOrderByIdService,
  getGuestOrdersService,
  getGuestOrderByIdService,
  listOrdersForAdminService,
  getOrderByIdForAdminService,
  updateOrderStatusService,
  reorderService,
} from "./order.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const createOrderForGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { couponCode, paymentMethod, notes } = req.body;

  const result = await createOrderForGuestService({
    guestId,
    couponCode,
    paymentMethod,
    notes,
    instapayScreenshotFile: req.file,
    lang: req.lang,
  });

  if (result.action === "requires_payment") {
    return res.status(200).json({
      data: result.order,
      action: "requires_payment",
      clientSecret: result.clientSecret,
      publicKey: result.publicKey,
    });
  }

  res.status(201).json({ data: result.order });
});

export const createOrderForUser = asyncHandler(async (req, res) => {
  const { couponCode, paymentMethod, notes, savedCardId } = req.body;

  const result = await createOrderForUserService({
    userId: req.user._id,
    couponCode,
    paymentMethod,
    notes,
    savedCardId,
    instapayScreenshotFile: req.file,
    lang: req.lang,
  });

  if (result.action === "requires_payment") {
    return res.status(200).json({
      data: result.order,
      action: "requires_payment",
      clientSecret: result.clientSecret,
      publicKey: result.publicKey,
    });
  }

  res.status(201).json({ data: result.order });
});

export const getMyOrders = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;

  const result = await getMyOrdersService({
    userId: req.user._id,
    page,
    limit,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const getMyOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const order = await getMyOrderByIdService({
    userId: req.user._id,
    orderId,
    lang: req.lang,
  });

  res.status(200).json({ data: order });
});

export const getGuestOrders = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { page, limit } = req.query;

  const result = await getGuestOrdersService({
    guestId,
    page,
    limit,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const getGuestOrder = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const orderId = req.params.id;

  const order = await getGuestOrderByIdService({
    guestId,
    orderId,
    lang: req.lang,
  });

  res.status(200).json({ data: order });
});

export const listOrdersForAdmin = asyncHandler(async (req, res) => {
  const result = await listOrdersForAdminService({
    ...req.query,
    warehouseScope: req.orderWarehouseScope,
    lang: req.lang,
  });
  res.status(200).json(result);
});

export const getOrderForAdmin = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const order = await getOrderByIdForAdminService(
    orderId,
    req.lang,
    req.orderWarehouseScope,
  );

  res.status(200).json({ data: order });
});

export const updateOrderStatusForAdmin = asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const { status } = req.body;
  const lang = req.lang;

  const updated = await updateOrderStatusService({
    orderId,
    newStatus: status,
    actorUserId: req.user._id,
    warehouseScope: req.orderWarehouseScope,
    lang,
  });

  res.status(200).json({ data: updated });
});

export const reorderForUser = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const cart = await reorderService({
    userId: req.user._id,
    guestId: null,
    orderId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const reorderForGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const orderId = req.params.id;

  const cart = await reorderService({
    userId: null,
    guestId,
    orderId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});
