import axios from "axios";

export function normalizeEgyptianMobile(phone) {
  const trimmed = String(phone).trim();

  if (trimmed.startsWith("+20")) {
    return trimmed.replace("+20", "20");
  }

  if (trimmed.startsWith("20")) {
    return trimmed;
  }

  if (trimmed.startsWith("0")) {
    return `20${trimmed.slice(1)}`;
  }

  // As a fallback, assume caller passed a national number without 0
  // e.g. 10XXXXXXXX -> 2010XXXXXXXX
  if (/^1[0-9]{9}$/.test(trimmed)) {
    return `20${trimmed}`;
  }

  throw new Error("Invalid Egyptian mobile format for SMS Misr");
}

export async function sendOtpSms(phone, code) {
  const {
    SMS_API_USERNAME,
    SMS_API_PASSWORD,
    SMS_API_URL,
    SMS_API_SENDER,
    SMS_API_TEMPLATE,
    SMS_API_ENVIRONMENT,
  } = process.env;


  if (!SMS_API_USERNAME || !SMS_API_PASSWORD || !SMS_API_URL) {
    console.error("SMS Misr credentials or URL are not configured");
    throw new Error("SMS provider not configured");
  }

  const environment = SMS_API_ENVIRONMENT || "2"; // 1 Live, 2 Test
  const sender = SMS_API_SENDER;
  const template = SMS_API_TEMPLATE;

  if (!sender || !template) {
    console.error("SMS Misr sender or template token is not configured");
    throw new Error("SMS provider not fully configured");
  }

  const mobile = normalizeEgyptianMobile(phone);

  const params = {
    environment,
    username: SMS_API_USERNAME,
    password: SMS_API_PASSWORD,
    sender,
    mobile,
    template,
    otp: String(code).slice(0, 10),
  };

  try {
    const { data } = await axios.post(SMS_API_URL, null, { params });

    if (data?.Code !== "4901") {
      console.error("SMS Misr error response", data);
      throw new Error("Failed to send OTP SMS");
    }
  } catch (err) {
    console.error(
      "SMS Misr request error",
      err.response?.data || err.message || err
    );
    throw err;
  }
}
