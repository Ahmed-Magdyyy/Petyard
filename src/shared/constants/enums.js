export const roles = Object.freeze({
  SUPER_ADMIN: "superAdmin",
  ADMIN: "admin",
  MODERATOR: "moderator",
  USER: "user",
  GUEST: "guest",
});

export const accountStatus = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  BANNED: "banned",
  DELETED: "deleted",
});

export const authProviderEnum = Object.freeze({
  SYSTEM: "SYSTEM",
  GOOGLE: "GOOGLE",
  APPLE: "APPLE",
});

export const orderStatusEnum = Object.freeze({
  AWAITING_PAYMENT: "awaiting_payment",
  PENDING: "pending",
  ACCEPTED: "accepted",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  FAILED: "failed",
  RETURNED: "returned",
});

export const paymentMethodEnum = Object.freeze({
  COD: "cod",
  CARD: "card",
  POS_ON_DELIVERY: "pos_on_delivery",
  INSTAPAY: "instapay",
});

export const FREE_SHIPPING_THRESHOLD = 3000;
export const paymentStatusEnum = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
});

export const returnStatusEnum = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

export const refundMethodEnum = Object.freeze({
  WALLET: "wallet",
  CARD: "card",
  MANUAL: "manual",
});

export const enabledControls = Object.freeze({
  ANALYTICS: "analytics",
  USERS: "users",
  CONDITIONS: "conditions",
  PETS: "pets",
  CATEGORIES: "categories",
  SUBCATEGORIES: "subcategories",
  BRANDS: "brands",
  PRODUCTS: "products",
  ORDERS: "orders",
  COUPONS: "coupons",
  BANNERS: "banners",
  COLLECTIONS: "collections",
  CARTS: "carts",
  LOYALTY_POINTS: "loyalty_points",
  NOTIFICATIONS: "notifications",
  RETURNS: "return",
  SERVICE_LOCATIONS: "service_locations",
  SERVICE_RESERVATIONS: "service_reservations",
  WALLET: "wallet",
  WAREHOUSES: "warehouses",
  HOME_LAYOUT: "home_layout",
  VIDEOS: "videos",
});

export const productTypeEnum = Object.freeze({
  SIMPLE: "SIMPLE",
  VARIANT: "VARIANT",
});

export const cartStatusEnum = Object.freeze({
  ACTIVE: "ACTIVE",
  ABANDONED: "ABANDONED",
});

export const warehouseFulfillmentStatusEnum = Object.freeze({
  OPERATIONAL: 'OPERATIONAL',
  MAINTENANCE: 'MAINTENANCE',
  CLOSED: 'CLOSED',
});

export const substitutionRequestStatusEnum = Object.freeze({
  OFFERED: 'offered',
  AWAITING_CARD_PAYMENT: 'awaiting_card_payment',
  INSTAPAY_SUBMITTED: 'instapay_submitted',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

export const orderSubstitutionStateEnum = Object.freeze({
  NONE: 'none',
  AWAITING_CUSTOMER: 'awaiting_customer',
  AWAITING_CARD_PAYMENT: 'awaiting_card_payment',
  INSTAPAY_SUBMITTED: 'instapay_submitted',
});

export const orderLineKindEnum = Object.freeze({
  ORIGINAL: 'original',
  SUBSTITUTE: 'substitute',
});

export const orderPaymentAttemptStatusEnum = Object.freeze({
  INITIALIZING: 'initializing',
  AWAITING_PAYMENT: 'awaiting_payment',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  LATE_SUCCESS_REFUND_REQUIRED: 'late_success_refund_required',
  REFUNDED: 'refunded',
});

export const refundOperationStatusEnum = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  RETRYABLE: 'retryable',
  MANUAL_REQUIRED: 'manual_required',
});

export const settlementOperationKindEnum = Object.freeze({
  WALLET_DEBIT: 'wallet_debit',
  WALLET_CREDIT: 'wallet_credit',
  CARD_CAPTURE: 'card_capture',
  CARD_REFUND: 'card_refund',
  CARD_DUE: 'card_due',
  INSTAPAY_SUBMITTED: 'instapay_submitted',
  INSTAPAY_CONFIRMED: 'instapay_confirmed',
  DELIVERY_DUE: 'delivery_due',
  REFUND_LIABILITY: 'refund_liability',
  LOYALTY_EARN: 'loyalty_earn',
  LOYALTY_REVERSAL: 'loyalty_reversal',
});

export const settlementOperationStatusEnum = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  REVERSED: 'reversed',
  FAILED: 'failed',
});

export const inventoryAuditReasonEnum = Object.freeze({
  CHECKOUT_RESERVE: 'checkout_reserve',
  SUBSTITUTION_ORIGINAL_CORRECTION: 'substitution_original_correction',
  SUBSTITUTION_RESERVE: 'substitution_reserve',
  SUBSTITUTION_RELEASE: 'substitution_release',
  CANCEL_RESTORE: 'cancel_restore',
  RETURN_RESTORE: 'return_restore',
});

export const notificationOutboxStatusEnum = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENT: 'sent',
  RETRYABLE: 'retryable',
  DEAD_LETTER: 'dead_letter',
});

export const serviceTypeEnum = Object.freeze({
  GROOMING: "GROOMING",
  SHOWERING: "SHOWERING",
  CLINIC: "CLINIC",
  BOARDING: "BOARDING",
});

export const serviceRoomTypeEnum = Object.freeze({
  GROOMING_ROOM: "GROOMING_ROOM",
  CLINIC_ROOM: "CLINIC_ROOM",
});

export const serviceReservationStatusEnum = Object.freeze({
  BOOKED: "BOOKED",
  IN_PROGRESS: "IN_PROGRESS",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
  NO_SHOW: "NO_SHOW",
});

// Videos lifecycles are separate even when their persisted values overlap.
export const editorialVideoKindEnum = Object.freeze({
  YOUTUBE: "youtube",
  REEL: "reel",
});

export const editorialVideoStatusEnum = Object.freeze({
  DRAFT: "draft",
  IN_REVIEW: "in_review",
  APPROVED: "approved",
  PUBLISHED: "published",
  UNPUBLISHED: "unpublished",
});

export const editorialReviewStatusEnum = Object.freeze({
  DRAFT: "draft",
  IN_REVIEW: "in_review",
  REJECTED: "rejected",
});

export const videoAssetOwnerTypeEnum = Object.freeze({
  REEL: "reel",
  PRODUCT_VIDEO: "product_video",
});

export const videoAssetTechnicalStateEnum = Object.freeze({
  AWAITING_UPLOAD: "awaiting_upload",
  PROCESSING: "processing",
  READY: "ready",
  FAILED: "failed",
  DELETING: "deleting",
  DELETED: "deleted",
});

export const editorialCoverStateEnum = Object.freeze({
  UPLOADING: "uploading",
  UPLOADED: "uploaded",
  ATTACHED: "attached",
  DELETING: "deleting",
  DELETED: "deleted",
});

export const productVideoLifecycleStateEnum = Object.freeze({
  RESERVING: "reserving",
  AWAITING_UPLOAD: "awaiting_upload",
  PROCESSING: "processing",
  READY: "ready",
  DELETING: "deleting",
  FAILED: "failed",
  REMOVED: "removed",
});

export const productVideoUploadBatchStatusEnum = Object.freeze({
  RESERVING: "reserving",
  ISSUED: "issued",
  FAILED: "failed",
});

export const productVideoReplacementStatusEnum = Object.freeze({
  RESERVING: "reserving",
  ISSUED: "issued",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const reelUploadSessionStatusEnum = Object.freeze({
  RESERVING: "reserving",
  ISSUED: "issued",
  FAILED: "failed",
});

export const videoUploadRecoveryStatusEnum = Object.freeze({
  WAITING_CLEANUP: "waiting_cleanup",
  RESERVING: "reserving",
  ISSUED: "issued",
  FAILED: "failed",
});

export const reelUploadPurposeEnum = Object.freeze({
  INITIAL: "initial",
  REPLACEMENT: "replacement",
});

export const videoProviderOperationTypeEnum = Object.freeze({
  RECONCILE: "reconcile",
  COPY_POSTER: "copy_poster",
  DELETE: "delete",
  ABANDONED_UPLOAD_CLEANUP: "abandoned_upload_cleanup",
  VERIFY_DELETION: "verify_deletion",
  COVER_CLEANUP: "cover_cleanup",
});

export const videoProviderOperationStatusEnum = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  NEEDS_ATTENTION: "needs_attention",
  COMPLETED: "completed",
});

export const videoUploadAttemptStageEnum = Object.freeze({
  SESSION: "session",
  UPLOAD: "upload",
  PROCESSING: "processing",
  CLEANUP: "cleanup",
});

export const videoUploadAttemptOutcomeEnum = Object.freeze({
  STARTED: "started",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const videoContentKindEnum = Object.freeze({
  YOUTUBE: "youtube",
  REEL: "reel",
  PRODUCT: "product",
});

export const videoIdentityTypeEnum = Object.freeze({
  USER: "user",
  GUEST: "guest",
});

export const videoAnalyticsEventTypeEnum = Object.freeze({
  IMPRESSION: "impression",
  SHARE: "share",
  PLAYBACK_ERROR: "playback_error",
  PLAY_START: "play_start",
  REPLAY: "replay",
  WATCH_TIME: "watch_time",
  PROGRESS_25: "progress_25",
  PROGRESS_50: "progress_50",
  PROGRESS_75: "progress_75",
  COMPLETE: "complete",
  REBUFFER: "rebuffer",
  SAVE_ADDED: "save_added",
  SAVE_REMOVED: "save_removed",
});

export const videoPlaybackErrorReasonEnum = Object.freeze({
  NETWORK: "network",
  DECODE: "decode",
  UNAVAILABLE: "unavailable",
  EMBEDDING_DISABLED: "embedding_disabled",
  UNKNOWN: "unknown",
});

export const videoPreviewSelectionEnum = Object.freeze({
  ACTIVE: "active",
  PENDING: "pending",
});

export const videoUploadResponseStatusEnum = Object.freeze({
  NONE: "none",
  APPLIED: "applied",
  CANCELLED: "cancelled",
  FAILED: "failed",
  RESERVING: "reserving",
  AWAITING_UPLOAD: "awaiting_upload",
  PROCESSING: "processing",
  READY: "ready",
  RECOVERING: "recovering",
  DELETING: "deleting",
});

export const videoAssetApplicationResultEnum = Object.freeze({
  IGNORED: "ignored",
  STALE: "stale",
  ABANDONED: "abandoned",
  FAILED: "failed",
  READY: "ready",
  REMOVED: "removed",
  NOT_READY: "not_ready",
  AWAITING_REVIEW: "awaiting_review",
  PREVIEW_PENDING: "preview_pending",
  APPLIED: "applied",
  ALREADY_PUBLISHED: "already_published",
  PUBLISHED: "published",
});

export const videoProviderExecutionStatusEnum = Object.freeze({
  SKIPPED: "skipped",
  RETRYABLE: "retryable",
  COMPLETED: "completed",
  STALE: "stale",
});

export const videoOrphanRecoveryStatusEnum = Object.freeze({
  NOT_APPLICABLE: "not_applicable",
  AMBIGUOUS: "ambiguous",
  NO_MATCH_OBSERVED: "no_match_observed",
  REQUIRES_REVIEW: "requires_review",
  ALREADY_TRACKED: "already_tracked",
  CANDIDATE: "candidate",
  NOT_ENABLED: "not_enabled",
  CLEANUP_RECORDED: "cleanup_recorded",
  STALE: "stale",
});

export const productVideoSetupKindEnum = Object.freeze({
  BATCH: "batch",
  REPLACEMENT: "replacement",
});

export const videoAnalyticsMarkerEnum = Object.freeze({
  QUALIFIED_VIEW: "qualified_view",
});
