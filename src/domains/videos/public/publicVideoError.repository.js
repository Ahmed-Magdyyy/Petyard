import { roles, enabledControls, accountStatus, editorialVideoKindEnum, editorialVideoStatusEnum } from "../../../shared/constants/enums.js";
import { enqueueNotificationOutbox } from "../../notification/notificationOutbox.service.js";

export function createPublicVideoErrorPersistence({ videos, users, outbox, connection }) {
  return {
    async recordPlayerErrorAlerts({ id, youtubeId, day, notification }) {
      const session = await connection.startSession();
      let accepted = false;
      try {
        await session.withTransaction(async () => {
          accepted = false;
          // Serialize reports and fence deletion/unpublish/link edits on the same
          // owner. This private fence must not change the editorial revision.
          const video = await videos.findOneAndUpdate({ _id: id, kind: editorialVideoKindEnum.YOUTUBE,
            status: editorialVideoStatusEnum.PUBLISHED, youtubeId }, { $inc: { associationRevision: 1 } },
          { session, new: true, timestamps: false });
          if (!video) return;
          const recipients = await users.find({ active: true, deletedAt: null,
            account_status: { $ne: accountStatus.BANNED },
            $or: [{ role: roles.SUPER_ADMIN },
              { role: roles.ADMIN, enabledControls: enabledControls.VIDEOS }] })
            .session(session).select("_id").lean();
          for (const recipient of recipients) {
            const dedupeKey = `video-player-error:${id}:${youtubeId}:${day}:${recipient._id}`;
            if (await outbox.findOne({ dedupeKey }).session(session)) continue;
            await enqueueNotificationOutbox({ ...notification,
              recipientUser: recipient._id, dedupeKey,
              source: { domain: "videos", event: "youtube_player_error", referenceId: id },
              session, model: outbox });
          }
          accepted = true;
        });
      } finally { await session.endSession(); }
      return accepted;
    },
  };
}
