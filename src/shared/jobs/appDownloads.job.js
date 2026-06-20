import cron from "node-cron";
import { syncAppDownloadsService } from "../../domains/appDownloads/appDownloads.service.js";

let initialized = false;

async function runAppDownloadsSync(reason) {
  try {
    const result = await syncAppDownloadsService();
    console.log(
      `[appDownloads.job] Sync complete (${reason}): ${JSON.stringify(result)}`,
    );
  } catch (err) {
    console.error("[appDownloads.job] Sync error:", err.message);
  }
}

export function startAppDownloadsJob() {
  if (initialized) return;
  initialized = true;

  if (process.env.APP_DOWNLOAD_SYNC_ON_STARTUP !== "false") {
    setTimeout(() => {
      runAppDownloadsSync("startup");
    }, 15_000);
  }

  // Daily at 8:30 AM Cairo time. Reports can arrive late, so the service re-syncs
  // the recent lookback window instead of only yesterday.
  cron.schedule(
    "30 8 * * *",
    async () => {
      await runAppDownloadsSync("daily");
    },
    { timezone: "Africa/Cairo" },
  );

  console.log("[appDownloads.job] Cron started");
}
