import { Router } from "express";
import { protect } from "../auth/auth.middleware.js";
import {
  getGuestAddresses,
  addGuestAddress,
  updateGuestAddress,
  deleteGuestAddress,
  setDefaultGuestAddress,
  mergeGuestAddresses,
} from "./address.controller.js";
import {
  addAddressValidator,
  updateAddressValidator,
  deleteAddressValidator,
  setDefaultAddressValidator,
} from "./address.validators.js";

const router = Router();

// ── Guest address routes (x-guest-id header) ───────────────────────────────

router.get("/guest", getGuestAddresses);
router.post("/guest", addAddressValidator, addGuestAddress);
router.patch("/guest/:addressId", updateAddressValidator, updateGuestAddress);
router.delete("/guest/:addressId", deleteAddressValidator, deleteGuestAddress);
router.patch(
  "/guest/:addressId/default",
  setDefaultAddressValidator,
  setDefaultGuestAddress,
);

// ── Merge route (JWT + x-guest-id) ─────────────────────────────────────────

router.post("/merge", protect, mergeGuestAddresses);

export default router;
