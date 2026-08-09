import assert from "node:assert/strict";
import test from "node:test";

import { paymentMethodEnum } from "../../../src/shared/constants/enums.js";
import {
  hasPreAwardedCardLoyalty,
  shouldDeferCardLoyaltyUntilAcceptance,
} from "../../../src/domains/substitution/substitution.loyalty.js";

test("feature-enabled card orders defer loyalty until acceptance", () => {
  const order = {
    paymentMethod: paymentMethodEnum.CARD,
    warehouse: "warehouse-1",
  };

  assert.equal(
    shouldDeferCardLoyaltyUntilAcceptance(order, {
      isSubstitutionEnabled: (warehouse) => warehouse === "warehouse-1",
    }),
    true,
  );
  assert.equal(
    shouldDeferCardLoyaltyUntilAcceptance(order, {
      isSubstitutionEnabled: () => false,
    }),
    false,
  );
});

test("legacy card orders with pre-awarded points require reconciliation", () => {
  assert.equal(
    hasPreAwardedCardLoyalty({
      user: "user-1",
      paymentMethod: paymentMethodEnum.CARD,
      loyaltyPointsAwarded: 25,
    }),
    true,
  );
  assert.equal(
    hasPreAwardedCardLoyalty({
      user: "user-1",
      paymentMethod: paymentMethodEnum.INSTAPAY,
      loyaltyPointsAwarded: 25,
    }),
    false,
  );
});
