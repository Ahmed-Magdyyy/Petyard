import axios from "axios";
import https from "https";

// ePushEg uses an incomplete SSL certificate chain — disable verification for this host only
const epushHttpsAgent = new https.Agent({ rejectUnauthorized: false });

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
const REDACTED_LOG_VALUE = "[redacted]";

function redactKnownValues(value, sensitiveValues) {
  if (typeof value !== "string") return value;

  return sensitiveValues.reduce((redacted, sensitiveValue) => {
    if (!sensitiveValue) return redacted;
    return redacted.split(String(sensitiveValue)).join(REDACTED_LOG_VALUE);
  }, value);
}

function sanitizeProviderResponse(responseData, sensitiveValues) {
  if (responseData == null) return null;

  if (Buffer.isBuffer(responseData)) {
    return redactKnownValues(responseData.toString("utf8"), sensitiveValues);
  }

  if (typeof responseData === "string") {
    return redactKnownValues(responseData, sensitiveValues);
  }

  if (typeof responseData === "object") {
    try {
      return JSON.parse(
        redactKnownValues(JSON.stringify(responseData), sensitiveValues),
      );
    } catch {
      return "[unserializable provider response]";
    }
  }

  return responseData;
}

function summarizeEpushError(err) {
  const responseData = err?.response?.data;
  const summary = {
    status: err?.response?.status || null,
    code: err?.code || null,
  };

  if (typeof responseData === "string") {
    summary.responseType = "string";
    if (responseData.includes("QueuePool limit")) {
      summary.providerReason = "QueuePool limit";
    }
  } else if (Array.isArray(responseData)) {
    summary.responseType = "array";
  } else if (responseData && typeof responseData === "object") {
    summary.responseType = "object";
  } else if (responseData != null) {
    summary.responseType = typeof responseData;
  }

  return summary;
}

function buildEpushFailureLog({ err, attempt, maxRetries, sensitiveValues }) {
  return {
    attempt,
    maxRetries,
    ...summarizeEpushError(err),
    clientError: redactKnownValues(err?.message || null, sensitiveValues),
    providerResponse: sanitizeProviderResponse(
      err?.response?.data,
      sensitiveValues,
    ),
  };
}

function createSmsProviderError(err) {
  const summary = summarizeEpushError(err);
  const label =
    summary.status || summary.code || summary.providerReason || "provider_error";

  const error = new Error(`Failed to send OTP SMS (${label})`);
  error.name = "SmsProviderError";
  error.code = "EPUSH_REQUEST_FAILED";
  error.providerStatus = summary.status;
  error.providerCode = summary.code;
  if (summary.providerReason) {
    error.providerReason = summary.providerReason;
  }

  return error;
}

export async function sendOtpSms(phone, code) {
  const { epush_username, epush_password, epush_api_key } = process.env;

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

  const sensitiveLogValues = [
    epush_username,
    epush_password,
    epush_api_key,
    params.message,
    String(code).slice(0, 10),
    mobile,
  ];

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(EPUSH_BASE_URL, {
        params,
        httpsAgent: epushHttpsAgent,
        timeout: 15000, // 15s timeout per attempt
      });

      // ePush returns { new_msg_id, transaction_price, net_balance } on success
      if (!data?.new_msg_id) {
        const error = new Error("ePush response missing message id");
        error.code = "EPUSH_UNEXPECTED_RESPONSE";
        error.response = { status: 200, data };
        throw error;
      }

      return; // success — exit
    } catch (err) {
      const status = err?.response?.status;
      const responseData = err?.response?.data || "";
      const isPoolExhausted =
        typeof responseData === "string" &&
        responseData.includes("QueuePool limit");

      // Retry on: 5xx, network/timeout errors, or ePush pool exhaustion (returns 401)
      const isRetryable =
        !status ||
        status >= 500 ||
        isPoolExhausted ||
        err?.code === "ECONNABORTED" ||
        err?.code === "ECONNRESET";

      if (isRetryable && attempt < MAX_RETRIES) {
        const delayMs = attempt * 1000; // 1s, 2s
        console.warn(
          "ePush attempt failed, retrying",
          {
            ...buildEpushFailureLog({
              err,
              attempt,
              maxRetries: MAX_RETRIES,
              sensitiveValues: sensitiveLogValues,
            }),
            retryInMs: delayMs,
          },
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // Final attempt or non-retryable error — give up
      console.error(
        "ePush request failed",
        buildEpushFailureLog({
          err,
          attempt,
          maxRetries: MAX_RETRIES,
          sensitiveValues: sensitiveLogValues,
        }),
      );
      throw createSmsProviderError(err);
    }
  }
}
