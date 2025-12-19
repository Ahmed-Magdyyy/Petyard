import { Router } from "express";
import {
  getCollections,
  getCollection,
  getCollectionWithProducts,
  createCollection,
  updateCollection,
  deleteCollection,
} from "./collection.controller.js";
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
  createCollectionValidator,
  updateCollectionValidator,
  collectionIdParamValidator,
} from "./collection.validators.js";
import { listProductsQueryValidator } from "../product/product.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getCollections);
router.get("/:id", collectionIdParamValidator, getCollection);
router.get(
  "/:id/products",
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
  "/:id",
  uploadSingleImage("image"),
  updateCollectionValidator,
  updateCollection
);

router.delete("/:id", collectionIdParamValidator, deleteCollection);

export default router;
