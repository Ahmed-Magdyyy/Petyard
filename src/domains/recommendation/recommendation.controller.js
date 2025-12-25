import asyncHandler from "express-async-handler";
import {
  getHomeRecommendationsService,
  getRelatedProductsService,
} from "./recommendation.service.js";

export const getHomeRecommendations = asyncHandler(async (req, res) => {
  const { warehouse } = req.query;

  const sections = await getHomeRecommendationsService({
    userId: req.user._id,
    warehouseId: warehouse,
    lang: req.lang || "en",
  });

  res.status(200).json({ data: sections });
});

export const getRelatedProducts = asyncHandler(async (req, res) => {
  const { warehouse, productId } = req.query;

  const data = await getRelatedProductsService({
    productId,
    warehouseId: warehouse,
    userId: req.user?._id || null,
    lang: req.lang || "en",
  });

  res.status(200).json({ data });
});
