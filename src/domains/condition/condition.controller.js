import asyncHandler from "express-async-handler";
import {
  getConditionsService,
  createConditionService,
  updateConditionService,
  toggleConditionActiveService,
  deleteConditionService,
} from "./condition.service.js";

// GET /conditions
export const getConditions = asyncHandler(async (req, res) => {
  const data = await getConditionsService(req.query, req.lang);
  res.status(200).json({ data });
});

// POST /conditions
export const createCondition = asyncHandler(async (req, res) => {
  const condition = await createConditionService(req.body);
  res.status(201).json({ data: condition });
});

// PATCH /conditions/:id
export const updateCondition = asyncHandler(async (req, res) => {
  const updated = await updateConditionService(req.params.id, req.body);
  res.status(200).json({ data: updated });
});

// PATCH /conditions/:id/toggle-active
export const toggleConditionActive = asyncHandler(async (req, res) => {
  const updated = await toggleConditionActiveService(req.params.id);
  res.status(200).json({ message: "Condition visibility changed successfully", data: updated });
});

// DELETE /conditions/:id
export const deleteCondition = asyncHandler(async (req, res) => {
  await deleteConditionService(req.params.id);
  res.status(204).json({ message: "Condition deleted successfully" });
});
