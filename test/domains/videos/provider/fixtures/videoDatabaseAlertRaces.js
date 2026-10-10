import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createPublicVideoErrorPersistence } from "../../../../../src/domains/videos/public/publicVideoError.repository.js";

export async function verifyVideoDatabaseAlertRaces(t, { models, connection }) {
  const report = createPublicVideoErrorPersistence({ ...models, connection }).recordPlayerErrorAlerts;
  const recipient = new mongoose.Types.ObjectId();
  await models.users.collection.insertOne({ _id: recipient, role: "admin", active: true, enabledControls: ["videos"] });
  const createVideo = async () => {
    const id = new mongoose.Types.ObjectId();
    await models.videos.collection.insertOne({ _id: id, kind: "youtube", status: "published", youtubeId: "dQw4w9WgXcQ" });
    return { id: String(id), youtubeId: "dQw4w9WgXcQ", day: "2026-10-09",
      notification: { title_en: "Synthetic alert race", body_en: "Isolated database test; never dispatched" } };
  };
  await t.test("actual alert transactions serialize with deletion, unpublish and YouTube link changes", async () => {
    for (const change of ["delete", "unpublish", "link"]) {
      const request = await createVideo();
      const id = new mongoose.Types.ObjectId(request.id);
      const [accepted] = await Promise.all([
        report(request),
        change === "delete" ? models.videos.deleteOne({ _id: id }) : models.videos.updateOne({ _id: id },
          { $set: change === "unpublish" ? { status: "unpublished" } : { youtubeId: "M7lc1UVf-VE" } }),
      ]);
      // An alert may commit before the owner change; a later report must be refused.
      assert.equal(await report(request), false);
      assert.equal(await models.outbox.countDocuments({ "source.referenceId": request.id }), accepted ? 1 : 0);
    }
  });
  await t.test("subsequent alert decisions honor revoked controls, inactive staff and banned accounts", async () => {
    for (const change of [{ enabledControls: [] }, { enabledControls: ["videos"], active: false },
      { active: true, account_status: "banned" }]) {
      await models.users.updateOne({ _id: recipient }, { $set: change });
      const request = await createVideo();
      assert.equal(await report(request), true);
      assert.equal(await models.outbox.countDocuments({ "source.referenceId": request.id }), 0);
    }
  });
}
