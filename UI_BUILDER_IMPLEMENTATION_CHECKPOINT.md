# UI Builder Implementation Checkpoint

Historical checkpoint only. The frontend Markdown arrived on 2026-09-24 and implementation resumed; the code/file inventory and verification statements below describe the **old paused state**, not current work. See `UI_BUILDER_FE_RECONCILIATION.md` and current tests for the new state. No UI Builder release, deployment, or publication has occurred.

## Agreed decisions so far

- V1 serves `customer_home`: home sections plus the five fixed navigation destinations and chatbot FAB.
- The builder runs inside the super-admin mobile app. Only a super admin may save, publish, inspect history, or restore.
- Every draft PATCH sends the complete navigation and sections, including every child. Missing items are removed from the draft.
- The frontend owns the shape and rendering of `data.children`; the backend treats children as opaque JSON within generic limits.
- The customer app evaluates display visibility. `pet_types` matches any owned pet. `prime_location` is limited to `"any"` until its specific meaning is defined.
- Existing `/api/v1/home-layout` behavior is preserved for older clients.

## Files added or changed for this partial implementation

- Added `src/domains/uiLayout/uiLayout.contract.js`: outer payload validation and generic opaque-child limits.
- Added `src/domains/uiLayout/uiLayout.model.js`: layout draft/current-publication record and immutable publication records.
- Added `src/domains/uiLayout/uiLayout.service.js`: draft compare-and-swap, public read, transactional publish, history, and restore.
- Added `src/domains/uiLayout/uiLayout.validators.js`, `uiLayout.controller.js`, and `uiLayout.routes.js`: HTTP validation, response envelopes, and super-admin/public routes.
- Changed `src/app/routes.js` only to mount `GET /api/v1/ui-layouts/customer_home` and `/api/v1/admin/ui-layouts/customer_home` routes.
- Updated `UI_BUILDER_PLAN.md`; the existing untracked `CONTEXT.md` has the Customer App Layout glossary added after its pre-existing Videos glossary.

Do not assume these files match the frontend contract yet. The source tree has other active, unrelated dirty changes (videos, product, environment, and runtime files); preserve all of them. No commit, push, deploy, reset, clean, stash, feature enablement, or database write was performed for UI Builder.

## Verification performed

- `node --check` passed for all six new `src/domains/uiLayout/*.js` files and `src/app/routes.js`.
- No UI Builder tests have been written or run.
- No database transaction, HTTP route, app startup, cache behavior, or mobile rendering has been exercised.
- The current backend code is **not release-ready**. Its provisional fields, limits, route paths, response envelopes, concurrency handling, and storage behavior need review against the incoming frontend document.

## Exact next steps after receiving the frontend Markdown document

1. Read the complete frontend document and compare its create/edit/preview/publish/read flow field by field against `UI_BUILDER_PLAN.md` and the six new domain files. Record keep/change/remove decisions before editing code.
2. Confirm exact route paths, request and response envelopes, `schema_version`, section and child handling, visibility semantics, navigation keys, error behavior, and fallback behavior. Treat the frontend document as the contract input, while preserving existing backend security and legacy-client guarantees.
3. Reconcile the partial implementation. Review transactional publish and draft concurrency carefully. Keep the repository's `src/domains/<domain>/{model,service,controller,routes,validators}` structure and avoid adding needless layers.
4. Add targeted contract and service tests, including opaque child round-trip, stale PATCH conflict, publish atomicity/idempotency, public draft isolation, restore, role protection, and legacy route regression. Run the smallest relevant gates, then review the full UI Builder diff.
5. Leave publication and rollout disabled until the frontend app is ready and the user explicitly authorizes external release steps.
