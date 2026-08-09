import { Router } from "express";
import {
  allowedTo,
  enabledControls as enabledControlsMiddleware,
  protect,
  requireSystemPhoneVerifiedForSensitiveActions,
} from "../auth/auth.middleware.js";
import { scopeOrdersToModeratorWarehouses } from "../order/order.middleware.js";
import {
  enabledControls,
  roles,
} from "../../shared/constants/enums.js";
import {
  guestLimiter,
  paymentLimiter,
} from "../../shared/middlewares/rateLimitMiddleware.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";
import {
  createSubstitutionOffer,
  getGuestSubstitutionRequest,
  getMySubstitutionRequest,
  getSubstitutionRequestForStaff,
  listGuestSubstitutionRequests,
  listMySubstitutionRequests,
  listSubstitutionCandidates,
  listSubstitutionRequestsForStaff,
  quoteGuestSubstitution,
  quoteMySubstitution,
  respondToGuestSubstitution,
  respondToMySubstitution,
  retryGuestSubstitutionPayment,
  retryMySubstitutionPayment,
} from "./substitution.controller.js";
import {
  createSubstitutionValidator,
  quoteSubstitutionValidator,
  parseSubstitutionJsonFields,
  respondToSubstitutionValidator,
  retrySubstitutionPaymentValidator,
  substitutionCandidatesValidator,
  substitutionOrderIdValidator,
  substitutionRequestParamsValidator,
} from "./substitution.validators.js";

const router = Router();

router.get(
  "/guest/:id/substitutions",
  guestLimiter,
  substitutionOrderIdValidator,
  listGuestSubstitutionRequests,
);
router.get(
  "/guest/:id/substitutions/:requestId",
  guestLimiter,
  substitutionRequestParamsValidator,
  getGuestSubstitutionRequest,
);
router.post(
  "/guest/:id/substitutions/:requestId/quote",
  guestLimiter,
  quoteSubstitutionValidator,
  quoteGuestSubstitution,
);
router.post(
  "/guest/:id/substitutions/:requestId/respond",
  guestLimiter,
  paymentLimiter,
  uploadSingleImage("additionalInstapayScreenshot"),
  parseSubstitutionJsonFields,
  respondToSubstitutionValidator,
  respondToGuestSubstitution,
);
router.post(
  "/guest/:id/substitutions/:requestId/payment-attempts/:attemptId/retry",
  guestLimiter,
  paymentLimiter,
  retrySubstitutionPaymentValidator,
  retryGuestSubstitutionPayment,
);

router.get(
  "/me/:id/substitutions",
  protect,
  substitutionOrderIdValidator,
  listMySubstitutionRequests,
);
router.get(
  "/me/:id/substitutions/:requestId",
  protect,
  substitutionRequestParamsValidator,
  getMySubstitutionRequest,
);
router.post(
  "/me/:id/substitutions/:requestId/quote",
  protect,
  requireSystemPhoneVerifiedForSensitiveActions,
  quoteSubstitutionValidator,
  quoteMySubstitution,
);
router.post(
  "/me/:id/substitutions/:requestId/respond",
  protect,
  paymentLimiter,
  requireSystemPhoneVerifiedForSensitiveActions,
  uploadSingleImage("additionalInstapayScreenshot"),
  parseSubstitutionJsonFields,
  respondToSubstitutionValidator,
  respondToMySubstitution,
);
router.post(
  "/me/:id/substitutions/:requestId/payment-attempts/:attemptId/retry",
  protect,
  paymentLimiter,
  requireSystemPhoneVerifiedForSensitiveActions,
  retrySubstitutionPaymentValidator,
  retryMySubstitutionPayment,
);

router.use(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControls.ORDERS),
  scopeOrdersToModeratorWarehouses,
);
router.get(
  "/admin/:id/substitution-candidates",
  substitutionCandidatesValidator,
  listSubstitutionCandidates,
);
router.get(
  "/admin/:id/substitutions",
  substitutionOrderIdValidator,
  listSubstitutionRequestsForStaff,
);
router.get(
  "/admin/:id/substitutions/:requestId",
  substitutionRequestParamsValidator,
  getSubstitutionRequestForStaff,
);
router.post(
  "/admin/:id/substitutions",
  createSubstitutionValidator,
  createSubstitutionOffer,
);

export default router;
