import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import fs from "fs";
import path from "path";

let messaging;

export function getFirebaseMessaging() {
  if (messaging) {
    return messaging;
  }

  let serviceAccountJson;
  const rawJsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (rawJsonEnv && rawJsonEnv.trim()) {
    try {
      serviceAccountJson = JSON.parse(rawJsonEnv);
    } catch (err) {
      console.error(
        "[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON -",
        err.message
      );
      return null;
    }
  } else {
    const rawPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (!rawPath) {
      console.warn(
        "[Firebase] No FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH set. Notifications are disabled."
      );
      return null;
    }

    const resolvedPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);

    try {
      const fileContents = fs.readFileSync(resolvedPath, "utf8");
      serviceAccountJson = JSON.parse(fileContents);
    } catch (err) {
      console.error(
        "[Firebase] Failed to read/parse service account JSON at",
        resolvedPath,
        "-",
        err.message
      );
      return null;
    }
  }

  try {
    const app = initializeApp({
      credential: cert(serviceAccountJson),
    });
    messaging = getMessaging(app);
  } catch (err) {
    console.error("[Firebase] Failed to initialize admin SDK:", err.message);
    return null;
  }

  console.log("[Firebase] Admin initialized");
  return messaging;
}
