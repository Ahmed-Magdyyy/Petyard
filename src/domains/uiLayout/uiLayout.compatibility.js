import { SEMVER, UI_LAYOUT_PRODUCT_REFERENCE_FORMAT } from "./uiLayout.constants.js";
import { compareVersions } from "./uiLayout.targeting.js";
import { collectLayoutReferences } from "./uiLayout.productReferences.js";

// No compatible customer release has been agreed yet. Unset/invalid means no publication.
export function getIdOnlyMinimumAppVersion() {
  const value = process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
  return typeof value === "string" && SEMVER.test(value) ? value : null;
}

export function getExtensionsMinimumAppVersion() {
  const value = process.env.UI_BUILDER_EXTENSIONS_MIN_APP_VERSION;
  return typeof value === "string" && SEMVER.test(value) ? value : null;
}

export function usesUiLayoutExtensions(content) {
  return collectLayoutReferences(content).some((entry) =>
    entry.type === "subcategory" || entry.path.includes(".image_urls["));
}

export function inspectClientCompatibility(content, targeting, minimum = getIdOnlyMinimumAppVersion(),
  extensionsMinimum = getExtensionsMinimumAppVersion()) {
  const errors = [];
  const version = targeting?.min_app_version;
  if (content.product_reference_format === UI_LAYOUT_PRODUCT_REFERENCE_FORMAT &&
    (typeof minimum !== "string" || !SEMVER.test(minimum) ||
    typeof version !== "string" || !SEMVER.test(version) || compareVersions(version, minimum) < 0)) {
    errors.push({ path: "targeting.min_app_version", code: "CLIENT_VERSION_UNSUPPORTED",
      message: minimum ? `New content must target app version ${minimum} or later.` :
        "New-format publication is disabled until the first compatible customer-app version is configured." });
  }
  if (usesUiLayoutExtensions(content) &&
    (typeof extensionsMinimum !== "string" || !SEMVER.test(extensionsMinimum) ||
      typeof version !== "string" || !SEMVER.test(version) || compareVersions(version, extensionsMinimum) < 0)) {
    errors.push({ path: "targeting.min_app_version", code: "CLIENT_VERSION_UNSUPPORTED",
      message: extensionsMinimum ? `Subcategory/carousel content must target app version ${extensionsMinimum} or later.` :
        "Subcategory/carousel publication is disabled until a compatible customer-app version is configured." });
  }
  return errors;
}
