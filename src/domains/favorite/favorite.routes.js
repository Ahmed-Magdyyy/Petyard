import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getFavorite,
  addToFavorite,
  removeFromFavorite,
  clearFavorite,
  getFavoriteGuest,
  addToFavoriteGuest,
  removeFromFavoriteGuest,
  clearFavoriteGuest,
  mergeGuestFavoriteIntoMyFavorite,
} from "./favorite.controller.js";
import {
  addToFavoriteValidator,
  removeFromFavoriteValidator,
  guestFavoriteHeaderValidator,
  addToFavoriteGuestValidator,
  removeFromFavoriteGuestValidator,
} from "./favorite.validators.js";

const router = Router();

router.get("/guest", guestFavoriteHeaderValidator, getFavoriteGuest);

router.post("/guest/items", addToFavoriteGuestValidator, addToFavoriteGuest);

router.delete(
  "/guest/items",
  removeFromFavoriteGuestValidator,
  removeFromFavoriteGuest
);

router.delete("/guest", guestFavoriteHeaderValidator, clearFavoriteGuest);

router.use(protect, allowedTo(roles.USER, roles.ADMIN, roles.SUPER_ADMIN));

router.post("/merge", guestFavoriteHeaderValidator, mergeGuestFavoriteIntoMyFavorite);

router.get("/", getFavorite);

router.post("/items", addToFavoriteValidator, addToFavorite);

router.delete("/items", removeFromFavoriteValidator, removeFromFavorite);

router.delete("/", clearFavorite);

export default router;
