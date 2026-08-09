import { paymentMethodEnum } from "../../shared/constants/enums.js";
import { isOrderSubstitutionEnabledForWarehouse } from "./substitution.config.js";

export function hasPreAwardedCardLoyalty(order) {
  return Boolean(order?.user) &&
    order?.paymentMethod === paymentMethodEnum.CARD &&
    Number(order?.loyaltyPointsAwarded || 0) > 0;
}

export function shouldDeferCardLoyaltyUntilAcceptance(
  order,
  { isSubstitutionEnabled = isOrderSubstitutionEnabledForWarehouse } = {},
) {
  return (
    order?.paymentMethod === paymentMethodEnum.CARD &&
    isSubstitutionEnabled(order?.warehouse)
  );
}
