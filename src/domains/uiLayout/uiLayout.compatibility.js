import { SEMVER, UI_LAYOUT_PRODUCT_REFERENCE_FORMAT } from "./uiLayout.constants.js";
import { compareVersions } from "./uiLayout.targeting.js";

// No compatible customer release has been agreed yet. Unset/invalid means no publication.
export function getIdOnlyMinimumAppVersion() {
  const value = process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
  return typeof value === "string" && SEMVER.test(value) ? value : null;
}

export function inspectClientCompatibility(content, targeting, minimum = getIdOnlyMinimumAppVersion()) {
  if (content.product_reference_format !== UI_LAYOUT_PRODUCT_REFERENCE_FORMAT) return [];
  const version = targeting?.min_app_version;
  if (typeof minimum !== "string" || !SEMVER.test(minimum) ||
    typeof version !== "string" || !SEMVER.test(version) || compareVersions(version, minimum) < 0) {
    return [{ path: "targeting.min_app_version", code: "CLIENT_VERSION_UNSUPPORTED",
      message: minimum ? `New content must target app version ${minimum} or later.` :
        "New-format publication is disabled until the first compatible customer-app version is configured." }];
  }
  return [];
}
