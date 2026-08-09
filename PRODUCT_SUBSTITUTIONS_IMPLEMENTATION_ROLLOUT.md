# Product substitutions: implementation and production rollout

## Scope and non-negotiable rules

This feature lets staff resolve an offline stock shortage after an order has been placed. It is deliberately separate from `orderStatusEnum`: the order remains in its normal lifecycle (`pending`, `accepted`, `shipped`, and so on), while a linked `SubstitutionRequest` records customer action and payment state.

- The warehouse is always the exact `order.warehouse` stored at checkout. Do not recalculate a delivery zone and do not use the warehouse-maintenance fallback for an existing order.
- Registered users and guests use the same request state machine. Guest routes require the original `x-guest-id`; user routes require the authenticated order owner.
- Staff offer and view access is limited to `superAdmin`, `admin`, and `moderator`. The existing `scopeOrdersToModeratorWarehouses` middleware remains the moderator boundary.
- An offer is only for a committed, pending, non-terminal order with safe settlement data. `settlement.migrationState === "manual_review"` is a hard runtime block.
- An order has at most one active substitution request. A later request is permitted only for a genuinely new shortage after the prior request became terminal.
- A later shortage may target a previously accepted substitute line, but it may never use that line as its own substitute candidate. The same exact stored order warehouse and CAS stock rules still apply.
- Stock is not reserved while an offer is being composed. All selected substitute SKUs are reserved atomically only when the customer responds.
- The original shortage is a compare-and-set correction of the currently unallocated warehouse quantity. It never restores the offline-sold units.
- Coupon discount and net shipping are locked from the original order. All new money is integer piastres; legacy decimal fields are retained for compatibility.

## Runtime files and responsibilities

| Area | Files | Responsibility |
| --- | --- | --- |
| Order data | `src/domains/order/order.model.js`, `src/domains/order/order.service.js` | Additive line identity/snapshot fields, order substitution summary, settlement summary, and order-status guard while customer action is required. |
| Shared state | `src/shared/constants/enums.js`, `src/shared/utils/money.js` | Request, payment-attempt, settlement, inventory-audit, and outbox enums; finite-decimal to piastre conversion. |
| Inventory | `src/domains/inventory/inventory.repository.js`, `inventory.service.js`, `inventoryAudit.model.js` | Exact warehouse CAS correction, atomic reserve/release/restore, audit idempotency, and stock revision handling. |
| Product candidates | `src/domains/product/product.model.js`, `product.repository.js`, `productPricing.service.js` | Per-warehouse stock revisions, duplicate-row validation on new writes, and active candidate snapshot/pricing lookup. |
| Request domain | `src/domains/substitution/substitutionRequest.model.js`, `substitution.repository.js`, `substitution.service.js`, `substitution.pricing.js`, `substitution.order.js`, `substitution.settlement.js`, `substitution.notification.js`, `substitution.presenter.js`, `substitution.config.js` | Request persistence, quote calculation, response/finalization, settlement, notifications, customer-safe projection, and feature gating. |
| HTTP boundary | `src/domains/substitution/substitution.routes.js`, `substitution.controller.js`, `substitution.validators.js`, `src/app/routes.js` | Staff/user/guest routes, multipart parsing, validation, ownership, rate limits, and route mounting before the broad order routes. |
| Payments/refunds | `src/domains/payment/orderPaymentAttempt.model.js`, `substitutionPayment.service.js`, `refundOperation.model.js`, `refund.worker.service.js`, `payment.controller.js` | Additional-card intentions/webhook handoff, retry and late-success handling, durable refunds, and provider idempotency. |
| Notifications | `src/domains/notification/inAppNotification.model.js`, `inAppNotification.service.js`, `notificationOutbox.model.js`, `notificationOutbox.service.js`, `notificationOutbox.worker.service.js`, `notificationDispatcher.js` | User-or-guest in-app records, durable token-notification outbox, recipient-scoped staff routing, retry leases, and deduplication. |
| Workers | `src/workers/notificationOutbox.worker.js`, `src/workers/substitutionRefund.worker.js`, `src/workers/substitutionExpiration.worker.js` | Separately supervised durable notification delivery, refund/manual-refund processing, and offer/additional-card expiry sweeps. |
| Rollout tools | `scripts/backfillSubstitutionReadiness.js`, `scripts/auditSubstitutionReadiness.js` | Additive migration and independent read-only readiness audit. |

## Request and order state machine

`SubstitutionRequest.status` is one of:

```text
offered
  ├─ customer rejects/all choices rejected ───────────────> rejected
  ├─ card amount due ─────────────────────────────────────> awaiting_card_payment
  │     ├─ successful webhook ────────────────────────────> completed
  │     └─ payment expiry ────────────────────────────────> expired
  ├─ InstaPay additional proof uploaded ──────────────────> instapay_submitted
  │     └─ staff accepts the normal order/proof review ───> completed
  ├─ zero/COD/POS/wallet-settled response ────────────────> completed
  └─ offer expiry/system cancellation ────────────────────> expired/cancelled
```

`Order.substitutionState` is a summary only: `none`, `awaiting_customer`, `awaiting_card_payment`, or `instapay_submitted`. `requiresCustomerAction` is true only while the customer must respond. There is no new order status.

An active request has a unique partial index on `order`. Each request also has a monotonically increasing `requestSequence` and immutable offer idempotency key.

## Staff offer flow

1. Staff opens candidates for an order line. The candidate query reads only the stored order warehouse and includes only active products/SKUs with positive stock in that warehouse.
2. The staff UI sends the original line, the deliverable original quantity, observed quantity/revision, corrected unallocated quantity, and a capped list of substitute candidates. The service re-reads and snapshots all candidates; it does not trust client product prices, names, stock, or warehouse.
3. The service runs the original shortage correction with the submitted quantity and stock revision as a CAS guard. A changed stock row returns a conflict rather than guessing.
4. It stores a request with an offer expiry preset of 15, 30, 60, or 120 minutes (30 minutes by default). No substitute stock is reserved yet.
5. A durable customer notification is enqueued. The actual push uses the existing in-app notification surface and token-based dispatch.

For an InstaPay original order, staff must verify the original transfer before submitting the modification. This is the same review boundary already used before the original order is accepted. A later additional InstaPay proof is not independently approved: accepting the pending order is the proof-review/finalization action. If it is not accepted, staff contacts the customer or cancels the order using the normal process.

## Customer response, payment, and refunds

The quote normalizes every shortage. The customer can accept any offered candidates up to the unavailable quantity and reject the remainder. The quote includes a deterministic `quoteRevision`; the response must submit that same revision, the request revision, and a new `Idempotency-Key`.

- A positive delta uses registered-user wallet first. Remaining money is paid by card, submitted as additional InstaPay proof, or becomes COD/POS delivery due.
- A negative delta is credited to a registered user's wallet for card/InstaPay routes; a guest card path creates a Paymob refund; guest InstaPay is a durable manual-refund task. COD/POS reduces delivery due first, then credits any registered-user excess to wallet.
- A card response creates one additional payment attempt and starts the second expiry clock. Retrying creates a new intention without extending that clock. Only one attempt can be accepted; a terminal late success is queued for refund.
- A response reserves all selected substitute stock in one transaction. Expiry, failed payment, and cancellation release only the reservation made by that request.
- All wallet, payment, refund, and inventory side effects carry operation IDs and durable records, so a duplicate request/webhook/worker retry cannot double-charge, double-credit, or double-reserve.
- Reorders and sales/user-activity analytics use each line's final fulfillment quantity and final line total. Zero-fulfilled originals are not reordered or counted as sold; accepted substitute lines are included.

For feature-enabled card orders, loyalty is deferred until staff accepts the order. Older pending committed registered-card orders that already have awarded loyalty points are blocked from substitution; the readiness audit reports them as `legacyCardLoyaltyRisk` for an explicit canary decision.

## API contract

All routes are mounted below `/api/v1/orders`.

| Actor | Method and route | Notes |
| --- | --- | --- |
| Staff | `GET /admin/:id/substitution-candidates?lineId=...&q=...&page=1&limit=20` | Authenticated role plus ORDERS permission and warehouse scope. |
| Staff | `GET /admin/:id/substitutions` and `GET /admin/:id/substitutions/:requestId` | Staff-safe lifecycle/reservation view. |
| Staff | `POST /admin/:id/substitutions` | Requires `Idempotency-Key`; original InstaPay verification is explicit. |
| User | `GET /me/:id/substitutions`, `GET /me/:id/substitutions/:requestId` | Authenticated owner only. |
| User | `POST /me/:id/substitutions/:requestId/quote` | Authenticated owner; phone verification required. |
| User | `POST /me/:id/substitutions/:requestId/respond` | Authenticated owner, `Idempotency-Key`; multipart only when adding InstaPay proof. |
| User | `POST /me/:id/substitutions/:requestId/payment-attempts/:attemptId/retry` | Authenticated owner; does not extend the payment deadline. |
| Guest | Same paths under `/guest/:id/...` | Original `x-guest-id` header is mandatory; opaque not-found behavior prevents cross-guest probing. |

Staff offer JSON example:

```json
{
  "expiresInMinutes": 30,
  "originalInstapayVerified": false,
  "shortages": [
    {
      "lineId": "legacy-0a8db2afaa7d9b09f2b53a11f5da2304",
      "deliverableOriginalQuantity": 1,
      "expectedUnallocatedQuantity": 3,
      "expectedStockRevision": 12,
      "correctedUnallocatedQuantity": 1,
      "correctionReason": "offline_sale",
      "note": "Two units were sold in-store.",
      "alternatives": [
        {
          "productId": "65a000000000000000000222",
          "variantId": null,
          "maxQuantity": 2
        }
      ]
    }
  ]
}
```

Quote JSON example:

```json
{
  "requestRevision": 0,
  "selections": [
    {
      "shortageId": "shortage-1",
      "choices": [{ "candidateId": "candidate-1", "quantity": 2 }]
    }
  ]
}
```

Response JSON example:

```json
{
  "requestRevision": 0,
  "quoteRevision": "f3c4...",
  "quotedWalletBalancePiastres": 12500,
  "savedCardId": "65a000000000000000000333",
  "selections": [
    {
      "shortageId": "shortage-1",
      "choices": [{ "candidateId": "candidate-1", "quantity": 2 }]
    }
  ]
}
```

For an additional InstaPay proof, submit the same response fields as `multipart/form-data`, serialize `selections` as JSON, and include exactly one `additionalInstapayScreenshot` image. The required headers remain `Idempotency-Key` and, for guests, `x-guest-id`.

`Idempotency-Key` is included in the API CORS `allowedHeaders` list. Keep it in the deployed reverse-proxy/browser CORS allow-list too; otherwise a browser client cannot submit an offer, response, or retry safely.

## Configuration and workers

The feature is disabled by default:

```dotenv
ORDER_SUBSTITUTIONS_ENABLED=false
# Optional canary. Empty means all warehouses only after the flag is true.
ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST=<warehouse-object-id>
```

Do not enable it globally at deployment time. First enable a single warehouse in the allowlist, observe it, then expand deliberately. The existing `.env` encryption/deployment process remains authoritative; this repository has no tracked `.env.example` to alter.

`ecosystem.config.cjs` defines three additional, independently supervised workers. Their safe restart policy is a 1-second exponential-backoff base, 15 unstable restarts, 512 MB memory restart, and a 30-second graceful shutdown allowance. Adding the definitions does not start them.

After the code deploy and index/readiness checks, make the separate, approved process-management change using either the npm scripts or PM2 definitions below. Do not run these commands as part of the database migration itself, and do not restart unrelated processes.

```bash
# Worker entrypoint commands (run only through your normal supervisor).
npm run start:notification-outbox-worker
npm run start:substitution-refund-worker
npm run start:substitution-expiration-worker

# PM2 definitions, started explicitly and independently.
pm2 start ecosystem.config.cjs --only petyard-notification-outbox-worker
pm2 start ecosystem.config.cjs --only petyard-substitution-refund-worker
pm2 start ecosystem.config.cjs --only petyard-substitution-expiration-worker
pm2 status
```

Verify each worker connects, processes a no-op poll, and shuts down gracefully before the canary. The expiration worker polls every 30 seconds by default, which is suitable for the 15-minute minimum offer preset.

## Database indexes and deploy order

The following indexes are declared in the named Mongoose schemas; ensure application startup creates/validates them before enabling the flag:

- `SubstitutionRequest`: unique active request per order; unique `{ order, requestSequence }`; unique `{ order, offerIdempotencyKey }`; status/deadline scans; owner/warehouse listing indexes.
- `OrderPaymentAttempt`: request/idempotency uniqueness; provider order uniqueness; partial unique accepted success per request; expiry scan.
- `RefundOperation`: unique operation ID plus due/lease scans.
- `SettlementLedger`, wallet transactions, loyalty transactions, inventory audit, and notification outbox: operation/dedupe IDs plus worker claim indexes.
- `Order`: active request and customer-action summary indexes.

Deployment sequence:

1. Take and verify an Atlas backup/snapshot. Record the backup timestamp and restore procedure owner.
2. Deploy the code with `ORDER_SUBSTITUTIONS_ENABLED=false`. Let the application create indexes while the feature is still inaccessible.
3. Run the backfill dry run with production credentials injected by dotenvx:

   ```bash
   npx dotenvx run -f .env -fk .env.keys -- \
     node scripts/backfillSubstitutionReadiness.js
   ```

4. Review `scripts/substitution-migration-reports/backfill-*.json`. Resolve every duplicate warehouse row manually; the script intentionally skips those products.
5. Apply only after backup review:

   ```bash
   npx dotenvx run -f .env -fk .env.keys -- \
     node scripts/backfillSubstitutionReadiness.js \
     --apply --confirm-live-db-rewrite
   ```

   Resume an interrupted phase without replaying prior documents:

   ```bash
   npx dotenvx run -f .env -fk .env.keys -- \
     node scripts/backfillSubstitutionReadiness.js \
     --apply --confirm-live-db-rewrite \
     --resume-products-after=<last-product-id> \
     --resume-orders-after=<last-order-id>
   ```

   Every update requires its target fields to still be absent. A compare-before-update mismatch is reported and never overwritten.

6. Run the independent, read-only audit:

   ```bash
   npx dotenvx run -f .env -fk .env.keys -- \
     node scripts/auditSubstitutionReadiness.js
   ```

7. Require zero active-request-index conflicts, zero duplicate-stock products, zero invalid settlement invariants, and no unexpectedly eligible pending committed orders lacking readiness before the canary. The audit also reports `legacyCardLoyaltyRisk.pendingCommittedRegisteredCardOrdersWithAwardedPoints` for the configured canary warehouses (or all warehouses if the allowlist is empty). Review those samples before enabling a card canary: they are evidence for the separate safe-eligibility decision to defer loyalty on feature-enabled card orders until staff acceptance. This audit does not alter loyalty points.
8. Make the separate approved process-management change to start and verify the notification-outbox, substitution-refund, and substitution-expiration workers. Test one low-risk staff offer in the canary warehouse for each payment method.
9. Set `ORDER_SUBSTITUTIONS_ENABLED=true` with one warehouse ID in `ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST`. Monitor before widening the allowlist, then remove the allowlist only after a planned global enablement.

## Monitoring, rollback, and manual-review boundary

Alert on:

- request offer/payment expiration counts and age;
- CAS conflicts and inventory-audit failures;
- outbox retry/dead-letter records and notification dispatch latency;
- payment attempts awaiting beyond deadline, late successful cards, refund retries, and manual refund operations;
- settlement invariant failures, `manual_review` orders, and duplicate active request/index conflicts.
- final-fulfillment reorder/analytics totals, especially zero-fulfilled originals and accepted substitute lines.

The operational rollback is immediate and non-destructive: set `ORDER_SUBSTITUTIONS_ENABLED=false` and remove the warehouse allowlist. Existing active requests remain durable records; use staff operations to finish/cancel them rather than deleting database documents. Do not restore a broad backup to undo this feature unless an incident commander explicitly chooses the data-loss tradeoff.

Historical cancelled, returned, failed, refunded, inconsistent, or otherwise unsafe orders are deliberately marked `settlement.migrationState: "manual_review"` without invented financial buckets. They remain blocked from substitution until a human has reconciled the original payment and stock history. Duplicate warehouse stock rows are never merged by a script; correct the product manually, then rerun the dry run and audit.
