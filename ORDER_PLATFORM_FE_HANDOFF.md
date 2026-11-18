# Order platform tracking

Petyard records the platform that submitted an order so staff can see whether it came from the Android app, iOS app, or website. Flutter sends the platform when it places the order. The backend stores it on that order and returns it with the order data.

This is the contract for the backend implementation in this change. Confirm that the target backend has deployed it before enabling the admin display in that environment.

## What changed

| Surface | Before | With this change |
| --- | --- | --- |
| Order creation for a signed-in customer or guest | Order creation did not read a platform. | The backend reads optional `X-App-Platform` on both order creation routes. |
| Checkout request body | The body contained the existing checkout fields. | The same JSON and InstaPay multipart formats apply. The new input is an HTTP header. |
| Order storage | Order records had no platform fields. | Creation saves `platform` and `platformSource` on the order. |
| Order responses | Orders had no platform fields. | Each order returned through the existing order presenter includes both fields. Older records are presented as `unknown`. |
| Staff order list and details | There was no platform to display. | The same endpoints return the platform on each order. The staff app can add a column and a detail row. |

The platform belongs to the order, so an iOS order stays iOS when the customer later opens it on web, completes card payment, or transfers their guest orders to an account. An order created later through a different platform takes the value from that new request. This release does not use device registration or FCM records to classify orders. Existing records are read as unknown without a backfill.

## What Flutter sends

| Request | Identity | Platform |
| --- | --- | --- |
| `POST /api/v1/orders/me` | `Authorization: Bearer <accessToken>`. The account must meet the existing phone verification requirements for checkout. | Optional `X-App-Platform`. |
| `POST /api/v1/orders/guest` | `x-guest-id: <guestId>`. Use the same guest ID that owns the cart and delivery address. | Optional `X-App-Platform`. |

Use one header value per request. Header names are case insensitive. Send the platform value in lowercase.

| Value | When to send |
| --- | --- |
| `android` | Flutter is running as the native Android app. |
| `ios` | Flutter is running as the native iOS app. |
| `web` | Flutter is running in a browser. This includes Chrome on Android, Safari on iPhone, and a web app installed from the browser. |
| Header omitted | Flutter cannot determine a supported platform, or an older app version has no platform support. The order can still be created and is recorded as unknown. |

Use Flutter's web check before considering the target platform. A browser on Android or iOS must send `web`. Put the detection in the shared API client or the shared checkout request builder so JSON, multipart, signed-in, and guest checkout use the same value.

```dart
import 'package:flutter/foundation.dart';

String? currentOrderPlatform() {
  if (kIsWeb) return 'web';
  if (defaultTargetPlatform == TargetPlatform.android) return 'android';
  if (defaultTargetPlatform == TargetPlatform.iOS) return 'ios';
  return null;
}

void addOrderPlatformHeader(Map<String, String> headers) {
  final platform = currentOrderPlatform();
  if (platform != null) {
    headers['X-App-Platform'] = platform;
  }
}
```

Keep or compute that runtime value for each **new checkout submission**. It can be reused across checkouts from the same app session. It does not come from a previous order response, the OS underneath a browser, a saved card, or a push token. Use the existing auth and guest identity handling separately. The backend accepts this header as client-reported information for staff display.

Both `platform` and `platformSource` in the JSON or form body are ignored for attribution. Do not send `unknown`, `mobile`, `flutter`, uppercase values, an empty string, or a list of values in the header. Omit it when unavailable. The backend already allows `X-App-Platform` through CORS. The website's origin must also be on the environment's CORS allowlist.

### Existing checkout request fields

For JSON requests, send `Content-Type: application/json`. The server reads the cart and its delivery address by the authenticated user or guest identity. Prices, shipping, wallet usage, and stock come from the existing backend checkout rules.

| Field | Type and allowed values | Meaning and use |
| --- | --- | --- |
| `paymentMethod` | Optional string. `cod`, `card`, `pos_on_delivery`, `instapay`. Omission selects `cod`. | Use the payment method chosen at checkout. `cod` is cash on delivery. `pos_on_delivery` is payment by terminal on delivery. `card` initializes Paymob checkout. `instapay` submits proof of transfer. |
| `couponCode` | Optional string or null in JSON. | The coupon the customer selected. Omit or send null with no coupon. Reuse the checkout-selected code only while the customer still intends to apply it. |
| `notes` | Optional string or null in JSON. | Customer instructions for this order. For form data, omit absent values. |
| `savedCardId` | Optional registered-customer JSON field. MongoDB ID string or null. | The current route accepts and validates this existing field. The order creation code loads the account's available saved card tokens for Paymob and does not select one from `savedCardId`. Keep the current saved-card flow and do not depend on this field to force a specific card. Guests should omit it. |
| `instapayScreenshot` | Multipart file field, at most one file under this name. | Legacy field for a single transfer proof. |
| `instapayScreenshots` | Repeat this multipart file field for multiple images. At most five files across both screenshot fields. | Use when `paymentMethod=instapay`. Send at least one image. JPEG, PNG, or WebP up to 5 MiB per image are practical choices. The backend also recognizes JPG, GIF, and SVG MIME types and may reject files it cannot process. |

For InstaPay, let the HTTP client create the multipart boundary. Attach `X-App-Platform` as a request header.

```http
POST /api/v1/orders/me
Authorization: Bearer <accessToken>
X-App-Platform: ios
Accept-Language: en
Content-Type: application/json

{"paymentMethod":"card","couponCode":"SAVE10","notes":"Call on arrival"}
```

```http
POST /api/v1/orders/guest
x-guest-id: <existingGuestId>
X-App-Platform: web
Accept-Language: en
Content-Type: application/json

{"paymentMethod":"cod"}
```

```bash
curl -X POST "$BASE_URL/api/v1/orders/guest" \
  -H "x-guest-id: $GUEST_ID" \
  -H 'X-App-Platform: web' \
  -F 'paymentMethod=instapay' \
  -F 'instapayScreenshots=@transfer-proof.png;type=image/png'
```

`Accept-Language` is optional. A value starting with `ar` selects Arabic for messages and order data where localization is available. Other values use English. Some middleware and validation errors are English in both cases, so map errors to app-owned translations.

## What the backend returns

### Platform fields

These are strings inside each order object in `data`.

| Field | Values in this release | Meaning |
| --- | --- | --- |
| `platform` | `android`, `ios`, `web`, `unknown` | The platform reported when the order was placed. `unknown` means no usable platform was recorded for the order. |
| `platformSource` | `request`, `unknown` | `request` means the backend saved a supported `X-App-Platform` from order creation. `unknown` means the header was absent or the order predates tracking. |

The emitted pairs are `android/request`, `ios/request`, `web/request`, and `unknown/unknown`. A later historical backfill may define `inferred`. It is not emitted in this release. Older deployed backends and cached responses can omit both fields. FE should decode them tolerantly and render **Unknown** for missing, null, non-string, unfamiliar, or inconsistent values. Treat them as display metadata and keep the order screen usable.

### Successful creation

For COD, POS on delivery, and InstaPay, the backend returns **201 Created** with the order in `data`. This is an abbreviated response.

```json
{
  "data": {
    "_id": "67b23dd876a0312a8eae45d1",
    "orderNumber": "PY-20261118-1234ABCD",
    "status": "pending",
    "paymentMethod": "cod",
    "paymentStatus": "pending",
    "currency": "EGP",
    "total": 250,
    "platform": "web",
    "platformSource": "request"
  }
}
```

For card checkout, the backend returns **200 OK** with the new order and these top-level payment fields. This is an abbreviated response.

```json
{
  "data": {
    "_id": "67b23dd876a0312a8eae45d2",
    "orderNumber": "PY-20261118-2345BCDE",
    "status": "awaiting_payment",
    "paymentMethod": "card",
    "paymentStatus": "pending",
    "currency": "EGP",
    "total": 250,
    "platform": "ios",
    "platformSource": "request"
  },
  "action": "requires_payment",
  "clientSecret": "<Paymob checkout session secret>",
  "publicKey": "<Paymob public key>"
}
```

| Response field | Source and how FE uses it |
| --- | --- |
| `data` | The order returned by the server. Validate that it is an object before opening order details or payment. |
| `data._id` | The stored MongoDB order ID. Keep this for order details, polling after payment, reorder, and links. Use it for `:id` in all routes below. |
| `data.orderNumber` | The order reference the server generated. Show it on receipts or in support messages. Admin can search by it. |
| `action` | Currently `requires_payment` for the initial card response. Branch on this value and the presence of the payment fields before opening Paymob. |
| `clientSecret` | Created by Paymob for this initial checkout session. Keep it only as needed for that session, and exclude it from logs, analytics, and support messages. Order reads do not return it. |
| `publicKey` | Paymob public integration key. Pass it to the existing Paymob checkout together with `clientSecret`. |

HTTP 200 with `requires_payment` means the backend has initialized checkout. Verify payment using a fresh order read after Paymob returns or closes. `status: "pending"` with `paymentStatus: "paid"` is the expected result immediately after card payment is confirmed. The order can progress further before the next poll. While it remains `awaiting_payment`, show a pending state and use bounded polling with a delay. Handle `failed`, `cancelled`, and `refunded` with the existing payment UX. There is no customer endpoint that refreshes the Paymob session for this order. If an expected card credential is missing or the response is incomplete, keep the order ID if available and reconcile the order before offering another submission.

### Existing order data fields

The platform fields are added alongside the existing DTO. Read amounts as JSON numbers in the order currency wherever the field does not end in `Piastres`. For EGP, 100 piastres equal 1 EGP. Optional, legacy, and route-specific fields may be absent or null.

| Fields | Meaning and use |
| --- | --- |
| `status` | Fulfillment and order state. Values are `awaiting_payment`, `pending`, `accepted`, `shipped`, `delivered`, `cancelled`, `failed`, and `returned`. |
| `paymentMethod`, `paymentStatus` | Server-recorded method from the request enum. Payment status values are `pending`, `paid`, `failed`, and `refunded`. Read payment and order state separately. |
| `currency`, `subtotal`, `shippingFee`, `discountAmount`, `shippingDiscount`, `totalDiscount`, `walletUsed`, `total` | Currency code, merchandise subtotal, shipping charge before shipping discount, merchandise discount, shipping discount, total discount, wallet portion, and amount due after discounts and wallet use. Display server amounts. A card order can show planned wallet use while its payment is pending. |
| `couponCode`, `isPrimeLocation`, `loyaltyPointsAwarded`, `notes` | Applied coupon, recorded Prime eligibility, awarded loyalty points, and order instructions. |
| `user`, `guestId`, `warehouse` | Order ownership and fulfillment warehouse. Use the caller's current bearer token or original guest ID for reads. Staff responses can populate the user and warehouse as objects. Other responses can contain IDs or omit the irrelevant identity. |
| `deliveryAddress` | The saved address snapshot. It can contain `userAddressId`, `label`, `name`, `governorate`, `area`, `phone`, `building`, `floor`, `apartment`, `location.lat`, `location.lng`, and `details`. Display it as delivery information for that order. |
| `items[]` | Each product line has `product`, `productType` (`SIMPLE` or `VARIANT`), `productName`, `productImageUrl`, `variantId`, `variantOptions[]` (`name` and `value`), `quantity`, `itemPrice`, and `lineTotal` where applicable. Promotion fields include `baseEffectivePrice`, `promotion` (`collectionId`, `collectionSlug`, `discountPercent`), and `promotionDiscountedPrice`. Use the order quantities and prices for the receipt. |
| Order line fulfillment fields | `lineId` identifies a line, `lineKind` is `original` or `substitute`, `sourceLineId` and `sourceSubstitutionRequest` identify substitution lineage, and `fulfillmentQuantity` and `finalizedUnavailableQuantity` track fulfilled and unavailable units. Some records also contain `itemPricePiastres` and `lineTotalPiastres`. |
| `bundles[]` | Present when the existing bundle order flow returns grouped items. Each includes group `id`, `bundleId`, `bundleRevision`, `type: "BUNDLE"`, `name`, `image`, `quantity`, `itemPrice`, `originalItemPrice`, `lineTotal`, and `components[]`. Each component has `productId`, `productType`, `variantId`, `name`, `image`, `variantOptions`, and `quantity`. Platform is on the order. |
| `instapayScreenshot`, `instapayScreenshots[]` | Existing proof image URLs. The singular field supports older clients. Use the array for a gallery where present. Private proof URLs may expire. Refresh the order if necessary. |
| `history[]`, `createdAt`, `updatedAt` | Order timeline and timestamps. Respect `visibleToUser` in customer views. A history entry has `at`, `description`, and optional actor information such as `byUser` or `byUserId`, depending on the response. |
| `activeSubstitutionRequest`, `substitutionState`, `requiresCustomerAction`, `substitutionRevision` | Existing substitution flow fields. States are `none`, `awaiting_customer`, `awaiting_card_payment`, and `instapay_submitted`. Continue using the substitution contract for actions. |
| `settlement` | Optional existing summary of amounts calculated by the backend, with `schemaVersion`, `revision`, and `currency`. `currentMerchandiseGross`, `originalCouponDiscount`, `preservedCouponDiscount`, `lockedNetShipping`, and `currentOrderValue` describe order value. `walletDebited`, `walletCredited`, `cardCaptured`, `cardRefunded`, `cardDue`, `instapaySubmitted`, `instapayConfirmed`, `deliveryDue`, and `pendingRefundLiability` describe settlement movements and amounts due. `migrationState` can be `native`, `backfilled`, or `manual_review` and concerns settlement only. |
| Optional internal references | Some responses contain stage or provider references such as `sideEffectsCommitted`, `paymobOrderId`, `paymobTransactionId`, `paymobRefundTransactionId`, `multiCaptureRefundReconciliationOperation`, and MongoDB `__v`. Use the public order ID and payment status for customer navigation. Avoid exposing these references in UI or client logs. |

Use null-safe decoding for new and existing fields. Localize status and platform labels. Preserve unknown enum values safely when decoding for forward compatibility, and render a neutral label when the app does not recognize a value.

### Where to read the platform later

| Action | Request and identity | Response |
| --- | --- | --- |
| Signed-in order list | `GET /api/v1/orders/me?page=1&limit=20` and bearer token. | `200` with `data[]`, `page`, `totalPages`, and `results`. |
| Signed-in order details or payment check | `GET /api/v1/orders/me/:id` and bearer token. | `200` with `data`. |
| Guest order list | `GET /api/v1/orders/guest?page=1&limit=20` and the original `x-guest-id`. | `200` with `data[]`, `page`, `totalPages`, and `results`. |
| Guest order details or payment check | `GET /api/v1/orders/guest/:id` and the original `x-guest-id`. | `200` with `data`. |
| Staff order list | `GET /api/v1/orders/admin?page=1&limit=20` and staff bearer token with order access. | `200` with `data[]`, `page`, `totalPages`, `results`, `totalOrders`, and optional `statusCounts`. |
| Staff order details | `GET /api/v1/orders/admin/:id` and staff bearer token with order access. | `200` with `data`. |
| Staff status update | `PATCH /api/v1/orders/admin/:id/status` and staff bearer token. Body is `{"status":"<order status>"}`. | `200` with updated `data`, including the order's saved platform. Existing transition and role rules apply. |

The GET requests have no body. `page` is the one-based page, `limit` is the requested page size, `results` is the number returned on this page, and `totalPages` is the number of pages, with a minimum of one. Admin `totalOrders` is the count matching the query. `statusCounts` is an existing optional map of order status to count. It is absent on status-filtered responses and can be absent when staff has no warehouse scope. Admin requests retain their existing query parameters, including `sort`, `status`, `orderNumber`, `warehouse`, `user`, `guestId`, `from`, `to`, and `q`. This handoff defines platform display. It does not define a platform filter or a platform sales report.

The platform header is only needed on order creation for this feature. Do not copy either platform response field into later write bodies. Reorder endpoints return a cart and the next checkout captures its own platform. Platform display reads the saved value even when the viewing device reports a different platform.

This is an abbreviated staff list response with one old order and one new order. The platform fields are on each entry, not beside the pagination fields.

```json
{
  "totalOrders": 2,
  "totalPages": 1,
  "page": 1,
  "results": 2,
  "data": [
    {
      "_id": "67b23dd876a0312a8eae45d1",
      "orderNumber": "PY-20261118-1234ABCD",
      "platform": "web",
      "platformSource": "request"
    },
    {
      "_id": "67b23dd876a0312a8eae45d0",
      "orderNumber": "PY-20261117-3456CDEF",
      "platform": "unknown",
      "platformSource": "unknown"
    }
  ]
}
```

### Staff UI

| Order value | Suggested English label | Suggested Arabic label |
| --- | --- | --- |
| `android/request` | Android app | تطبيق أندرويد |
| `ios/request` | iOS app | تطبيق iOS |
| `web/request` | Web | الموقع الإلكتروني |
| Unknown or unavailable | Unknown | غير معروف |

Add the label on each staff list row and the corresponding detail screen. A missing platform should never hide an order or block status updates. Staff access stays based on the authenticated role, enabled controls, and warehouse scope.

Decode the fields after validating that the order is a JSON object. In this example, a null result maps to the localized **Unknown** label.

```dart
String? reportedOrderPlatform(Map<String, dynamic> order) {
  final platform = order['platform'];
  if (order['platformSource'] != 'request' || platform is! String) {
    return null;
  }
  return const {'android', 'ios', 'web'}.contains(platform)
      ? platform
      : null;
}
```

## Errors and recovery

### Platform validation

An invalid header causes **400 Bad Request** before the order creation handler runs. Auth, rate limits, and multipart processing can reject a request earlier. This is the exact response for `X-App-Platform: mobile` when header validation is the only failure.

```json
{
  "status": "fail",
  "error": [
    {
      "field": "x-app-platform",
      "value": "mobile",
      "location": "headers",
      "message": "X-App-Platform must be one of: android, ios, web"
    }
  ],
  "message": "Validation error"
}
```

`status` is the backend's category, `message` is a server description, and `error` can list several error entries. The entry's `field` identifies the input, `location` is where it came from, `value` is the rejected value when available, and `message` describes the validation rule. The header error has no separate machine code. Detect it with HTTP 400 plus `field == "x-app-platform"` and `location == "headers"`. Use the checkout client's own runtime mapping to correct the header. If there is no supported runtime value, omission is valid. Where this is the only error, a corrected submission is safe because checkout did not run. If other errors are present, address them too.

Use a localized fallback such as “We couldn't place your order. Please try again.” Keep support diagnostics out of the customer-facing message.

### Existing checkout and order errors

Use the HTTP status first. Prefer a structured error code when present and check validation entries by field. Some legacy errors have only a message. Different backend layers can return an empty array, omit `error`, or use entries with `path` and `msg` instead of `field` and `message`. Gateways and browsers can return text, HTML, an empty body, or a network exception. Treat all response parsing as fallible.

| Result | Examples or cause | FE handling |
| --- | --- | --- |
| **400** invalid checkout fields or path ID | Invalid `paymentMethod`, `couponCode`, `notes`, `savedCardId`, missing InstaPay proof, invalid `:id`, or invalid staff `status`. The existing checkout validator may also reject unsupported bundle inputs. | Highlight the relevant form input. On an invalid link, return to the order list and let the user select an order. Avoid sending empty placeholders for optional enum or ID fields. |
| **400** missing guest ID | `x-guest-id header is required`. | Restore the original guest identity and retry a corrected request. A new guest ID does not own an existing guest cart or order. |
| **400** empty cart or invalid checkout details | Empty or nonpositive cart total, missing warehouse or address, incomplete address, missing map location, item unavailable, incorrect product type or quantity, insufficient stock or wallet balance. | Take the customer to the cart or address step. Refresh price, stock, and checkout summary before a new submission. |
| **400** coupon rules | Restricted customer or items, maximum usage, or minimum or maximum order total. A missing, invalid, expired, or inactive coupon can return **404**. | Show a coupon-specific message. Let the customer remove or replace the coupon and review the recalculated total. |
| **400** photo validation | Unexpected field, unsupported image, too many files, oversized or invalid image. Image validation can return `error[].code: "IMAGE_FILE_INVALID"`. | Keep the checkout form and ask the customer to select a supported image. Confirm the form field name and file count before submission. |
| **400** invalid staff transition | The status is valid as an enum but the transition from the current order status is not allowed. | Reload the order and refresh the actions available to staff. |
| **401** authentication rejected | Missing, expired, or invalid token, a changed password, missing or inactive account. | Use the existing token refresh or sign-in flow. Repeat a write only after a definite authentication rejection and successful recovery. A timeout is a separate case. |
| **403** account or permission restrictions | Phone missing or unverified, banned account, missing staff order access, warehouse restriction, or cancellation attempted by a role other than `superAdmin`. | Route to phone completion or verification when applicable. For permission failures, show a localized access message without retrying. |
| **404** missing or inaccessible resource | Cart, order, warehouse, product, variant, or coupon is no longer available. Reads for another customer's order can also return 404. | Use screen context to guide recovery. Refresh the cart or order list, or ask the user to review the address or coupon. |
| **409** stock or cart change | `error[].code: "CART_STOCK_REVIEW_REQUIRED"` when provided, an inventory or bundle conflict, or a message asking the user to refresh the cart. Some existing conflicts have no wire code. | Reload the cart and let the user resolve quantities or review the updated total. Avoid automatically resubmitting the order. |
| **409** payment already in progress | The same checkout can have a recent card order in `awaiting_payment`. The message may include seconds to wait or ask the customer to check the order. | Recover the existing order by its ID, or refresh the order list. Show pending and check status before allowing another submission. |
| **409** staff action blocked by substitution | `error[].code: "SUBSTITUTION_ACTION_REQUIRED"` identifies an order waiting for customer action. | Refresh the order, keep its current status, and display the substitution state to staff. |
| **429** request limit | Rate limiting can return just `status` and `message`. | Disable immediate repeated actions. Use `Retry-After` when present and readable, or the app's conservative cooldown. Browsers may be unable to read that header. |
| **502** provider or upload failure | The existing checkout flow can return `Payment initialization failed. Please try again.` or an InstaPay upload failure. | Show a simple payment or upload error. Refresh the relevant order and cart state before another order submission. |
| **500**, **503**, other **5xx**, timeout, offline, or failed CORS | Unexpected server or proxy response, temporary dependency failure, or no readable response. | Preserve the form and show a localized message such as “We couldn't confirm your order. Check your orders before trying again.” Reconcile order and cart state before retrying a write. |

Some existing bundle exceptions keep their application code server-side. The global order error handler does not expose every internal code on the wire. Keep an HTTP-status fallback and use the generic recovery action when a more specific code is unavailable.

### Prevent duplicate orders and app crashes

1. Disable the checkout button while the request is in flight and re-enable it when the operation resolves to a state where a new submission is safe. Treat a delayed payment callback as pending.
2. Validate the response shape before reading nested fields. A successful HTTP status with missing `data._id`, or a card response without its expected credentials, should go through order reconciliation. Wrap decoding and provider calls so an exception does not leave the UI stuck.
3. A GET can be retried with a delay. Order creation has no general client idempotency key contract. After an ambiguous response, check the order by its known ID or refresh the order list and cart before a customer retries. Keep `x-guest-id` stable throughout guest checkout and recovery. Avoid silently retrying a state-changing request after a timeout.
4. Use trusted app-owned text for alerts and inline validation. Never render server strings as HTML or show raw stack traces, internal messages, headers, tokens, or Paymob secrets. For support, retain the HTTP status, route template, order ID when known, request timestamp, and `X-Request-Id` from the response when present. That ID is generated by the server for log lookup.

## Integration checks

- Place signed-in and guest orders across Android, iOS, and Flutter web. Include a phone browser to confirm it is recorded as Web.
- Check that JSON and InstaPay multipart requests each carry exactly one platform value.
- Test an older app without the header. Verify order creation succeeds and reads as Unknown. Check that a historical order and a cached response without the fields also show Unknown.
- Send an unsupported value in a test environment. Confirm the 400 is handled without an order being created and without any server error text appearing in the customer UI.
- Confirm the same saved platform in creation, customer reads, and staff list and details. Verify a card order retains its platform after payment confirmation.
- Review browser CORS from the real Flutter web origin in the target environment. Test slow network, expired auth, a stock conflict, and a lost checkout response to confirm the UI recovers without submitting a duplicate order.
