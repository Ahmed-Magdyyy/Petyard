# Customer Home UI Builder backend handoff

Status: implemented in this checkout for integration, **not deployed or production-enabled**. Verification updated on 2026-10-01. The complete frontend walkthrough is now available in [UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md](UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md), with ordered flows, field dependencies, request/response examples, recovery behavior, and rollout limitations. The FE document is a v1 proposal and is not treated as permission to change the existing live Home API. See UI_BUILDER_FE_RECONCILIATION.md for keep/change/remove decisions; the checked integration guide and current source take precedence over older summaries.

## Live-compatibility boundary

- Existing GET/PATCH /api/v1/home-layout remains unchanged by default for old customers/admins. GET switches to the published contract only when UI_BUILDER_PUBLIC_CUTOVER_ENABLED=true; PATCH remains legacy.
- Legacy PATCH retains its existing admin permission and only changes the old six-section layout; every new UI Builder editor operation is super-admin-only and does not read that legacy draft.
- New published response is also available at GET /api/v1/ui-layouts/customer_home for integration. It returns a data/meta envelope, sections + navigation, immutable version metadata, checksum, ETag/304, and private revalidation. Server cache keys include the transactionally advanced publication epoch and target dimensions. The /home-layout flag must be enabled only at a coordinated customer-app cutover.
- Super-admin editor routes use /api/v1/admin/home-layouts; catalog/assets use /api/v1/admin/ui-builder.
- Publication/scheduling/rollback return 503 UI_LAYOUT_RELEASE_DISABLED unless UI_BUILDER_PUBLISH_ENABLED=true. Test publications and the worker have been exercised against the user-approved copied database and isolated local Redis. Production publication and cutover have not been enabled.
- The chatbot button setting is saved as optional content.floating_action_button in drafts and versions. It is omitted from the v1 public payload. Catalog reports chatbot_fab_config: false until the customer app can consume it.

## Admin flow and routes

All admin routes require the existing verified super-admin bearer token. Success has data and meta.request_id. Errors have error.code, error.message, error.request_id, and error.details.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/v1/admin/ui-builder/catalog | Supported section schemas, navigation, limits, truthful capabilities. |
| POST / GET | /api/v1/admin/ui-builder/assets | Upload a raster image / list ready UI Builder assets. |
| POST / GET | /api/v1/admin/home-layouts/drafts | Create blank/clone / list drafts. |
| GET / PATCH / DELETE | /api/v1/admin/home-layouts/drafts/:draftId | Read / full-snapshot autosave / archive. |
| POST | /api/v1/admin/home-layouts/drafts/:draftId/validate | Field-level publish validation. |
| POST | /api/v1/admin/home-layouts/drafts/:draftId/preview | Immutable expiring preview token. |
| DELETE | /api/v1/admin/home-layouts/previews/:previewId | Revoke a preview. |
| POST | /api/v1/admin/home-layouts/drafts/:draftId/publish | Immediate or scheduled publication. |
| POST | /api/v1/admin/home-layouts/drafts/:draftId/cancel-schedule | Return scheduled draft to editable draft. |
| GET | /api/v1/admin/home-layouts/history | Immutable version history. |
| GET | /api/v1/admin/home-layouts/versions/:versionId | Historical snapshot. |
| POST | /api/v1/admin/home-layouts/versions/:versionId/rollback | Revalidate and create a new publication. |
| GET | /api/v1/admin/home-layouts/audit | Builder audit entries. |

Create a blank draft with:

~~~json
{
  "layout_key": "customer_home",
  "name": "October Home",
  "source": { "type": "blank" }
}
~~~

To clone, use a published source with version_id. A blank draft is allowed but cannot publish. The full-snapshot PATCH requires the If-Match header containing the quoted current revision, with name, complete targeting, and complete content. Send a stable UUID in X-Client-Mutation-Id for retry deduplication. Omitted sections/navigation entries are removed.

~~~json
{
  "name": "October Home",
  "targeting": {
    "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
    "min_app_version": null, "max_app_version": null,
    "audience": "all", "priority": 0
  },
  "content": {
    "sections": [
      {
        "id": "b8e793a5-dcde-49a5-b207-e79cc24b6a88",
        "section_type": "banners",
        "name": "Main banners",
        "position": 0,
        "data": {}
      }
    ],
    "navigation": {
      "items": [
        {
          "key": "home", "label_key": "home", "icon_key": "home",
          "destination": "home", "order": 0, "enabled": true
        }
      ]
    },
    "floating_action_button": { "enabled": true }
  }
}
~~~

Publish requires Idempotency-Key with a UUID and a body containing revision, mode (now or schedule), and change_note. Scheduling also needs scheduled_for as a UTC ISO timestamp at least two minutes ahead. Rollback requires the same idempotency header and a change note. A global version must exist before targeted versions. Equal-priority overlapping target scopes are rejected.
Canceling a schedule advances the draft revision. Fetch the draft again before editing or re-scheduling; an old delayed queue job cannot publish the replacement.

## Preview, assets, and customer app

- Preview creation requires a synchronized server draft revision; its token reads GET /api/v1/home-layout/preview?token=.... It is no-store, expiring and revocable. The returned preview_url is relative to the API origin. Catalog reports remote_preview: false until the customer app implements token entry.
- The existing media pipeline is reused with multipart POST /api/v1/admin/ui-builder/assets, fields image and usage (promo or dynamic_item). It verifies JPEG/PNG/WebP content, size/dimensions, re-encodes the upload, and records a ready public URL. This differs from the FE document's recommended direct-to-storage slot + completion pair. Product/category/brand images already present in public catalog records may also be referenced.
- Image URLs not registered as ready UI Builder assets or used by public catalog records cannot publish. Product/category/brand action values must be real MongoDB ObjectIds; numeric IDs in the FE document are illustrative, not usable database IDs here.
- Published resolution accepts X-App-Platform, X-App-Version, X-App-Locale, X-Location-Id, and X-Country-Code headers; authenticated audience comes from the bearer token. Location IDs may be an existing MongoDB ObjectId or a UUID. Country-targeted layouts require the app to send X-Country-Code; otherwise the global layout is used.
- admin_promo and dynamic_section use the supported v1 data fields; all ten built-in section types use an empty data object. widget_group, children, and composed_section are not publishable.
- The super-admin mobile app owns Hive-first local persistence, conflict resolution, local preview, and the clean-before-publish gate. The backend only publishes its persisted server draft.

## Structure cleanup on 2026-10-01

The request pipeline is routes, request validators, controllers, and business services backed by existing models. Validators normalize request input into `res.locals.uiLayoutInput`; controllers add the authenticated actor and return HTTP responses. Publication eligibility, reference checks, concurrency, retry replay, and transactions remain enforced by the business service and worker paths.

- `uiLayout.limiters.js` owns the independent preview rate-limit policies.
- `uiLayout.middleware.js` owns bounded multipart parsing, the release guard, and domain error handling.
- `uiLayout.release.service.js` owns immediate/scheduled release orchestration, including best-effort enqueue recovery after a schedule is durably accepted.
- `uiLayout.catalog.js` owns editor catalog schemas and live publication/scheduling capabilities.
- `uiLayout.constants.js` owns shared supported values, validation patterns, schema version, and layout/upload limits.
- `uiLayout.serialization.js` owns the existing pure draft/version/public/asset DTO mapping and timestamp formatting.
- No generic repository framework was added. Direct model access remains valid for the confirmed repository/model architecture; transactional lifecycle operations were not split across new persistence layers.

The baseline suite passed 36/36 before edits. After cleanup, 43/43 tests passed, including new HTTP and release-orchestration regressions. Source comparison confirmed identical route methods, paths, and order, and that the transactional service changed only by extracting response mapping. This cleanup did not rerun live MongoDB, Redis, or media integration, change any API contract or release configuration, or modify Postman.

### Whole-module follow-up audit

The follow-up inspected every module file, the standalone worker, route mounts, legacy integration, and the shared configuration/media/serialization paths that affect this module. Responsibilities now have these explicit owners:

| File in `src/domains/uiLayout/` | Responsibility |
| --- | --- |
| `uiLayout.routes.js` | Route wiring and middleware order only. |
| `uiLayout.validators.js` | HTTP request shape, IDs/headers/query parsing, and normalized controller input. |
| `uiLayout.controller.js` | HTTP responses/cache headers and authenticated actor handoff. |
| `uiLayout.service.js` | Draft/publication lifecycle, business checks, model persistence, transaction boundaries, revision protection, retry replay, previews, history/audit, and public resolution. |
| `uiLayout.release.service.js` | Accept the service result, then deliver scheduled work to the queue without undoing durable acceptance on enqueue failure. |
| `uiLayout.model.js` | Stored schemas, statuses, constraints, and indexes. |
| `uiLayout.constants.js` | Single definitions of shared supported values, patterns, and limits. |
| `uiLayout.catalog.js` | Editor schemas and runtime capability reporting. |
| `uiLayout.contract.js` | Pure content/targeting validation and content normalization, including publish-only rules. |
| `uiLayout.references.js` | Availability checks for referenced catalog records and images. |
| `uiLayout.targeting.js` | Target defaults, scope identity, version comparison, overlap, matching, and deterministic ranking. |
| `uiLayout.assets.js` | Safe image decoding, existing media-provider reuse, ready-asset persistence, cleanup on registration failure, and library paging. |
| `uiLayout.serialization.js` | Shared response mapping, including one asset mapper for upload and list. |
| `uiLayout.pagination.js` | Cursor encoding/decoding and stable timestamp-plus-ID boundaries. |
| `uiLayout.middleware.js` | Multipart parsing, release guard, and operational HTTP error handling. |
| `uiLayout.limiters.js` | Independent preview read/create rate policies. |
| `uiLayout.error.js` | Domain operational-error type shared across execution paths. |
| `uiLayout.queue.js` | BullMQ connection/job delivery/reconciliation setup and connection cleanup. |
| `uiLayout.jobs.js` | Due-job processing, stale-job protection, failure classification, audit, and in-app failure-alert attempt. |

The worker entry point remains outside the domain at `src/workers/uiLayoutPublish.worker.js`: it owns process startup, worker wiring, and shutdown. No generic repository wrapper or separate file per lifecycle method was added; transactionally related persistence stays together in the business service, using the confirmed repository/model option.

The audit reproduced two pre-existing navigation-validation defects before fixing them: a null entry could throw instead of returning field errors, and inherited object-property names could bypass the fixed-destination lookup. The shared validator now rejects unsupported/non-string keys and safely handles malformed entries. The new regression cases cover draft and publication checks without changing supported payloads.

After the follow-up, 45/45 focused tests passed. Additional assertions preserve complete asset DTOs and timestamp precision and check ordered/equal/inverted app-version ranges. Before/after comparison confirmed identical catalog JSON, unchanged route wiring, and unchanged transactional lifecycle service body apart from its constant imports. An independent read-only reviewer found no issue in the HTTP wiring or the bounded navigation/constants/catalog follow-up; this is not a guarantee against all defects.

Syntax and whitespace checks passed for all 19 domain files, eight focused test files, the worker entry point, and the legacy route file (29 files total). All 48 JSON examples in the frontend integration guide still parsed successfully. The tracked legacy-route diff also passed `git diff --check`.

Live MongoDB, Redis, media, deployment, and mobile checks were not rerun for this audit. Earlier integration evidence below remains historical evidence, not a fresh live validation of this refactor. Unrelated user changes, `.env`, Postman, publication/cutover flags, and Git history were not modified by this audit.

## Backend verification completed on 2026-10-01

- The focused suite passed 45/45 after the whole-module follow-up: contract/catalog, validation, permissions, draft concurrency, previews, publication, targeting, rollback, pagination, scheduled failure handling, request-middleware ordering, extracted limiter/upload behavior, release enqueue recovery, and malformed/fixed-destination navigation regressions.
- `scripts/testUiLayoutMongoIntegration.js` passed real MongoDB transactions and HTTP checks against the explicitly approved copied `petyard` database: revision conflicts, retry deduplication, immutable publication, preview/revocation, history/rollback, ETag/304, and legacy/cutover routing. The harness refuses unexpected targets and pre-existing UI Builder collections.
- With `UI_LAYOUT_TEST_MEDIA=true`, a real multipart image upload used the configured Bunny image-storage provider. The returned WebP URL was publicly readable, the ready asset appeared in the library, and its reference passed draft validation, preview, and publication. The temporary object was deleted through the existing media helper; a direct storage read then confirmed 404. A CDN may retain a cached copy until its own expiry.
- With `UI_LAYOUT_TEST_REDIS=true` and `UI_LAYOUT_TEST_STANDALONE_WORKER=true`, the separate `src/workers/uiLayoutPublish.worker.js` process started and processed an actual delayed publication scheduled more than two minutes ahead in UTC. The earlier in-process test also proved reconciliation of an already-due schedule.
- Created UI Builder collections and the unique `ui-layout-it-<UUID-without-hyphens>` Redis namespace were removed, and cleanup was verified. Credentials were supplied in the process environment rather than saved in project files.
- The first media attempt was blocked by the execution sandbox's refusing Axios proxy (`ECONNREFUSED 127.0.0.1:9`). The approved execution outside that restriction passed using unchanged product code.
- A real simultaneous-publish check exposed a retry conflict: one identical request returned 201 and the other returned 409 after MongoDB retried its transaction. Draft save, publish, schedule, and rollback now share a recorded-operation lookup that runs again inside every transaction attempt. The retained MongoDB/HTTP regression checks send identical requests concurrently and verify identical responses with no duplicate revision or version.

These are backend integration results. They do not prove mobile rendering, Hive behavior, server supervision, production performance, or delivery of a real scheduled-failure alert. The worker test confirms startup and delayed execution; production graceful shutdown and restart recovery still need deployment-environment checks.

## Remaining release gates

1. The FE must send UUID section/item IDs according to section 5 of its specification and actual MongoDB ObjectIds for catalog actions. Illustrative values such as dyn-item-1, 81, and 1074 are not valid write payloads for this backend.
2. Provision the release environment and confirm its MongoDB transaction support, Redis connectivity, media configuration, and required indexes. Copied-database, local Redis, and real image-provider integration have passed; production resources have not been exercised.
3. Verify super-admin Hive synchronization, customer renderer fixtures, and remote preview entry. The app's current chatbot button remains app-owned.
4. Configure and supervise src/workers/uiLayoutPublish.worker.js only when enabling publication. Its durable reconciliation reads scheduled MongoDB snapshots and enqueues BullMQ work. A permanent failure leaves the old live version active, records schedule_failure, and attempts an in-app alert to the responsible admin; confirm that alert in staging.
5. Stage a known-good global publication, test Android/iOS/web and offline fallback, then explicitly coordinate the /home-layout response cutover. Do not infer cutover or deployment authorization from this handoff.
