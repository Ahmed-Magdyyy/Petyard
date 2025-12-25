import { ConditionModel } from "./condition.model.js";
import { PetModel } from "../pet/pet.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { normalizeTag } from "../../shared/utils/tagging.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";

export async function getConditionsService(query = {}, lang = "en") {
  const { type, visible } = query;

  const filter = {};
  if (type) {
    filter.type = type;
  }
  if (visible !== undefined) {
    if (visible === "true" || visible === "1" || visible === true) {
      filter.visible = true;
    } else if (visible === "false" || visible === "0" || visible === false) {
      filter.visible = false;
    }
  }

  const conditions = await ConditionModel.find(filter).sort({
    type: 1,
    slug: 1,
  });

  const normalizedLang = lang === "ar" ? "ar" : "en";

  return conditions.map((c) => ({
    id: c._id,
    slug: c.slug,
    type: c.type,
    name: pickLocalizedField(c, "name", normalizedLang),
    visible: c.visible,
  }));
}

export async function createConditionService(payload) {
  const { type, name_en, name_ar, visible } = payload;

  const normalizedSlug = normalizeTag(name_en);

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await ConditionModel.findOne({ slug: normalizedSlug });
  if (existing) {
    throw new ApiError(
      `Condition with slug '${normalizedSlug}' already exists`,
      409
    );
  }

  const condition = await ConditionModel.create({
    slug: normalizedSlug,
    type,
    name_en,
    name_ar,
    visible,
  });

  return condition;
}

export async function updateConditionService(id, payload) {
  const condition = await ConditionModel.findById(id);
  if (!condition) {
    throw new ApiError(`No condition found for this id: ${id}`, 404);
  }
  const { type, name_en, name_ar } = payload;

  if (type !== undefined) condition.type = type;
  if (name_en !== undefined) condition.name_en = name_en;
  if (name_ar !== undefined) condition.name_ar = name_ar;

  const updated = await condition.save();
  return updated;
}

export async function toggleConditionActiveService(id) {
  const condition = await ConditionModel.findById(id);
  if (!condition) {
    throw new ApiError(`No condition found for this id: ${id}`, 404);
  }
  condition.visible = !condition.visible;
  const updated = await condition.save();
  return updated;
}

export async function deleteConditionService(id) {
  const condition = await ConditionModel.findById(id);
  if (!condition) {
    throw new ApiError(`No condition found for this id: ${id}`, 404);
  }

  const slug = condition.slug;

  const isReferencedByPet = await PetModel.exists({
    $or: [
      { chronic_conditions: slug },
      { temp_health_issues: slug },
    ],
  });

  if (isReferencedByPet) {
    throw new ApiError(
      "Cannot delete condition because it is referenced by existing pets",
      409
    );
  }

  await ConditionModel.deleteOne({ _id: id });
}
