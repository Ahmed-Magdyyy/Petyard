// src/domains/pet/pet.service.js
import { PetModel } from "./pet.model.js";
import { ConditionModel } from "../condition/condition.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { buildPagination, buildSort } from "../../shared/utils/apiFeatures.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

async function validateConditionSlugs({ chronicSlugs, tempSlugs }) {
  if (chronicSlugs && chronicSlugs.length > 0) {
    const uniqueChronic = [...new Set(chronicSlugs)];
    const chronicConditions = await ConditionModel.find({
      slug: { $in: uniqueChronic },
      type: "chronic",
      visible: true,
    }).select("slug type");

    const foundChronicSlugs = chronicConditions.map((c) => c.slug);
    const missingChronic = uniqueChronic.filter(
      (slug) => !foundChronicSlugs.includes(slug)
    );

    if (missingChronic.length > 0) {
      throw new ApiError(
        `Invalid chronic condition slugs: ${missingChronic.join(", ")}`,
        400
      );
    }
  }

  if (tempSlugs && tempSlugs.length > 0) {
    const uniqueTemp = [...new Set(tempSlugs)];
    const tempConditions = await ConditionModel.find({
      slug: { $in: uniqueTemp },
      type: "temporary",
      visible: true,
    }).select("slug type");

    const foundTempSlugs = tempConditions.map((c) => c.slug);
    const missingTemp = uniqueTemp.filter(
      (slug) => !foundTempSlugs.includes(slug)
    );

    if (missingTemp.length > 0) {
      throw new ApiError(
        `Invalid temporary health issue slugs: ${missingTemp.join(", ")}`,
        400
      );
    }
  }
}

export async function setDefaultPetForOwnerService(ownerId, petId) {
  const pet = await PetModel.findOne({ _id: petId, petOwner: ownerId });
  if (!pet) {
    throw new ApiError(`No pet found for this id: ${petId}`, 404);
  }

  await PetModel.updateMany(
    { petOwner: ownerId, isDefault: true },
    { $set: { isDefault: false } }
  );

  pet.isDefault = true;
  await pet.save();

  return pet;
}

export async function getAllPetsService(queryParams = {}) {
  const { page, limit } = queryParams;

  const filter = {};

  const totalPetsCount = await PetModel.countDocuments(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);
  const sort = buildSort(queryParams, "-createdAt");

  const petsQuery = PetModel.find(filter).skip(skip).limit(limitNum);

  if (sort) {
    petsQuery.sort(sort);
  }

  const pets = await petsQuery;

  const totalPages = Math.ceil(totalPetsCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: pets.length,
    data: pets,
  };
}

export async function createPetService(ownerId, payload, file) {
  const {
    name,
    type,
    breed,
    gender,
    birthDate,
    chronic_conditions,
    temp_health_issues,
  } = payload;

  await validateConditionSlugs({
    chronicSlugs: chronic_conditions,
    tempSlugs: temp_health_issues,
  });

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/pets",
      publicId: `pet_${ownerId}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  const hasAnyPets = await PetModel.exists({ petOwner: ownerId });
  const shouldBeDefault = !hasAnyPets;

  try {
    const pet = await PetModel.create({
      petOwner: ownerId,
      name,
      type,
      breed,
      gender,
      birthDate,
      chronic_conditions,
      temp_health_issues,
      isDefault: shouldBeDefault,
      ...(image && { image }),
    });

    return pet;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function getPetsForOwnerService(ownerId, queryParams = {}) {
  const { page, limit } = queryParams;

  const filter = { petOwner: ownerId };

  const totalPetsCount = await PetModel.countDocuments(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);
  const sort = buildSort(queryParams, "-createdAt");

  const petsQuery = PetModel.find(filter).skip(skip).limit(limitNum);

  if (sort) {
    petsQuery.sort(sort);
  }

  const pets = await petsQuery;

  const totalPages = Math.ceil(totalPetsCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: pets.length,
    data: pets,
  };
}

export async function getPetByIdForOwnerService(ownerId, petId) {
  const pet = await PetModel.findOne({ _id: petId, petOwner: ownerId });

  if (!pet) {
    throw new ApiError(`No pet found for this id: ${petId}`, 404);
  }

  return pet;
}

export async function updatePetForOwnerService(ownerId, petId, payload, file) {
  const pet = await PetModel.findOne({ _id: petId, petOwner: ownerId });

  if (!pet) {
    throw new ApiError(`No pet found for this id: ${petId}`, 404);
  }

  const {
    name,
    type,
    breed,
    gender,
    birthDate,
    chronic_conditions,
    temp_health_issues,
  } = payload;

  await validateConditionSlugs({
    chronicSlugs: chronic_conditions,
    tempSlugs: temp_health_issues,
  });

  if (name !== undefined) pet.name = name;
  if (type !== undefined) pet.type = type;
  if (breed !== undefined) pet.breed = breed;
  if (gender !== undefined) pet.gender = gender;
  if (birthDate !== undefined) pet.birthDate = birthDate;
  if (chronic_conditions !== undefined)
    pet.chronic_conditions = chronic_conditions;
  if (temp_health_issues !== undefined)
    pet.temp_health_issues = temp_health_issues;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = pet.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/pets",
      publicId: `pet_${pet._id}_${Date.now()}`,
    });
    pet.image = newImage;
  }

  try {
    const updatedPet = await pet.save();

    if (oldPublicId) {
      await deleteImageFromCloudinary(oldPublicId);
    }

    return updatedPet;
  } catch (err) {
    if (newImage?.public_id) {
      await deleteImageFromCloudinary(newImage.public_id);
    }
    throw err;
  }
}

export async function deletePetByIdService(petId) {
  const pet = await PetModel.findByIdAndDelete(petId);

  if (!pet) {
    throw new ApiError(`No pet found for this id: ${petId}`, 404);
  }
  if (pet.image?.public_id) {
    await deleteImageFromCloudinary(pet.image.public_id);
  }
  return pet;
}

export async function deletePetForOwnerService(ownerId, petId) {
  const pet = await PetModel.findOneAndDelete({
    _id: petId,
    petOwner: ownerId,
  });

  if (!pet) {
    throw new ApiError(`No pet found for this id: ${petId}`, 404);
  }
  if (pet.image?.public_id) {
    await deleteImageFromCloudinary(pet.image.public_id);
  }
  return pet;
}
