import cron from "node-cron";
import { markAbandonedCartsService } from "../../domains/cart/cart.service.js";

// Runs every hour; adjusts threshold (e.g. 12h) as needed
const ABANDON_THRESHOLD_HOURS = 12;
const ABANDON_THRESHOLD_MS = ABANDON_THRESHOLD_HOURS * 60 *60 * 1000;

let initialized = false;

export function startAbandonedCartsJob() {
  if (initialized) return;
  initialized = true;

  cron.schedule("0 0,12 * * *", async () => {
    try {
      const result = await markAbandonedCartsService(ABANDON_THRESHOLD_MS);      
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[abandonedCarts.job] Marked carts as ABANDONED: matched=${result.matchedCount ?? result.matched} modified=${result.modifiedCount ?? result.modified}`
        );
      }
    } catch (err) {
      console.error("[abandonedCarts.job] Error while marking abandoned carts", err);
    }
  });
}
