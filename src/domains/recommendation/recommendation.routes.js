import { Router } from "express";
import { protect, optionalProtect } from "../auth/auth.middleware.js";
import {
  getHomeRecommendations,
  getRelatedProducts,
} from "./recommendation.controller.js";

const router = Router();

router.get("/home", protect, getHomeRecommendations);
router.get("/related", optionalProtect, getRelatedProducts);

export default router;
