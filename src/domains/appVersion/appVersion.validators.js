import { body, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import {
  appVersionPattern,
  appVersionPlatforms,
} from "./appVersion.model.js";

const platformValues = Object.values(appVersionPlatforms);
const versionMessage = "Version must be numeric, e.g. 1.2.3 or 1.2.3+45";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateVersionReleasePayload(value, index = null) {
  const prefix = index === null ? "release" : `releases[${index}]`;

  if (!isPlainObject(value)) {
    throw new Error(`${prefix} must be an object`);
  }

  if (!platformValues.includes(value.platform)) {
    throw new Error(`${prefix}.platform must be either android or ios`);
  }

  if (typeof value.version !== "string" || !appVersionPattern.test(value.version)) {
    throw new Error(`${prefix}.version ${versionMessage}`);
  }

  if (typeof value.mustUpdate !== "boolean") {
    throw new Error(`${prefix}.mustUpdate is required and must be a boolean`);
  }

  for (const field of ["setAsLatestVersion", "setAsMinVersion"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(`${prefix}.${field} must be a boolean`);
    }
  }
}

export const checkAppVersionValidator = [
  query("platform")
    .notEmpty()
    .withMessage("platform is required")
    .bail()
    .isIn(platformValues)
    .withMessage("platform must be either android or ios"),
  query("appVersion")
    .notEmpty()
    .withMessage("appVersion is required")
    .bail()
    .matches(appVersionPattern)
    .withMessage(versionMessage),
  validatorMiddleware,
];

export const createAppVersionReleasesValidator = [
  body().custom((value) => {
    const releases = Array.isArray(value?.releases) ? value.releases : [value];

    if (!releases.length) {
      throw new Error("At least one release must be provided");
    }

    releases.forEach((release, index) =>
      validateVersionReleasePayload(
        release,
        Array.isArray(value?.releases) ? index : null,
      ),
    );

    return true;
  }),
  validatorMiddleware,
];
