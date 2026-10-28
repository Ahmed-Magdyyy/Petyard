export async function combinedNativeModels() {
  const shared = await import("../../../../src/domains/assistant/shared/assistant.models.js");
  const { NotificationOutboxModel } = await import("../../../../src/domains/notification/notificationOutbox.model.js");
  const { AssistantCartProposal } = await import("../../../../src/domains/assistant/shared/assistant.cart-proposal.model.js");
  const { AssistantCartReceipt } = await import("../../../../src/domains/assistant/shared/assistant.cart-receipt.model.js");
  const { AssistantBookingReceipt } = await import("../../../../src/domains/assistant/shared/assistant.booking-receipt.model.js");
  const { ManualBundle } = await import("../../../../src/domains/bundle/bundle.model.js");
  const { CartModel } = await import("../../../../src/domains/cart/cart.model.js");
  const { ProductModel } = await import("../../../../src/domains/product/product.model.js");
  const { UserModel } = await import("../../../../src/domains/user/user.model.js");
  const { WarehouseModel } = await import("../../../../src/domains/warehouse/warehouse.model.js");
  const { LoyaltySettingsModel } = await import("../../../../src/domains/loyalty/loyaltySettings.model.js");
  return { ...shared, NotificationOutboxModel, AssistantCartProposal, AssistantCartReceipt, AssistantBookingReceipt,
    ManualBundle, CartModel, ProductModel, UserModel, WarehouseModel, LoyaltySettingsModel,
    indexed: [...Object.values(shared.assistantModels), shared.AssistantAdminChat, shared.AssistantAdminMessage,
      NotificationOutboxModel, AssistantCartProposal, AssistantCartReceipt, AssistantBookingReceipt, ManualBundle] };
}

export async function combinedNativeConfig(category) {
  const { loadAssistantConfig } = await import("../../../../src/domains/assistant/shared/assistant.config.js");
  const { testPolicy } = await import("./foundationPolicy.js");
  return loadAssistantConfig({ ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "fictional-not-a-key", ASSISTANT_ADMIN_ENABLED: "true",
    ASSISTANT_ADMIN_REPORT_MAX_BYTES: "65536", ASSISTANT_BUNDLE_CART_ENABLED: "true", ASSISTANT_CART_ENABLED: "true",
    ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy({ productSearchEnabled: true, timeoutMs: 30000, queueTimeoutMs: 600000,
      cartPolicy: { version: "combined-native-v1", proposalSeconds: 600, rateMax: 100, rateWindowSeconds: 60 },
      catalogClassification: { version: "combined-native-v1", foodCategoryIds: [], nonFoodCategoryIds: [String(category)], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] } })) });
}
