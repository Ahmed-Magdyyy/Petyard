# Customer App UI Builder Plan

Status: superseded for implementation by `UI_BUILDER_FE_RECONCILIATION.md` after the frontend's 2026-09-24 specification arrived. This file records the earlier decisions and assumptions, several of which (especially `widget_group`/opaque children and public FAB configuration) conflict with what the current customer app renders. Do not implement this older contract as written. See `UI_BUILDER_IMPLEMENTATION_CHECKPOINT.md` for the paused code inventory.

## Objective and agreed scope

The super admin edits the customer app home sections, bottom navigation, and floating action button (FAB) inside the super-admin mobile app. The customer app receives a published JSON configuration and renders only types already supported by that app release. The app evaluates published visibility rules using its customer state. The frontend owns the structure and rendering of `data.children`; the backend stores this JSON without understanding individual child widget fields.

The first layout is `customer_home`. This identifier addresses one published response containing both home content and app-wide navigation. Internal storage may separate those concerns, but the public response remains one consistent snapshot.

The supplied response example establishes the outer envelope, five fixed navigation destinations (`home`, `videos`, `favorites`, `orders`, `profile`), a `chatbot` FAB, and a top-level `widget_group` with `visibility` and `children`. V1 navigation editing is limited to reordering and enabling/disabling those destinations and toggling the FAB. The frontend adds actual children when it saves the draft. The backend does not need to know their individual widget types to persist them.

Out of scope for V1: arbitrary code or CSS from the editor, arbitrary remote destinations, layouts for other screens, per-customer layout documents, experiments, scheduling, and new product/media upload workflows. Content references use existing domain resources. Adding a new renderer type requires a customer app release before an editor can publish that type.

## Current repository baseline

- `GET /api/v1/home-layout` returns `{ data: { sections } }` and localizes section names. It creates a singleton with the six fixed keys `banners`, `services`, `collections`, `recommended`, `categories`, and `shopByUserPet` if absent.
- `PATCH /api/v1/home-layout` changes positions of existing keys only. Unknown keys are ignored. There is no draft, publication, revision, navigation, or arbitrary widget data.
- Public home layout caching is keyed by Redis version and language. The current endpoint must retain its existing shape for clients that use it.
- The checked-in `petyard-admin-ui` is a separate web tool with no layout-builder screen; it is not the planned editor for this feature.
- This checkout contains neither the super-admin nor customer mobile app source, so renderer support and navigation semantics require frontend confirmation.

## Canonical concepts and invariants

- **Customer App Layout** is the editable configuration addressed by `layout_id`.
- **Layout Draft** is the current editable candidate and has a `draft_revision` used for concurrent-edit checks.
- **Layout Publication** is an immutable snapshot with a monotonically increasing public `revision`, `published_at`, and publishing actor. Only a Layout Publication is served to customers.
- `schema_version` describes the JSON format, not the content edit number. It changes only for a breaking contract migration.
- The backend assigns `layout_id`, `schema_version`, `draft_revision`, public `revision`, `published_at`, and actor metadata. The editor sends only editable content and its expected draft revision.
- Every public response is one snapshot: navigation and sections share the same public revision. A failed publish never partly changes the public layout.
- Re-publishing old content creates a new public revision; it never rewrites historical publications.

## Proposed interfaces and lifecycle

The paths below are proposed, not yet a committed frontend contract. All admin routes require the existing bearer authentication plus `SUPER_ADMIN`; public GET requires no authorization.

| Operation | Proposed route | Result |
| --- | --- | --- |
| Read public publication | `GET /api/v1/ui-layouts/customer_home` | Current published snapshot; `404 LAYOUT_NOT_PUBLISHED` before first publish |
| Read editor state | `GET /api/v1/admin/ui-layouts/customer_home` | Draft, draft revision, current public revision, and validation status |
| Save draft | `PATCH /api/v1/admin/ui-layouts/customer_home/draft` | Create at expected revision 0, or replace editable fields after expected-revision compare; returns next draft revision |
| Validate draft | `POST /api/v1/admin/ui-layouts/customer_home/validate` | Structured errors/warnings; no public change |
| Publish draft | `POST /api/v1/admin/ui-layouts/customer_home/publish` | New immutable public revision; invalid/stale drafts fail without public change |
| List publications | `GET /api/v1/admin/ui-layouts/customer_home/publications` | Revision, timestamp, actor, and summary |
| Restore publication | `POST /api/v1/admin/ui-layouts/customer_home/restore` | Copies old content into a new draft; publishing it creates a new public revision |

The public success envelope is `{ "success": true, "data": { "layout_id": "customer_home", "schema_version": 1, "revision": 18, "published_at": "...", "navigation": { ... }, "sections": [ ... ] } }`. The admin PATCH contains `expected_draft_revision`, `navigation`, and `sections`; it does not contain public metadata. On first save `expected_draft_revision` is 0. Every PATCH replaces the complete editable draft snapshot, including all navigation, sections, and children; omitted items are removed from the draft. It is not a JSON Patch operation. A stale expected revision returns `409` with the current draft revision so the editor can reload and show a conflict. Failed structural validation returns field paths, stable error codes, and readable messages.

Example sequence: create draft revision 1; preview and publish it as public revision 1; save an edit as draft revision 2 while public revision 1 remains unchanged; publish draft 2 as public revision 2. Two admins editing draft 2 cannot both overwrite it: the second save with expected draft revision 2 fails after the first save produces draft revision 3. Restoring public revision 1 creates a new draft and, after publish, public revision 3.

Publish is idempotent for an unchanged draft: a repeated request for the same already-published draft returns the existing public revision. Each successful publication records the content hash, source draft revision, actor, and timestamp.

The super-admin mobile app previews its unsaved local state immediately and can reload the saved draft from the admin read route to verify persistence. That preview must use the same rendering rules as the customer app; if the two mobile apps do not share renderer code, frontend visual QA must compare their output for the same contract fixtures. There is no public draft endpoint and no special backend preview token in V1.

## Contract boundaries

The backend validates the outer document and stores the complete child JSON; the customer app owns child structure, rendering, and child-specific validity. JSON is data only: the backend does not execute it, and the customer renderer must not execute supplied code or inject unsanitized HTML. The backend applies a strict allowlist to navigation destinations and FAB actions. The frontend contract determines child `type`, `data`, and child action fields.

The frontend should document each child widget's type key, editable fields, content references, empty/loading/error behavior, localization, supported app versions, and a renderable fixture. This is a frontend responsibility and can evolve without a backend validator for every child type. The backend needs only a documented outer shape and generic safety limits. Empty `children` is valid in a draft; the customer app should render no blank section for an empty published group.

Shared structural validation for V1:

- Unique stable IDs for top-level sections and unique navigation keys; no duplicate positions/orders after server normalization. The frontend owns IDs nested inside opaque `children`.
- Finite limits for request size, section count, children count, nesting depth, string lengths, and localized content. Proposed starting limits are 256 KiB for the JSON body, 50 top-level sections, 500 total child objects, depth 8 within `children`, and 4,000 characters per text field. Confirm against real frontend fixtures; all are below the existing 5 MB Express body limit.
- A strict allowlist for outer section types, the five fixed navigation destinations, icon keys, label keys, FAB action type, and visibility values. Child widget types and child data remain opaque. Reject unknown outer keys on editor writes instead of silently dropping them.
- A publishable navigation configuration always preserves a reachable home route and agreed essential destinations. Disabled items cannot accidentally become the only route to a required screen.
- The frontend validates any asset/product/category/collection references it puts in children and handles later deletion or inactivity at runtime. The backend cannot validate child-specific references while children are opaque.
- `enabled: false` retains an item in both draft and public JSON so the frontend can round-trip the same shape; the customer client must not render it. Disabled content is still public data and must not contain secrets.

`visibility` is a display rule, not authorization. The public JSON can therefore be shared/cached across users. The customer app evaluates it after it has the relevant authentication, pet, and selected location state, and reevaluates when that state changes. `pet_types` matches any pet owned by the customer. A customer with no pets does not match a nonempty `pet_types` list. The current backend recognizes `dog`, `cat`, `bird`, and `small-animal`. For the first release, the only publishable `prime_location` value is `"any"`, which imposes no location condition; a more specific location rule needs a named location source and client semantics before it can be enabled.

Because every customer can fetch the same published JSON, visibility must never be used to hide secret content, private prices, or authorization-controlled actions. Any sensitive data remains protected by its existing domain endpoint.

## Persistence and concurrency

Use a unique `layout_id` record containing the latest draft revision and the pointer to the current publication. Store each publication as an immutable full snapshot with a unique `(layout_id, revision)` index. A full snapshot makes rollback and historical inspection independent of later edits or deleted resources. Store editor/audit metadata separately from the public payload.

Draft replacement uses a compare-and-swap against `draft_revision`. Publish validates the exact draft revision, inserts its publication, and changes the current-publication pointer atomically in a MongoDB transaction. If transactions cannot be guaranteed in an environment, the implementation needs an equivalent atomic single-document publication design before rollout. Publication must not depend on Redis availability.

The public read uses only the published pointer and snapshot. It cannot accidentally return the draft. Use an ETag derived from the public revision and a short cache lifetime; invalidate server cache after a successful publication. Redis failure falls back to MongoDB, and an invalidation failure is bounded by TTL. Draft saves do not invalidate the public cache.

## Authorization and operational rules

- Only an authenticated, phone-verified `superAdmin` can create, save, validate, preview, publish, inspect history, or restore in V1. The API checks the role on every admin operation. The editor UI's own gate is not authorization.
- Public GET is read-only and does not require a bearer token. Avoid making a bad optional token suppress an otherwise public layout if this is the intended client behavior; settle this in the route contract.
- Record who created, saved, published, and restored a layout, along with timestamps and revisions. Do not place credentials, tokens, or private customer data in layout content or audit diffs.
- Publishing errors are explicit: `400` malformed input, `401/403` auth, `404` unknown layout/publication, `409` stale revision or duplicate create, and `422` well-formed but unpublishable content. Stable machine codes and field paths support editor feedback.

## Customer app behavior

- Bundle a safe static navigation/home fallback. On first install, fetch the publication at app start or home entry, then use a cached last-known-good snapshot while offline.
- If no publication exists, network fails, schema version is unsupported, or the payload fails client validation, keep the last-known-good snapshot or the bundled fallback. Unknown widget types should be skipped with telemetry; navigation should use a safe static fallback as a whole.
- The app must only route to destinations implemented in that release. A backend publication that requires a newer renderer must be blocked or scoped to compatible app versions before release.
- The frontend resolves child content references through existing domain endpoints or its defined data sources. Opaque child data may contain static copy or IDs according to the frontend widget schema. An older app must skip an unknown child widget safely, and its navigation must retain a static fallback.

## Migration and rollout

1. Obtain the frontend's outer-payload agreement, fixed route/icon/label registry, supported app versions, visibility behavior, and at least one populated child fixture for preview testing. Freeze schema version 1 for the outer document. Individual child schemas remain frontend-owned.
2. Implement the new storage and admin/public routes behind a default-off publication/read rollout switch. Keep `/api/v1/home-layout` working with its existing `{data:{sections}}` shape for old clients.
3. Seed the first draft by mapping the current six section keys and their order where matching renderers exist. Supply the existing static navigation as the starting navigation. Do not fabricate widget data for types the frontend has not defined. Check for duplicate singleton records and make seeding repeatable.
4. Super admin previews and publishes a known-good first snapshot. Release the customer app with renderer registry, last-known-good cache, and static fallback; enable its new endpoint after the backend publication is available.
5. Enable editor writes and monitor validation failures, unsupported types, fetch errors, fallback use, and publish/rollback events. Roll back by publishing an earlier snapshot or disabling the new client read switch; old clients continue to use the legacy endpoint.
6. Retire the old endpoint only after supported old client versions no longer call it. Any legacy sunset is a separate decision.

Older clients will continue to see the legacy six-section layout. New widget children and navigation edits do not appear in those clients; attempting to project them into the old response would misrepresent the old client contract.

## Acceptance gates

- Contract fixtures prove the backend accepts the agreed outer payload and round-trips opaque children without dropping or rewriting fields. Frontend tests prove its supported child widgets render, including Arabic and English, actions, and visibility states.
- Unauthorized users and ordinary admins cannot call any editor route. Public GET never includes draft or actor metadata.
- First create, duplicate create, concurrent draft saves, concurrent publish, invalid publish, repeated publish, history, and restore are covered by integration tests. A failed publish leaves the previous public revision intact.
- Cache/ETag checks show publication is visible after commit and draft saves leave the public response unchanged, including when Redis is unavailable.
- The legacy home-layout response and its current update behavior pass regression checks until retirement is authorized.
- Super-admin preview and customer app visual QA compare the same layout fixtures and cover each widget, empty references, guest/no-pet/no-location states, offline fallback, unsupported schema/version, and navigation to every enabled destination.
- Release gate: one approved snapshot is published in a non-production environment and rendered by the target customer app build; production enabling requires the agreed rollout check.

## Open contract items requiring frontend/product input

1. The frontend's populated-child fixture, generic child nesting/size limits, renderer fallback behavior, and preview method. The backend will not validate each child widget's fields.
2. The super-admin and customer mobile apps' icon/label registries and renderer fixtures. Confirm whether navigation in `customer_home` applies app-wide.
3. Whether `prime_location` should later support a selected address, warehouse, or other location source. V1 uses `"any"` only. Guest and missing-location behavior for future values must be defined then. `pet_types` matching any owned pet is agreed.
4. Minimum supported customer app versions and whether publication should target all versions or be gated by app version/capability.
5. Confirm the proposed payload limits against a real populated frontend fixture. Disabled items remain in public JSON and are client-hidden.
6. Confirm that the customer app uses its bundled or last-known-good fallback for `404 LAYOUT_NOT_PUBLISHED` before first publication.
7. Whether the super-admin and customer mobile apps share rendering code; if not, agree the fixture-based visual comparison used at release.

The plan is ready to finalize once these items are resolved. Backend implementation must preserve unknown child fields exactly and must not invent a child widget catalog.
