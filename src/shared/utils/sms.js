import axios from "axios";

export function normalizeEgyptianMobile(phone) {
  const trimmed = String(phone).trim();

  const localPattern = /^0(10|11|12|15)\d{8}$/;
  const intlPattern = /^20(10|11|12|15)\d{8}$/;
  const plusIntlPattern = /^\+20(10|11|12|15)\d{8}$/;
  const noLeadingPattern = /^(10|11|12|15)\d{8}$/;

  if (plusIntlPattern.test(trimmed)) {
    return trimmed.replace("+", "");
  }

  if (intlPattern.test(trimmed)) {
    return trimmed;
  }

  if (localPattern.test(trimmed)) {
    return `20${trimmed.slice(1)}`;
  }

  if (noLeadingPattern.test(trimmed)) {
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
