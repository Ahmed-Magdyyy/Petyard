import cron from "node-cron";
import { cancelAbandonedCardOrdersService } from "../../domains/order/order.service.js";

const TIMEOUT_MINUTES = 5;

export function startAbandonedPaymentsJob() {
  // Run every minute (abandoned timeout is 5 min, so worst case ~6 min)
  cron.schedule("* * * * *", async () => {
    try {
      const { cancelledCount } =
        await cancelAbandonedCardOrdersService(TIMEOUT_MINUTES);
      if (cancelledCount > 0) {
        console.log(
          `[AbandonedPayments] Cancelled ${cancelledCount} abandoned card order(s)`,
        );
      }
    } catch (err) {
      console.error("[AbandonedPayments] Job error:", err.message);
    }
  });

  console.log(
    `[AbandonedPayments] Cron started — cancels unpaid card orders after ${TIMEOUT_MINUTES}min`,
  );
}
