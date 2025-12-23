import crypto from "crypto";

export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

export function computeNextOtpSendCountToday({ lastSentAt, sendCountToday, now }) {
  let nextCount = sendCountToday || 0;

  if (lastSentAt) {
    const last = new Date(lastSentAt);
    const isSameDay =
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCDate() === now.getUTCDate();

    if (!isSameDay) {
      nextCount = 0;
    }
  }

  return nextCount;
}
