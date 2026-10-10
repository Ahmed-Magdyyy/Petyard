# Prime Location implementation plan

Status: implemented locally on 2026-10-05. Production activation and frontend acceptance remain pending.
Prepared: 2026-10-04. Inspected checkout: `85505c6`, with existing unrelated local changes preserved.

## 1. Confirmed requirements and decisions

- A Prime Location is a configured geographic area within a warehouse's `boundaryGeometry`.
- A warehouse may have several separate prime areas.
- Precise coordinates inside a prime area qualify, including points exactly on its edge.
- Prime customers receive a special theme owned by the customer app.
- Location resolution and saved-address responses expose a real boolean named `isPrimeLocation`.
- Warehouses gain `primeShippingPrice` alongside `defaultShippingPrice`.
- Prime shipping may be free or equal to normal shipping: `0 <= primeShippingPrice <= defaultShippingPrice`.
- When another warehouse fulfills an order through maintenance fallback, prime benefits are disabled. Do not transfer eligibility or use the fallback warehouse's prime area to reinstate it.

The remaining choices below are implementation recommendations, not additional business promises. There is no defined numeric delivery-time promise, subscription, membership, radius rule, or Prime-specific free-shipping threshold.

### Live-app compatibility requirement

The user explicitly requires compatibility with the existing live app. Response changes must be additive: preserve all existing field names, JSON types, nesting, null/omission conventions, identifiers, HTTP status codes, pagination, and array/object envelopes. Keep existing routes, request bodies, and authorization rules; older clients must not need to send any new field. New Prime fields must not replace existing fields or make old request fields newly mandatory.

For warehouses without configured Prime and for non-prime locations, existing responses and behavior must remain unchanged apart from the added metadata. Prime-eligible fee values and their dependent totals intentionally change through the existing pricing fields; this is the confirmed feature behavior, not a promise of identical numeric values. `defaultShippingPrice` remains the original normal price even for Prime customers.

Do not include unrelated bug fixes in this rollout. In particular, preserve the current zero `shippingFee` in cart mutation/merge response paths that already return zero. Correcting that legacy response behavior requires separate scope and client verification. Also defer changing the existing address-coordinate request contract or correcting its partial-update behavior; unusable resulting coordinates cannot establish Prime eligibility.

Before release, add response compatibility checks that remove only the documented new fields and compare the remaining output with baseline fixtures. Disabled/non-prime cases must match the baseline; Prime cases may change only documented shipping amounts and the coupon/total/settlement values derived from them. Verify an existing released FE build against staging: additive fields are the design constraint, but uninspected client parsing cannot be assumed tolerant.

## 2. Current implementation and why the change spans several domains

| Concern | Current behavior | Relevant source |
| --- | --- | --- |
| Warehouse coverage | GeoJSON `Polygon`; warehouse point uses `[lng, lat]`; normal shipping defaults to zero | `src/domains/warehouse/warehouse.model.js` |
| Warehouse administration | Existing POST/PATCH permissions; PATCH explicitly selects editable fields; geometry checks currently validate only the outer structure | `warehouse.validators.js`, `warehouse.service.js`, `warehouse.routes.js` |
| Warehouse reads | List excludes `boundaryGeometry`; detail returns the complete document and its GET route currently has no authentication middleware | `warehouse.repository.js`, `warehouse.routes.js` |
| Coordinate resolution | Tests all active delivery polygons; chooses the nearest warehouse among overlapping candidates; then resolves maintenance fallback | `src/domains/location/location.service.js` |
| Manual location resolution | No precise coordinates; `canDeliver: false`, `PRECISE_LOCATION_REQUIRED`; still returns a browsing warehouse | `location.service.js` |
| Outside-boundary resolution | Supported governorate locations outside all boundaries are non-deliverable; unsupported/unknown governorate fallback currently permits delivery through the default warehouse | `location.service.js` |
| Saved addresses | Both users and guests use `AddressModel`; the saved `warehouse` is the geographic zone warehouse, including during maintenance | `src/domains/address/address.model.js`, `address.service.js` |
| Address editing | Re-resolves when supplied coordinates are truthy; partial coordinate edits currently risk replacing the other coordinate with `undefined` | `address.service.js`, `address.validators.js` |
| Cart address | Shared owner-aware snapshot contains coordinates and address reference, but does not preserve the source zone warehouse | `src/domains/cart/cartAddressSnapshot.js`, `cart.model.js` |
| Cart routing | Cart `warehouse` is the effective fulfillment warehouse; callers can select/rebind it through warehouse-specific routes | `cart.service.js` |
| Cart shipping | GET calculates normal shipping; item mutations and merge branches call the response mapper without shipping options, which defaults `shippingFee` to zero | `cart.service.js` |
| Checkout shipping | Summary and the exported coupon helper independently calculate normal shipping again | `src/domains/checkout/checkout.service.js` |
| Order shipping | The common user/guest creation path independently calculates shipping after resolving fulfillment; orders lock financial values at creation | `src/domains/order/order.service.js`, `order.model.js` |
| Existing promotions | Free shipping begins at an item subtotal of EGP 3,000; coupon shipping reductions apply afterward; wallet use affects merchandise only | `src/shared/constants/enums.js`, `coupon.application.js`, `coupon.service.js` |
| Later settlement | Substitutions consume locked order shipping, including `settlement.lockedNetShippingPiastres` | `src/domains/substitution/substitution.pricing.js` |
| Prime theme ownership | Existing UI Builder documents place Prime personalization in the customer app/domain; it is not a layout targeting segment | `UI_BUILDER_FE_RECONCILIATION.md`, `UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md` |

The feature must change the final order calculation as well as checkout previews. Changing checkout alone would display a reduced fee and charge the normal fee.

## 3. Warehouse configuration

Recommended fields:

```js
primeBoundaryGeometry: { type: 'MultiPolygon', coordinates: /* GeoJSON */ }
primeShippingPrice: Number | null
```

Use `MultiPolygon` consistently, including when only one prime area exists. Its nesting is polygons, rings, coordinate pairs. Coordinate pairs remain `[longitude, latitude]`; address inputs remain `{ lat, lng }`.

Example warehouse PATCH with two separate areas:

```json
{
  "primeBoundaryGeometry": {
    "type": "MultiPolygon",
    "coordinates": [
      [[[31.500, 29.950], [31.505, 29.950], [31.505, 29.955], [31.500, 29.955], [31.500, 29.950]]],
      [[[31.510, 29.960], [31.515, 29.960], [31.515, 29.965], [31.510, 29.965], [31.510, 29.960]]]
    ]
  },
  "primeShippingPrice": 20
}
```

The example is illustrative and requires a parent boundary that contains both polygons.

Configuration rules:

1. Both prime fields absent/null means Prime is disabled. Existing warehouses keep their current behavior.
2. A configured prime geometry requires an explicitly configured price. Do not default the price to zero or use truthiness to detect it.
3. Use one PATCH to configure the pair. To disable Prime, send both fields as null. Omitted PATCH fields preserve their existing values.
4. Validate the resulting configuration after merging the PATCH with the existing warehouse. This covers price-only edits, normal-price reductions, and parent-boundary changes.
5. Reject a parent-boundary edit that leaves any prime area outside it. Require a corrected prime geometry or explicit clearing in the same PATCH. Do not silently clip it.
6. Reject clearing the parent boundary while retaining configured prime areas.
7. Validate all delivery configuration before any default-warehouse side effects. Persist related configuration together; guard conflicting concurrent delivery-configuration edits with MongoDB conditional writes if the existing save path cannot preserve the validated result. A stale write should return 409 rather than overwrite a competing change.
8. Keep existing admin write permissions. Exclude the new geometry from warehouse lists as the existing boundary is excluded. Keep price available for warehouse administration.

No separate enable flag, collection, worker, geospatial index, or distance calculation is needed. Geometry is loaded after warehouse selection and checked with the installed Turf dependency.

### Geometry validation

Validate finite numeric longitude/latitude ranges, exact coordinate pairs, nonempty polygons/rings, closed rings, at least three distinct vertices, positive polygon area, and valid ring/component topology. Reject self-intersections, holes outside their outer ring, overlapping hole interiors, and overlapping component interiors. Respect GeoJSON holes in both prime and parent geometry; points inside holes do not qualify.

Validate the parent geometry when configuring Prime or changing its parent boundary. Avoid an unrelated bulk rewrite of legacy warehouse polygons.

After structural/topological validation, prove full containment using the installed Turf 6.5 `difference(primeFeature, boundaryFeature) === null`. Touching the parent boundary is permitted. Reject any remaining outside area without an arbitrary area tolerance.

Do not rely on checking vertices or `booleanWithin` alone. Local probes found that `booleanWithin` returns true for both a polygon crossing the outside notch of a concave boundary and a polygon covering a hole in its parent. `difference` detects both violations. Local probes also verified MultiPolygon membership, gaps, edges, and containment.

Use the existing Turf exports for validation/clipping where they fit. `kinks` alone is not proof of every ring/component topology rule. Do not silently repair malformed submitted coordinates or self-crossing polygons.

## 4. One authoritative eligibility rule

Introduce a small warehouse delivery module, suggested path `src/domains/warehouse/warehouse.delivery.js`, for shared prime configuration validation, point eligibility, and shipping selection. Keep database lookups in the existing services and reuse `warehouse.fulfillment.js` for warehouse state.

A location qualifies only when all of these are true:

- Both coordinates are present and finite.
- Its source zone warehouse is known and active/operational.
- The source zone and actual fulfillment warehouse are the same.
- The warehouse has valid prime geometry and a valid configured prime price.
- The point is inside both the current warehouse boundary and its prime geometry, with edges included.
- The current context permits delivery.

Select the warehouse with the existing coverage/nearest-candidate rules first. Prime membership must not alter warehouse selection or prefer a farther warehouse merely because its prime polygon matches.

Return false for manual/coarse locations, outside-boundary fallback locations, missing/deleted warehouses, unavailable zones, malformed legacy prime configuration, and rerouted orders. Do not grant Prime based only on a warehouse ID, a saved boolean, or a client-supplied flag.

For saved-address presentation, an unavailable warehouse produces `isPrimeLocation: false`; do not fail the entire address list. Existing resolver/checkout/order rejection behavior for inactive or closed warehouses remains in place.

## 5. API and frontend contract

Put the location-dependent boolean on the resolved result, not on the warehouse object as if it were a permanent warehouse property.

### Resolve location

`POST /api/v1/locations/resolve` retains its request and response structure and adds `data.isPrimeLocation`. Warehouse summaries may expose configured `primeShippingPrice`, nullable when disabled. Existing `defaultShippingPrice` always remains the normal price.

Illustrative response excerpt:

```json
{
  "data": {
    "isPrimeLocation": true,
    "warehouse": {
      "id": "<fulfillment-warehouse-id>",
      "defaultShippingPrice": 50,
      "primeShippingPrice": 20
    },
    "zoneWarehouse": { "id": "<zone-warehouse-id>" },
    "warehouseRouting": { "rerouted": false },
    "delivery": {
      "canDeliver": true,
      "coverageStatus": "INSIDE_BOUNDARY",
      "effectiveShippingPrice": 20,
      "shippingFee": 20,
      "defaultShippingPrice": 50
    }
  }
}
```

All existing location response fields remain present; the excerpt omits them for readability. Location resolution has no cart subtotal, so its effective fee is the geographic base fee before cart threshold/coupon rules.

Always return an explicit boolean. Manual location options cannot establish Prime eligibility. Keep `/locations/options` coarse and avoid putting location-specific flags or prime geometry in its cached output.

### Saved addresses

Each saved address adds root-level `isPrimeLocation` next to its existing `warehouse` field. Keep `warehouse` as the original geographic zone ID.

Cover every user and guest response: list, create, update, delete responses that return remaining addresses, default selection, and guest-to-user merge. Preserve their current array-versus-single-object envelopes.

Relevant routes are `/api/v1/users/me/addresses`, `/api/v1/addresses/guest`, their address/default routes, and `/api/v1/addresses/merge`. Retain the existing PUT compatibility routes alongside PATCH.

The FE uses the selected location/address flag. It must not use “any saved address is prime,” send an eligibility flag to claim a discount, or infer eligibility from a price of zero. Refresh on address selection, coordinate changes, and relevant resolver/address/cart/checkout responses. Missing fields from an older backend/client cache mean false until refreshed.

### Cart, checkout, and order

Recommended additive response fields are `data.isPrimeLocation` on customer cart responses and checkout summaries, plus an order-level `isPrimeLocation` snapshot at creation. This lets the FE reconcile a changed warehouse status at checkout and preserves the order's historical eligibility.

Keep existing pricing fields and meanings. No new client pricing inputs are needed. The order boolean is historical and must not later be recomputed from live warehouse geometry.

Prime themes remain app runtime behavior. Do not add Prime targeting to UI Builder, change Home layout contracts, or claim a numeric delivery ETA.

## 6. Saved-address freshness and coordinate editing

Recommended approach: persist `Address.isPrimeLocation` as the last computed snapshot, but derive the response value from current coordinates, warehouse configuration, and state. The stored flag is never financial authority.

- Compute and store the flag on user/guest address creation and coordinate updates.
- Preserve the current coordinate update/request behavior in this additive rollout. Evaluate Prime from the resulting saved coordinates with presence/finite checks; incomplete or unusable coordinates return false. The discovered partial-coordinate replacement bug is recorded for a separate fix rather than bundled with new request validation.
- Keep text-only edits from triggering unnecessary reverse geocoding. Refresh the response flag using current assigned-warehouse configuration.
- Share one presentation/enrichment path across list and single-address responses. Batch-load distinct assigned warehouses once per address list. Eligibility does not require Google reverse geocoding.
- Warehouse geometry, price, or fulfillment changes become visible on the next read. Do not synchronously update all saved addresses when a warehouse is edited.
- Legacy records missing the field still return a real boolean computed when possible; missing/unusable coordinates or warehouse produce false.
- Ownership transfer preserves the address's coordinates and zone warehouse. Present the transferred addresses using current eligibility.

This avoids a mass backfill, background worker, configuration revision system, or permanently stale FE theme. The persisted snapshot can differ from the live response after a warehouse edit; that distinction must be documented for direct database consumers.

## 7. Preserve the source warehouse in cart snapshots

Add `deliveryAddress.warehouse` to the cart schema and `buildCartDeliveryAddressSnapshot`; it stores the address's source zone warehouse. Cart-level `warehouse` continues to store the actual fulfillment warehouse. Do not change those existing meanings.

- User and guest address selection and `syncActiveCartAddressSnapshots` preserve the new source field.
- Keep synchronization scoped to active carts already referencing that owner's address.
- Do not persist a second cart eligibility flag as pricing authority. Derive cart eligibility from the current source/effective warehouses and coordinates.
- For legacy snapshots without the source field, recover the zone from the referenced saved address using the cart owner's authorization filter. Handle transferred guest address references without bypassing user ownership. If recovery is impossible, use normal pricing and false; never assume the effective warehouse was the source.
- Evaluate the actual cart fulfillment warehouse against the retained source, including when a caller explicitly rebinds the cart to another warehouse.
- Refresh prime status on reads and item/quantity changes, removal, address selection, and every cart merge response branch. Share eligibility enrichment, but preserve each existing response path's shipping behavior. GET and address-selection paths that already calculate shipping use the Prime-aware calculation; mutation/merge paths that currently default shipping to zero retain that existing value.
- Preserve current cart adoption/merge address-selection behavior; the feature does not choose a new address for the user.

When A enters maintenance, a cart holding A's address and B's fulfillment ID must remain non-prime even if B has its own prime polygon at those coordinates. Recovery of A does not create a new automatic warehouse-selection policy: eligibility becomes true when the actual fulfilling warehouse is A again under the existing selection flow.

## 8. Pricing order and final financial authority

Keep the existing pricing core in place. Share only Prime eligibility and the selection of the raw warehouse shipping price in location resolution, cart paths that already calculate shipping, both checkout calculation paths, and common user/guest order creation. Each caller retains its existing normal-price validation, threshold, coupon, wallet, rounding, and total calculation. Do not introduce a shipping calculation into legacy mutation/merge response paths that currently return zero.

The intended change at the existing shipping input is:

```js
const rawShipping = isPrimeLocation
  ? warehouse.primeShippingPrice
  : warehouse.defaultShippingPrice;
```

Eligibility must already establish that the prime price is configured and valid; zero is valid. Without Prime eligibility, this is the exact existing normal shipping input. The existing downstream sequence remains:

```text
baseShippingPrice = isPrimeLocation ? primeShippingPrice : defaultShippingPrice
shippingFee = itemSubtotal >= 3000 ? 0 : baseShippingPrice
netShipping = max(0, shippingFee - couponShippingDiscount)
finalTotal = merchandiseAfterCouponAndWallet + netShipping
```

Preserve the current EGP 3,000 threshold and its existing item-subtotal basis. Prime status remains true even when the threshold or coupon makes shipping free. A prime price of zero remains an explicit valid price. Coupon `shippingDiscount` discounts the chosen prime/normal shipping fee rather than the normal price unconditionally. Wallet and loyalty rules stay unchanged.

Do not replace checkout's existing calculation with the cart's quoted fee, extract a new general pricing engine, consolidate coupon/wallet code, change money representation or rounding, or reorder financial operations in this feature. Update only shipping input selection in the exported `applyCouponAtCheckoutService` as well, even though no current route imports it.

Do not introduce a separate Prime discount into `discountAmount` or `totalDiscount`. Prime selects the shipping tariff; existing coupon discounts keep their current meaning. Preserve merchandise subtotal, item prices, product promotions, coupon eligibility, wallet deductions, loyalty points, inventory side effects, and transaction/idempotency behavior for identical non-shipping inputs. Where a shipping-dependent value legitimately changes, demonstrate the exact expected change in tests.

Final order creation re-evaluates eligibility from cart coordinates and current warehouse configuration, within the order transaction's session for relevant database reads. Never trust an earlier quote or saved boolean. Preserve `resolveOrderCartWarehouse` behavior while retaining/recovering the source context needed to distinguish fallback.

Snapshot the resulting `isPrimeLocation` and shipping amounts in the new order. Keep the existing `shippingFee`, `shippingDiscount`, and `settlement.lockedNetShippingPiastres` financial semantics. Payment initialization, later payment completion, substitution, refunds, and order reads consume the locked order values; they must not recalculate against live Prime configuration.

Configuration can change between a preview and order submission, as normal warehouse prices can today. The final order remains authoritative. A guaranteed price lock or new quote-confirmation workflow is outside the confirmed scope.

## 9. Implementation sequence and file responsibilities

1. **Warehouse configuration and shared rules:** add the two model fields; add request validation and merged-configuration validation to warehouse create/update; implement the small shared delivery module using installed Turf; add focused geometry/configuration tests. Keep fulfillment routing in its existing module.
2. **Resolver and saved addresses:** extend resolver projections and response summaries; compute the root boolean and base price; add the address snapshot field; share fresh response enrichment across user/guest paths; preserve existing address input/update contracts.
3. **Cart context and presentation:** extend cart address schema/snapshot with source `warehouse`; support safe legacy recovery; share eligibility enrichment and existing priced response calculations without changing legacy zero-fee mutation/merge responses, repeating stock rebinding, or creating duplicate side effects. Keep the source field internal unless separately added to the documented public contract.
4. **Checkout and order:** change only the shipping-price input using shared Prime eligibility/price selection; retain the existing financial calculations and operation order; snapshot final order eligibility; pass the transaction session through new order-related reads; preserve coupons, threshold, wallet, loyalty, stock, and settlement behavior.
5. **Contract and verification:** document additive FE fields/examples and admin MultiPolygon payloads; extend focused tests; review final diffs and results. Perform separately authorized staging acceptance before release.

Expected edits: warehouse model/validators/service/repository and one delivery helper; location service; address model/service; cart model/service/snapshot; checkout service; order model/service and, only if needed for additive historical metadata, order presenter. Existing address validators, controllers, and routes normally need no changes. Do not touch unrelated dirty product/video/runtime files.

## 10. Verification and acceptance

### Geometry/configuration tests

- Each separate component qualifies; the gap does not; longitude/latitude order is correct.
- Edges and vertices qualify; hole interiors do not.
- Missing configuration, numeric zero price, equal prices, negative/nonfinite/too-high prices, and half-configured Prime are handled correctly.
- Reject empty/unclosed/degenerate/self-crossing geometry and invalid ring/component topology.
- Reject concave-boundary crossings and coverage holes even when all prime vertices are inside.
- Reject shrinking/clearing the parent boundary and lowering default shipping when the merged configuration becomes invalid; accept a correcting/clearing PATCH.
- Verify conflicting concurrent configuration writes cannot persist an invalid composite result if conditional writes are introduced.

### Flow and money tests

- User and guest resolver/address paths return the same boolean for the same location/configuration.
- Manual and outside-boundary fallbacks remain non-prime without changing delivery coverage policy.
- Overlap selection remains unchanged; a nonselected warehouse's prime area cannot grant benefits.
- Every saved-address response shape includes the flag, including legacy/default/merge paths.
- Coordinate movement into/out of Prime, text-only edits, and active cart snapshot synchronization update the new flag. Legacy partial/incomplete-coordinate behavior remains unchanged and cannot grant Prime with unusable resulting coordinates.
- Editing geometry/price/status changes response eligibility on the next read; persisted flags cannot force a discount.
- Maintenance disables Prime throughout resolver, addresses, cart, checkout, and order, even if fallback B's prime area matches.
- Legacy source recovery enforces ownership; missing/deleted references and explicit warehouse mismatch cannot claim Prime.
- Cart paths that already calculate shipping, checkout summary/coupon helper, and final order agree on fees for unchanged inputs; cover both owners. Existing zero-fee mutation/merge responses keep their legacy fee value while adding current eligibility metadata.
- Baseline response fixtures retain all existing fields, types, nesting, envelopes, status codes, and null/omission conventions after stripping only documented additions. Disabled/non-prime prices and totals remain identical. Existing request fixtures require no new inputs.
- Threshold below/at/above EGP 3,000, zero/equal prime price, free-shipping coupons, and wallet use preserve current pricing order and financial settlement invariants.
- Compare baseline and Prime-enabled runs with identical carts, warehouse state, products, coupons, wallet balances, and owners. For non-prime/disabled/rerouted cases, require identical existing pricing outputs and recorded financial side effects. For prime cases, require the expected shipping-dependent differences only: unchanged merchandise prices/subtotal, merchandise discount, wallet use, loyalty, and stock movements; correct shipping discount, total discount, payable total, payment amount, and locked settlement shipping.
- Cover normal, zero, and equal Prime fees; subtotal immediately below/at/above the threshold; no coupon, fixed/percentage merchandise coupons, and free-shipping coupons; no/partial/full merchandise wallet coverage; both user and guest checkout; COD, POS, InstaPay, and card creation. Reuse existing payment tests where applicable and avoid live financial side effects during local verification.
- Exercise actual order creation for registered/guest paths and card versus immediate-side-effect payment branches; do not substitute a pure helper test for final-order integration evidence.
- Geometry/status changes between quote and order affect the new order; changes after creation do not reprice the order, payment, or substitution.
- Submitted `warehouse`, `isPrimeLocation`, and shipping values in address/checkout/order bodies cannot override server decisions.
- Existing warehouse status/permission and address ownership checks remain effective.

Pricing acceptance is a release gate. The earlier 39-test baseline does not cover this full financial matrix and must not be presented as proof that Prime preserves the pricing core. Require focused integration evidence for actual checkout/order calculations and locked payment/settlement values, followed by staging acceptance with a released FE build. If those checks show unexpected differences, stop release and resolve them rather than accepting a changed core calculation.

Reuse `node:test` and existing mocked-query conventions. Extend `test/domains/warehouseValidators.test.js`, `warehouseStateTransitions.test.js`, `warehouseRoutingFlows.test.js`, and `addressCartSync.test.js`; add focused delivery geometry/pricing and order-creation tests where existing coverage is absent. The current routing test only exercises `resolveOrderCartWarehouse`, not full final-order pricing.

For release acceptance, use staging MongoDB transactions and configured payment paths to check a warehouse with two prime polygons, a non-prime point, an edge point, maintenance fallback, address edits, coupons, and a created order's locked amounts. Local mocked tests do not prove live Google Maps, MongoDB, payment-provider, or frontend behavior.

## 11. Current evidence and rollout boundaries

- The five existing warehouse/address test files passed **39/39** with:

```powershell
node --test --experimental-test-isolation=none --test-concurrency=1 test/domains/warehouseValidators.test.js test/domains/warehouseStateTransitions.test.js test/domains/warehouseFulfillment.test.js test/domains/warehouseRoutingFlows.test.js test/domains/addressCartSync.test.js
```

- The default isolated runner initially failed with sandbox `spawn EPERM` before executing assertions. The single-process runner above completed successfully. Redis reported caching disabled because `REDIS_URL` was unset in the test process.
- Local installed-Turf probes verified the containment pitfalls and MultiPolygon operations described above. The implemented helper now has runnable geometry and eligibility tests.
- Implementation uses the existing dependencies. No environment configuration, databases, runtime processes, commits, pushes, or deployments were changed for Prime.
- No bulk address/cart/order migration is required for correctness under the recommended live-read and safe legacy-recovery strategy. Do not fabricate historical Prime eligibility for existing orders; absence means unknown historical eligibility, not proof they were geographically non-prime.
- Configure Prime through the existing admin API only after backend validation is released and FE contract integration is verified. Per-warehouse rollback clears the prime geometry and price together; existing order amounts remain locked.
- Application/database compatibility must be checked before a code rollback that removes Prime pricing. Prefer configuration rollback while keeping correct historical order reads.

## 12. Implemented behavior and verification

The user authorized implementation after confirming multiple separate areas, no benefits on reroute, equal/free prices, and inclusive edges. The additive response fields, nullable configuration pair, live saved-address presentation, internal cart source context, historical order flag, and conditional delivery-configuration saves are now implemented. See `PRIME_LOCATION_API_CONTRACT.md` for the frontend and admin contract.

Shipping configuration is read in location resolution as well as cart GET, both checkout pricing services, and the shared user/guest final-order path. All now select the applicable raw warehouse shipping price before the existing threshold, coupon, wallet, payment, and settlement calculations. Downstream substitutions, refunds, and payments continue using the created order's locked amounts. Cart mutation/merge responses preserve their existing zero fee.

New verification files:

- `test/domains/warehousePrimeDelivery.test.js`: geometry containment, holes, separate components, boundaries, prices, operational state, malformed input, and reroutes.
- `test/domains/warehousePrimeConfiguration.test.js`: merged PATCH validation, explicit zero/clearing, original-value Mongoose save conditions, and stale legacy edits racing with Prime activation.
- `test/domains/cartPrimeContext.test.js`: internal source snapshots, public address preservation, safe owned legacy recovery, coordinate matching, session use, and missing references.
- `test/domains/primeLocationFlows.test.js`: resolver/manual response compatibility, refreshed saved-address flags, cart/checkout/coupon pricing, actual guest/user card order creation with captured mocked gateway amounts, and guest COD plus registered COD/POS orders. The immediate-order matrix checks merchandise subtotal/discount, partial/full wallet debit and transaction, stock quantity/revision, coupon usage, free/zero/equal shipping, threshold below/at/above, disabled/non-prime/rerouted cases, and locked settlement shipping/delivery amounts.

Existing routing tests now configure matching Prime areas on both source and fallback warehouses and still require normal fallback pricing and false eligibility. Existing address synchronization fixtures support current warehouse enrichment without weakening their assertions.

Local regression checks passed for warehouse/address behavior, money conversion, settlement, order fulfillment/presentation/InstaPay helpers, substitution payment/refund handling, quotes, loyalty guards, and transaction safety. These use mocked persistence and payment calls; they do not prove real transaction conflict behavior, live InstaPay screenshot uploads, provider webhooks, released frontend parsing, or production throughput. Complete the staging acceptance described in section 10 before activation. Historical orders are not backfilled or repriced.

The combined 19-file local run passed **134/134 tests**, with zero failures or skips, on 2026-10-05 using the single-process runner. A subsequent explicit-null normal-price guard check passed the focused configuration suite. Independent read-only review found no actionable defects in the geometry/configuration guards or the asserted order-pricing matrix. `git diff --check` passed. These checks establish local implementation evidence; the staging boundaries above remain open.
