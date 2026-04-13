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

  throw new Error("Invalid Egyptian mobile format");
}

const EPUSH_BASE_URL = "https://api.epusheg.com/api/v2/send_bulk";

export async function sendOtpSms(phone, code) {
  const {
    epush_username,
    epush_password,
    epush_api_key,
  } = process.env;

  if (!epush_username || !epush_password || !epush_api_key) {
    console.error("ePush credentials are not configured");
    throw new Error("SMS provider not configured");
  }

  const mobile = normalizeEgyptianMobile(phone);

  const params = {
    username: epush_username,
    password: epush_password,
    api_key: epush_api_key,
    message: `your Petyard OTP code is: ${String(code).slice(0, 10)}`,
    from: "Petyard",
    to: mobile,
  };

  try {
    const { data } = await axios.get(EPUSH_BASE_URL, { params });

    // ePush returns { new_msg_id, transaction_price, net_balance } on success
    if (!data?.new_msg_id) {
      console.error("ePush error response", data);
      throw new Error("Failed to send OTP SMS");
    }
  } catch (err) {
    console.error(
      "ePush request error",
      err.response?.data || err.message || err
    );
    throw err;
  }
}
