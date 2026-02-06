import asyncHandler from "express-async-handler";
import {
  getAllPetsService,
  createPetService,
  getPetsForOwnerService,
  getPetByIdForOwnerService,
  updatePetForOwnerService,
  deletePetForOwnerService,
  deletePetByIdService,
  setDefaultPetForOwnerService,
} from "./pet.service.js";

// ----- Admin Controllers -----

// GET /pets/admin
export const getAllPets = asyncHandler(async (req, res) => {
  const result = await getAllPetsService(req.query);
  res.status(200).json(result);
});

// GET /pets/admin/user/:userId
export const getUserPets = asyncHandler(async (req, res) => {
  const result = await getPetsForOwnerService(req.params.userId, req.query);
  res.status(200).json(result);
});

// POST /pets/admin/user/:userId
export const createUserPet = asyncHandler(async (req, res) => {
  const pet = await createPetService(req.params.userId, req.body, req.file || null);
  res.status(201).json({ data: pet });
});

// DELETE /pets/admin/:id
export const deletePetAdmin = asyncHandler(async (req, res) => {
  await deletePetByIdService(req.params.id);
  res.status(200).json({ message: "Pet deleted successfully" });
});

// ----- Logged-in User Controllers -----

// GET /pets
export const getPets = asyncHandler(async (req, res) => {
  const result = await getPetsForOwnerService(req.user._id, req.query);
  res.status(200).json(result);
});

// GET /pets/:id
export const getPet = asyncHandler(async (req, res) => {
  const pet = await getPetByIdForOwnerService(req.user._id, req.params.id);
  res.status(200).json({ data: pet });
});

// POST /pets
export const createPet = asyncHandler(async (req, res) => {
  const pet = await createPetService(req.user._id, req.body, req.file || null);
  res.status(201).json({ data: pet });
});

// PATCH /pets/:id
export const updatePet = asyncHandler(async (req, res) => {
  const pet = await updatePetForOwnerService(
    req.user._id,
    req.params.id,
    req.body,
    req.file || null
  );
  res.status(200).json({ data: pet });
});

// DELETE /pets/:id
export const deletePet = asyncHandler(async (req, res) => {
  await deletePetForOwnerService(req.user._id, req.params.id);
  res.status(200).json({ message: "Pet deleted successfully" });
});

// PATCH /pets/:id/default
export const setDefaultPet = asyncHandler(async (req, res) => {
  const pet = await setDefaultPetForOwnerService(req.user._id, req.params.id);
  res.status(200).json({ data: pet });
});
