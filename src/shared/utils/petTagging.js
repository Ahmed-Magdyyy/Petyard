import { normalizeTag } from "./tagging.js";
import {
  knownBreedTagsByPetType,
  breedAliasMapByPetType,
  nonSpecificBreedTags,
  petLifeStageTags,
} from "../constants/petTags.js";

export function calculateAgeMonths(birthDate) {
  if (!birthDate) return null;

  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;

  const now = new Date();
  const months =
    (now.getFullYear() - birth.getFullYear()) * 12 +
    (now.getMonth() - birth.getMonth());

  return Math.max(0, months);
}

export function getLifeStage(ageMonths) {
  if (ageMonths === null) return petLifeStageTags.ADULT;
  return ageMonths <= 5 ? petLifeStageTags.BABY : petLifeStageTags.ADULT;
}

export function resolveBreedTag({ petType, breed }) {
  const normalized = normalizeTag(breed);
  if (!normalized) return null;

  const aliasMap = breedAliasMapByPetType[petType] || {};
  const canonical = aliasMap[normalized] || normalized;

  if (nonSpecificBreedTags.includes(canonical)) return null;

  const known = knownBreedTagsByPetType[petType];
  if (!Array.isArray(known) || !known.length) return null;

  return known.includes(canonical) ? canonical : null;
}

export function buildPetTags(pet) {
  if (!pet) return [];

  const tags = [];

  if (pet.type) {
    tags.push(normalizeTag(pet.type));
  }

  const ageMonths = calculateAgeMonths(pet.birthDate);
  tags.push(getLifeStage(ageMonths));

  const breedTag = resolveBreedTag({ petType: pet.type, breed: pet.breed });
  if (breedTag) tags.push(breedTag);

  if (Array.isArray(pet.chronic_conditions)) {
    tags.push(...pet.chronic_conditions.map(normalizeTag).filter(Boolean));
  }

  if (Array.isArray(pet.temp_health_issues)) {
    tags.push(...pet.temp_health_issues.map(normalizeTag).filter(Boolean));
  }

  return [...new Set(tags.filter(Boolean))];
}
