# Fixed product bundles

**Latest assistant mixed-cart connection, 2026-10-24:** the existing product
proposal/receipt and checkout-estimate owners now reuse the shared merchandise
planner and public group projection for carts containing bundles. Product request
and confirmation contracts remain unchanged; display arrays are additive and
subtotals count both kinds of merchandise once. Only the existing read-session
and group-projection helpers were exported here. 513 selected local checks pass,
including 16 new focused cases; no scoped independent-review finding. No new
runtime file/store/lifecycle or payment/refund change. The flag stays off; native
combined-path and older-app/Flutter acceptance remain pending. Evidence:
../../../.scratch/assistant-bundle/assistant-mixed-cart/verification.json.
The two mixed-cart assistant caller blockers in the earlier note below are resolved.

**2026-10-24:** existing assistant catalog cards and cart-proposal APIs now expose
source-bound published-bundle suggestions and explicit cart confirmation, using
these existing helpers. 335 selected local assistant checks pass; independent
review found no scoped issue. No bundle module or core commerce owner changed
in this slice. No store/model/dependency/runtime file was added, no database or
provider was called, and the existing bundle flag stays off. See the frontend
handoff's first section and
../../../.scratch/assistant-bundle/assistant-suggestions/verification.json.
Ordinary-product assistant additions and assistant checkout previews for a cart
already containing bundles remain the next shared-helper integration. Native
combined-path database proof and older-app/staging/Flutter acceptance remain pending.

The existing signed-in order endpoint now accepts bundle merchandise behind the
existing disabled flag. Cart/checkout readiness follows that flag and validated
pricing. Checkout address validation and internal card-key fallback are reused;
no runtime file, client protocol or separate payment/refund owner was added.
513 selected local checks pass; the temporary Postman payment simulator is stopped.
No real provider or database acceptance is claimed. Older-app production policy
and native/staging/assistant/frontend acceptance remain pending. Latest evidence:
../../../.scratch/assistant-bundle/shared-public-orders/verification.json.

Bundles are merchandise in the existing cart, checkout, order, payment,
cancellation and return flows. Reuse the existing owners unchanged wherever they
already satisfy the requirement. Bundle definitions remain a separate collection.

## Retained responsibilities

- SuperAdmin management of fixed products, exact variants, quantities and EGP price.
- Product-shaped customer cards and availability calculated independently in each
  selected warehouse, using stock of every exact component.
- Shared cart validation, price/stock planning and existing assistant confirmation.
- Purchased component snapshots, private physical inventory rows and the additive
  public order bundles array. Existing product items retain their contract.
- Compatibility checks that prevent partial component substitution or double pricing.

The existing gate remains off and public bundle purchases remain blocked. This
local integration does not complete public purchasing or native acceptance.

Internal order assembly and card confirmation reuse existing owners. Existing
whole-order cancellation and both return entry points pass local mocked tests;
their service, inventory and refund code remains unchanged. Cancellation retains
existing ordinary-shortage proof for strict saved-price validation. No new
lifecycle or receipt fields. 500 selected checks pass; native persistence and
older-app compatibility remain pending. Latest evidence:
../../../.scratch/assistant-bundle/shared-order-reversals/verification.json.

## Retired code removed on 2026-10-23

The standalone shopping interface, its request counters, duplicate checkout/order
creation, bundle card initialization/completion/refunds, cancellation/return and
related duplicate inventory helpers have been removed. The optional cart checkout
fingerprint helper is also removed. Only tests/fixtures exclusive to those removed
implementations were retired; shared behavior tests remain.

There are verified source/test backups and an exact removal manifest in
../../../.scratch/assistant-bundle/retired-lifecycle-cleanup/. The User model and
service match committed HEAD. All 411 selected local checks pass, with mocked
persistence/providers. No database records/indexes or deployed process changed.

## Approved shared-schema cleanup

The owner approved removing the six old Order receipt fields and their validation.
The exact four-file patch is now applied. Component integrity and active pending
ordinary-substitution checks remain, as does redaction of legacy stored metadata.
The shared payment/refund/inventory owners and wallet schema are unchanged.
Historical experimental cancelled orders depending on the old receipt exception
may no longer validate; no database inspection or migration was performed.

Use ../../../AI_ASSISTANT_BUNDLE_SHARED_COMMERCE_CONTRACT.md for current behavior;
older standalone lifecycle documents are historical and are not implementation
instructions. General payment hardening remains outside this bundle work.
