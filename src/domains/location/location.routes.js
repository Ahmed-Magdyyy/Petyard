// src/domains/location/location.routes.js
import { Router } from "express";
import { resolveLocation, getLocationOptions } from "./location.controller.js";
import { resolveLocationValidator } from "./location.validators.js";

const router = Router();

router.get("/options", getLocationOptions);
router.post("/resolve", resolveLocationValidator, resolveLocation);

export default router;
