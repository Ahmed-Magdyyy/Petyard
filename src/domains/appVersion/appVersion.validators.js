import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import {
  appVersionPattern,
  appVersionPlatforms,
} from "./appVersion.model.js";

const platformValues = Object.values(appVersionPlatforms);
const versionMessage = "Version must be numeric, e.g. 1.2.3 or 1.2.3+45";

function optionalNullableString(field) {
  return body(field)
    .optional({ nullable: true })
    .isString()
    .withMessage(`${field} must be a string or null`)
    .trim();
}

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

  if (
    value.releaseNotes !== undefined &&
    value.releaseNotes !== null &&
    typeof value.releaseNotes !== "string"
  ) {
    throw new Error(`${prefix}.releaseNotes must be a string or null`);
  }
}

export const platformParamValidator = [
  param("platform")
    .isIn(platformValues)
    .withMessage("platform must be either android or ios"),
  validatorMiddleware,
];

export const checkAppVersionValidator = [
  param("platform")
    .optional()
    .isIn(platformValues)
    .withMessage("platform must be either android or ios"),
  query("platform")
    .if((value, { req }) => !req.params.platform)
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

export const updateAppVersionReleaseValidator = [
  param("platform")
    .isIn(platformValues)
    .withMessage("platform must be either android or ios"),
  param("version").matches(appVersionPattern).withMessage(versionMessage),
  body("mustUpdate")
    .optional()
    .isBoolean()
    .withMessage("mustUpdate must be a boolean")
    .toBoolean(),
  optionalNullableString("releaseNotes"),
  body().custom((value) => {
    const allowedFields = ["mustUpdate", "releaseNotes"];
    const hasAllowedField = allowedFields.some((field) =>
      Object.prototype.hasOwnProperty.call(value, field),
    );

    if (!hasAllowedField) {
      throw new Error(
        "At least mustUpdate or releaseNotes must be provided",
      );
    }

    return true;
  }),
  validatorMiddleware,
];

export const updateAppVersionPolicyValidator = [
  param("platform")
    .isIn(platformValues)
    .withMessage("platform must be either android or ios"),
  body("latestAppVersion")
    .optional()
    .matches(appVersionPattern)
    .withMessage(versionMessage),
  body("minAppVersion")
    .optional()
    .matches(appVersionPattern)
    .withMessage(versionMessage),
  body().custom((value) => {
    if (!value.latestAppVersion && !value.minAppVersion) {
      throw new Error(
        "At least latestAppVersion or minAppVersion must be provided",
      );
    }
    return true;
  }),
  validatorMiddleware,
];
