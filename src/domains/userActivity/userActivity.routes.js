// src/domains/userActivity/userActivity.routes.js
import { Router } from "express";
import { getUserActivity } from "./userActivity.controller.js";
import { getUserActivityValidator } from "./userActivity.validators.js";

// This router is mounted with mergeParams so it receives :id from the parent
const router = Router({ mergeParams: true });

router.get("/", getUserActivityValidator, getUserActivity);

export default router;
