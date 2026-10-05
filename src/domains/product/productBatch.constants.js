// Layout manifests and the product loader share one bound; neither truncates IDs.
export const PRODUCT_BATCH_MAX_IDS = 50;
export const PRODUCT_BATCH_MAX_REQUEST_BYTES = 2048;
export const PRODUCT_BATCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PRODUCT_BATCH_QUERY_TIMEOUT_MS = 10_000;
