import { loadAssistantConfig, requireEnabled } from "./shared/assistant.config.js";
import { AssistantRun } from "./shared/assistant.models.js";
import { customerRunFilter, isCustomerRun, runPurposes } from "./shared/assistant.purpose.js";
import { processAssistantRun, recoverAssistantRuns } from "./customer/assistant.worker.service.js";
import { processBusinessPlan, recoverBusinessPlans } from "./admin/assistant.admin-worker.js";
import { processBusinessReports, recoverBusinessReports } from "./admin/assistant.admin-reports.js";
import { enqueueWeeklyBundleGeneration, processBundleGeneration, recoverBundleGenerations } from "./bundles/assistant.bundle-worker.js";
import { loadReferenceConfig, loadReferenceIndexingConfig } from "./references/assistant.reference-config.js";
import { referenceWorker } from "./references/assistant.reference-worker.js";
import { catalogIndexer } from "./products/assistant.catalog-indexer.js";

export async function drainAssistantWork(options = {}) {
  const config = (options.getConfig ?? loadAssistantConfig)();
  let bookingNotifications;
  let bookingRetention;
  let queryVectorRetention;
  if (config.referenceRetentionEnabled === true || config.catalogSemanticEnabled === true) {
    try {
      const { removeExpiredQueryVectors } = await import("./customer/assistant.query-embedding.js");
      queryVectorRetention = await removeExpiredQueryVectors(config);
    } catch { queryVectorRetention = { enabled: true, removed: 0, failed: 1 }; }
  }
  if (config.bookingRetentionEnabled === true) {
    try {
      const { removeExpiredBookingReviews } = await import("./customer/assistant.booking-lifecycle.js");
      bookingRetention = await removeExpiredBookingReviews(config);
    } catch { bookingRetention = { enabled: true, removed: 0, confirmed: 0, failed: 1 }; }
  }
  if (!config.enabled) return { enabled: false, processed: 0, failed: (bookingRetention?.failed ?? 0) + (queryVectorRetention?.failed ?? 0),
    ...(queryVectorRetention ? { queryVectorRetention } : {}),
    ...(bookingRetention ? { bookingRetention } : {}) };
  requireEnabled(config);
  if (config.bookingNotificationsEnabled === true) {
    try {
      const { drainBookingNotifications } = await import("./customer/assistant.booking-notifications.js");
      bookingNotifications = await drainBookingNotifications(config);
    }
    catch { bookingNotifications = { enabled: true, processed: 0, queued: 0, deferred: 0, failed: 1 }; }
  }
  await recoverAssistantRuns(config);
  await recoverBusinessPlans(config);
  await recoverBusinessReports(config);
  await recoverBundleGenerations(config);
  let bundleGeneration;
  try { bundleGeneration = await enqueueWeeklyBundleGeneration(config); }
  catch { bundleGeneration = { enabled: true, failed: 1 }; }
  const candidates = await AssistantRun.find({ $or: [customerRunFilter({ status: "queued" }),
    { purpose: runPurposes.adminBusiness, status: "queued", phase: { $in: ["plan", "reports"] } },
    ...(config.bundleGenerationEnabled === true ? [{ purpose: runPurposes.automaticBundles, status: "queued" }] : [])] })
    .sort({ createdAt: 1 }).limit(25).select("_id purpose phase").maxTimeMS(5000).lean();
  let failed = (bookingNotifications?.failed ?? 0) + (bookingRetention?.failed ?? 0) + (bundleGeneration?.failed ?? 0) + (queryVectorRetention?.failed ?? 0);
  for (const candidate of candidates) {
    try {
      if (isCustomerRun(candidate)) await processAssistantRun(candidate._id, options);
      else if (candidate.purpose === runPurposes.automaticBundles) await processBundleGeneration(candidate._id, options);
      else if (candidate.phase === "reports") await processBusinessReports(candidate._id, options);
      else {
        const result = await processBusinessPlan(candidate._id, options);
        if (result.phase === "reports") await processBusinessReports(candidate._id, options);
      }
    } catch { failed++; } // Durable per-run recovery must not prevent another owner's queued work from being processed.
  }
  let references;
  try {
    const referenceConfig = (options.getReferenceConfig ?? loadReferenceConfig)();
    if (referenceConfig.enabled) {
      let indexing;
      try { indexing = (options.getReferenceIndexingConfig ?? loadReferenceIndexingConfig)(referenceConfig, config); }
      catch { indexing = { enabled: false }; failed++; }
      references = referenceWorker.start(referenceConfig, { shared: config, indexing });
    }
  } catch { references = { enabled: true, failed: 1 }; failed++; }
  const catalogIndexing = catalogIndexer.start(config);
  return { enabled: true, processed: candidates.length, failed, ...(catalogIndexing.enabled ? { catalogIndexing } : {}), ...(references ? { references } : {}), ...(bookingNotifications ? { bookingNotifications } : {}),
    ...(queryVectorRetention ? { queryVectorRetention } : {}),
    ...(bookingRetention ? { bookingRetention } : {}) };
}
