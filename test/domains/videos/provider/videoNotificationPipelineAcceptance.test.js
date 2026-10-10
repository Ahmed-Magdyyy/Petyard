import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import mongoose from "mongoose";
import dotenvx from "@dotenvx/dotenvx";
import { deleteApp, getApps } from "firebase-admin/app";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { NotificationDeviceModel } from "../../../../src/domains/notification/notification.model.js";
import { InAppNotificationModel } from "../../../../src/domains/notification/inAppNotification.model.js";
import { NotificationOutboxModel } from "../../../../src/domains/notification/notificationOutbox.model.js";
import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { deliverClaimedNotificationOutbox } from "../../../../src/domains/notification/notificationOutbox.worker.service.js";
import { claimNextNotificationOutbox, markNotificationOutboxSent,
  markNotificationOutboxRetryable, markNotificationOutboxDeadLetter } from "../../../../src/domains/notification/notificationOutbox.service.js";
import { roles, accountStatus } from "../../../../src/shared/constants/enums.js";

const userId = "691abbbbc2b6dc546f3e730f";
const directory = new URL("../../../../scripts/videos-notification-pipeline-20261009/", import.meta.url);
const manifest = new URL("private.json", directory);
const hash = value => createHash("sha256").update(value).digest("hex");

test("Videos player-error service, durable outbox, real dispatcher and Firebase reach only the approved account", {
  skip: process.env.VIDEOS_NOTIFICATION_PIPELINE_ENABLED !== "true", timeout: 60_000,
}, async () => {
  const uri = process.env.VIDEOS_ACCEPTANCE_MONGO_URI;
  assert.ok(uri, "Explicit approved copied Mongo URI required");
  assert.ok(!existsSync(manifest), "One-send scope consumed or uncertain; never retry automatically");
  const environment = {};
  dotenvx.config({ path: ".env", envKeysFile: ".env.keys", processEnv: environment,
    quiet: true, strict: true, noOps: true, logLevel: "error" });
  assert.ok(environment.MONGO_URI);
  const state = { prefix: `videos_notification_${randomBytes(12).toString("hex")}`,
    uriHash: hash(uri), envHash: hash(readFileSync(".env")), collections: [], userId, sendRequested: false };
  mkdirSync(directory, { recursive: true });
  const save = () => {
    writeFileSync(new URL("private.tmp", directory), JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(new URL("private.tmp", directory), manifest);
  };
  save();
  const connection = mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  const recipientConnection = mongoose.createConnection(environment.MONGO_URI,
    { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  const models = {};
  const originals = { users: UserModel, videos: EditorialVideoModel, devices: NotificationDeviceModel,
    inbox: InAppNotificationModel, outbox: NotificationOutboxModel };
  const savedMethods = { distinct: NotificationDeviceModel.distinct, deleteMany: NotificationDeviceModel.deleteMany,
    findOneAndUpdate: InAppNotificationModel.findOneAndUpdate };
  const savedFirebase = Object.fromEntries(["FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_SERVICE_ACCOUNT_PATH"].map(key => [key, process.env[key]]));
  try {
    try { await Promise.all([connection.asPromise(), recipientConnection.asPromise()]); }
    catch (error) { throw new Error(`Acceptance connection failed (${error?.name || "Error"})`); }
    const recipient = new mongoose.Types.ObjectId(userId);
    const user = await recipientConnection.db.collection("users").findOne({ _id: recipient },
      { projection: { role: 1, active: 1, deletedAt: 1, account_status: 1 } });
    assert.ok(user?.role === roles.SUPER_ADMIN && user.active !== false && !user.deletedAt && user.account_status !== accountStatus.BANNED);
    const devices = await recipientConnection.db.collection("notificationdevices").find({ user: recipient },
      { projection: { token: 1, platform: 1 } }).toArray();
    const tokens = [...new Set(devices.map(device => device.token?.trim()).filter(Boolean))];
    assert.ok(tokens.length > 0 && tokens.length <= 500);
    await recipientConnection.close();
    assert.equal((await connection.db.listCollections({ name: { $regex: `^${state.prefix}_` } }).toArray()).length, 0);
    for (const [key, original] of Object.entries(originals)) {
      const name = `${state.prefix}_${original.collection.name}`;
      state.collections.push(name); save();
      await connection.db.createCollection(name, { validator: { $jsonSchema: { bsonType: "object", description: state.prefix } } });
      models[key] = connection.model(original.modelName, original.schema.clone(), name);
      await models[key].createIndexes();
    }
    await models.users.collection.insertOne({ _id: recipient, role: roles.SUPER_ADMIN, active: true });
    await models.devices.collection.insertMany(tokens.map(token => ({ user: recipient, token })));
    const videoId = new mongoose.Types.ObjectId();
    await models.videos.collection.insertOne({ _id: videoId, kind: "youtube", status: "published", youtubeId: "dQw4w9WgXcQ" });
    const repository = createPublicVideoRepository({ videos: models.videos, users: models.users, outbox: models.outbox, connection });
    const service = createPublicVideoService({ repository, isEnabled: () => true });
    const report = { id: String(videoId), identity: { type: "user", id: userId },
      body: { youtubeId: "dQw4w9WgXcQ", reason: "unavailable" } };
    assert.deepEqual(await service.reportPlayerError(report), { reported: true });
    assert.deepEqual(await service.reportPlayerError(report), { reported: true });
    assert.equal(await models.outbox.countDocuments(), 1);
    const row = await models.outbox.findOne();
    assert.equal(String(row.recipientUser), userId);
    assert.equal(row.source.domain, "videos"); assert.equal(row.source.event, "youtube_player_error");
    assert.match(row.body_en, /unverified/i);
    // Label the isolated test obligation before the authorized delivery to a real phone.
    await models.outbox.updateOne({ _id: row._id }, { $set: {
      title_en: "Petyard Videos pipeline test", title_ar: "Petyard Videos pipeline test",
      body_en: "Test of the Videos alert and notification worker. No action is needed.",
      body_ar: "Test of the Videos alert and notification worker. No action is needed." } });
    // The dispatcher uses these static models; route only these calls into real isolated collections.
    NotificationDeviceModel.distinct = (field, filter) => {
      assert.equal(field, "token"); assert.equal(String(filter.user), userId);
      return models.devices.distinct(field, filter);
    };
    NotificationDeviceModel.deleteMany = filter => models.devices.deleteMany(filter);
    InAppNotificationModel.findOneAndUpdate = (...args) => {
      assert.equal(args[0].dedupeKey, row.dedupeKey);
      return models.inbox.findOneAndUpdate(...args);
    };
    for (const key of Object.keys(savedFirebase)) if (environment[key]) process.env[key] = environment[key];
    const claimed = await claimNextNotificationOutbox({ model: models.outbox });
    assert.ok(claimed?.leaseToken); assert.equal(String(claimed.recipientUser), userId);
    state.sendRequested = true; save();
    const result = await deliverClaimedNotificationOutbox({ outbox: claimed,
      markSent: input => markNotificationOutboxSent({ ...input, model: models.outbox }),
      markRetryable: input => markNotificationOutboxRetryable({ ...input, model: models.outbox }),
      markDeadLetter: input => markNotificationOutboxDeadLetter({ ...input, model: models.outbox }) });
    state.deliveryStatus = result.status;
    state.successCount = result.result?.push?.successCount || 0;
    state.failureCount = result.result?.push?.failureCount || 0; save();
    assert.equal(result.status, "sent"); assert.equal(state.successCount, tokens.length); assert.equal(state.failureCount, 0);
    assert.equal((await models.outbox.findById(row._id)).status, "sent");
    assert.equal(await models.inbox.countDocuments({ user: recipient, dedupeKey: row.dedupeKey }), 1);
    assert.equal(await claimNextNotificationOutbox({ model: models.outbox }), null);
    console.log(JSON.stringify({ check: "videos-notification-pipeline", userId, deduplicatedReports: 2,
      outboxRecords: 1, inAppRecords: 1, acceptedPushes: state.successCount, failedPushes: state.failureCount, customerDatabaseUnchanged: true }));
  } finally {
    NotificationDeviceModel.distinct = savedMethods.distinct;
    NotificationDeviceModel.deleteMany = savedMethods.deleteMany;
    InAppNotificationModel.findOneAndUpdate = savedMethods.findOneAndUpdate;
    for (const [key, value] of Object.entries(savedFirebase)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const failures = [];
    if (connection.readyState === 1) {
      for (const name of state.collections) {
        try {
          assert.ok(name.startsWith(`${state.prefix}_`));
          const metadata = await connection.db.listCollections({ name }).toArray();
          if (!metadata.length) continue;
          assert.equal(metadata[0].options?.validator?.$jsonSchema?.description, state.prefix);
          await connection.dropCollection(name);
        } catch (error) { failures.push(error?.name || "Error"); }
      }
      try { assert.equal((await connection.db.listCollections({ name: { $regex: `^${state.prefix}_` } }).toArray()).length, 0); }
      catch (error) { failures.push("CollectionVerificationFailed"); }
    } else if (state.collections.length) failures.push("MongoUnavailable");
    await Promise.allSettled([connection.close(), recipientConnection.close(), ...getApps().map(app => deleteApp(app))]);
    state.cleanupFailures = failures; save();
    console.log(JSON.stringify({ check: "notification-pipeline-cleanup", temporaryCollections: state.collections.length, failures, envUnchanged: state.envHash === hash(readFileSync(".env")) }));
    assert.deepEqual(failures, []); assert.equal(state.envHash, hash(readFileSync(".env")));
  }
});
