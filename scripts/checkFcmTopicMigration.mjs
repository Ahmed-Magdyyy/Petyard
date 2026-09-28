import "@dotenvx/dotenvx/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { getFirebaseMessaging } from "../src/config/firebase.js";
import { NotificationDeviceModel } from "../src/domains/notification/notification.model.js";
import { getBroadcastTopicForToken } from "../src/domains/notification/notificationTopics.service.js";

function getConfiguredProjectId() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson?.trim()) return JSON.parse(rawJson).project_id;

  const credentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!credentialPath) throw new Error("Firebase credentials are not configured");
  if (credentialPath.startsWith("encrypted:")) {
    throw new Error("Firebase credentials were not decrypted");
  }

  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(path.resolve(credentialPath), "utf8"));
  } catch {
    throw new Error("Could not read Firebase credentials");
  }
  return credentials.project_id;
}

async function main() {
  const expectedProjectId = process.env.FCM_CANARY_PROJECT_ID;
  if (!expectedProjectId) throw new Error("FCM_CANARY_PROJECT_ID is required");
  if (getConfiguredProjectId() !== expectedProjectId) {
    throw new Error("Firebase credentials do not match the expected project");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  const messaging = getFirebaseMessaging();
  if (!messaging) throw new Error("Firebase Messaging failed to initialize");

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const devices = await NotificationDeviceModel.find(
      { token: { $type: "string", $ne: "" } },
      { token: 1 },
    )
      .sort({ lastUsedAt: -1 })
      .limit(5)
      .lean();

    if (!devices.length) throw new Error("No device token is available for the canary");

    for (const device of devices) {
      const { topic } = getBroadcastTopicForToken(device.token);
      const result = await messaging.subscribeToTopic(device.token, topic);

      if (!result.failureCount) {
        console.log(`FCM topic subscription succeeded for ${expectedProjectId}: ${topic}`);
        if (process.env.FCM_CANARY_DRY_RUN_SEND === "true") {
          const notification = {
            title: "Petyard FCM validation",
            body: "Dry run only",
          };
          await messaging.send({ token: device.token, notification }, true);
          await messaging.send({ topic, notification }, true);
          console.log("FCM direct and topic sends validated in dry-run mode");
        }
        return;
      }

      const errors = result.errors.map(({ error }) => error);
      if (
        errors.every((error) =>
          [
            "messaging/invalid-registration-token",
            "messaging/registration-token-not-registered",
          ].includes(error?.code),
        )
      ) {
        continue;
      }

      const failures = errors.map((error) => {
        const providerError = error?.httpResponse?.data?.error;
        const reasons = (providerError?.details || [])
          .map((detail) => detail?.reason)
          .filter(Boolean);
        return [
          error?.code || "unknown",
          `HTTP ${error?.httpResponse?.status || "unknown"}`,
          providerError?.status,
          ...reasons,
        ]
          .filter(Boolean)
          .join(" / ");
      });
      throw new Error(`FCM subscription failed: ${failures.join(", ")}`);
    }

    throw new Error("The five most recent device tokens are no longer registered");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`[FCM Canary] ${error.code || error.message || "Unexpected failure"}`);
  process.exitCode = 1;
});
