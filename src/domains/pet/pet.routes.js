// src/domains/pet/pet.routes.js
import { Router } from "express";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import { protect, allowedTo } from "../auth/auth.middleware.js";

import {
  getAllPets,
  getUserPets,
  createUserPet,
  createPet,
  getPets,
  getPet,
  updatePet,
  deletePet,
  deletePetAdmin,
  setDefaultPet,
} from "./pet.controller.js";
import {
  createPetValidator,
  updatePetValidator,
  petIdParamValidator,
  petUserIdParamValidator,
} from "./pet.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.use(protect);

// ----- Admin Routes -----

router.get("/admin", allowedTo(roles.SUPER_ADMIN), getAllPets);
router.get(
  "/admin/user/:userId",
  allowedTo(roles.SUPER_ADMIN),
  petUserIdParamValidator,
  getUserPets
);
router.post(
  "/admin/user/:userId",
  allowedTo(roles.SUPER_ADMIN),
  petUserIdParamValidator,
  uploadSingleImage("image"),
  createPetValidator,
  createUserPet
);
router.delete(
  "/admin/:id",
  allowedTo(roles.SUPER_ADMIN),
  petIdParamValidator,
  deletePetAdmin
);

// ----- Logged-in User Routes -----

router
  .route("/")
  .get(
    // allowedTo(roles.USER),
   getPets)
  .post(
    allowedTo(roles.USER),
    uploadSingleImage("image"),
    createPetValidator,
    createPet
  );

router
  .route("/:id")
  .get(allowedTo(roles.USER), petIdParamValidator, getPet)
  .patch(
    allowedTo(roles.USER),
    uploadSingleImage("image"),
    updatePetValidator,
    updatePet
  )
  .delete(allowedTo(roles.USER), petIdParamValidator, deletePet);

router.patch(
  "/:id/default",
  allowedTo(roles.USER),
  petIdParamValidator,
  setDefaultPet
);

export default router;
