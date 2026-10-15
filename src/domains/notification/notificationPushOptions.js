import crypto from "node:crypto";

export function buildStaffAlertPushOptions() {
  return {
    android: {
      channelId: "petyard_notification_channel_v7",
      sound: "petyard_songe",
      priority: "max",
      defaultVibrateTimings: true,
      visibility: "public",
      tag: `reservation_${crypto.randomUUID()}`,
    },
    apns: {
      sound: "petyardSonge.caf",
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
    },
  };
}
