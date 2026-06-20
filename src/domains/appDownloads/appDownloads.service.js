import fs from "fs";
import zlib from "zlib";
import jwt from "jsonwebtoken";
import { DateTime } from "luxon";
import { GoogleAuth } from "google-auth-library";
import { AppDownloadMetricModel } from "./appDownloadMetric.model.js";

const EGYPT_ZONE = "Africa/Cairo";
const GOOGLE_SOURCE = "google_play";
const APPLE_SOURCE = "app_store_connect";
const ANDROID_METRIC = "daily_user_installs";
const IOS_METRIC = "app_units";

function splitList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDefaultSyncWindow() {
  const lookbackDays = Number(process.env.APP_DOWNLOAD_SYNC_LOOKBACK_DAYS || 14);
  const safeLookbackDays = Number.isFinite(lookbackDays) && lookbackDays > 0
    ? lookbackDays
    : 14;
  const today = DateTime.now().setZone(EGYPT_ZONE).startOf("day");

  return {
    from: today.minus({ days: safeLookbackDays }).toISODate(),
    to: today.toISODate(),
  };
}

function normalizeDateKey(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const isoDate = DateTime.fromISO(str, {
    zone: EGYPT_ZONE,
    setZone: str.includes("T"),
  });
  if (isoDate.isValid) return isoDate.setZone(EGYPT_ZONE).toISODate();

  const appleDate = DateTime.fromFormat(str, "M/d/yyyy", { zone: "UTC" });
  if (appleDate.isValid) return appleDate.toISODate();

  const appleDatePadded = DateTime.fromFormat(str, "MM/dd/yyyy", {
    zone: "UTC",
  });
  return appleDatePadded.isValid ? appleDatePadded.toISODate() : null;
}

function dateKeyToUtcDate(dateKey) {
  const dt = DateTime.fromISO(dateKey, { zone: "UTC" }).startOf("day");
  return dt.toJSDate();
}

function buildDateKeyRange({ from, to } = {}) {
  if (!from || !to) return {};
  const fromKey = normalizeDateKey(from);
  const toKey = normalizeDateKey(to);
  if (!fromKey || !toKey) return {};
  return { fromKey, toKey };
}

function isDateKeyInRange(dateKey, range) {
  if (!range.fromKey || !range.toKey) return true;
  return dateKey >= range.fromKey && dateKey <= range.toKey;
}

function monthKeysInRange(range) {
  if (!range.fromKey || !range.toKey) return null;

  let cursor = DateTime.fromISO(range.fromKey, { zone: "UTC" }).startOf(
    "month",
  );
  const end = DateTime.fromISO(range.toKey, { zone: "UTC" }).startOf("month");
  const months = new Set();

  while (cursor <= end) {
    months.add(cursor.toFormat("yyyyLL"));
    cursor = cursor.plus({ months: 1 });
  }

  return months;
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseDelimited(text, delimiter) {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) return [];

  const headers = parseDelimitedLine(lines[0], delimiter).map((header) =>
    header.trim(),
  );

  return lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    return headers.reduce((doc, header, index) => {
      doc[header] = values[index] == null ? "" : values[index].trim();
      return doc;
    }, {});
  });
}

function decodeReportBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  const probeLength = Math.min(buffer.length, 200);
  let nullBytes = 0;
  for (let i = 0; i < probeLength; i += 1) {
    if (buffer[i] === 0) nullBytes += 1;
  }

  return nullBytes > probeLength / 4
    ? buffer.toString("utf16le")
    : buffer.toString("utf8");
}

function parseNumber(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

async function upsertDownloadRecords(records) {
  if (records.length === 0) return { matched: 0, modified: 0, upserted: 0 };

  const result = await AppDownloadMetricModel.bulkWrite(
    records.map((record) => ({
      updateOne: {
        filter: {
          platform: record.platform,
          source: record.source,
          metric: record.metric,
          dateKey: record.dateKey,
        },
        update: { $set: record },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return {
    matched: result.matchedCount || 0,
    modified: result.modifiedCount || 0,
    upserted: result.upsertedCount || 0,
  };
}

function getGoogleReportConfig() {
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const bucket = String(process.env.GOOGLE_PLAY_REPORT_BUCKET || "").replace(
    /^gs:\/\//,
    "",
  );
  const prefix = process.env.GOOGLE_PLAY_INSTALLS_PREFIX || "stats/installs/";
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!packageName || !bucket || !credentials) {
    return null;
  }

  return { packageName, bucket, prefix, credentials };
}

async function getGoogleStorageClient(credentials) {
  const auth = new GoogleAuth({
    keyFile: credentials,
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });

  return auth.getClient();
}

async function listGoogleOverviewReports({ client, bucket, prefix, packageName }) {
  const objectPrefix = `${prefix}installs_${packageName}_`;
  const names = [];
  let pageToken;

  do {
    const response = await client.request({
      url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
        bucket,
      )}/o`,
      params: {
        prefix: objectPrefix,
        maxResults: 1000,
        ...(pageToken ? { pageToken } : {}),
      },
    });

    for (const item of response.data.items || []) {
      if (item.name.endsWith("_overview.csv")) names.push(item.name);
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return names.sort();
}

async function readGoogleObject({ client, bucket, name }) {
  const response = await client.request({
    url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
      bucket,
    )}/o/${encodeURIComponent(name)}`,
    params: { alt: "media" },
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data);
}

function extractMonthFromGoogleReportName(name) {
  const match = String(name).match(/_(\d{6})_overview\.csv$/);
  return match ? match[1] : null;
}

export async function syncGooglePlayDownloads({ from, to } = {}) {
  const config = getGoogleReportConfig();
  if (!config) {
    return { platform: "android", skipped: true, reason: "missing_config" };
  }

  const range = buildDateKeyRange({ from, to });
  const allowedMonths = monthKeysInRange(range);
  const client = await getGoogleStorageClient(config.credentials);
  const reportNames = await listGoogleOverviewReports({
    client,
    bucket: config.bucket,
    prefix: config.prefix,
    packageName: config.packageName,
  });

  const records = [];
  for (const reportName of reportNames) {
    const reportMonth = extractMonthFromGoogleReportName(reportName);
    if (allowedMonths && !allowedMonths.has(reportMonth)) continue;

    const buffer = await readGoogleObject({
      client,
      bucket: config.bucket,
      name: reportName,
    });
    const rows = parseDelimited(decodeReportBuffer(buffer), ",");

    for (const row of rows) {
      const dateKey = normalizeDateKey(row.Date);
      if (!dateKey || !isDateKeyInRange(dateKey, range)) continue;
      if (row["Package name"] !== config.packageName) continue;

      records.push({
        platform: "android",
        source: GOOGLE_SOURCE,
        metric: ANDROID_METRIC,
        dateKey,
        date: dateKeyToUtcDate(dateKey),
        downloads: parseNumber(row["Daily User Installs"]),
        reportName,
        raw: {
          dailyDeviceInstalls: parseNumber(row["Daily Device Installs"]),
          dailyUserInstalls: parseNumber(row["Daily User Installs"]),
          activeDeviceInstalls: parseNumber(row["Active Device Installs"]),
          installEvents: parseNumber(row["Install events"]),
        },
      });
    }
  }

  const writeResult = await upsertDownloadRecords(records);
  return {
    platform: "android",
    reports: reportNames.length,
    records: records.length,
    ...writeResult,
  };
}

function getAppleReportConfig() {
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID;
  const privateKeyPath = process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH;
  const vendorNumber = process.env.APP_STORE_VENDOR_NUMBER;
  const appSku = process.env.APP_STORE_APP_SKU;
  const appleId = process.env.APP_STORE_APP_APPLE_ID;

  if (!issuerId || !keyId || !privateKeyPath || !vendorNumber) {
    return null;
  }

  return {
    issuerId,
    keyId,
    privateKeyPath,
    vendorNumber,
    appSku,
    appleId,
    downloadProductTypeIds: new Set(
      splitList(process.env.APP_STORE_DOWNLOAD_PRODUCT_TYPE_IDS, ["1", "1F"]),
    ),
  };
}

function createAppleJwt(config) {
  const privateKey = fs.readFileSync(config.privateKeyPath, "utf8");
  return jwt.sign(
    {
      iss: config.issuerId,
      aud: "appstoreconnect-v1",
    },
    privateKey,
    {
      algorithm: "ES256",
      keyid: config.keyId,
      expiresIn: "20m",
    },
  );
}

async function fetchAppleSalesReport({ config, token, dateKey }) {
  const reportDate = DateTime.fromISO(dateKey, { zone: "UTC" }).toISODate();
  const params = new URLSearchParams();
  params.set("filter[frequency]", "DAILY");
  params.set("filter[reportDate]", reportDate);
  params.set("filter[reportSubType]", "SUMMARY");
  params.set("filter[reportType]", "SALES");
  params.set("filter[vendorNumber]", config.vendorNumber);

  const response = await fetch(
    `https://api.appstoreconnect.apple.com/v1/salesReports?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const buffer = Buffer.from(await response.arrayBuffer());

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Apple sales report ${reportDate} failed with ${response.status}: ${buffer
        .toString("utf8")
        .slice(0, 300)}`,
    );
  }

  return zlib.gunzipSync(buffer).toString("utf8");
}

function appleRowMatchesApp(row, config) {
  const rowSku = row.SKU;
  const rowAppleId = row["Apple Identifier"];

  if (config.appleId && rowAppleId === String(config.appleId)) return true;
  if (config.appSku && rowSku === config.appSku) return true;
  return false;
}

function sumAppleDownloads(text, config) {
  if (!text) return 0;

  const rows = parseDelimited(text, "\t");
  return rows.reduce((sum, row) => {
    if (!appleRowMatchesApp(row, config)) return sum;
    if (!config.downloadProductTypeIds.has(row["Product Type Identifier"])) {
      return sum;
    }
    return sum + parseNumber(row.Units);
  }, 0);
}

function eachDateKey({ fromKey, toKey }) {
  const keys = [];
  let cursor = DateTime.fromISO(fromKey, { zone: "UTC" }).startOf("day");
  const end = DateTime.fromISO(toKey, { zone: "UTC" }).startOf("day");

  while (cursor <= end) {
    keys.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }

  return keys;
}

export async function syncAppStoreDownloads({ from, to } = {}) {
  const config = getAppleReportConfig();
  if (!config) {
    return { platform: "ios", skipped: true, reason: "missing_config" };
  }

  const defaultWindow = getDefaultSyncWindow();
  const range = buildDateKeyRange({
    from: from || defaultWindow.from,
    to: to || defaultWindow.to,
  });
  const token = createAppleJwt(config);
  const records = [];
  const errors = [];

  for (const dateKey of eachDateKey(range)) {
    try {
      const report = await fetchAppleSalesReport({ config, token, dateKey });
      const downloads = sumAppleDownloads(report, config);

      records.push({
        platform: "ios",
        source: APPLE_SOURCE,
        metric: IOS_METRIC,
        dateKey,
        date: dateKeyToUtcDate(dateKey),
        downloads,
        reportName: `salesReports:${dateKey}`,
        raw: {
          productTypeIds: Array.from(config.downloadProductTypeIds),
        },
      });
    } catch (err) {
      errors.push({ dateKey, message: err.message });
    }
  }

  const writeResult = await upsertDownloadRecords(records);
  return {
    platform: "ios",
    records: records.length,
    errors,
    ...writeResult,
  };
}

export async function syncAppDownloadsService({
  from,
  to,
  platform = "all",
} = {}) {
  const defaultWindow = getDefaultSyncWindow();
  const syncFrom = from || defaultWindow.from;
  const syncTo = to || defaultWindow.to;

  const results = {};

  if (platform === "all" || platform === "android") {
    results.android = await syncGooglePlayDownloads({
      from: syncFrom,
      to: syncTo,
    });
  }

  if (platform === "all" || platform === "ios") {
    results.ios = await syncAppStoreDownloads({ from: syncFrom, to: syncTo });
  }

  return {
    from: syncFrom,
    to: syncTo,
    results,
  };
}

export async function getAppDownloadsStatsService({ from, to } = {}) {
  const range = buildDateKeyRange({ from, to });
  const dateMatch =
    range.fromKey && range.toKey
      ? { dateKey: { $gte: range.fromKey, $lte: range.toKey } }
      : {};

  const [overallDownloads, inRangeDownloads] = await Promise.all([
    aggregateDownloadTotals(),
    aggregateDownloadTotals(dateMatch),
  ]);

  return {
    overallDownloads,
    inRangeDownloads,
  };
}

async function aggregateDownloadTotals(match = {}) {
  const summary = {
    total: 0,
    android: 0,
    ios: 0,
  };

  const platformDocs = await AppDownloadMetricModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$platform",
        downloads: { $sum: "$downloads" },
      },
    },
  ]);

  for (const { _id, downloads } of platformDocs) {
    if (_id === "android" || _id === "ios") {
      summary[_id] = downloads || 0;
      summary.total += downloads || 0;
    }
  }

  return summary;
}
