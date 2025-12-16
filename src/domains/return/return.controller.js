import asyncHandler from "express-async-handler";
import {
  createReturnRequestService,
  listReturnRequestsService,
  getReturnRequestByIdService,
  processReturnRequestService,
} from "./return.service.js";

export const createReturnRequest = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { orderId } = req.params;
  const { reason } = req.body;

  const returnRequest = await createReturnRequestService({
    userId,
    orderId,
    reason,
  });

  res.status(201).json({ data: returnRequest });
});

export const getMyReturnRequests = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { status, page, limit } = req.query;

  const result = await listReturnRequestsService({
    userId,
    status,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 20,
  });

  res.status(200).json(result);
});

export const getMyReturnRequest = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { returnId } = req.params;

  const returnRequest = await getReturnRequestByIdService({
    returnId,
    userId,
  });

  res.status(200).json({ data: returnRequest });
});

export const listReturnRequestsForAdmin = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;

  const result = await listReturnRequestsService({
    status,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 20,
  });

  res.status(200).json(result);
});

export const getReturnRequestForAdmin = asyncHandler(async (req, res) => {
  const { returnId } = req.params;

  const returnRequest = await getReturnRequestByIdService({
    returnId,
  });

  res.status(200).json({ data: returnRequest });
});

export const processReturnRequest = asyncHandler(async (req, res) => {
  const adminUserId = req.user?._id;
  const { returnId } = req.params;
  const { status, rejectionReason } = req.body;

  const returnRequest = await processReturnRequestService({
    returnId,
    action: status,
    adminUserId,
    rejectionReason,
  });

  res.status(200).json({ data: returnRequest });
});
