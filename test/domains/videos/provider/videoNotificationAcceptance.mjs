// One explicitly authorized push test. Reads only the supplied account/devices.
import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenvx from "@dotenvx/dotenvx";
import mongoose from "mongoose";
import { deleteApp, getApps } from "firebase-admin/app";
import { getFirebaseMessaging } from "../../../../src/config/firebase.js";
import { roles } from "../../../../src/shared/constants/enums.js";

const userId = "691abbbbc2b6dc546f3e730f";
const directory = new URL("../../../../scripts/videos-notification-acceptance-20261009/", import.meta.url);
const manifest = new URL("private.json", directory);
const mode = process.argv[2];
let connection;
try {
  assert.ok(["preflight", "send"].includes(mode));
  const environment = {};
  dotenvx.config({ path: ".env", envKeysFile: ".env.keys", processEnv: environment,
    quiet: true, strict: true, noOps: true, logLevel: "error" });
  assert.ok(environment.MONGO_URI);
  connection = mongoose.createConnection(environment.MONGO_URI, { autoCreate: false,
    autoIndex: false, serverSelectionTimeoutMS: 15_000 });
  try { await connection.asPromise(); }
  catch (error) { throw new Error(`Notification connection failed (${error?.name || "connection error"})`); }
  const objectId = new mongoose.Types.ObjectId(userId);
  const user = await connection.db.collection("users").findOne({ _id: objectId },
    { projection: { _id: 1, role: 1, active: 1, deletedAt: 1 } });
  assert.ok(user && user.role === roles.SUPER_ADMIN && user.active !== false && !user.deletedAt,
    "Authorized recipient must be an active super admin");
  const devices = await connection.db.collection("notificationdevices").find({ user: objectId },
    { projection: { token: 1, platform: 1 } }).toArray();
  const tokens = [...new Set(devices.map(value => value.token?.trim()).filter(Boolean))];
  assert.ok(tokens.length > 0 && tokens.length <= 500, "Recipient must have 1..500 registered device tokens");
  console.log(JSON.stringify({ userId, roleVerified: true, registeredDevices: devices.length,
    uniqueTokens: tokens.length, platforms: [...new Set(devices.map(value => value.platform))] }));
  if (mode === "send") {
    assert.ok(!existsSync(manifest), "Send scope consumed or outcome uncertain; do not retry");
    for (const key of ["FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_SERVICE_ACCOUNT_PATH"])
      if (environment[key]) process.env[key] = environment[key];
    const messaging = getFirebaseMessaging(); assert.ok(messaging);
    const state = { userId, runId: randomUUID(), requestedAt: new Date().toISOString(),
      tokens: tokens.length, sendRequested: true };
    mkdirSync(directory, { recursive: true });
    const save = () => {
      writeFileSync(new URL("private.tmp", directory), JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(new URL("private.tmp", directory), manifest);
    };
    save();
    // Use the same Firebase transport as the dispatcher, without deleting stale registrations.
    const result = await messaging.sendEachForMulticast({ tokens,
      notification: { title: "Petyard Videos test", body: "Backend notification test for your super-admin account. No action is needed." },
      data: { type: "videos_acceptance_test", runId: state.runId },
      android: { priority: "high", notification: { sound: "default" } },
      apns: { headers: { "apns-priority": "10", "apns-push-type": "alert" }, payload: { aps: { sound: "default" } } },
    });
    state.finishedAt = new Date().toISOString(); state.successCount = result.successCount;
    state.failureCount = result.failureCount;
    state.errorCodes = result.responses.filter(response => !response.success)
      .map(response => response.error?.code || "unknown");
    save(); console.log(JSON.stringify({ userId, successCount: state.successCount,
      failureCount: state.failureCount, errorCodes: state.errorCodes, registrationsUnchanged: true }));
    assert.ok(state.successCount > 0, "No push was accepted by Firebase");
  }
} catch (error) {
  console.error(JSON.stringify({ failed: true, name: error?.name || "Error",
    code: error?.code || null, status: Number.isInteger(error?.status) ? error.status : null }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([connection?.close(), ...getApps().map(app => deleteApp(app))]);
}
