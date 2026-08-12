import { Router } from "express";
import {
  createSearchSuggestion,
  deleteSearchSuggestion,
  getAdminSearchSuggestions,
  getSearchSuggestions,
  updateSearchSuggestion,
  updateSearchSuggestionPositions,
} from "./searchSuggestion.controller.js";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import {
  createSearchSuggestionValidator,
  listSearchSuggestionsQueryValidator,
  searchSuggestionIdParamValidator,
  updateSearchSuggestionPositionsValidator,
  updateSearchSuggestionValidator,
} from "./searchSuggestion.validators.js";

const router = Router();

router.get("/", listSearchSuggestionsQueryValidator, getSearchSuggestions);

router.get(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  listSearchSuggestionsQueryValidator,
  getAdminSearchSuggestions,
);

router.post(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  createSearchSuggestionValidator,
  createSearchSuggestion,
);

router.patch(
  "/positions",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  updateSearchSuggestionPositionsValidator,
  updateSearchSuggestionPositions,
);

router.patch(
  "/admin/:id",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  updateSearchSuggestionValidator,
  updateSearchSuggestion,
);

router.delete(
  "/admin/:id",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  searchSuggestionIdParamValidator,
  deleteSearchSuggestion,
);

export default router;
