import { Router } from "express";
import {
  getCollections,
  getCollection,
  getCollectionWithProducts,
  createCollection,
  updateCollection,
  deleteCollection,
  updateCollectionPositions,
} from "./collection.controller.js";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
  optionalProtect,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import {
  createCollectionValidator,
  updateCollectionValidator,
  collectionIdParamValidator,
  updateCollectionPositionsValidator,
} from "./collection.validators.js";
import { listProductsQueryValidator } from "../product/product.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", optionalProtect, getCollections);
router.get("/:id", optionalProtect, collectionIdParamValidator, getCollection);
router.get(
  "/:id/products",
  optionalProtect,
  collectionIdParamValidator,
  listProductsQueryValidator,
  getCollectionWithProducts
);

router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.COLLECTIONS)
);

router.post(
  "/",
  uploadSingleImage("image"),
  createCollectionValidator,
  createCollection
);

router.patch(
  "/positions",
  updateCollectionPositionsValidator,
  updateCollectionPositions
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateCollectionValidator,
  updateCollection
);

router.delete("/:id", collectionIdParamValidator, deleteCollection);

export default router;
