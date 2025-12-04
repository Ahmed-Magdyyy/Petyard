import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  listProductReviews,
  createGuestReview,
  createUserReview,
  deleteReview,
} from "./review.controller.js";
import { createReviewValidator, reviewIdParamValidator } from "./review.validators.js";
import { productIdParamValidator } from "../product/product.validators.js";

const router = Router({ mergeParams: true });

router.get("/", productIdParamValidator, listProductReviews);

router.post(
  "/guest",
  productIdParamValidator,
  createReviewValidator,
  createGuestReview
);

router.use(protect);

router.post(
  "/",
  productIdParamValidator,
  createReviewValidator,
  createUserReview
);

router.delete(
  "/:reviewId",
  productIdParamValidator,
  reviewIdParamValidator,
  allowedTo(roles.ADMIN, roles.SUPER_ADMIN, roles.USER),
  deleteReview
);

export default router;
