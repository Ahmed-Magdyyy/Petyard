import { Router } from "express";
import {
  getConditions,
  createCondition,
  updateCondition,
  toggleConditionActive,
  deleteCondition,
} from "./condition.controller.js";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  createConditionValidator,
  updateConditionValidator,
  conditionIdParamValidator,
} from "./condition.validators.js";

const router = Router();

// Public list for dropdowns
router.get("/", getConditions);

// Admin-only routes
router.use(protect, allowedTo(roles.SUPER_ADMIN));

router.post("/", createConditionValidator, createCondition);
router.patch("/:id", updateConditionValidator, updateCondition);
router.patch("/:id/toggle-active", conditionIdParamValidator, toggleConditionActive);
router.delete("/:id", conditionIdParamValidator, deleteCondition);

export default router;
