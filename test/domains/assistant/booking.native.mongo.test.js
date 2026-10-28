import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { bookingNativeOptIn, validateBookingNativePlan, claimBookingNativeDatabase, inspectBookingNativeDatabase,
  cleanupBookingNativeDatabase, installBookingNativeWriteGuard } from "./fixtures/bookingNativeTarget.js";

test("owned isolated native booking acceptance", { skip: process.env.ASSISTANT_BOOKING_NATIVE_TEST !== bookingNativeOptIn && "Prepared only; explicit isolated-database setup/run/cleanup approval required", timeout: 600000 }, async t => {
  const plan = validateBookingNativePlan(JSON.parse(await fs.readFile(process.env.ASSISTANT_BOOKING_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_BOOKING_NATIVE_URI, sharedMongoConfirmation);
  assert.equal(process.env.REDIS_URL, undefined);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const refuse = () => { throw Error("External HTTP is outside native booking acceptance"); };
  t.mock.method(globalThis, "fetch", refuse); t.mock.method(http, "request", refuse); t.mock.method(https, "request", refuse);
  let claimed = false;
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
      retryWrites: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    await claimBookingNativeDatabase(mongoose.connection, plan); claimed = true;
    const guard = installBookingNativeWriteGuard(t, mongoose.connection, plan);
    const api = await import("../../../src/domains/assistant/customer/assistant.booking-proposals.js");
    const { removeExpiredBookingReviews } = await import("../../../src/domains/assistant/customer/assistant.booking-lifecycle.js");
    const { drainBookingNotifications } = await import("../../../src/domains/assistant/customer/assistant.booking-notifications.js");
    const { getBookingLiveStatus } = await import("../../../src/domains/assistant/customer/assistant.booking-status.js");
    const { testConfig } = await import("./fixtures/foundationPolicy.js");
    const models = mongoose.models, selected = Object.values(models).filter(model => plan.collections.includes(model.collection.name));
    assert.equal(selected.length, 18);
    for (const model of selected) { await model.createCollection(); await model.createIndexes(); }
    const db = mongoose.connection.db, config = { ...testConfig({ rateMax: 1000, timeoutMs: 30000 }),
      bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true, bookingNotificationsEnabled: true };
    const oid = () => new mongoose.Types.ObjectId(), now = () => new Date();
    const insert = async (name, value) => { await db.collection(name).insertOne({ ...value, fixtureRun: plan.run }); return value; };
    await insert("warehouses", { _id: oid(), code: "ALEXO03", name: "Native fixture", governorate: "alexandria", active: true,
      isDefault: true, fulfillment: { status: "OPERATIONAL" }, defaultShippingPrice: 0, __v: 0 });
    for (const type of ["CLINIC", "GROOMING", "SHOWERING"]) await insert("servicecatalogs", { _id: oid(), type, name_en: type, name_ar: type,
      isActive: true, options: [{ key: "standard", name_en: "Standard", name_ar: "اختيار", price: 75 }], __v: 0 });
    let serial = 0;
    const actor = async branchId => {
      const index = ++serial, owner = oid(), pet = oid(), branch = branchId ?? oid();
      await insert("users", { _id: owner, name: `Native fixture ${index}`, phone: `+200000000${index}`, role: "user", active: true,
        phoneVerified: true, deletedAt: null, account_status: "confirmed", __v: 0 });
      await insert("pets", { _id: pet, petOwner: owner, name: `Fixture pet ${index}`, type: "cat", gender: "male",
        birthDate: new Date("2023-01-01"), chronic_conditions: [], temp_health_issues: [], __v: 0 });
      await insert("assistantaccounts", { _id: oid(), owner, blocked: false, restrictionVersion: 0, __v: 0 });
      await insert("assistantchats", { _id: oid(), owner, activeSubject: `pet:${pet}`, contextVersion: 0, nextSequence: 0, subjects: [], __v: 0 });
      if (!branchId) await insert("servicelocations", { _id: branch, slug: `native-${index}`, name_en: `Fixture branch ${index}`, name_ar: "الفرع",
        city: "Alexandria", timezone: "Africa/Cairo", active: true, capacityByRoomType: { groomingRoom: 1, clinicRoom: 1 }, __v: 0 });
      return { owner, pet, branch, index };
    };
    const location = { governorateCode: "alexandria", areaCode: "smouha" };
    const prepare = async (a, extras = {}, expiresAt = new Date(Date.now() + 600000)) => {
      const body = { language: "en", location, booking: { locationId: String(a.branch), petId: String(a.pet),
        date: DateTime.now().setZone("Africa/Cairo").plus({ days: 2 }).toISODate(), hour24: 14,
        serviceType: "CLINIC", serviceOptionKey: "standard", ...extras } };
      const result = await api.prepareBookingProposal(a.owner, body, `native-review-${a.index}`, config, { expiresAt });
      return result.proposal;
    };
    const confirm = (a, proposal) => api.confirmBookingProposal(a.owner, proposal.id,
      { expectedVersion: proposal.version, fingerprint: proposal.fingerprint, location }, config);
    const counts = async branch => ({ reservations: await db.collection("servicereservations").countDocuments({ location: branch }),
      inventory: await db.collection("serviceslotinventories").countDocuments({ location: branch }) });
    const casePassed = async name => { const snapshot = await inspectBookingNativeDatabase(mongoose.connection, plan);
      t.diagnostic(`booking_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`); };
    const first = await actor(); let firstProposal;
    await t.test("same proposal concurrent confirmations reserve exactly once", async () => {
      firstProposal = await prepare(first, {}, new Date(Date.now() + 120000));
      const results = await Promise.all([confirm(first, firstProposal), confirm(first, firstProposal)]);
      assert.deepEqual(results.map(row => row.duplicate).sort(), [false, true]);
      assert.equal(results[0].receipt.result.services[0].reservationId, results[1].receipt.result.services[0].reservationId);
      assert.deepEqual(await counts(first.branch), { reservations: 1, inventory: 1 });
      assert.equal((await db.collection("serviceslotinventories").findOne({ location: first.branch })).bookedCount, 1);
      await casePassed("same_proposal_once");
    });
    await t.test("different users overlap before the branch fence and only one takes the last slot", async child => {
      const a = await actor(), b = await actor(a.branch), pa = await prepare(a), pb = await prepare(b);
      const collection = models.ServiceLocation.collection, original = collection.updateOne.bind(collection);
      let arrivals = 0, release; const barrier = new Promise(resolve => { release = resolve; });
      const timer = setTimeout(() => release(), 8000); child.after(() => clearTimeout(timer));
      child.mock.method(collection, "updateOne", async (...args) => {
        if (String(args[0]._id) === String(a.branch) && arrivals < 2) { arrivals++; if (arrivals === 2) release(); await barrier; }
        return original(...args);
      });
      const results = await Promise.allSettled([confirm(a, pa), confirm(b, pb)]);
      assert.equal(arrivals, 2); assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      const rejected = results.find(row => row.status === "rejected"); assert.equal(rejected.reason.code, "booking_slot_unavailable");
      assert.deepEqual(await counts(a.branch), { reservations: 1, inventory: 1 });
      assert.equal((await db.collection("serviceslotinventories").findOne({ location: a.branch })).bookedCount, 1);
      await casePassed("last_slot_overlap");
    });
    await t.test("receipt failure rolls back both staged services and their inventory", async child => {
      const a = await actor();
      const p = await prepare(a, { serviceType: undefined, serviceOptionKey: undefined,
        services: [{ serviceType: "CLINIC", serviceOptionKey: "standard" }, { serviceType: "GROOMING", serviceOptionKey: "standard" }] });
      const old = await db.collection("pets").findOne({ _id: a.pet }); let injected = false;
      child.mock.method(models.AssistantBookingReceipt, "create", async (_docs, options) => {
        assert.equal(options.session.inTransaction(), true); injected = true; throw Error("native receipt failure injection");
      });
      await assert.rejects(confirm(a, p), /native receipt failure injection/); assert.equal(injected, true);
      assert.deepEqual(await counts(a.branch), { reservations: 0, inventory: 0 });
      assert.equal(await db.collection("assistantbookingreceipts").countDocuments({ _id: new mongoose.Types.ObjectId(p.id) }), 0);
      assert.equal((await db.collection("pets").findOne({ _id: a.pet })).__v, old.__v);
      await casePassed("receipt_failure_rollback");
    });
    await t.test("a simulated lost application reply after real commit recovers the original receipt", async child => {
      const a = await actor(), p = await prepare(a), start = mongoose.startSession.bind(mongoose); let lost = false;
      child.mock.method(mongoose, "startSession", async (...args) => {
        const session = await start(...args), withTransaction = session.withTransaction.bind(session);
        session.withTransaction = async (...parameters) => {
          const result = await withTransaction(...parameters);
          if (result?.confirmed && !result.duplicate && !lost) { lost = true; throw Error("synthetic lost application reply"); }
          return result;
        }; return session;
      });
      await assert.rejects(confirm(a, p), /synthetic lost application reply/); assert.equal(lost, true);
      assert.equal((await confirm(a, p)).duplicate, true); assert.deepEqual(await counts(a.branch), { reservations: 1, inventory: 1 });
      await casePassed("committed_reply_recovery");
    });
    await t.test("a real competing pet edit aborts the stale confirmation", async child => {
      const a = await actor(), p = await prepare(a), wrapper = models.Pet.collection, native = wrapper.collection,
        original = wrapper.updateOne.bind(wrapper); let edited = false;
      child.mock.method(wrapper, "updateOne", async (...args) => {
        if (!edited && String(args[0]._id) === String(a.pet)) {
          edited = true; await native.updateOne({ _id: a.pet }, { $set: { name: "Changed fixture pet" } });
        }
        return original(...args);
      });
      await assert.rejects(confirm(a, p), { code: "context_changed" }); assert.equal(edited, true);
      assert.deepEqual(await counts(a.branch), { reservations: 0, inventory: 0 });
      assert.equal((await db.collection("pets").findOne({ _id: a.pet })).name, "Changed fixture pet");
      await casePassed("competing_profile_edit");
    });
    await t.test("pending alerts defer without staff and concurrent drainers deduplicate outbox rows", async () => {
      const pending = await db.collection("assistantbookingreceipts").countDocuments({ notificationPending: true }); assert.equal(pending, 3);
      assert.equal((await drainBookingNotifications(config)).deferred, 3);
      await insert("users", { _id: oid(), name: "Fixture staff", role: "superAdmin", active: true, account_status: "confirmed", deletedAt: null });
      const results = await Promise.all([drainBookingNotifications(config), drainBookingNotifications(config)]);
      assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
      assert.equal(await db.collection("notificationoutboxes").countDocuments({}), 3);
      assert.equal(await db.collection("assistantbookingreceipts").countDocuments({ notificationPending: true }), 0);
      assert.equal((await drainBookingNotifications(config)).queued, 0);
      await casePassed("pending_alert_deduplication");
    });
    await t.test("owner status shows current state while foreign access remains denied", async () => {
      const before = await getBookingLiveStatus(first.owner, firstProposal.id, config); assert.equal(before.reservations[0].status, "BOOKED");
      await assert.rejects(getBookingLiveStatus(new mongoose.Types.ObjectId(), firstProposal.id, config));
      await db.collection("servicereservations").updateOne({ _id: new mongoose.Types.ObjectId(before.reservations[0].reservationId) },
        { $set: { status: "CANCELLED", cancelledAt: now() } });
      const after = await getBookingLiveStatus(first.owner, firstProposal.id, config);
      assert.equal(after.creationStatus, "confirmed"); assert.equal(after.reservations[0].status, "CANCELLED");
      await casePassed("owned_current_status");
    });
    await t.test("real review expiry and unused-detail cleanup retain retry and confirmed booking boundaries", async () => {
      const a = await actor(), p = await prepare(a, {}, new Date(Date.now() + 10000));
      const until = Math.max(Date.parse(p.expiresAt), Date.parse(firstProposal.expiresAt));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now()) + 100));
      await assert.rejects(confirm(a, p), { code: "booking_proposal_expired" });
      for (const proposal of [p, firstProposal]) await db.collection("assistantbookingproposals").updateOne({ _id: new mongoose.Types.ObjectId(proposal.id) },
        { $set: { detailsExpireAt: new Date(Math.floor((Date.now() + Date.parse(proposal.expiresAt)) / 2)) } });
      const cleanup = await removeExpiredBookingReviews(config); assert.equal(cleanup.removed, 1); assert.equal(cleanup.confirmed, 1); assert.equal(cleanup.failed, 0);
      const tombstone = await db.collection("assistantbookingproposals").findOne({ _id: new mongoose.Types.ObjectId(p.id) });
      assert.equal(tombstone.inputJson, undefined); assert.equal(tombstone.quoteJson, undefined); assert.ok(tombstone.key);
      await assert.rejects(confirm(a, p), { code: "booking_review_removed" });
      assert.equal((await api.getBookingProposalState(first.owner, firstProposal.id, config)).proposal.status, "confirmed");
      assert.deepEqual(await counts(a.branch), { reservations: 0, inventory: 0 });
      await casePassed("expiry_and_retention");
    });
    t.diagnostic(`booking_native_insert_attempts=${guard.insertAttempts()}`);
  } finally {
    try { if (claimed) { const cleanup = await cleanupBookingNativeDatabase(mongoose.connection, plan); t.diagnostic(`booking_native_cleanup=${JSON.stringify(cleanup)}`); } }
    finally { await mongoose.disconnect(); }
  }
});
