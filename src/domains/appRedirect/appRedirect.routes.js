import { Router } from "express";

const router = Router();

// ── Store URLs ───────────────────────────────────────────────
// TODO(setup): Replace these with the actual App Store and Play Store URLs
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.petyard.petyard";
const APP_STORE_URL =
  "https://apps.apple.com/us/app/petyard/id6759263780";
const FALLBACK_URL = "https://petyardstores.com";

/**
 * Detect platform from User-Agent and redirect to the correct app store.
 * Primary use case: ad links that direct users to download the app.
 *
 * Flow:
 *  - iOS device → App Store
 *  - Android device → Play Store
 *  - Desktop / unknown → main website (fallback)
 */
function smartRedirect(req, res) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();

  if (/iphone|ipad|ipod/i.test(ua)) {
    return res.redirect(302, APP_STORE_URL);
  }

  if (/android/i.test(ua)) {
    return res.redirect(302, PLAY_STORE_URL);
  }

  // Desktop or unrecognised → redirect to main website
  return res.redirect(302, FALLBACK_URL);
}

// Only root path redirects to store (temporary — for FE testing)
router.get("/", smartRedirect);

// All other paths: no redirect (temporary)
router.get("*", (req, res) => {
  res.status(200).send("Deep link path received — redirect disabled for testing.");
});

export default router;
