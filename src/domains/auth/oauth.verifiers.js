import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ApiError } from "../../shared/utils/ApiError.js";

const googleClient = new OAuth2Client();

function getGoogleAudiences() {
  const raw =
    process.env.GOOGLE_CLIENT_IDS ||
    process.env.GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
    "";

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function verifyGoogleIdTokenOrThrow(idToken) {
  const audiences = getGoogleAudiences();
  if (!audiences.length) {
    throw new ApiError("Google OAuth client id is not configured", 500);
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
  } catch {
    throw new ApiError("Invalid Google token", 401);
  }

  const payload = ticket.getPayload();

  if (!payload?.sub) {
    throw new ApiError("Invalid Google token", 401);
  }

  return {
    providerUserId: String(payload.sub),
    email: payload.email ? String(payload.email).toLowerCase() : undefined,
    emailVerified: Boolean(payload.email_verified),
    name: payload.name ? String(payload.name) : undefined,
  };
}

const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

function sha256Base64Url(input) {
  const hash = crypto.createHash("sha256").update(String(input)).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function verifyAppleIdentityTokenOrThrow({ identityToken, nonce }) {
  const audience =
    process.env.APPLE_CLIENT_ID ||
    process.env.APPLE_SERVICE_ID ||
    process.env.APPLE_BUNDLE_ID;

  if (!audience) {
    throw new ApiError("Apple OAuth client id is not configured", 500);
  }

  let verified;
  try {
    verified = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience,
    });
  } catch {
    throw new ApiError("Invalid Apple token", 401);
  }

  const payload = verified.payload;
  if (!payload?.sub) {
    throw new ApiError("Invalid Apple token", 401);
  }

  if (nonce) {
    const expected = sha256Base64Url(nonce);
    const actual = payload.nonce ? String(payload.nonce) : "";
    if (!actual || actual !== expected) {
      throw new ApiError("Invalid Apple token", 401);
    }
  }

  return {
    providerUserId: String(payload.sub),
    email: payload.email ? String(payload.email).toLowerCase() : undefined,
    emailVerified: payload.email_verified === "true" || payload.email_verified === true,
  };
}
