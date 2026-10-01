# PetYard UI Builder: Complete Frontend Integration Guide

Contract: schema version 1. Last checked against the backend source: 2026-10-01.

Audience: the super-admin mobile app developer, customer app developer, backend developer, and QA.

This document describes the backend that is implemented in this checkout. It replaces assumptions in the earlier proposal with the actual routes, fields, state transitions, validation, and limitations. It is an integration contract, not confirmation that the code has been deployed or that the customer app is already wired to it.

The backend integration checks have passed against a copied MongoDB database, local Redis, a separate publishing worker, and the real image provider. Frontend rendering, Hive behavior, and deployment-environment checks still need their own acceptance tests.

## Contents

1. [Scope and ownership](#1-scope-and-ownership)
2. [Terms, identities, and values to retain](#2-terms-identities-and-values-to-retain)
3. [Complete route inventory](#3-complete-route-inventory)
4. [HTTP rules, authentication, and response parsing](#4-http-rules-authentication-and-response-parsing)
5. [Lifecycle and prerequisites](#5-lifecycle-and-prerequisites)
6. [First publication: exact ordered walkthrough](#6-first-publication-exact-ordered-walkthrough)
7. [Catalog and capability discovery](#7-catalog-and-capability-discovery)
8. [Create, clone, open, list, and archive drafts](#8-create-clone-open-list-and-archive-drafts)
9. [Upload and select images](#9-upload-and-select-images)
10. [Save the complete draft](#10-save-the-complete-draft)
11. [Section and action field reference](#11-section-and-action-field-reference)
12. [Navigation and chatbot setting](#12-navigation-and-chatbot-setting)
13. [Targeting and layout resolution](#13-targeting-and-layout-resolution)
14. [Validate before preview or release](#14-validate-before-preview-or-release)
15. [Create, open, and revoke a preview](#15-create-open-and-revoke-a-preview)
16. [Publish immediately](#16-publish-immediately)
17. [Schedule, observe, cancel, and reschedule](#17-schedule-observe-cancel-and-reschedule)
18. [History, version details, and rollback](#18-history-version-details-and-rollback)
19. [Audit trail](#19-audit-trail)
20. [Customer published reads and caching](#20-customer-published-reads-and-caching)
21. [Hive, offline work, synchronization, and conflict recovery](#21-hive-offline-work-synchronization-and-conflict-recovery)
22. [Errors and recovery decisions](#22-errors-and-recovery-decisions)
23. [Legacy Home APIs and coordinated cutover](#23-legacy-home-apis-and-coordinated-cutover)
24. [Complete use-case playbooks](#24-complete-use-case-playbooks)
25. [Integration acceptance checklist](#25-integration-acceptance-checklist)
26. [Current limitations and outstanding integration decisions](#26-current-limitations-and-outstanding-integration-decisions)
27. [Backend source map and maintenance](#27-backend-source-map-and-maintenance)

## 1. Scope and ownership

The builder configures the customer Home screen's supported sections and the five supported bottom-navigation destinations. The editor lives inside the super-admin mobile app.

The backend stores separate editable drafts and immutable published versions. Saving a draft never changes the customer layout. Publishing or rollback changes the active version for one target scope atomically, including sections and navigation together.

| Responsibility | Owner | Practical implication |
| --- | --- | --- |
| Editor forms, drag/drop, duplicate/delete/reorder, local preview | Super-admin app | Convert edits to the supported JSON contract; do not send Flutter widgets. |
| Local persistence and offline synchronization | Super-admin app | Save to Hive first; preserve dirty work across errors and restarts. |
| Authentication, authorization, validation, revisions, immutable versions | Backend | All new editor endpoints require a verified super-admin account. |
| Immediate publication, schedules, history, rollback | Backend | Release requests operate on persisted server drafts or historical versions. |
| Remote preview rendering | Customer app plus backend | The backend exists; customer-app token entry still needs wiring. |
| Rendering and fetching built-in section data | Customer app | A `banners` section does not contain banner records; it uses the existing banners feature. |
| Prime delivery state and pet personalization | Existing domains/customer app | These are runtime states, not builder targeting fields. |
| Release flags, worker supervision, production cutover | Backend/release owner | The mobile app cannot enable these by sending JSON. |

V1 supports ten built-in sections, `admin_promo`, and `dynamic_section`. It does not support arbitrary children, `widget_group`, `composed_section`, HTML, scripts, expressions, arbitrary routes, or remote widget definitions.

The chatbot floating action button, abbreviated FAB in the original proposal, means the separate chatbot button floating over the screen. Its preference can be stored in drafts/history now. It is not returned to the customer app in the v1 published or preview payload and does not currently affect that app.

## 2. Terms, identities, and values to retain

### 2.1 Different IDs have different jobs

| Value | Created by / obtained from | Meaning | Retain and reuse for |
| --- | --- | --- | --- |
| API origin | App environment configuration | Host, such as `https://api.petyardstores.com` | Every request; keep test and production separate. |
| Access token | Existing authentication flow | Identifies the signed-in account | `Authorization` on admin routes; never put it inside layout JSON. |
| Admin account ID | Existing authenticated account | Owner of the local workspace | Scope Hive records; server obtains audit actor from the token. |
| `layout_key` | Fixed constant `customer_home` | Logical Home layout name | Draft creation only; do not replace it with a UUID. |
| `layout_id` | Draft/public/version response | Backend-generated UUID of the parent layout | Local association and traceability; it is not a draft route parameter. |
| Draft `id` / `draft_id` / route `draftId` | Create/list/read draft response | UUID of one editable/scheduled/published/archived draft | Read, PATCH, validate, preview, publish, cancel, archive. These names refer to the same draft identity. |
| `revision` | Draft response | Positive concurrency counter, initially 1 | Quoted `If-Match` for PATCH; JSON body for preview/publish/schedule. |
| `schema_version` | Catalog/draft/version/public response | JSON contract version, currently 1 | Select the supported renderer/validator; never use it as a draft revision. |
| Section `id` | FE generates a UUID when adding a section | Stable identity of a section | Retain across edits/reordering; use a new ID when duplicating a section. |
| Dynamic item `id` | FE generates a UUID when adding an item | Stable identity within that dynamic section | Retain across edits; generate new IDs for duplicated items. |
| Section `key` | Optional FE/admin business label | Optional stable key, unique within the layout | Editor organization; not a route or replacement for `section_type`. |
| Asset `id` | Upload/library response | UUID of a registered ready image | Local image selection and library reconciliation. It is not sent as `image_url`. |
| Asset `url` | Upload/library response | Public URL registered by the backend | Send the exact value as a promo/item `image_url`. |
| Catalog entity `id` | Existing product/category/brand API | MongoDB ObjectId string | `action.value` for that entity type. Do not generate it. |
| `preview_id` | Create-preview response | UUID identifying a preview record | Revoke the preview. It is not the read credential. |
| Preview `token` | Create-preview response | Secret capability to read one snapshot | Use only for the preview read; protect it and keep it out of ordinary Hive drafts/logs. |
| `version_id` | Publish/history/public/version response | UUID of an immutable version | Clone, read a historical snapshot, or rollback. |
| `version_number` | Published response | Monotonic sequence across the entire parent layout | Human-readable history; not a draft revision and not a route ID. |
| `checksum` | Published/preview response | SHA-256 identity of that public snapshot | Cache identity and diagnostics. Backend calculates it. |
| `ETag` header | Published GET response | Quoted checksum used by HTTP caching | Send unchanged as `If-None-Match` for the same request context. |
| `X-Client-Mutation-Id` | FE generates one UUID per logical save | Retry identity for a PATCH | Keep with the exact original PATCH body and original `If-Match` until its outcome is resolved. |
| `Idempotency-Key` | FE generates one UUID per release operation | Retry identity for publish/schedule/rollback | Retain with that exact operation body; reuse only to retry that operation. |
| `next_before` | A list response | Cursor for the next page | Pass unchanged as that endpoint's `before` query value. |
| `request_id` / `X-Request-Id` | Backend per HTTP request | Correlation with server logs | Display/capture for support; never use as a mutation or publication key. |

Use ordinary UUID v4 generation for new FE section/item/mutation/idempotency IDs. The backend accepts its configured UUID pattern, not strings such as `hero_offer_001` or `dyn-item-1`. Catalog entity IDs are 24 hexadecimal characters; illustrative numeric IDs such as `81` and `1074` are invalid here.

### 2.2 Draft, version, and public response are different objects

An admin draft contains `content.sections` and `content.navigation`. A public layout contains `sections` and `navigation` directly under `data`. A historical version contains `content` plus publication metadata. Do not send an entire response back as a PATCH body.

The response envelope is not the persisted content. `success`, `data`, `meta`, `layout_id`, `revision`, and `published_at` are not top-level fields in a draft PATCH. Read-only metadata remains outside the PATCH body.

### 2.3 Time and case

Send schedule times as real UTC instants with a trailing `Z`. Prefer second precision: `2026-10-02T15:00:00Z`. Convert the admin's selected local date/time to UTC first; do not append `Z` to a local clock string.

Most layout API timestamps are emitted in UTC without milliseconds. Asset-library `created_at` has a current app-wide serialization caveat described in section 26. Never use that display timestamp as a schedule input or build pagination cursors from it.

Field names and enum values are case-sensitive. `newArrivals`, `shopByUserPet`, and `myOrders` are intentional spellings. Use canonical IDs consistently in target lists and request headers: targeting compares strings, not normalized aliases.

## 3. Complete route inventory

Count endpoints as method plus path. There are 19 new method/path combinations: 17 admin endpoints and 2 public endpoints. The 2 existing legacy combinations are retained, giving 21 combinations relevant to this integration. The existing GET's behavior is gated for a future cutover; no legacy route has been removed.

All paths below include `/api/v1`. If your configured API base already ends with `/api/v1`, do not append it twice.

| # | Method | Path | Success | Purpose / prerequisite |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/v1/admin/ui-builder/catalog` | 200 | Read schemas/capabilities before offering editor operations. |
| 2 | POST | `/api/v1/admin/ui-builder/assets` | 201 | Upload one image using multipart; no draft ID is required. |
| 3 | GET | `/api/v1/admin/ui-builder/assets` | 200 | Select a previously uploaded ready image. |
| 4 | POST | `/api/v1/admin/home-layouts/drafts` | 201 | Create blank or clone an existing version. |
| 5 | GET | `/api/v1/admin/home-layouts/drafts` | 200 | List drafts and statuses. |
| 6 | GET | `/api/v1/admin/home-layouts/drafts/:draftId` | 200 | Get a complete current draft. |
| 7 | PATCH | `/api/v1/admin/home-layouts/drafts/:draftId` | 200 | Replace its editable snapshot using `If-Match`. |
| 8 | DELETE | `/api/v1/admin/home-layouts/drafts/:draftId` | 204 | Archive a draft whose status is `draft`. |
| 9 | POST | `/api/v1/admin/home-layouts/drafts/:draftId/validate` | 200 | Validate current saved content; inspect `data.valid`. |
| 10 | POST | `/api/v1/admin/home-layouts/drafts/:draftId/preview` | 201 | Create a frozen preview of a specified revision. |
| 11 | DELETE | `/api/v1/admin/home-layouts/previews/:previewId` | 204 | Revoke one preview. |
| 12 | POST | `/api/v1/admin/home-layouts/drafts/:draftId/publish` | 201 | Publish now OR schedule; both use this route. |
| 13 | POST | `/api/v1/admin/home-layouts/drafts/:draftId/cancel-schedule` | 204 | Unlock a scheduled draft and advance its revision. |
| 14 | GET | `/api/v1/admin/home-layouts/history` | 200 | Read immutable version history. |
| 15 | GET | `/api/v1/admin/home-layouts/versions/:versionId` | 200 | Read one immutable admin snapshot. |
| 16 | POST | `/api/v1/admin/home-layouts/versions/:versionId/rollback` | 201 | Revalidate an old snapshot and publish it as a new version. |
| 17 | GET | `/api/v1/admin/home-layouts/audit` | 200 | Read builder audit entries. |
| 18 | GET | `/api/v1/ui-layouts/customer_home` | 200 / 304 | New published contract for customer integration. |
| 19 | GET | `/api/v1/home-layout/preview?token=...` | 200 | Read a preview using its secret token. |
| 20 | GET | `/api/v1/home-layout` | 200, or 304 after cutover | Existing legacy read; switches to the new public contract only through release configuration. |
| 21 | PATCH | `/api/v1/home-layout` | 200 | Existing legacy ordering update, independent of builder drafts/versions. |

There are no v1 `/submit`, `/approve`, `/reject`, asset `/complete`, asset delete, draft restore, draft-to-draft clone, active-target delete, or history archive endpoints. Do not build calls to those proposed routes.

### 3.1 Finding the requests in Postman

In the [Petyard Postman workspace](https://go.postman.co/workspace/701d8eda-731b-4251-86c8-13fbdd4cffd2), open the **Home Layout** collection. Its **UI Builder** folder contains the 19 new requests, organized by task:

| Folder | Requests | When to use it |
| --- | --- | --- |
| `01 - Catalog` | 1 | Read schemas, limits, and currently enabled capabilities first. |
| `02 - Images` | 2 | Upload/select images before saving content that references them. |
| `03 - Drafts` | 5 | Create or clone, list/open, full-snapshot save, and archive drafts. |
| `04 - Validation and Preview` | 4 | Validate saved content, create/read a frozen preview, and revoke it. |
| `05 - Publication and Scheduling` | 2 | Publish now or schedule through the same request; cancel a schedule. |
| `06 - History and Rollback` | 3 | List/read immutable versions and publish a historical snapshot as a new version. |
| `07 - Audit` | 1 | Inspect lifecycle audit records. |
| `08 - Customer Layout` | 1 | Read the published customer contract and test conditional reads. |

The two existing **Get Home Layout** and **Update Home Layout** requests remain outside **UI Builder**. They are legacy requests, not missing builder operations. Publication versus scheduling and blank creation versus cloning are alternate bodies/examples of their existing endpoints, not additional endpoints.

Postman examples are illustrative fixtures, not captured production responses or proof of deployment. Replace placeholder IDs, artwork URLs, and checksums with values from your own responses. The saved `304` example deliberately has no body. See section 22 for error responses and recovery; saved success examples are not an exhaustive list of possible outcomes.

Select the intended environment before sending anything. `BASE_URL` is the API origin without `/api/v1`; `JWT` comes from the existing login flow. Populate these local variables only when the corresponding operation needs them:

| Postman variable | Obtain from / purpose |
| --- | --- |
| `ui_draft_id` | Draft response `data.id`; used in draft route paths. |
| `ui_revision` | Latest acknowledged draft `data.revision`; keep it numeric. PATCH wraps it in quotes in `If-Match`, while preview/publish bodies use a JSON number. |
| `ui_mutation_id` | Generate a UUID for one new logical save. Retain it with the exact body and original revision for retries. |
| `ui_preview_id` | Create-preview response `data.preview_id`; used for revocation. |
| `ui_preview_token` | Create-preview response `data.token`; used only for the public preview read. Keep it local/sensitive and do not share it in examples. |
| `ui_version_id` | A published/history version ID; used for version reads, cloning, and rollback. |
| `ui_publish_key` | Generate a stable UUID for one publish/schedule operation; reuse the same key and body only for retries of that operation. |
| `ui_rollback_key` | Generate a stable UUID for one rollback operation; apply the same retry rule. |
| `ui_scheduled_for` | Your selected future time converted to UTC; used in the saved scheduling request example. |
| `ui_page_before` | The relevant list response's `data.next_before`; enable the disabled `before` query parameter only for the next page. Never reuse one endpoint's cursor for another endpoint. |

The collection does not automatically generate retry keys or run a workflow. Do not substitute a freshly generated UUID on each retry. If you enable optional targeting or caching headers, use the actual values described in sections 13 and 20. Local request descriptions and alternate saved examples supplement this guide; they do not replace its prerequisites and recovery rules.

## 4. HTTP rules, authentication, and response parsing

### 4.1 Authentication

Use the existing login/refresh flow. Every new admin endpoint requires:

```http
Authorization: Bearer <access_token>
```

The account must exist, be active, not deleted/banned, have a verified phone, and have role `superAdmin`. Ordinary admins and moderators cannot use these editor endpoints, even if they can use the legacy Home layout endpoint. Do not send `created_by`, `updated_by`, `published_by`, or `actor_id` to select an actor; the backend derives the actor from authentication.

Published reads permit guests. A guest omits the bearer header. A valid authenticated token selects the logged-in audience. If a bearer token is supplied but expired/invalid, the read can fail with 401; optional authentication does not mean a bad token is ignored. A guest ID is not required by this layout resolver and does not select the logged-in audience.

The preview read uses the token in its query string and does not require a bearer token. Anyone possessing that token can read its snapshot until expiration/revocation, so it must be treated as sensitive.

### 4.2 Request formats

For JSON writes, use `Content-Type: application/json`. JSON booleans must be `true`/`false`, and integers must be JSON numbers, not strings. Omit optional fields when unused unless the field explicitly accepts `null`. Unknown JSON body/content/configuration fields are rejected; do not include local Hive metadata in server payloads.

GETs have no request body. Validate and cancel accept `{}` or no body; the examples use `{}`. Archive and revoke have no body. Multipart upload is the exception to JSON: let the HTTP library generate its boundary, with binary field `image` and text field `usage`.

### 4.3 Header reference

| Header | Use | Required? | Source / relationship |
| --- | --- | --- | --- |
| `Authorization` | All new admin routes; optional public read | Admin: yes | Existing account access token. |
| `Content-Type` | JSON writes / multipart upload | Appropriate to the body | Library sets multipart boundary automatically. |
| `If-Match` | Draft PATCH | Yes | Current acknowledged server revision, e.g. `"2"` including both quotes. Not the public ETag. |
| `X-Client-Mutation-Id` | Draft PATCH | Optional in backend; required by this reliable FE flow | Fresh UUID per logical autosave; keep unchanged during retries. |
| `Idempotency-Key` | Publish now, schedule, rollback | Yes | Fresh UUID per logical operation; same body/key on retries. |
| `If-None-Match` | Published GET | Optional | Exact previous ETag for the same target/auth context. |
| `X-App-Platform` | Published GET | Optional, but send when known | `android`, `ios`, or `web`; affects targeting. |
| `X-App-Version` | Published GET | Optional, but send when known | Semantic version such as `1.7.0`; not a build-number integer. |
| `X-App-Locale` | Published GET | Optional | Exact locale string such as `en`, `ar`, or `en-US`. |
| `Accept-Language` | Existing language middleware / catalog pickers | Optional | If no `X-App-Locale`, app middleware supplies `ar` or `en`, defaulting to `en`. |
| `X-Location-Id` | Published GET | Optional | Selected presentation target ID; agree its namespace with the admin app first. |
| `X-Country-Code` | Published GET | Optional | Two uppercase letters such as `EG`; required to match country-constrained targeting. |

`If-Match: 2`, `If-Match: W/"2"`, and a public checksum in `If-Match` are invalid. Send exactly a quoted positive draft revision.

The server returns `X-Request-Id` for diagnostics. Browser CORS permits these custom request headers and exposes `ETag`/`X-Request-Id`, but only configured origins are allowed. The current origin list includes the existing Netlify app and selected development localhost origins. A new web editor origin needs release configuration. Native mobile clients do not use browser CORS enforcement.

### 4.4 Success and error parsing

New builder success responses normally have this envelope:

```json
{
  "data": {},
  "meta": {
    "request_id": "c40e7d11-4309-45ab-96e6-100bd6bfc389"
  }
}
```

There is no required `success: true` flag. Use HTTP status plus the documented `data`. Validation is a special case: HTTP 200 can contain `data.valid: false`.

A handled builder error normally has:

```json
{
  "error": {
    "code": "UI_LAYOUT_VALIDATION_FAILED",
    "message": "Layout cannot be published.",
    "request_id": "c40e7d11-4309-45ab-96e6-100bd6bfc389",
    "details": [
      {
        "path": "content.navigation.items",
        "code": "HOME_NAVIGATION_REQUIRED",
        "message": "An enabled home destination is required."
      }
    ]
  }
}
```

`error.details` is usually an array, but a PATCH revision conflict returns an object containing conflict metadata. Handle both. Unexpected failures, parser errors, global middleware errors, legacy errors, or proxy errors may use the application's older envelope or a non-JSON body. Provide a generic fallback instead of assuming every failure contains `error.code`.

For 204 and 304, do not call a required JSON decoder: the body is empty. Admin reads/writes use `Cache-Control: no-store`; keep intentional editor working state in Hive, not an HTTP response cache.

### 4.5 Lengths, nulls, and pagination

String limits follow the backend's JavaScript string length (UTF-16 code units); an emoji outside the basic multilingual plane can count as two. JSON size is a separate UTF-8 byte limit; do not equate 262,144 characters with 262,144 bytes. Draft-name length is checked before outer whitespace is trimmed for storage. Trim form input to make the displayed value and submitted name consistent.

Only explicitly nullable fields accept null: target version bounds, optional draft change note, and read-only nullable metadata. Optional text/action/image/config fields should be omitted rather than sent as null. `false`, `0`, an empty list, omission, and null are different values; do not remove false/zero values through a truthy-value serializer.

| List | Default/max `limit` | `before` | Optional server filter |
| --- | --- | --- | --- |
| Drafts | 20/100 | Opaque `next_before` string. | status only. |
| Assets | 30/100 | Opaque `next_before` string. | None. |
| Audit | 20/100 | Opaque `next_before` string. | None. |
| History | 20/100 | Positive version number from `next_before`. | None. |

On the first page omit `before`. For the next page, retain the same list/filter/limit and URL-encode the returned cursor through the HTTP client's query-parameter support. Never combine a cursor from one list with another list or decode/edit it. Null ends pagination; empty rows also end the current traversal. Refreshing starts again without before; deduplicate by resource identity when mutable drafts move between pages. The parser retains legacy timestamp-cursor compatibility, but new FE clients should use returned opaque cursors to avoid losing records that share a timestamp.

## 5. Lifecycle and prerequisites

```text
create blank / clone a version
             |
             v
           draft -- PATCH --> draft with revision + 1
             |
             +-- validate --> valid or invalid; no lifecycle change
             +-- preview --> separate immutable expiring snapshot
             +-- archive --> archived
             +-- publish now --> published draft + new immutable version
             +-- schedule --> scheduled, locked snapshot
                                  |
                                  +-- worker success --> published
                                  +-- terminal failure --> still scheduled, with schedule_failure
                                  +-- cancel --> draft with revision + 1

historical version -- rollback --> new immutable active version
historical version -- clone --> new draft with revision 1
```

| Operation | What must exist first | What must be synchronized / valid | What changes afterward |
| --- | --- | --- | --- |
| Create blank | Verified super-admin session | A non-empty name | Backend creates parent layout if needed and a draft at revision 1. |
| Clone version | Existing `version_id` | Valid source request | New draft, same cloned content/targeting, revision 1. |
| Upload | Verified super-admin session and a local image | Format/size/pixels pass | Independent ready asset; draft revision does not change. |
| PATCH | Existing editable draft ID | Complete snapshot and acknowledged revision | Replaces editable snapshot; increments revision once. |
| Validate | Existing saved draft | Flush local changes first to validate what the admin sees | Returns checks for that saved revision; no revision increment. |
| Preview | Existing draft at requested revision | Full publish validation must pass, including references/target overlap | Separate frozen preview; no published version is created. |
| Publish now | Existing editable server draft | Clean local workspace, current revision, full revalidation, non-empty change note, release enabled | New immutable version and active pointer; draft status becomes published. |
| Schedule | Existing editable server draft | Same as publish; future UTC time; scheduling configured | Locks draft and persists scheduled snapshot; no version yet. |
| Cancel | Draft status scheduled | No pending editor save | Clears schedule/failure and increments revision; GET again before editing. |
| Rollback | Existing historical version | Its old content/references/target scope must pass current validation | New version; historical row is never edited. |

Published and archived drafts are not editable. A published version is immutable. To change a published layout, clone a version and edit the new draft. There is no separate `failed` draft status: use `status: "scheduled"` plus `schedule_failure`.

Publication, scheduling, and rollback are separately gated by backend configuration. Saving drafts and creating previews do not require the release flag. A targeted draft cannot validate/preview/publish until an active global fallback exists. Start the first rollout with global targeting.

## 6. First publication: exact ordered walkthrough

This minimal walkthrough needs no uploaded images and no catalog entity IDs. It is useful for the first successful FE integration before adding campaign content.

The UUIDs, request IDs, times, and checksums below are illustrative. Retain actual values returned by your server. Generate fresh mutation/idempotency IDs for your real operations. An upload URL elsewhere in this guide is not a real registered asset simply because it appears in documentation.

### Step 1: Authenticate and discover capabilities

Use the normal login flow, retain the access token securely, and request:

```http
GET /api/v1/admin/ui-builder/catalog HTTP/1.1
Authorization: Bearer <access_token>
```

Read `schema_version`, `section_types`, `navigation_destinations`, `limits`, and `capabilities`. Section 7 gives the complete field reference. If `publish_now` is false, draft work can continue, but the release owner must enable publishing before step 7 can succeed.

### Step 2: Create the server draft

```http
POST /api/v1/admin/home-layouts/drafts HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "layout_key": "customer_home",
  "name": "October Home",
  "source": { "type": "blank" },
  "change_note": "Prepare the first builder-managed Home."
}
```

Response: 201.

```json
{
  "data": {
    "id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "layout_id": "b1e94213-b895-4809-ab06-6738cbf71e8f",
    "layout_key": "customer_home",
    "name": "October Home",
    "status": "draft",
    "schema_version": 1,
    "revision": 1,
    "based_on_version_id": null,
    "targeting": {
      "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
      "min_app_version": null, "max_app_version": null,
      "audience": "all", "priority": 0
    },
    "content": { "sections": [], "navigation": { "items": [] } },
    "change_note": "Prepare the first builder-managed Home.",
    "scheduled_for": null,
    "schedule_failure": null,
    "created_at": "2026-10-01T10:00:00Z",
    "updated_at": "2026-10-01T10:00:00Z"
  },
  "meta": { "request_id": "c40e7d11-4309-45ab-96e6-100bd6bfc389" }
}
```

Store `data.id` as `server_draft_id`, `data.revision` as `server_revision`, and the complete acknowledged draft in the admin's environment-scoped local workspace. Do not treat the empty draft as publishable.

### Step 3: Edit locally and save a complete snapshot to Hive

Add a banners section with a FE-generated UUID and an enabled Home navigation item. Store the complete local snapshot first and mark it dirty. Then generate a mutation UUID and freeze the exact outgoing PATCH body and current revision for this save.

### Step 4: Synchronize that snapshot

```http
PATCH /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
If-Match: "1"
X-Client-Mutation-Id: 836608a5-b2cf-49cb-8236-c64aa43cf38a
```

```json
{
  "name": "October Home",
  "change_note": "Add the main banners and Home navigation.",
  "targeting": {
    "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
    "min_app_version": null, "max_app_version": null,
    "audience": "all", "priority": 0
  },
  "content": {
    "sections": [
      {
        "id": "1a10f4bf-993c-4fc2-bc46-0926c6a35ab6",
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
```

Response: 200.

```json
{
  "data": {
    "id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "layout_id": "b1e94213-b895-4809-ab06-6738cbf71e8f",
    "layout_key": "customer_home",
    "name": "October Home",
    "status": "draft",
    "schema_version": 1,
    "revision": 2,
    "based_on_version_id": null,
    "targeting": {
      "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
      "min_app_version": null, "max_app_version": null,
      "audience": "all", "priority": 0
    },
    "content": {
      "sections": [
        {
          "id": "1a10f4bf-993c-4fc2-bc46-0926c6a35ab6",
          "section_type": "banners", "name": "Main banners", "position": 0, "data": {}
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
    },
    "change_note": "Add the main banners and Home navigation.",
    "scheduled_for": null,
    "schedule_failure": null,
    "created_at": "2026-10-01T10:00:00Z",
    "updated_at": "2026-10-01T10:01:00Z"
  },
  "meta": { "request_id": "32149334-1371-43ba-a5e5-c2043b1838ef" }
}
```

Update the acknowledged server revision to 2. Store the normalized returned content as the server snapshot. Mark the working copy clean only if no newer local edit happened while this request was running. If the request times out, retry the original body with `If-Match: "1"` and the same mutation UUID; do not change it to revision 2 merely because you suspect the first request succeeded.

### Step 5: Validate the saved revision

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/validate HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{}
```

Response: 200.

```json
{
  "data": {
    "valid": true,
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "revision": 2,
    "errors": [],
    "warnings": [],
    "validated_at": "2026-10-01T10:02:00Z"
  },
  "meta": { "request_id": "200733aa-3953-49c7-8c5e-d54ae359518b" }
}
```

Associate the validation with revision 2. If you save revision 3 afterward, revision 2's validation is no longer a validation of the editor's current content. The backend will still validate again during publication.

### Step 6: Optionally preview the saved revision

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/preview HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "revision": 2,
  "device_profile": "mobile",
  "locale": "en",
  "platform": "android",
  "expires_in_seconds": 1800
}
```

Response: 201.

```json
{
  "data": {
    "preview_id": "5792f9ce-1552-4f8d-a9bb-97893df56664",
    "token": "UiPreviewExampleToken0123456789abcdefghijklmno",
    "expires_at": "2026-10-01T10:33:00Z",
    "revision": 2,
    "preview_url": "/api/v1/home-layout/preview?token=UiPreviewExampleToken0123456789abcdefghijklmno"
  },
  "meta": { "request_id": "a6c5ca63-bbe1-478d-92aa-a14ba2c786aa" }
}
```

Resolve `preview_url` against the API origin, not against a base URL that would add `/api/v1` a second time. This sample token is illustrative and cannot read a real snapshot. Section 15 explains how to read/revoke actual previews. The customer app still needs a preview entry mechanism; a false `remote_preview` capability is not an absent backend route.

### Step 7: Publish the acknowledged server revision

Require a clean workspace and an explicit online admin confirmation. Use a fresh UUID for this publish operation, distinct from the save's mutation UUID.

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/publish HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: 25973937-7de2-41fd-a165-64053129c10e
```

```json
{
  "revision": 2,
  "mode": "now",
  "change_note": "Launch the first builder-managed Home."
}
```

Response: 201, assuming publication is enabled and this is the first version.

```json
{
  "data": {
    "version_id": "66ee543b-96f6-4dbf-9729-9c836a7dba86",
    "version_number": 1,
    "status": "published",
    "published_at": "2026-10-01T10:04:00Z",
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "superseded_version_id": null
  },
  "meta": { "request_id": "7d510055-9651-4cce-96e3-39d0e414077b" }
}
```

Retain the actual `version_id` and `version_number`. The example checksum is a format placeholder; use the checksum the backend returns. Refresh the draft to observe `status: "published"`; it is now read-only. Publishing does not increment the draft's revision.

### Step 8: Read the new published contract

```http
GET /api/v1/ui-layouts/customer_home HTTP/1.1
X-App-Platform: android
X-App-Version: 1.7.0
X-App-Locale: en
```

Response: 200.

```json
{
  "data": {
    "layout_id": "b1e94213-b895-4809-ab06-6738cbf71e8f",
    "version_id": "66ee543b-96f6-4dbf-9729-9c836a7dba86",
    "version_number": 1,
    "schema_version": 1,
    "published_at": "2026-10-01T10:04:00Z",
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "sections": [
      {
        "id": "1a10f4bf-993c-4fc2-bc46-0926c6a35ab6",
        "section_type": "banners", "name": "Main banners", "position": 0, "data": {}
      }
    ],
    "navigation": {
      "items": [
        {
          "key": "home", "label_key": "home", "icon_key": "home",
          "destination": "home", "order": 0, "enabled": true
        }
      ]
    }
  },
  "meta": {
    "cache_ttl_seconds": 0,
    "request_id": "41d4f57b-bb4d-49f9-9331-6ce06dd733fc"
  }
}
```

Observe that there is no draft `revision`, no admin `targeting`, and no `floating_action_button`. Retain the response and its actual ETag together. Before coordinated cutover, `GET /api/v1/home-layout` continues returning its separate legacy shape even after this publication succeeds.

### Step 9: Make the next edit using a new draft

Create another draft with `source.type: "published"` and the actual returned `version_id`; edit/save/validate/preview/publish that draft. Do not PATCH the published draft, edit the historical version, or use the legacy PATCH as an update to this version.

## 7. Catalog and capability discovery

Request: `GET /api/v1/admin/ui-builder/catalog`, with the super-admin bearer token and no body. Response: 200 with the fields below under `data`, plus `meta.request_id`.

| Field | Meaning / how the FE uses it |
| --- | --- |
| `schema_version` | Current contract version. Select the v1 editor/renderer. |
| `capabilities` | Availability information; explained below. |
| `limits.max_sections` | 30 sections per layout. |
| `limits.max_navigation_items` | At most 5 navigation records, including disabled records. |
| `limits.max_dynamic_items` | At most 20 items in each dynamic section. |
| `limits.max_payload_bytes` | 262144 UTF-8 bytes. Account for content/public metadata, not only character count. |
| `asset_upload.mode` | `multipart`; do not implement upload-slot/completion calls. |
| `asset_upload.endpoint` | `/api/v1/admin/ui-builder/assets`; use against the API origin. |
| `asset_upload.image_field` | `image`, the single binary part name. |
| `asset_upload.usage_field` | `usage`, the text part name. |
| `asset_upload.usages` | `promo`, `dynamic_item`. |
| `asset_upload.allowed_mime_types` | `image/jpeg`, `image/png`, `image/webp`. |
| `asset_upload.max_bytes` | 5242880 input bytes, exactly 5 MiB. |
| `section_types` | All ten built-ins plus the two configurable section records. |
| `section_types[].key` | Exact `section_type` value to write. |
| `section_types[].repeatable` | Whether the type may occur more than once. |
| `section_types[].config_schema` | Field schema for that section's `data`, not for the entire section wrapper. |
| `navigation_destinations` | Five fixed definitions: `key`, `label_key`, `icon_key`, `required`. |
| `navigation_destinations[].required` | True only for Home. This catalog flag is not a navigation-record field to POST. |
| `actions` | `product`, `category`, `brand`, `screen`, `url`; additional type-specific rules still apply. |

Capability example when publication is disabled:

```json
{
  "remote_preview": false,
  "publish_now": false,
  "scheduled_publish": false,
  "review_workflow": false,
  "component_tree": false,
  "chatbot_fab_config": false,
  "chatbot_fab_draft_storage": true
}
```

This block is the `data.capabilities` fragment, not the whole catalog response.

| Capability | Actual meaning |
| --- | --- |
| `publish_now` | True when the server publication flag is enabled. |
| `scheduled_publish` | True when publication is enabled and a Redis URL is configured. It does not probe Redis health or confirm a worker is running. |
| `remote_preview` | False until customer-app preview entry is enabled. Backend preview creation/read endpoints already exist. |
| `review_workflow` | False; no submit/approve/reject API exists. |
| `component_tree` | False; composed/widget trees are rejected. |
| `chatbot_fab_config` | False; public/preview responses omit the setting. |
| `chatbot_fab_draft_storage` | True; editor can persist the future preference in drafts/history. |

Fetch the catalog when entering the builder and again after an environment/release change or a release-disabled response. Do not permanently cache a false/true publication capability in Hive.

`config_schema` uses standard field-definition concepts: `type`, `properties`, `required`, `additionalProperties`, `enum`, `format`, `pattern`, `minimum`, `maximum`, `minItems`, `maxItems`, `minLength`, and `maxLength`. `required` describes the publish-ready form, while incomplete draft saves are permitted. The catalog does not express every conditional/reference rule: HTTPS host restrictions, required images for selected templates, CTA/action dependencies, existing catalog records, and targeting overlap still require the rules below and backend validation.

The complete section/configuration/navigation field reference is in sections 11 and 12. Do not add `repeatable`, `config_schema`, or catalog `required` to a section or navigation record sent to the server.

### Complete catalog response example

This is the complete catalog generated from the current contract definitions, with release capabilities shown disabled. Your server can return `publish_now` and `scheduled_publish` as true according to its configuration. Do not copy this fixture into a layout PATCH; use the live response to build forms.

```json
{
  "data": {
    "schema_version": 1,
    "capabilities": {
      "remote_preview": false,
      "publish_now": false,
      "scheduled_publish": false,
      "review_workflow": false,
      "component_tree": false,
      "chatbot_fab_config": false,
      "chatbot_fab_draft_storage": true
    },
    "limits": {
      "max_sections": 30,
      "max_navigation_items": 5,
      "max_dynamic_items": 20,
      "max_payload_bytes": 262144
    },
    "asset_upload": {
      "mode": "multipart",
      "endpoint": "/api/v1/admin/ui-builder/assets",
      "image_field": "image",
      "usage_field": "usage",
      "usages": [
        "promo",
        "dynamic_item"
      ],
      "allowed_mime_types": [
        "image/jpeg",
        "image/png",
        "image/webp"
      ],
      "max_bytes": 5242880
    },
    "section_types": [
      {
        "key": "banners",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "services",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "newArrivals",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "collections",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "shopByUserPet",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "petProfileBanner",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "recommended",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "categories",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "bestSeller",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "brands",
        "repeatable": false,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      },
      {
        "key": "admin_promo",
        "repeatable": true,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "enabled",
            "visibility",
            "layout",
            "title"
          ],
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "visibility": {
              "enum": [
                "all",
                "logged_in",
                "guest"
              ]
            },
            "layout": {
              "enum": [
                "card",
                "split",
                "full_banner",
                "text_strip"
              ]
            },
            "image_url": {
              "type": "string",
              "format": "uri"
            },
            "title": {
              "type": "string",
              "maxLength": 80
            },
            "subtitle": {
              "type": "string",
              "maxLength": 180
            },
            "cta_text": {
              "type": "string",
              "maxLength": 30
            },
            "background_color": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "title_color": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "subtitle_color": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "cta_background": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "cta_color": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "action": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "type",
                "value"
              ],
              "properties": {
                "type": {
                  "enum": [
                    "product",
                    "category",
                    "brand",
                    "screen",
                    "url"
                  ]
                },
                "value": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                }
              }
            }
          }
        }
      },
      {
        "key": "dynamic_section",
        "repeatable": true,
        "config_schema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "enabled",
            "title",
            "display_type",
            "card_style",
            "items"
          ],
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "title": {
              "type": "string",
              "maxLength": 80
            },
            "subtitle": {
              "type": "string",
              "maxLength": 180
            },
            "display_type": {
              "enum": [
                "slider",
                "grid"
              ]
            },
            "card_style": {
              "enum": [
                "product_card",
                "pill_avatar",
                "square_banner"
              ]
            },
            "columns_per_row": {
              "type": "integer",
              "minimum": 1,
              "maximum": 4
            },
            "limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 20
            },
            "show_see_all": {
              "type": "boolean"
            },
            "background_color": {
              "type": "string",
              "pattern": "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            },
            "action": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "type",
                "value"
              ],
              "properties": {
                "type": {
                  "enum": [
                    "product",
                    "category",
                    "brand",
                    "screen",
                    "url"
                  ]
                },
                "value": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                }
              }
            },
            "items": {
              "type": "array",
              "minItems": 1,
              "maxItems": 20,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "id",
                  "name"
                ],
                "properties": {
                  "id": {
                    "type": "string",
                    "format": "uuid"
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "subtitle": {
                    "type": "string",
                    "maxLength": 100
                  },
                  "image_url": {
                    "type": "string",
                    "format": "uri"
                  },
                  "action": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "enum": [
                          "product",
                          "category",
                          "brand",
                          "screen",
                          "url"
                        ]
                      },
                      "value": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2048
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    ],
    "navigation_destinations": [
      {
        "key": "home",
        "label_key": "home",
        "icon_key": "home",
        "required": true
      },
      {
        "key": "videos",
        "label_key": "videos",
        "icon_key": "videos",
        "required": false
      },
      {
        "key": "favorites",
        "label_key": "favorites",
        "icon_key": "favorites",
        "required": false
      },
      {
        "key": "orders",
        "label_key": "myOrders",
        "icon_key": "orders",
        "required": false
      },
      {
        "key": "profile",
        "label_key": "profile",
        "icon_key": "profile",
        "required": false
      }
    ],
    "actions": [
      "product",
      "category",
      "brand",
      "screen",
      "url"
    ]
  },
  "meta": {
    "request_id": "de27db99-a6ab-48fb-b76a-c56246d2f7df"
  }
}
```

In the schemas, `properties` lists permitted configuration fields, `required` lists publish-ready fields, and `additionalProperties: false` rejects extra fields. `type` checks JSON kinds; `enum` constrains literal choices; `format` is a format hint rather than the complete security policy; `pattern` is the required regular expression. `minimum`/`maximum` bound numbers, `minItems`/`maxItems` bound array counts, and `minLength`/`maxLength` bound strings. Nested `items` describes each dynamic item, not the section wrapper. The actual server adds the conditional/reference/security rules documented below.

## 8. Create, clone, open, list, and archive drafts

### 8.1 Creation fields

`POST /api/v1/admin/home-layouts/drafts` returns 201 and the complete draft object illustrated in section 6.

| Request field | Required / limits | Source and use |
| --- | --- | --- |
| `layout_key` | Required; exactly `customer_home` | FE constant. Parent identity is created automatically if absent. |
| `name` | Required non-whitespace string; at most 120 characters | Admin's internal name; backend trims its outer whitespace. |
| `source` | Required object; only `type` and optional `version_id` | Choose blank or a version clone. |
| `source.type` | Required; `blank` or `published` | Blank starts empty. Published copies a version's content and targeting. |
| `source.version_id` | Required for `published`; omit for `blank` | Actual version UUID from history/publication. It must exist under this parent layout. |
| `change_note` | Optional string, maximum 500; `null` permitted | Optional draft description. Omission becomes null. It does not satisfy a later publish body's required note. |

Clone request example:

```json
{
  "layout_key": "customer_home",
  "name": "October Home revision",
  "source": {
    "type": "published",
    "version_id": "66ee543b-96f6-4dbf-9729-9c836a7dba86"
  },
  "change_note": "Prepare a new campaign from the current global version."
}
```

Its response has a NEW draft `id`, `revision: 1`, `status: "draft"`, and `based_on_version_id` equal to the source. Its `content` and `targeting` contain the actual cloned values, not empty arrays. Its name/note come from this request. Section/item IDs in the cloned content remain stable; they are not globally unique across different drafts/versions.

Cloning a superseded historical version is allowed. It does not reactivate that version or change the public layout. There is no `source.type: "draft"` or raw-content create. To duplicate a working draft, create a blank draft first, then PATCH the complete chosen snapshot to it.

### 8.2 Complete draft response field dictionary

| Response field | Meaning / FE action |
| --- | --- |
| `id` | Server draft UUID. Use in draft routes. |
| `layout_id` | Parent layout UUID; retain for association, not write input. |
| `layout_key` | `customer_home`. |
| `name` | Internal draft name. |
| `status` | `draft`, `scheduled`, `published`, or `archived`. Determines permitted editing/actions. |
| `schema_version` | Current contract version. Not editable through PATCH. |
| `revision` | Current concurrency counter. Every successful new PATCH and schedule cancellation advances it; validation/preview/publication/scheduling/archive do not. |
| `based_on_version_id` | Version cloned at creation, or null. Not changed by later edits. |
| `targeting` | Complete normalized target rules. Defaulted/sorted by the server. |
| `content` | Complete supported sections/navigation, plus optional stored chatbot preference. |
| `change_note` | Current draft note or null. PATCH omission resets it to null. |
| `scheduled_for` | UTC scheduled time when scheduled, otherwise null. |
| `schedule_failure` | Null normally; terminal schedule error code when execution failed. Status remains scheduled. |
| `created_at` | Creation time; read-only. |
| `updated_at` | Latest draft update time; read-only. |

The draft response does not expose `created_by` or `updated_by`. PATCH conflict metadata may expose `updated_by` for diagnosis; version/audit responses expose actors separately.

### 8.3 Open an existing draft

```http
GET /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe HTTP/1.1
Authorization: Bearer <access_token>
```

No body. Response 200 has exactly the full draft response structure shown in section 6, reflecting current state. An unknown draft gives `UI_DRAFT_NOT_FOUND`/404; a malformed ID gives `UI_LAYOUT_INVALID_REQUEST`/400.

Load the local workspace before the network call, then reconcile its dirty/clean/conflict state with this response as section 21 explains. Never overwrite unsynchronized local work simply because the GET succeeded.

### 8.4 List drafts

```http
GET /api/v1/admin/home-layouts/drafts?status=draft&limit=20 HTTP/1.1
Authorization: Bearer <access_token>
```

Response 200 contains `data.items` of complete draft objects and `data.next_before`.

An empty-list example:

```json
{
  "data": { "items": [], "next_before": null },
  "meta": { "request_id": "c40e7d11-4309-45ab-96e6-100bd6bfc389" }
}
```

When items exist, each item is the complete draft object in 8.2; this endpoint does not return a shortened draft summary.

| Query field | Rules |
| --- | --- |
| `status` | Optional; `draft`, `scheduled`, `published`, `archived`. If omitted, all statuses are included, including archived records. |
| `limit` | Optional integer 1..100; default 20. |
| `before` | Optional opaque cursor from this list's `next_before`; URL-encode it and send unchanged. |

Rows sort by `updated_at` descending with an internal ID tie-breaker. Use `status=draft` for the normal editable list and `status=scheduled` for schedules. Do not derive a cursor from the visible time or assume `before` is a version number. Refresh/deduplicate by draft ID if editing changes list order between pages. Unknown query fields are rejected.

### 8.5 Archive

```http
DELETE /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe HTTP/1.1
Authorization: Bearer <access_token>
```

Response:

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
```

Only status `draft` can be archived. A scheduled draft must be canceled first. Published/archived/missing draft cases return `UI_DRAFT_NOT_EDITABLE`/409. Archiving sets status to archived, preserves the record/content/history, writes an audit event, and does not delete images or previews. It does not advance revision.

There is no archive idempotency key or restore endpoint. A repeated DELETE after a successful archive can return 409. After a timeout, GET the draft and accept status archived as confirmation instead of blindly repeating forever. Remove its Hive record only after confirmed archive or an explicit local-discard choice. Archived drafts remain readable; normal draft lists should filter them out.

## 9. Upload and select images

An image must exist before a draft that references it can pass reference validation. A local phone file, temporary upload URL, or invented CDN URL is not a publishable image reference.

### 9.1 One-step multipart upload

```http
POST /api/v1/admin/ui-builder/assets HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: multipart/form-data; boundary=<generated_by_your_HTTP_client>
```

The body is multipart, not JSON:

| Part | Type | Required | Source and purpose |
| --- | --- | --- | --- |
| `image` | One binary file | Yes | The file selected on the device. Use this exact field name. |
| `usage` | Text | Yes | `promo` for promotional artwork, or `dynamic_item` for a dynamic item image. Used to label the asset library record. |

Let the HTTP library generate the boundary and Content-Type. Do not set `application/json`, send Base64, or upload through an upload-slot/completion sequence. There is no upload-slot or completion endpoint.

Example command, with your actual API origin, token, and file substituted:

```bash
curl -X POST "$API_BASE/api/v1/admin/ui-builder/assets" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "image=@/path/to/promo.png;type=image/png" \
  -F "usage=promo"
```

Response 201, route-level representation:

```json
{
  "data": {
    "id": "d8ab3fd4-f81a-4942-afc5-94b8c612b671",
    "status": "ready",
    "usage": "promo",
    "url": "https://media.example.com/ui-layout-assets/example.webp",
    "width": 1600,
    "height": 900,
    "byte_size": 245760,
    "created_at": "2026-10-01T10:00:00.000Z"
  },
  "meta": { "request_id": "350247d8-28fc-4256-b5e8-3d2c15cbddda" }
}
```

The URL above is a fixture, not a usable registered image. Replace it with the exact returned URL. The main server currently reformats this endpoint's millisecond timestamp; see 26.1 before interpreting `created_at`.

| Returned field | What it means | What to retain/use |
| --- | --- | --- |
| `id` | Backend-generated asset UUID. | Keep for library selection and local bookkeeping. Never send as a section field. |
| `status` | `ready`: upload processing and asset record creation succeeded. | Only use ready records. This does not promise perpetual CDN availability. |
| `usage` | Library classification submitted with the upload. | Useful for the picker. Not a section-type permission boundary. |
| `url` | Final delivery URL. | Copy unchanged into `data.image_url` or `data.items[i].image_url`. This is the publish dependency. |
| `width`, `height` | Original decoded input dimensions. | Useful for UI guidance; not the dimensions of the converted output. |
| `byte_size` | Original uploaded file size in bytes. | Not the converted WebP size. |
| `created_at` | Asset record creation time. | Display only after handling the timestamp caveat. Do not build cursors or schedules from it. |

Input restrictions:

- Exactly one file, 1..5,242,880 bytes.
- Declared MIME must be `image/jpeg`, `image/png`, or `image/webp`, matching the decoded format. `image/jpg`, SVG, GIF, videos, and unsupported/corrupt files are not accepted.
- Neither decoded dimension may exceed 8,000 pixels; total decoded area must not exceed 25,000,000 pixels.
- The server converts to WebP, quality 80, fits within 1920×1080 without enlargement, and uses server-side media credentials. The FE must not derive the output extension or receive storage credentials.
- Send only `image` and `usage`. Multipart parser limits include one file, at most two text fields, and at most 100 bytes per text field.

### 9.2 Reuse an existing library image

```http
GET /api/v1/admin/ui-builder/assets?limit=30 HTTP/1.1
Authorization: Bearer <access_token>
```

```json
{
  "data": {
    "items": [
      {
        "id": "d8ab3fd4-f81a-4942-afc5-94b8c612b671",
        "status": "ready",
        "usage": "promo",
        "url": "https://media.example.com/ui-layout-assets/example.webp",
        "width": 1600,
        "height": 900,
        "byte_size": 245760,
        "created_at": "2026-10-01T10:00:00.000Z"
      }
    ],
    "next_before": null
  },
  "meta": { "request_id": "88508be8-e1eb-487c-a70d-12f8f9470a1f" }
}
```

Only ready assets are listed. `limit` is 1..100, default 30; `before` is an opaque returned cursor. No `usage`, search, or status filter is exposed. Filter already-loaded rows locally if needed, without pretending the filtered rows are the entire library.

Uploading is not idempotent. If the response is lost, a retry can upload another object. Inspect recent library entries before retrying; the API does not expose a filename/checksum-based exact recovery key. Do not claim that selecting a same-looking image proves it is the lost upload.

### 9.3 Existing product/category/brand images

Reference validation also accepts exact stored public image URLs from active products, categories, and brands. A syntactically valid public URL alone is insufficient. Catalog image endpoints may return transformed delivery URLs that do not equal the stored URL; see 26.2. The simplest reliable new-artwork path is the builder asset upload.

Changing/removing an image field or archiving a draft does not delete the asset. The same ready URL can be reused. There is no FE asset-delete endpoint, and this guide does not authorize manual storage deletion.

## 10. Save the complete draft

### 10.1 Full replacement, not a partial patch

Use PATCH to replace the entire editable document. Always construct the request from the current complete working copy, not just the field that changed.

```http
PATCH /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
If-Match: "2"
X-Client-Mutation-Id: 50439f26-a744-4fd1-9f81-8e99113ca46f
```

```json
{
  "name": "October customer home",
  "targeting": {
    "platforms": [],
    "locales": [],
    "country_codes": [],
    "location_ids": [],
    "min_app_version": null,
    "max_app_version": null,
    "audience": "all",
    "priority": 0
  },
  "content": {
    "sections": [
      {
        "id": "bda5fbe3-7e43-43b3-bd28-4a3b15f09931",
        "section_type": "banners",
        "key": "home_banners",
        "name": "Banners",
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
    "floating_action_button": {
      "enabled": true,
      "key": "chatbot",
      "icon_key": "chatbot",
      "action": { "type": "route", "destination": "chatbot" }
    }
  },
  "change_note": "Keep banners first"
}
```

Response 200 has the complete draft DTO from 8.2. For this example it has `revision: 3`, the submitted normalized editable fields, and a new `updated_at`; retain that revision before the next operation. The complete response example is in 6.3; the shape is identical, not a different compact save response.

| Body field | Required | Meaning and dependency |
| --- | --- | --- |
| `name` | Yes | Nonblank draft display name, up to 120 characters; server trims it. It is not a customer-facing section title. |
| `targeting` | Yes | Complete selection rules, described in 13. Send all eight fields to avoid accidental resets. |
| `content` | Yes | The complete sections, navigation, and optional stored FAB setting. See 11–12. |
| `change_note` | No | String up to 500 characters, or null. Omission resets it to null on save; it is not a publish audit note. |

Do not send the response envelope, `success`, `data`, `id`, `layout_id`, `layout_key`, `schema_version`, `revision`, `status`, timestamps, `based_on_version_id`, or schedule fields in this body. They are server-controlled. Unknown fields are rejected.

### 10.2 What replacement means

| Local intention | What to send |
| --- | --- |
| Add a section | Previous sections plus the new section, plus the complete navigation/targeting/FAB you want retained. |
| Change a title | Entire document with the changed title. |
| Remove a section | Entire document without that section. |
| Reorder | Entire array, assigning unique positions/orders before sending. |
| Disable a custom section | Keep it, set `data.enabled` to false, and retain its required configuration. |
| Remove FAB storage | Omit `content.floating_action_button`; previous storage is removed. |
| Clear navigation while drafting | Send `navigation.items: []`; allowed to save, not to publish. |

`content: {}` is allowed for an incomplete draft but erases previous content and cannot publish. Leaving out an old section or navigation field does not mean “keep the old one.” The backend does not merge content, infer removed IDs, or implement JSON Patch operations.

### 10.3 Stable IDs and canonical ordering

The FE generates section and dynamic-item UUIDs when creating those editor elements. Keep IDs unchanged while editing/reordering. Generate new IDs when duplicating an element inside the same layout. Item IDs need to be unique within their own dynamic section; section IDs and optional section keys must be unique throughout the layout. Built-in section types cannot repeat.

Positions must be unique integers 0..29; navigation orders must be unique integers 0..4. The server validates first, sorts, then rewrites indices to consecutive values starting at zero. For example positions 2 and 7 are accepted and returned as 0 and 1; duplicate positions 2 and 2 are rejected rather than repaired. Use consecutive indices on the FE and adopt the returned canonical order.

### 10.4 Revision lock and mutation retry

`If-Match: "2"` means “save only if the current draft revision is still 2.” Quotes are mandatory. This is a draft-editing revision, not a public ETag, checksum, or version number.

Each successful fresh save advances revision once, even if its content happens to be identical. The optional backend `X-Client-Mutation-Id` should always be supplied by the FE: generate a UUID for one logical save and retain its exact body and original If-Match until resolved.

- Exact retry: same draft, mutation UUID, body, and original If-Match. Returns the saved result without another revision/audit mutation, including concurrent identical retries.
- New edit: new mutation UUID and the latest acknowledged revision.
- Reuse with different normalized payload/revision: `UI_MUTATION_KEY_REUSED`/409.
- Stale revision without an already-completed matching mutation: `UI_DRAFT_REVISION_CONFLICT`/409. Do not automatically resend with a newer revision.

A retried save may return the old acknowledged revision even if another save has already advanced the draft further. It is a replay of that operation, not a fresh GET. Refresh before continuing when the current state is uncertain; never replace a newer known local/server revision with an older replay.

Serialize saves per draft. If the user makes more edits while save A is in flight, retain those edits, acknowledge A's server revision, and send a new complete save B with a fresh mutation UUID. Do not overwrite unsent edits with A's response. Debouncing is a FE optimization, not permission to overlap uncontrolled full-document writes.

## 11. Section and action field reference

### 11.1 Section wrapper

| Field | Source | Rules | Use |
| --- | --- | --- | --- |
| `id` | FE-generated UUID | Required for draft and publish; unique across sections. | Stable editor identity, local state, error-to-element mapping. Not a catalog entity ID. |
| `section_type` | Catalog `section_types[].key` | Required, supported type only. | Selects the customer renderer and allowed `data` schema. |
| `key` | Optional FE-chosen string | Up to 80 characters; unique when present. | Optional logical section identifier. Not a route or required built-in key. |
| `name` | Admin input | Optional while drafting; nonblank up to 120 characters when publishing. | Editor/admin label; use `data.title` for custom customer display text. |
| `position` | FE array ordering | Required integer 0..29, unique; server normalizes. | Section display order. |
| `data` | Type-specific editor | Required object. | Renderer configuration described below. |

No wrapper `enabled`, `visibility`, `children`, or arbitrary styling fields are supported. Do not use the earlier generic `widget_group` proposal: it is not a supported renderer. Disabled custom sections still require valid configuration and references to publish.

### 11.2 Built-in sections

| `section_type` | Intended existing home block | `data` |
| --- | --- | --- |
| `banners` | Existing banners | `{}` only |
| `services` | Existing services | `{}` only |
| `newArrivals` | Existing new-arrivals products | `{}` only |
| `collections` | Existing collections | `{}` only |
| `shopByUserPet` | Existing shop-by-pet block | `{}` only |
| `petProfileBanner` | Existing pet-profile prompt | `{}` only |
| `recommended` | Existing recommended products | `{}` only |
| `categories` | Existing category block | `{}` only |
| `bestSeller` | Existing best-selling products | `{}` only |
| `brands` | Existing brand block | `{}` only |

Each can occur once. The builder configures presence and order; it does not accept products, prices, data-fetch URLs, or custom children in a built-in's `data`. The customer app continues to use the block's existing domain APIs/business rules. Remove a built-in from the section array to remove it from this layout; no built-in toggle field exists.

### 11.3 `admin_promo`

| `data` field | Required to publish | Accepted values and purpose |
| --- | --- | --- |
| `enabled` | Yes | Boolean. Customer renderer shows/hides the block; backend still validates and returns it. |
| `visibility` | Yes | `all`, `logged_in`, `guest`. Renderer-level authentication visibility, not backend layout targeting or authorization. |
| `layout` | Yes | `card`, `split`, `full_banner`, `text_strip`. Selects the promo visual variant. |
| `image_url` | Conditional | Public HTTPS registered URL; required for `split` and `full_banner`. Optional for `card`/`text_strip`. Use upload response `url`. |
| `title` | Yes | Nonblank string, maximum 80 characters. Customer-facing text. |
| `subtitle` | No | String, maximum 180 characters. |
| `cta_text` | No | String, maximum 30 characters. A nonempty value requires `action` at publication. Label for the call-to-action button. |
| `background_color` | No | `#RRGGBB` or `#AARRGGBB`; background. |
| `title_color` | No | Same color format; title. |
| `subtitle_color` | No | Same color format; subtitle. |
| `cta_background` | No | Same color format; CTA background. |
| `cta_color` | No | Same color format; CTA text. |
| `action` | Conditional | Action object from 11.5; required with nonempty `cta_text`. |

Example section to insert into a complete PATCH body after uploading the image and selecting a real category:

```json
{
  "id": "08aa82b0-07f1-49d6-af49-f3b3a044e5f1",
  "section_type": "admin_promo",
  "key": "october_offer",
  "name": "October pet offer",
  "position": 1,
  "data": {
    "enabled": true,
    "visibility": "all",
    "layout": "full_banner",
    "image_url": "https://media.example.com/ui-layout-assets/example.webp",
    "title": "Everything your pet needs",
    "subtitle": "Explore our food selection",
    "cta_text": "Shop food",
    "background_color": "#FFF3E0",
    "title_color": "#FF212121",
    "subtitle_color": "#616161",
    "cta_background": "#FF6D00",
    "cta_color": "#FFFFFF",
    "action": { "type": "category", "value": "66f000000000000000000001" }
  }
}
```

The category ID and image URL are illustrative; existence/registration must pass validation. `#FF212121` means alpha FF plus RGB 212121, not CSS's trailing-alpha convention. Text is literal text, not a translation object. The API does not store `{en, ar}` for these fields or automatically translate it; use separate locale-targeted layouts if appropriate.

Suggested design dimensions from the FE proposal are guidance, not enforced minimums: card 16:9 / 1200×675; split 4:5 / 800×1000; full banner 16:9 / 1600×900; text strip needs no image. Uploaded media is fitted within the server's processing bounds. Agree on actual cropping in the customer renderer; backend validation currently produces no low-resolution warning.

### 11.4 `dynamic_section`

| `data` field | Required to publish | Accepted values and purpose |
| --- | --- | --- |
| `enabled` | Yes | Boolean renderer toggle; not a validation bypass. |
| `title` | Yes | Nonblank string, up to 80 characters. |
| `subtitle` | No | String, up to 180 characters. |
| `display_type` | Yes | `slider` or `grid`. |
| `card_style` | Yes | `product_card`, `pill_avatar`, `square_banner`. |
| `columns_per_row` | No | Integer 1..4; grid layout setting. Send explicitly when needed. |
| `limit` | No | Integer 1..20; renderer item display limit. The FE proposal uses default 10; backend does not insert that value. |
| `show_see_all` | No | Boolean. If true, section-level `action` is required to publish. Send explicitly rather than relying on an unspecified client default. |
| `background_color` | No | `#RRGGBB` or `#AARRGGBB`; renderer styling, particularly square banners. |
| `action` | Conditional | Section-level “See all” destination. Required when `show_see_all` is true. Not inherited by individual items. |
| `items` | Yes | Array of 1..20 item objects on publish. Empty/missing is allowed while drafting. Array order is display order; no item `position` field exists. |

| Item field | Required | Source/rules/use |
| --- | --- | --- |
| `id` | Always | FE-generated UUID; unique within this section. Stable item identity. |
| `name` | Publish | Nonblank literal customer text, up to 80 characters. Does not automatically use the referenced entity's name. |
| `subtitle` | No | Literal string, up to 100 characters. |
| `image_url` | No | Exact registered public HTTPS image URL, usually asset upload `url`. |
| `action` | No | Individual tap destination from 11.5. No action means no configured item destination. |

```json
{
  "id": "a09b7579-85e6-40b1-9d24-405b32dd09dc",
  "section_type": "dynamic_section",
  "key": "food_picks",
  "name": "Food picks grid",
  "position": 2,
  "data": {
    "enabled": true,
    "title": "Food picks",
    "subtitle": "Selected for your next visit",
    "display_type": "grid",
    "card_style": "square_banner",
    "columns_per_row": 2,
    "limit": 10,
    "show_see_all": true,
    "background_color": "#FFFFFF",
    "action": { "type": "category", "value": "66f000000000000000000001" },
    "items": [
      {
        "id": "23d6e5cc-c4ef-42d7-a4bc-aae3f0cf80e3",
        "name": "Dry food",
        "subtitle": "Browse this category",
        "image_url": "https://media.example.com/ui-layout-assets/example.webp",
        "action": { "type": "category", "value": "66f000000000000000000001" }
      },
      {
        "id": "7bc2c1dd-dadb-43cd-96e8-0ae937d00b55",
        "name": "Add your pet",
        "action": { "type": "screen", "value": "add_pet_profile" }
      }
    ]
  }
}
```

Dynamic cards contain admin-authored snapshot text/artwork, not live commerce data. There are no `price`, `discount`, `stock`, product-fetch URL, or arbitrary filter fields. Do not display a manually typed subtitle as an authoritative current price; use domain APIs/built-in product blocks for live prices and availability.

### 11.5 Actions and entity prerequisites

Every action has exactly `type` and `value`; both required if the object is present. Do not use `{type: "route", destination: ...}` here—that shape belongs only to the stored chatbot FAB.

| `type` | `value` source and validation | FE behavior |
| --- | --- | --- |
| `product` | Actual product MongoDB ObjectId, 24 hex characters; must exist and be active at reference validation. Obtain through the existing product picker/API. | Open existing product detail flow. Handle later deletion/unavailability gracefully. |
| `category` | Actual existing category ObjectId; obtain through category picker/API. | Open existing category flow. |
| `brand` | Actual existing brand ObjectId; obtain through brand picker/API. | Open existing brand flow. |
| `screen` | Only `add_pet_profile`. No arbitrary screen/route names. | Use the existing add-pet flow, including its own auth requirements. |
| `url` | Public HTTPS URL on `petyardstores.com` or its subdomains. | Open using the app's approved web-link behavior. |

```json
{
  "product_example": { "type": "product", "value": "66f000000000000000000002" },
  "category_example": { "type": "category", "value": "66f000000000000000000001" },
  "brand_example": { "type": "brand", "value": "66f000000000000000000003" },
  "screen_example": { "type": "screen", "value": "add_pet_profile" },
  "url_example": { "type": "url", "value": "https://petyardstores.com/offers" }
}
```

This is a reference examples object, not an accepted request body. `value` must be a nonblank string of at most 2048 characters. Product/category/brand UUIDs, entity names, indices, and whole entity objects are wrong here. The backend checks category/brand existence; it does not promise an additional active-state condition absent from those models.

Public HTTPS checks reject credentials, non-default explicit ports, IP literals, localhost, `.local`, and obvious private-host forms. This is lexical URL validation, not a DNS/reachability guarantee. The URL action host restriction is stricter than image hosts. The backend does not fetch an external action page to prove it exists. Never use `http:`, `javascript:`, arbitrary deep links, external unapproved domains, or client-provided network-fetch instructions.

Draft save validates shape/URL format but does not prove entity/image existence. Validation, preview, publish, scheduling, execution of a schedule, and rollback check references again. A product/image disappearing later does not modify an immutable version automatically; the customer app still needs image and destination failure handling.

### 11.6 Where entity selections come from

These are existing domain reads, not additional builder APIs and not included in the 19-new/21-total builder count. Reuse the app's existing pickers; do not create a product/category/brand merely to obtain an action ID.

| Selection | Existing read example | Value to transfer |
| --- | --- | --- |
| Public active product | `GET /api/v1/products?page=1&limit=20` | Selected row's `data[i].id` as action value. Cards expose `image`; detail/admin DTOs can expose `images`/variants. |
| Admin product picker | `GET /api/v1/products/admin?page=1&limit=20&isActive=true` | Actual selected `data[i].id`; keep existing authentication/product-control rules. An inactive product does not pass builder publication. |
| Product detail | `GET /api/v1/products/:id` | Confirm selected product ID/details through the existing product flow. |
| Category | `GET /api/v1/categories` or `GET /api/v1/categories/:id` | List `data[i].id` or detail `data.id`; not name/slug/image ID. |
| Brand | `GET /api/v1/brands` or `GET /api/v1/brands/:id` | List `data[i].id` or detail `data.id`; not name/slug/image ID. |

For picker display, send the existing bearer token as appropriate and `Accept-Language: en` or `ar`. Product lists use their existing page-based response (`totalResults`, `totalPages`, `page`, `results`, `data`), not builder opaque cursors; category/brand lists return `{data: [...]}`. Existing product location/warehouse/search and domain permissions still apply independently; follow those domains' current contract rather than adding their query fields to builder requests.

Keep the selected entity ID separate from the optional copied title/image. Builder `action.value` does not cause the server to hydrate dynamic-card text/image from the entity. If selecting an existing image, inspect the actual DTO shape and validate its exact canonical URL as explained in 26.2; do not blindly use a category image object as a string.

## 12. Navigation and chatbot setting

### 12.1 Fixed navigation records

`content.navigation` has only `items`. Every provided item must contain the fixed identity tuple plus `order` and `enabled`. Reorder/toggle the supported destinations; do not create new ones.

| `key` | `label_key` | `icon_key` | `destination` | Publication rule |
| --- | --- | --- | --- | --- |
| `home` | `home` | `home` | `home` | Must exist and be enabled. |
| `videos` | `videos` | `videos` | `videos` | Optional. |
| `favorites` | `favorites` | `favorites` | `favorites` | Optional. |
| `orders` | `myOrders` | `orders` | `orders` | Optional. |
| `profile` | `profile` | `profile` | `profile` | Optional. |

```json
{
  "items": [
    { "key": "home", "label_key": "home", "icon_key": "home", "destination": "home", "order": 0, "enabled": true },
    { "key": "orders", "label_key": "myOrders", "icon_key": "orders", "destination": "orders", "order": 1, "enabled": true },
    { "key": "videos", "label_key": "videos", "icon_key": "videos", "destination": "videos", "order": 2, "enabled": false },
    { "key": "favorites", "label_key": "favorites", "icon_key": "favorites", "destination": "favorites", "order": 3, "enabled": true },
    { "key": "profile", "label_key": "profile", "icon_key": "profile", "destination": "profile", "order": 4, "enabled": true }
  ]
}
```

This object belongs at `content.navigation`. `label_key` is a fixed translation lookup key, not admin-authored translated text. `icon_key` refers to an existing app icon; no image URL, custom icon upload, badge, or custom label is accepted. `destination` must equal `key`. All item keys/orders must be unique; maximum five records. All provided records need boolean `enabled`, even during drafting. Only Home is mandatory on publication; five records are not mandatory.

**Disabled records remain in the public response.** The customer app must filter `enabled === true` then render the canonical order. The backend does not remove them. Removing a record from the complete draft also removes it from that version; retaining it disabled preserves its configuration for later editing. Navigation hiding is not permission control: destination APIs still enforce authentication/authorization independently.

### 12.2 FAB means floating action button

The FAB is the floating chatbot button. It is stored at `content.floating_action_button`, alongside `navigation`, not inside it:

```json
{
  "enabled": true,
  "key": "chatbot",
  "icon_key": "chatbot",
  "action": { "type": "route", "destination": "chatbot" }
}
```

`enabled` is required when the object is present. `key`, `icon_key`, and `action` are optional but, if sent, must be these fixed values. No custom action fields/destination are allowed. Prefer sending the complete object shown for clear persistence; toggle only the boolean in the next complete PATCH.

This is **storage only in the current contract**. Draft and admin version responses retain it; public and preview renderer payloads omit it. Catalog says `chatbot_fab_draft_storage: true` and `chatbot_fab_config: false`. Publishing the setting does not currently turn the customer's button on/off. Do not advertise that behavior until FE/backend public-contract support is coordinated. Omission on a later full save removes the stored setting.

## 13. Targeting and layout resolution

### 13.1 Complete targeting object

```json
{
  "platforms": ["android", "ios"],
  "locales": ["ar"],
  "country_codes": ["EG"],
  "location_ids": [],
  "min_app_version": "2.4.0",
  "max_app_version": "2.9.9",
  "audience": "logged_in",
  "priority": 100
}
```

| Field | Rules/default | Source and dependency |
| --- | --- | --- |
| `platforms` | Unique `android`, `ios`, `web`; max 3; default `[]`. | Admin selects platform; matched against `X-App-Platform`. Empty means unrestricted. |
| `locales` | Unique two lowercase letters, optionally `-` and two uppercase letters; max 20; default `[]`. | Actual supported app locales; matched exactly against `X-App-Locale` or language fallback. `ar` is not `ar-EG`. |
| `country_codes` | Unique two-uppercase-letter codes; max 250; default `[]`. | Agreed customer country source; matched against `X-Country-Code`. Syntax checked, not a country-registry lookup. |
| `location_ids` | Unique UUIDs or 24-hex ObjectIds; max 100; default `[]`. | Agreed delivery-location identifier; matched exactly against `X-Location-Id`. See 13.5 before using. |
| `min_app_version` | Strict `major.minor.patch`, inclusive, or null; default null. | Minimum compatible app release; matched against `X-App-Version`. |
| `max_app_version` | Same syntax, inclusive, or null; default null; must not precede minimum. | Optional upper bound. Not a date or expiry. |
| `audience` | `all`, `guest`, `logged_in`; default `all`. | Admin selection; actual public audience derives from a valid bearer token, not a client audience header. |
| `priority` | Integer 0..1000; default 0. | Selection precedence, not section order or version number. Use global 0 and a higher priority for targeted variants. |

Arrays cannot be null or contain duplicates. Send actual JSON booleans/integers elsewhere, not strings. Versions such as `2.4`, `v2.4.0`, `2.4.0-beta`, or `02.4.0` are not supported. Unknown targeting fields such as pet types, prime-location flags, dates, percentage rollout, account IDs, or language objects are rejected.

All empty arrays, null bounds, and `audience: all` define a global layout; priority does not change whether it is global. The server normalizes omitted fields to defaults and sorts target arrays. Send the complete object to make intent explicit and avoid accidental broadening.

### 13.2 Global layout must come first

Publish a valid global layout before validating/previewing/publishing/scheduling a targeted variant. It is the fallback when a customer does not match any targeted variant. Creating/saving a targeted draft can happen earlier, but its release prerequisites will not be satisfied until an active global exists.

Example sequence:

1. Publish global targeting `[]`/null/`all`, priority 0, as version 1.
2. Clone version 1 to a new draft.
3. Change full targeting to the Android/Arabic/EG/logged-in rules above, priority 100, and save.
4. Validate, preview, publish that draft as version 2.
5. Android, Arabic, EG, logged-in, app 2.5.0 gets version 2. A guest or English customer gets global version 1.

Version 1 remains active for its global scope. Publishing a targeted version does not replace the global or append its sections to the global. The backend returns one complete matching snapshot.

### 13.3 Scope identity and overlapping variants

An active scope is identified by the entire normalized targeting object, **including priority**. Publishing another version with that exact targeting supersedes the previous version in the same scope. Changing even priority creates a different scope, leaving the old one active.

Do not treat priority as a harmless update on a live campaign. To replace an existing variant, copy its exact complete targeting and priority. There is no target-delete/deactivate endpoint or automatic campaign expiry.

Different overlapping scopes at the same priority are rejected by validation/publication. This also applies to a targeted priority-0 scope overlapping the global priority-0 scope. Different priorities may overlap; the higher matching priority wins. A targeted variant below a global priority can be overshadowed by that global.

When multiple eligible active scopes exist, resolution uses:

1. Highest priority.
2. Highest specificity: nonempty platform/locale/country/location lists each contribute `1000 / list length`; a non-`all` audience contributes 1000; each version bound contributes 100.
3. Most recently updated active pointer.
4. Lexical version ID tie-breaker.

Equal-priority overlapping releases are normally blocked, but the deterministic tie-breaker still exists. Do not rely on it as a campaign design strategy. Version number alone does not choose a layout.

### 13.4 Customer request context

```http
GET /api/v1/ui-layouts/customer_home HTTP/1.1
Authorization: Bearer <customer_access_token>
X-App-Platform: android
X-App-Version: 2.5.0
X-App-Locale: ar
X-Country-Code: EG
```

Each configured targeting dimension must match; values within a given array are alternatives. A missing platform/version/country/location header excludes a variant constrained on that dimension. Locale falls back to the main server's language selection, normally `ar` when Accept-Language starts with ar, otherwise `en`. Prefer explicit `X-App-Locale`.

Guest requests omit Authorization. Invalid/expired tokens are not silently treated as guests; handle authentication errors. Do not send an admin-selected `audience` query/header and expect it to impersonate a customer cohort. These headers select presentation, not delivery/price permissions or proof of location.

### 13.5 Location and pet-rule boundaries

The apps must agree on the exact identifier meaning before enabling location targeting. Existing location-resolution responses expose warehouse information but not a dedicated builder `location_id`. Do not silently assume a warehouse ID is the required business location ID. Backend currently validates ID format and equality, not existence or delivery eligibility. Use `location_ids: []` and omit `X-Location-Id` until that mapping is confirmed.

The earlier `visibility.pet_types`, `prime_location`, and “any owned pet” proposal is not part of this implemented schema. Built-in pet blocks keep their existing client/domain logic; `admin_promo.visibility` only supports authentication visibility. Do not add unsupported pet fields to saved JSON.

Targeting is not data access control. Public layout text/artwork is public configuration; products, accounts, and orders retain their normal backend security rules.

## 14. Validate before preview or release

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/validate HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{}
```

Send an empty object or no body. Do not send the layout, revision, preview context, or validation options. The server validates the current saved draft, so save and await acknowledgement first.

Successful validation response 200:

```json
{
  "data": {
    "valid": true,
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "revision": 3,
    "errors": [],
    "warnings": [],
    "validated_at": "2026-10-01T10:06:00Z"
  },
  "meta": { "request_id": "3bad998d-7445-4b83-922d-45ea55ab6676" }
}
```

Invalid saved draft also returns **200**, not a transport failure:

```json
{
  "data": {
    "valid": false,
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "revision": 3,
    "errors": [
      {
        "path": "content.sections[1].data.image_url",
        "code": "ASSET_NOT_READY",
        "message": "Image must be a ready UI Builder asset."
      }
    ],
    "warnings": [],
    "validated_at": "2026-10-01T10:06:00Z"
  },
  "meta": { "request_id": "73e426f5-7e2a-43c8-b324-b7a6d6890118" }
}
```

This invalid example assumes a draft with a syntactically valid but unregistered image in section index 1. Indices refer to canonical saved arrays. Map a path back to the saved element's stable UUID; do not attach an error to the same local index if unsaved reordering has occurred.

| Field | Meaning and required FE behavior |
| --- | --- |
| `valid` | Gate for the saved revision. Check explicitly; HTTP 200 alone is not enough. |
| `draft_id` | Which draft was inspected. |
| `revision` | Which saved revision was inspected. Retain alongside the validation result; invalidate that local result after editing/saving again. |
| `errors` | Blocking `{path, code, message}` findings. Show actionable errors near their fields and in a summary. |
| `warnings` | Reserved array; currently always empty. Do not expect low-resolution or presentation warnings to be generated. |
| `validated_at` | Inspection time, not an approval or lease expiry. |

Checks include schema/version support, publish-required fields, at least one section, enabled Home navigation, references, global-fallback availability, and equal-priority targeting overlap. The publication path also enforces final public-response byte size.

Validation does not reserve references or create an approval token. No `validation_id` is returned or required next. Preview/publish/schedule/rollback inspect again; a product deletion, new conflicting active scope, or concurrent edit can make a later request fail after validation passed. No human reviewer approval endpoint exists.

## 15. Create, open, and revoke a preview

### 15.1 Create a saved-revision snapshot

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/preview HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "revision": 3,
  "device_profile": "iphone_15",
  "locale": "en",
  "platform": "ios",
  "expires_in_seconds": 1800
}
```

| Request field | Rules | Where it comes from / why |
| --- | --- | --- |
| `revision` | Required positive integer. | Latest acknowledged draft revision, not a version number. Prevents previewing an unexpected edit. |
| `device_profile` | Optional nonblank string, max 40 characters. | FE preview device selection; opaque rendering hint, not an enforced list. |
| `locale` | Optional locale such as `en`, `ar`, `en-US`. | FE preview choice; stored as context, not automatic text translation. |
| `platform` | Optional `android`, `ios`, `web`. | FE preview platform hint. |
| `location_id` | Optional UUID/ObjectId. | Agreed location hint only; same unresolved mapping caveat as 13.5. |
| `expires_in_seconds` | Integer 60..3600; default 1800. | Requested token lifetime in seconds. |

No audience, app-version, country, content, targeting, or idempotency field is accepted. If fields are omitted, they are absent from `requested_context`; the backend does not add a full synthetic customer state.

Response 201:

```json
{
  "data": {
    "preview_id": "bd42c22e-69c2-41ad-a1be-200d5c516252",
    "token": "YmxWbEdYVE5Ha0dTZzJuNWhjY0c2M2xmbklPc3hWaGc",
    "expires_at": "2026-10-01T10:40:00Z",
    "revision": 3,
    "preview_url": "/api/v1/home-layout/preview?token=YmxWbEdYVE5Ha0dTZzJuNWhjY0c2M2xmbklPc3hWaGc"
  },
  "meta": { "request_id": "e452a1a8-ff15-4f23-961f-326a498c086f" }
}
```

Retain `preview_id` for revoke, `revision` to label the preview, and `expires_at` for the expiry display. Resolve the relative `preview_url` against the same API origin. The token shown is only a fixture; use the real returned token/URL.

Creating a preview does not publish, create a history version, or advance the draft revision. It validates the selected saved revision and stores an immutable renderer snapshot. Later edits do not update an existing preview: create another preview for the new saved revision.

### 15.2 Read the preview

```http
GET /api/v1/home-layout/preview?token=YmxWbEdYVE5Ha0dTZzJuNWhjY0c2M2xmbklPc3hWaGc HTTP/1.1
```

No bearer token is required for this read; the preview token is the access credential. Response 200:

```json
{
  "data": {
    "layout_id": "73c6a589-4cf6-4c17-a479-0b613f98b67a",
    "version_id": null,
    "version_number": null,
    "schema_version": 1,
    "published_at": null,
    "sections": [
      {
        "id": "bda5fbe3-7e43-43b3-bd28-4a3b15f09931",
        "section_type": "banners",
        "key": "home_banners",
        "name": "Banners",
        "position": 0,
        "data": {}
      }
    ],
    "navigation": {
      "items": [
        { "key": "home", "label_key": "home", "icon_key": "home", "destination": "home", "order": 0, "enabled": true }
      ]
    },
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "meta": {
    "preview": true,
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "revision": 3,
    "requested_context": { "device_profile": "iphone_15", "locale": "en", "platform": "ios" },
    "request_id": "282f3674-1a8d-4a7d-88e3-1d7d9aee33fd"
  }
}
```

Preview output uses the customer renderer shape, but version ID/number and publication time are null. Stored FAB and targeting are not returned. The checksum is server-generated; the zero value above is a placeholder, not the real hash.

The preview returns the draft snapshot **without resolving customer targeting or filtering sections**. Context values are hints in `meta`, not proof that the chosen platform/location would receive this layout publicly. The FE renderer must apply its own enabled/authentication display behavior and create any required simulated customer state. Use public requests with actual customer context to test selection after publication.

Preview responses use `Cache-Control: no-store, private` and `Pragma: no-cache`, with no conditional ETag flow. Never put preview data into the normal published-layout/Hive cache or use it as an offline customer fallback. Catalog `remote_preview: false` reflects the current customer integration gate; backend preview endpoints existing does not mean the app already has a preview screen/deep link.

### 15.3 Expiry, secrets, rate limits, and revoke

The token is a short-lived capability: anyone holding it can read the snapshot. Do not include it in analytics, screenshots with visible URLs, logs, audit exports, durable draft history, or public links. Store only as long as needed for the preview; revocation/expiry ends access. It is not one-use and is returned only when creating the preview; GET draft does not recover it.

- Create limit: 30 requests per 15 minutes per IP.
- Read limit: 60 requests per 15 minutes per IP.
- Limit response: 429 / `UI_PREVIEW_RATE_LIMITED`; respect the returned wait/rate-limit headers when available. These are in-process limits, not a promised cluster-wide quota.
- Unknown/malformed token: 404 / `UI_PREVIEW_NOT_FOUND`.
- Expired or revoked stored token: 410 / `UI_PREVIEW_EXPIRED`. Eventually TTL cleanup removes the record, so it can later return 404.
- Creating another preview does not revoke the previous one. An uncertain create retry can create an extra preview; creation is not idempotent.

```http
DELETE /api/v1/admin/home-layouts/previews/bd42c22e-69c2-41ad-a1be-200d5c516252 HTTP/1.1
Authorization: Bearer <access_token>
```

Successful revoke returns 204 with no JSON. A repeated revoke/missing record returns 404. Revoke affects only that preview, not the draft or publication. Show “expired or no longer available” for both 404 and 410 in the preview UI.

## 16. Publish immediately

Before sending: finish uploads, complete/save the layout, await the save, validate the saved revision, and let the admin review the preview/confirmation. These are FE safeguards; the backend does not require a stored preview or separate approval record.

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/publish HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: ba46df8e-607d-4ac4-bcd0-dc9939cd8759
```

```json
{
  "revision": 3,
  "mode": "now",
  "change_note": "Publish October customer home after preview"
}
```

| Input | Source/rules/purpose |
| --- | --- |
| `revision` | Required positive integer, latest acknowledged draft revision. Prevents publishing unsaved/stale content. |
| `mode` | Required exact `now`; omit `scheduled_for`, even if null. |
| `change_note` | Required nonblank string, max 500 characters. Admin reason saved on the immutable version; separate from draft-save note. |
| `Idempotency-Key` | Required UUID, generated once for this logical publication. Persist with the exact request until its outcome is resolved. |

No If-Match is required here: the revision is in the body. Do not send content, targeting, checksum, version number, actor ID, preview token, or validation result. Publication uses the saved backend snapshot.

Response 201:

```json
{
  "data": {
    "version_id": "41c252a5-ecad-49e0-bd0b-09b6c2538e86",
    "version_number": 1,
    "status": "published",
    "published_at": "2026-10-01T10:15:00Z",
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "superseded_version_id": null
  },
  "meta": { "request_id": "7ae61320-8a49-422c-b638-e6452d17e17b" }
}
```

| Result field | Meaning/next use |
| --- | --- |
| `version_id` | Backend version UUID. Keep for detail, clone source, and rollback. |
| `version_number` | Increasing number shared across all customer-home scopes. Display/history paging; not the next draft revision. |
| `status` | `published`: immutable version and its active-scope pointer were committed. |
| `published_at` | Server publication time, UTC. |
| `checksum` | Server checksum of the renderer payload including version metadata. Retain for public caching when obtained through the public read. |
| `superseded_version_id` | Previous active version in this exact targeting scope, or null. Not necessarily the latest version across other scopes. |

Publication atomically creates a version, advances the layout's version counter/cache epoch, updates that scope's active pointer, changes the draft to published, and records its audit/idempotency result. A failed transaction does not leave a partially published version. References and targeting are checked again.

The draft revision does not increment on publication. The draft is no longer editable; refresh it and history, then read the public endpoint under the intended customer context. To edit again, create a new draft from the desired published version. Do not PATCH the published draft or reuse its revision as if it were editable.

### 16.1 Lost response and retry

If the request times out, do not immediately declare failure or create a new publication key. Retry the same operation using the same draft, revision, note, mode, and key. Completed identical retries return the original core result and do not create another version, including concurrent retries. Request metadata may change.

A replay remains the result of that old publication even if another release is now active. Refresh history/public state before showing it as “currently live.” Reusing a key with different parameters fails with `UI_IDEMPOTENCY_KEY_REUSED`/409. Publishing the now-published draft with a new key fails rather than creating another editable release.

The environment must enable publication. If `UI_BUILDER_PUBLISH_ENABLED` is not exactly `true`, publication and rollback return 503 / `UI_LAYOUT_RELEASE_DISABLED`. The FE reads capability flags; it must not set deployment flags or treat 503 as a validation mistake.

## 17. Schedule, observe, cancel, and reschedule

### 17.1 Schedule a saved draft

Use the same publication route with schedule mode and a fresh logical-operation key:

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/publish HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: 557a832a-e034-4309-98ab-87aa757ab06a
```

```json
{
  "revision": 3,
  "mode": "schedule",
  "scheduled_for": "2026-10-02T08:00:00Z",
  "change_note": "Launch October home tomorrow morning"
}
```

This example is an alternate path for an editable revision-3 draft, not an operation to send after the immediate-publication example. Always choose a real future time relative to the actual server clock.

`scheduled_for` is required in schedule mode: a real UTC ISO timestamp ending in `Z`, with seconds and optional 1..3 fractional digits. Convert the admin's local selection to UTC before sending. `2026-10-02T11:00:00+03:00` is not accepted; use its UTC equivalent. Impossible dates, missing timezone, `+00:00`, and times less than two minutes ahead are rejected. Give at least three minutes of practical buffer for clock skew/network delay, and label the local display timezone explicitly.

Response 201:

```json
{
  "data": {
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "status": "scheduled",
    "revision": 3,
    "scheduled_for": "2026-10-02T08:00:00Z"
  },
  "meta": { "request_id": "030d3888-60de-4b4e-a2be-d2bad473ca9c" }
}
```

If the database schedule was accepted but immediate queue submission failed, data can additionally include `queue_pending: true`. That is a successful frozen schedule requiring worker reconciliation, not a published version or a reason to resubmit with a new key. Read the draft and show “scheduled; queue reconciliation pending” without claiming the release has happened. `queue_pending` is a controller-time diagnostic and can differ between identical retries.

Schedule response fields are draft identity/status/revision/time, not version fields. Scheduling does not allocate a version number or increment draft revision. It freezes the saved content, targeting, and publication note. PATCH and direct publish-now are blocked while scheduled.

### 17.2 Worker execution and status display

The server's separate worker uses Redis/BullMQ. Accepted due schedules are reconciled on startup and approximately every minute; transient work retries use five attempts with exponential backoff starting at 30 seconds. The API capability checks configuration, not live worker/Redis health. A worker outage can cause late publication; scheduling is not an exact-to-the-second guarantee.

The worker revalidates references and active targeting when due. Another release can introduce an overlap, or a referenced product can become unavailable between acceptance and execution. Do not promise “scheduled means guaranteed publication.”

Use GET draft and refresh history to observe:

| Saved draft state | UI interpretation |
| --- | --- |
| `scheduled`, future `scheduled_for`, null `schedule_failure` | Waiting for the requested time. |
| `scheduled`, due time passed, null `schedule_failure` | Due/pending/retrying; not confirmed live. Refresh at a sensible foreground interval, not a tight loop. |
| `scheduled`, non-null `schedule_failure` | Failed; current live versions are unchanged. Remains locked until canceled. |
| `published`, null schedule fields | Schedule completed; inspect history/source draft ID for the new immutable version. |
| `draft`, cleared schedule fields, newer revision | Schedule was canceled; editable again. |

`schedule_failure` is a code string, for example `UI_LAYOUT_VALIDATION_FAILED` or `UI_SCHEDULE_RETRIES_EXHAUSTED`, not a full validation result. For details, cancel then validate the editable draft and inspect audit/support logs. A terminal failure records the code and attempts an in-app notification to the responsible admin, without push. Audit/notification delivery is best effort; actual production notification acceptance is not established by the local schedule test.

### 17.3 Cancel before editing or publishing now

```http
POST /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe/cancel-schedule HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{}
```

Response 204, no body. GET the draft immediately afterward. Cancellation changes scheduled → draft, advances revision from 3 to 4 in this example, and clears time/frozen snapshot/failure. **Use revision 4 for the next save/preview/publish, not 3.**

No If-Match or idempotency key is accepted as an operation guarantee. Cancellation and worker execution can race: if publication wins, cancellation returns 409 / `UI_SCHEDULE_INVALID_STATE`; refresh and use rollback if the now-live content needs reversal. A repeated cancel after success also returns 409. After a lost response, inspect state/revision rather than assuming the repeated 409 means the first request failed.

Stale queue jobs are safely skipped by state/revision checks; the FE does not manage Redis jobs. To reschedule, cancel, GET the new revision, optionally edit/save/validate, then schedule with a **new** idempotency UUID and a new sufficiently future time. To publish now, cancel first and use the refreshed revision.

An exact retry of the original accepted schedule can return its original result even after its scheduled time has passed. It does not create a new future schedule. Check current draft state afterward before drawing conclusions.

## 18. History, version details, and rollback

### 18.1 History

```http
GET /api/v1/admin/home-layouts/history?limit=20 HTTP/1.1
Authorization: Bearer <access_token>
```

Populated response example, with a minimal published version:

```json
{
  "data": {
    "items": [
      {
        "version_id": "41c252a5-ecad-49e0-bd0b-09b6c2538e86",
        "layout_id": "73c6a589-4cf6-4c17-a479-0b613f98b67a",
        "version_number": 1,
        "schema_version": 1,
        "targeting": {
          "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
          "min_app_version": null, "max_app_version": null, "audience": "all", "priority": 0
        },
        "content": {
          "sections": [
            { "id": "bda5fbe3-7e43-43b3-bd28-4a3b15f09931", "section_type": "banners", "key": "home_banners", "name": "Banners", "position": 0, "data": {} }
          ],
          "navigation": {
            "items": [
              { "key": "home", "label_key": "home", "icon_key": "home", "destination": "home", "order": 0, "enabled": true }
            ]
          },
          "floating_action_button": {
            "enabled": true, "key": "chatbot", "icon_key": "chatbot",
            "action": { "type": "route", "destination": "chatbot" }
          }
        },
        "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "source_draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
        "rollback_of_version_id": null,
        "change_note": "Publish October customer home after preview",
        "published_at": "2026-10-01T10:15:00Z",
        "published_by": "66f000000000000000000004",
        "status": "published"
      }
    ],
    "next_before": null
  },
  "meta": { "request_id": "596b9a81-6013-48b0-9a62-a96ba877f598" }
}
```

`limit` is 1..100, default 20. History sorts descending by shared version number. **History `before` is a positive version number**, not the opaque cursor used by drafts/assets/audit. Use returned `next_before` unchanged. A full final page can still return a cursor; the next page may be empty. Stop on null cursor or empty page; do not infer the total count from a cursor.

History `status` is computed from current active pointers: `published` means active in some targeting scope, `superseded` means no longer active. Multiple history entries can be published at once for different scopes. The first history entry is not necessarily the global fallback or what your particular customer sees. Determine the global from its complete targeting and verify public resolution with the intended context.

### 18.2 Version detail

```http
GET /api/v1/admin/home-layouts/versions/41c252a5-ecad-49e0-bd0b-09b6c2538e86 HTTP/1.1
Authorization: Bearer <access_token>
```

Response 200 contains the same version fields shown in 18.1 under `data`, **without `status`**, plus `meta.request_id`:

```json
{
  "data": {
    "version_id": "41c252a5-ecad-49e0-bd0b-09b6c2538e86",
    "layout_id": "73c6a589-4cf6-4c17-a479-0b613f98b67a",
    "version_number": 1,
    "schema_version": 1,
    "targeting": {
      "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
      "min_app_version": null, "max_app_version": null, "audience": "all", "priority": 0
    },
    "content": {
      "sections": [
        { "id": "bda5fbe3-7e43-43b3-bd28-4a3b15f09931", "section_type": "banners", "key": "home_banners", "name": "Banners", "position": 0, "data": {} }
      ],
      "navigation": {
        "items": [
          { "key": "home", "label_key": "home", "icon_key": "home", "destination": "home", "order": 0, "enabled": true }
        ]
      },
      "floating_action_button": {
        "enabled": true, "key": "chatbot", "icon_key": "chatbot",
        "action": { "type": "route", "destination": "chatbot" }
      }
    },
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "source_draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "rollback_of_version_id": null,
    "change_note": "Publish October customer home after preview",
    "published_at": "2026-10-01T10:15:00Z",
    "published_by": "66f000000000000000000004"
  },
  "meta": { "request_id": "d48d5e18-3511-4caa-9df8-18b07c08f260" }
}
```

| Version field | Meaning / where it is reused |
| --- | --- |
| `version_id` | Server UUID; version detail path, clone `source.version_id`, rollback path. |
| `layout_id` | Parent layout UUID. Not `customer_home`, a draft ID, or an entity ID. |
| `version_number` | Shared monotonically increasing release counter; history paging/display. |
| `schema_version` | Renderer contract version, currently 1. |
| `targeting` | The immutable complete selection rules; crucial for understanding what rollback will replace. |
| `content` | Immutable editable-format snapshot, including stored FAB when present. Not a PATCH response to a current draft. |
| `checksum` | Renderer checksum, not a checksum of all admin metadata/FAB/targeting. |
| `source_draft_id` | Original draft UUID for a normal/scheduled publication; null for rollback-generated versions. |
| `rollback_of_version_id` | Selected historical version UUID for rollback-generated versions; otherwise null. |
| `change_note` | Publication/rollback reason saved on this version. |
| `published_at` | Server UTC time of this release, not the selected older version's time during rollback. |
| `published_by` | Admin user ObjectId as a string; not an embedded user profile. |
| `status` | History only, dynamic active/superseded status. Not returned by version detail or stored as editable content. |

Version detail does not advance state. There is no API to edit or delete a version. If an old version needs changes, clone it to a new draft rather than trying to PATCH its snapshot.

### 18.3 Rollback creates a new release

Suppose global version 2 is live and version 1 is the desired older global:

```http
POST /api/v1/admin/home-layouts/versions/41c252a5-ecad-49e0-bd0b-09b6c2538e86/rollback HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: ca1900ce-3f89-4998-b51d-d8c89efc5367
```

```json
{
  "change_note": "Restore the previous global home after a display issue"
}
```

Response 201:

```json
{
  "data": {
    "version_id": "78a323c1-95ce-4a58-8e1f-a3e7f8714224",
    "version_number": 3,
    "status": "published",
    "published_at": "2026-10-01T11:00:00Z",
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "superseded_version_id": "607f89c7-9bc5-413a-806e-4d6b10b6d0a6"
  },
  "meta": { "request_id": "0f9ae42d-e01e-4f22-b3f6-e4809517306f" }
}
```

Only the reason body and UUID idempotency header are required. No draft revision, If-Match, desired new version number, or full content is sent.

Rollback revalidates the old content and exact old targeting against current references/scopes, then creates version 3 with the old configuration. It supersedes the current version in **that exact scope**; version 1 itself remains immutable and is not renumbered. The new record has `source_draft_id: null` and `rollback_of_version_id` pointing to version 1. No draft becomes editable and no draft revision increments.

Other active targeted scopes remain active. Rolling back a global does not disable a higher-priority campaign, so some customers may continue to receive that campaign. Inspect scope/priority before confirming the expected impact. An old missing image/product or new equal-priority overlap can block rollback with 422; clone/correct/publish instead if necessary.

Use the same key and exact reason to recover an uncertain rollback response. A new key means a new rollback operation and can create another version even when the selected old configuration is already effectively live. Refresh history and public context after success.

## 19. Audit trail

```http
GET /api/v1/admin/home-layouts/audit?limit=20 HTTP/1.1
Authorization: Bearer <access_token>
```

```json
{
  "data": {
    "items": [
      {
        "action": "draft_published",
        "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
        "version_id": "41c252a5-ecad-49e0-bd0b-09b6c2538e86",
        "actor_id": "66f000000000000000000004",
        "request_id": "7ae61320-8a49-422c-b638-e6452d17e17b",
        "details": { "previousVersionId": null, "rollbackOfVersionId": null },
        "created_at": "2026-10-01T10:15:00Z"
      }
    ],
    "next_before": null
  },
  "meta": { "request_id": "f95a6cb1-fa1c-4320-9530-946ffb2a8595" }
}
```

`limit` defaults to 20, range 1..100. `before` is an opaque audit cursor, not a version number. No action/actor/status filter is exposed. Audit rows sort newest first with an internal ID tie-breaker. Empty data is `{items: [], next_before: null}`.

| Field | Explanation |
| --- | --- |
| `action` | Lifecycle event code from the table below. |
| `draft_id` | Related draft UUID, nullable, e.g. null for rollback. |
| `version_id` | Related immutable version UUID, nullable before release. |
| `actor_id` | Admin user ObjectId string; can be null for system failure events. |
| `request_id` | Correlation ID of the originating request, or null for a system event. This is not an idempotency key. |
| `details` | Event-specific object. These internal detail names are currently camelCase; do not rename them when parsing. |
| `created_at` | Audit event UTC time. |

| `action` | Typical `details` |
| --- | --- |
| `draft_created` | `{}` |
| `draft_updated` | `revision` |
| `draft_archived` | `{}` |
| `draft_validated` | `revision`, `valid`, `errorCodes` |
| `preview_created` | `previewId`, `revision`, `expiresAt` |
| `preview_revoked` | `previewId` |
| `draft_published` | `previousVersionId`, `rollbackOfVersionId` |
| `draft_scheduled` | `revision`, `scheduledFor` |
| `schedule_cancelled` | `{}` |
| `rollback_published` | `previousVersionId`, `rollbackOfVersionId` |
| `schedule_failed` | `revision`, `code` |

The API does not expose an audit row ID, edit/delete audit routes, or a tamper-proof signature. It records these lifecycle events, not every denied request, preview read, malformed request, or external service failure. Do not promise complete security-event analytics from this endpoint. Audit/support request IDs should be retained for troubleshooting; do not log access or preview tokens.

## 20. Customer published reads and caching

### 20.1 New contract read

```http
GET /api/v1/ui-layouts/customer_home HTTP/1.1
X-App-Platform: android
X-App-Version: 2.5.0
X-App-Locale: en
X-Country-Code: EG
```

This is a guest example. For a logged-in customer, add that customer's valid bearer token. Add `X-Location-Id` only after the agreed mapping is available. No request body is needed and no `draft_id`, revision, or preview token is used.

Example headers:

```http
HTTP/1.1 200 OK
ETag: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
Cache-Control: private, max-age=0, must-revalidate
Vary: Authorization, X-App-Platform, X-App-Version, X-App-Locale, X-Location-Id, X-Country-Code
```

Example body:

```json
{
  "data": {
    "layout_id": "73c6a589-4cf6-4c17-a479-0b613f98b67a",
    "version_id": "41c252a5-ecad-49e0-bd0b-09b6c2538e86",
    "version_number": 1,
    "schema_version": 1,
    "published_at": "2026-10-01T10:15:00Z",
    "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "sections": [
      { "id": "bda5fbe3-7e43-43b3-bd28-4a3b15f09931", "section_type": "banners", "key": "home_banners", "name": "Banners", "position": 0, "data": {} }
    ],
    "navigation": {
      "items": [
        { "key": "home", "label_key": "home", "icon_key": "home", "destination": "home", "order": 0, "enabled": true }
      ]
    }
  },
  "meta": { "cache_ttl_seconds": 0, "request_id": "5e4c5ed5-6eb1-4e1f-ba17-7ee251c0de7f" }
}
```

| Field | Customer purpose |
| --- | --- |
| `layout_id` | Parent identity; compare only within the correct environment/layout key. |
| `version_id` | Exact selected immutable snapshot; keep for diagnostics/cache identity. |
| `version_number` | Release number for diagnostics. A customer changing cohort can legitimately receive a lower-numbered active version. |
| `schema_version` | Check renderer compatibility before using the payload. Current supported version is 1. |
| `published_at` | Selected snapshot's release time. Not a layout expiry or cache expiry. |
| `checksum` | Snapshot identity, corresponding to the quoted ETag. Do not modify/recalculate it after filtering. |
| `sections` | Complete ordered section configurations. Use supported renderer types, custom `data.enabled`, and promo visibility. |
| `navigation` | Complete fixed navigation configuration. Filter disabled items in the app. |
| `meta.cache_ttl_seconds` | 0 means revalidate HTTP freshness immediately; it does not mean delete your offline fallback. |
| `meta.request_id` | Request diagnostics, not persisted renderer configuration. |

There is no public draft revision, name, targeting object, actor ID, admin change note, preview context, or FAB field. Do not expect `success: true` or the initial proposal's `layout_id: customer_home`/`revision: 18` shape.

### 20.2 Conditional read

For the same request context and retained valid body:

```http
GET /api/v1/ui-layouts/customer_home HTTP/1.1
X-App-Platform: android
X-App-Version: 2.5.0
X-App-Locale: en
X-Country-Code: EG
If-None-Match: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
```

```http
HTTP/1.1 304 Not Modified
ETag: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
Cache-Control: private, max-age=0, must-revalidate
```

There is no JSON body on 304. Configure the HTTP library so 304 reaches your conditional-cache handler instead of becoming a generic error. Use the previously retained body for this context. If the body is missing/corrupt but its ETag survived, retry once without `If-None-Match` to obtain a 200.

Send the **exact returned strong ETag**, including quotes. The current handler compares one exact string; do not rely on weak ETags (`W/`), wildcard, or comma-separated ETag-list support. PATCH's `If-Match: "3"` is unrelated; never interchange the two.

### 20.3 Context-aware local cache

Scope published cache records by environment/API endpoint, layout key, platform, app version, exact locale, country, location, and authentication/account context. Never reuse an Arabic targeted cache for English, a logged-in cache for a guest, or a test API cache for production.

Retain the entire validated public body, ETag, checksum/version identity, context key, and last successful fetch time. Do not store access tokens in the cache key or layout document. Use an account ID/session scope if local account separation is required; clear/isolate caches on logout/account change.

Recommended read flow:

1. Determine the current context and its retained compatible layout.
2. If offline, show that last-known-good layout or the app's agreed static safe default.
3. If online, request with that context's ETag only when its body exists.
4. On 200, check expected envelope/schema/usable sections and replace cache atomically.
5. On 304, keep the retained body and update successful-check time.
6. On network/5xx/unsupported schema/corrupt response, retain last-known-good data; report diagnostics and retry later without a tight loop.
7. On a context change, resolve the new context independently. Do not assume version numbers can only increase across cohorts.

Backend Redis caching uses the publication epoch and target dimensions, with a normal 300-second server-cache duration. Publication advances the epoch transactionally so old cache keys are not selected for a new release. That internal cache duration is not a FE freshness promise; the response still requests immediate HTTP revalidation. Redis/worker details and storage credentials are server configuration, not FE JSON.

### 20.4 Rendering and fallback rules

- Render sections by canonical `position`; preserve configuration/IDs in cache rather than saving only visible widgets.
- For custom sections, filter `data.enabled`; for promos, evaluate `visibility` using actual guest/logged-in state. The backend returns disabled/auth-hidden sections unchanged.
- Filter navigation `enabled`; retain its returned order. Home is publish-required, but the app should still have a safe Home fallback for corrupted/unsupported data.
- Built-in blocks keep their existing runtime pet/delivery/business rules and fetch domain data through existing APIs.
- Dynamic/promo text is literal snapshot text. Layout locale targeting selects a snapshot; it does not translate its strings.
- If a future unsupported section arrives, avoid crashing; skip/report it and use a safe fallback if nothing usable remains. A backend-approved nonempty section array can still produce no visible custom sections after runtime visibility filtering.
- An image delivery failure needs a placeholder; a now-unavailable product/category/brand needs the existing unavailable-destination UX.
- Do not let a layout configuration bypass authentication, order authorization, pricing, delivery eligibility, or stock rules.
- Preview rendering is a separate ephemeral mode, never the ordinary customer cache.

404 / `UI_LAYOUT_NOT_PUBLISHED` means no compatible publication, including a missing initial global; use the agreed static fallback and report the integration state. 503 / `UI_LAYOUT_PUBLICATION_MISSING` means an active pointer could not load its version; preserve the good cache and alert backend support. A 401 needs the existing authentication recovery, not an automatic silent switch to guest presentation while the user is still signed in.

## 21. Hive, offline work, synchronization, and conflict recovery

This section specifies recommended FE behavior; these Hive fields are **local-only**, not a new backend schema. The backend does not implement a phone's offline store for it.

### 21.1 Local record and values to retain

| Local value | Why to retain | Do not send as |
| --- | --- | --- |
| Environment + admin account scope | Prevent cross-account/test-production draft mixing. | Layout targeting or actor override. |
| Local draft UUID | Track a draft before server creation. | Server `draftId`; the server creates its own draft UUID. |
| Server draft ID, parent ID, layout key | Associate acknowledged work with its API resource. | Arbitrary create ID fields. |
| Last acknowledged server revision/status | Supply revision locks and determine editability. | Mutable revision/status in PATCH body. |
| Last acknowledged snapshot | Base for comparison/conflict review. | Automatically overwrite another editor's work. |
| Current full working snapshot | Preserve all unsent edits; build complete PATCH. | A field-only diff. |
| Dirty/local-only/syncing/conflicted marker | Drive honest editor status. | Backend draft status. |
| Pending save mutation UUID + original revision + exact request | Safely recover uncertain saves. | A key reused for a newer edit. |
| Pending release kind/resource/key/exact body/outcome | Recover an online publication without duplicating it. | An automatically queued offline release instruction. |
| Pending local image file handle and upload status | Upload before storing its real public URL. | `file://`, Base64, or local path as `image_url`. |
| Validation result and inspected revision | Discard stale validation when work changes. | Validation token/body in publish. |
| Catalog schema/capabilities | Build supported UI and detect unsupported offline schema. | Client-controlled server capability changes. |

Store credentials through the app's existing secure authentication mechanism, not ordinary Hive layout JSON. Do not retain preview tokens in durable draft history. Local images may need app-private file persistence across restarts; a temporary picker path can disappear, so show a reselection error instead of sending a nonexistent file.

### 21.2 First create and offline-first editing

1. The admin can start a local draft offline using the supported cached catalog or agreed bundled schema.
2. Save edits locally immediately; display “saved on this device,” not “saved to server.”
3. When online/authenticated, create a server blank draft once.
4. Retain the returned server draft ID/revision 1 before saving its complete local content.
5. Finish/recover required image uploads and replace local handles with real returned URLs.
6. PATCH the complete local document with If-Match 1 and a saved mutation UUID.
7. On acknowledgement, retain the canonical server snapshot/revision and mark clean only if no newer local edits exist.

There is no client create idempotency key. If creation times out, keep the local draft and mark server creation uncertain. List recent drafts to recover an unambiguous match; names are not unique and matching by name/time alone can be ambiguous. If uncertain, ask the admin to choose an existing draft or explicitly create another, preserving the local work. Do not blindly create in a background retry loop.

### 21.3 Reconnect an existing dirty draft

1. Refresh authentication and GET the server draft.
2. If there is an unresolved save with a known key/body/revision, resolve that operation by exact retry and/or fresh read; do not guess whether its commit happened.
3. If the current server revision equals the local acknowledged base and status is draft, save the complete dirty snapshot with a new logical save key.
4. If the server revision differs, keep both snapshots and enter conflict review.
5. If status is scheduled/published/archived, do not keep retrying PATCH. Preserve local work and choose cancel-then-review or a new draft.

Do not automatically replay publish, schedule, rollback, archive, or cancel just because connectivity returns. Release actions need current state, valid references, and conscious admin confirmation. An already-started online release with an uncertain response may be recovered by its exact idempotent retry, but that is not the same as queuing a new offline release.

### 21.4 Conflict example and choices

Both admins open revision 4. Admin A saves and gets revision 5. Admin B sends If-Match 4 and receives 409:

```json
{
  "error": {
    "code": "UI_DRAFT_REVISION_CONFLICT",
    "message": "This draft was changed by another editor.",
    "request_id": "3e509069-546f-4974-8bfc-4d43cc903754",
    "details": {
      "expected_revision": 4,
      "current_revision": 5,
      "updated_by": "66f000000000000000000004",
      "updated_at": "2026-10-01T11:20:00Z"
    }
  }
}
```

This rich details object is available for a save conflict; other revision/state conflicts can have an empty details array. Always GET the current draft rather than treating these optional details as the whole new document.

Offer explicit choices:

- **Use server copy:** show a warning before discarding unsent local edits; replace only after consent.
- **Review/merge:** compare base, local, and server using stable IDs. Let the admin choose fields/order/deletions; send the final complete document against the freshly read revision with a new mutation UUID. Backend does not merge for you.
- **Keep local work as another draft:** create blank, then save the full preserved local content/targeting with its new ID/revision. There is no draft-source clone API; do not pretend an unsaved local snapshot is a published source.

Never silently retry B's document with If-Match 5. That would pass the lock while overwriting A's work. If another edit happens during conflict resolution, another 409 is legitimate; preserve the reviewed work and repeat the fresh-read review, not an infinite force-save loop.

### 21.5 App restart during a request

Persist an operation record before sending an idempotent save/release. After restart, reload that record, refresh state, and recover with its exact original request/key if needed. Do not generate a new key merely because a new process started.

Clear the pending operation only after acknowledgement or an explicit handled outcome. Separate the acknowledged snapshot from the current working snapshot so a late response cannot erase newer edits. If the server has moved beyond an acknowledged replay, get the current state before creating another request.

Keep editor records, published customer caches, and preview state in separate stores/namespaces. Exported debug information should redact credentials/tokens and any private account context.

## 22. Errors and recovery decisions

### 22.1 Parsing and retry safety

Use HTTP status plus machine `error.code`; display a suitable localized FE message and retain `request_id` for support. Do not parse English message text to control behavior. The `details` value can be an array, an object, or absent in a rate-limit response; tolerate all three.

Typical shape:

```json
{
  "error": {
    "code": "UI_LAYOUT_VALIDATION_FAILED",
    "message": "Layout cannot be published.",
    "request_id": "a02bca6b-f883-492b-ad20-83e57e4f0a92",
    "details": [
      {
        "path": "content.navigation.items",
        "code": "HOME_NAVIGATION_REQUIRED",
        "message": "An enabled home destination is required."
      }
    ]
  }
}
```

This is a publication error fixture for an incomplete saved navigation configuration. A validation POST would instead return 200 with `valid: false` and its findings in `data.errors`.

Do not assume every failure on the network has this shape. Body-parser limits, malformed JSON, unexpected server exceptions, old legacy validators, unmatched routes, and upstream proxies can return another JSON envelope or HTML/plain text. Preserve local work, use a generic message for unrecognized responses, and capture safe status/request-ID diagnostics.

| Operation | Deduplicated? | Safe uncertain-outcome recovery |
| --- | --- | --- |
| GET/list/public read | Read only | Retry with reasonable backoff; account for conditional 304. |
| Create draft | No | List/reconcile; ask when ambiguous. Avoid blind duplicate creates. |
| Upload asset | No | Inspect library/retained upload result; explicit reupload can create another asset. |
| PATCH draft | With `X-Client-Mutation-Id` | Exact original key/body/If-Match, then refresh if state moved further. Without a key, use GET to inspect; do not blindly repeat. |
| Validate | No state revision change, but writes an audit event | Can inspect again; repeated requests can add audit events. |
| Create preview | No | Create a new preview if needed; old one may still exist. |
| Revoke preview | No | Repeat can return 404; token read can show no longer available. |
| Publish/schedule/rollback | Required `Idempotency-Key` | Exact original key/resource/body. Do not generate a new operation while old outcome is uncertain. |
| Cancel schedule | No | GET state/new revision; repeated call can return 409. |
| Archive draft | No | GET status; repeated call can return 409. |

Deduplication is scoped to operation kind/resource and key. Nevertheless, generate a fresh UUID for every genuinely new operation; never share one across unrelated UI actions. Keys are identifiers, not credentials or substitutes for authorization. No documented deduplication expiry should be assumed by the FE.

### 22.2 Implemented operational codes

| HTTP | Code | What to do |
| --- | --- | --- |
| 400 | `UI_LAYOUT_INVALID_REQUEST` | Correct unknown/missing fields, malformed IDs, query/cursor, revision/key/context formats. Inspect details. |
| 400 | `UI_LAYOUT_UNSUPPORTED_KEY` | Use `layout_key: customer_home`; no other layout is supported. |
| 400 | `UI_DRAFT_INVALID_NAME` | Nonblank create name, max 120. |
| 400 | `UI_DRAFT_INVALID_SOURCE` | Use blank or an existing published-source version as documented. |
| 400 | `UI_DRAFT_INVALID_UPDATE` | Send complete valid name/targeting/content. |
| 400 | `UI_DRAFT_INVALID_CHANGE_NOTE` | Save/create note must be string up to 500 or null. |
| 400 | `UI_DRAFT_IF_MATCH_REQUIRED` | Supply quoted positive revision on PATCH. |
| 400 | `UI_PREVIEW_INVALID_EXPIRY` | Use integer 60..3600 seconds. |
| 400 | `UI_PUBLISH_INVALID_MODE` | Use now without scheduled_for, or schedule with time. |
| 400 | `UI_PUBLISH_CHANGE_NOTE_REQUIRED` | Provide a nonblank release reason up to 500. |
| 400 | `UI_ROLLBACK_CHANGE_NOTE_REQUIRED` | Provide a nonblank rollback reason up to 500. |
| 400 | `UI_SCHEDULE_INVALID_TIME` | Convert a real sufficiently future time to accepted UTC format. |
| 400 | `UI_ASSET_INVALID_UPLOAD` | Fix multipart name/file count/size/field constraints. |
| 400 | `UI_ASSET_INVALID_USAGE` | Use promo or dynamic_item. |
| 400 | `UI_ASSET_INVALID_FILE` | Select a valid bounded PNG/JPEG/WebP. |
| 401 | `UNAUTHORIZED`, or existing auth code | Existing token refresh/login handling; preserve dirty work. |
| 403 | `FORBIDDEN`, or existing auth code | Correct account/role/verification state; ordinary admins cannot use builder routes. Do not retry forever. |
| 404 | `UI_DRAFT_NOT_FOUND` | Verify resource/environment; preserve local copy and choose recovery. |
| 404 | `UI_VERSION_NOT_FOUND` | Refresh history; do not invent a version ID. |
| 404 | `UI_PREVIEW_NOT_FOUND` | Unknown/no longer retained token/preview; create a fresh preview if authorized. |
| 404 | `UI_LAYOUT_NOT_FOUND` | Backend parent missing during release; contact backend support. |
| 404 | `UI_LAYOUT_NOT_PUBLISHED` | Customer fallback; backend must establish compatible initial publication. |
| 409 | `UI_DRAFT_REVISION_CONFLICT` | GET, preserve local work, resolve revision/state conflict. |
| 409 | `UI_DRAFT_NOT_EDITABLE` | GET state; cancel a schedule or create another draft as appropriate. |
| 409 | `UI_SCHEDULE_INVALID_STATE` | Schedule no longer cancelable/current; inspect state and possible publication. |
| 409 | `UI_MUTATION_KEY_REUSED` | Stop; the same save key was used for another payload/revision. Resolve original outcome, then use a fresh key for a new action. |
| 409 | `UI_IDEMPOTENCY_KEY_REUSED` | Same problem for a release key. Do not silently regenerate while outcome is uncertain. |
| 410 | `UI_PREVIEW_EXPIRED` | Close expired/revoked preview; create another after checking current saved revision. |
| 422 | `UI_LAYOUT_VALIDATION_FAILED` | Fix findings, full-save, validate again. Applies to save/preview/release/rollback. |
| 422 | `UI_LAYOUT_PAYLOAD_TOO_LARGE` | Reduce final renderer payload below 262,144 bytes, leaving metadata headroom. |
| 429 | `UI_PREVIEW_RATE_LIMITED` | Stop rapid retries; wait for the rate-limit window. |
| 502 | `UI_ASSET_STORAGE_INVALID` | Provider returned unusable media metadata; preserve work and report request ID. |
| 503 | `UI_LAYOUT_RELEASE_DISABLED` | Deployment feature gate; cannot be fixed in the layout JSON. |
| 503 | `UI_SCHEDULE_UNAVAILABLE` | Server scheduling configuration unavailable; do not silently publish now instead. |
| 503 | `UI_LAYOUT_PUBLICATION_MISSING` | Backend consistency/availability issue; keep customer good cache and report. |
| 5xx/other | `UI_LAYOUT_REQUEST_FAILED` or unknown shape/code | Generic safe failure handling; recover keyed operations without duplicating them. |

Do not depend on a fixed error precedence when several fields/state conditions are wrong; correct the specific returned issue and refresh stale state.

### 22.3 Validation finding codes

These are `data.errors[].code` or `error.details[].code`, not necessarily top-level HTTP codes:

| Codes | Meaning |
| --- | --- |
| `INVALID_OBJECT`, `UNKNOWN_FIELD`, `REQUIRED` | Wrong object shape, extra field, or missing required field. |
| `INVALID_STRING`, `INVALID_BOOLEAN`, `INVALID_INTEGER`, `INVALID_ENUM` | Invalid type/value/length/range. |
| `INVALID_UUID`, `DUPLICATE_ID`, `DUPLICATE_KEY` | Bad or duplicated element identity. |
| `INVALID_COLOR`, `INVALID_HTTPS_URL` | Invalid color or public HTTPS URL. |
| `INVALID_REFERENCE_ID`, `INVALID_SCREEN`, `URL_HOST_NOT_APPROVED` | Unsupported action destination. |
| `IMAGE_REQUIRED`, `INVALID_ITEMS` | Conditional promo image or published dynamic-item array requirement. |
| `UNSUPPORTED_SECTION`, `DUPLICATE_BUILTIN`, `BUILTIN_DATA_UNSUPPORTED` | Renderer contract violation. |
| `INVALID_SECTIONS`, `DUPLICATE_POSITION` | Section count or ordering violation. |
| `INVALID_NAVIGATION`, `INVALID_NAVIGATION_ITEM`, `DUPLICATE_NAVIGATION`, `DUPLICATE_ORDER`, `HOME_NAVIGATION_REQUIRED` | Fixed navigation tuple/count/order/Home rule. |
| `INVALID_FAB` | Unsupported stored chatbot setting/action. |
| `INVALID_TARGET_LIST`, `INVALID_APP_VERSION`, `INVALID_APP_VERSION_RANGE` | Target list/version syntax/range. |
| `UNSUPPORTED_SCHEMA_VERSION` | Stored schema cannot be released by this backend. |
| `ASSET_NOT_READY`, `REFERENCE_NOT_PUBLIC` | Reference format may be valid, but registered/public resource is unavailable. |
| `GLOBAL_LAYOUT_REQUIRED`, `TARGETING_OVERLAP` | Missing global fallback or equal-priority overlapping scope. |
| `PAYLOAD_TOO_LARGE` | UTF-8 JSON byte size, not character count, exceeds the limit. |
| `INVALID_VALUE` | Request/header/query parsing finding; see its path/message. |

Optional missing config can be saved, but if present it still must have the correct type/value. JSON null is not an empty optional string/object. Unknown fields never become harmless merely because the section is disabled.

## 23. Legacy Home APIs and coordinated cutover

### 23.1 They are still needed today

The current customer app uses static sections and their order from the legacy API. Therefore do not remove those routes or change their response prematurely. New builder operations use separate storage; legacy PATCH cannot save a builder draft and builder publication cannot silently update legacy order.

| Operation | Before cutover | After explicit GET cutover |
| --- | --- | --- |
| GET `/api/v1/home-layout` | Legacy section-order response. | New published data/meta response, targeting/ETag/304 behavior. |
| PATCH `/api/v1/home-layout` | Legacy order update. | Still legacy order update; does not update the new published layout. |
| GET `/api/v1/ui-layouts/customer_home` | New contract available for integration. | Same new contract; useful without changing endpoint. |
| New admin builder routes | Draft/version lifecycle, super-admin only. | Same lifecycle. |

The switch is server `UI_BUILDER_PUBLIC_CUTOVER_ENABLED=true`, not a query, user setting, catalog mutation, or PATCH field. This is a shared endpoint cutover, not automatic routing by customer app version. Old clients still calling it can break if switched before they support the new shape. A compatibility strategy for any remaining old clients must be explicitly agreed before enabling it.

### 23.2 Legacy GET example

```http
GET /api/v1/home-layout HTTP/1.1
Accept-Language: en
```

Example default customer response 200:

```json
{
  "data": {
    "sections": [
      { "key": "banners", "name": "Banners", "position": 0 },
      { "key": "services", "name": "Services", "position": 1 },
      { "key": "collections", "name": "Collections", "position": 2 },
      { "key": "recommended", "name": "Recommended", "position": 3 },
      { "key": "categories", "name": "Categories", "position": 4 },
      { "key": "shopByUserPet", "name": "Shop By Pet", "position": 5 }
    ]
  }
}
```

`key` identifies the static legacy block, `name` is the language-selected name, and `position` is its order. This is not a builder UUID/type/data record. An authorized super-admin or an admin with HOME_LAYOUT control also receives `name_en` and `name_ar` on each GET item. Legacy GET currently does not return `isVisible`, despite storing it. Existing DB order/names can differ from the default example. On an empty legacy database the service can create its default document; it is not a pure diagnostic read in that case.

### 23.3 Legacy PATCH example

Requires the existing permitted admin/super-admin token and HOME_LAYOUT control rules; new builder routes are stricter super-admin-only.

```http
PATCH /api/v1/home-layout HTTP/1.1
Authorization: Bearer <permitted_admin_access_token>
Content-Type: application/json
```

```json
{
  "sections": [
    { "key": "services", "position": 0 },
    { "key": "banners", "position": 1 },
    { "key": "collections", "position": 2 },
    { "key": "recommended", "position": 3 },
    { "key": "categories", "position": 4 },
    { "key": "shopByUserPet", "position": 5 }
  ]
}
```

Response 200 for the default stored names:

```json
{
  "data": {
    "sections": [
      { "key": "services", "name_en": "Services", "name_ar": "الخدمات", "position": 0, "isVisible": true },
      { "key": "banners", "name_en": "Banners", "name_ar": "البانرات", "position": 1, "isVisible": true },
      { "key": "collections", "name_en": "Collections", "name_ar": "المجموعات", "position": 2, "isVisible": true },
      { "key": "recommended", "name_en": "Recommended", "name_ar": "موصى به", "position": 3, "isVisible": true },
      { "key": "categories", "name_en": "Categories", "name_ar": "الأقسام", "position": 4, "isVisible": true },
      { "key": "shopByUserPet", "name_en": "Shop By Pet", "name_ar": "مناسب للحيوان الخاص بك", "position": 5, "isVisible": true }
    ]
  }
}
```

Legacy request requires a nonempty sections array, string key, and nonnegative integer position. It updates positions of known stored keys only. Unknown keys do not create sections; omitted sections remain, unlike the new full replacement PATCH. It does not update section names, visibility, navigation, custom data, drafts, or versions. Send explicit valid unique ordering even though the legacy validator does not provide the new builder's full uniqueness protections. Its responses/errors do not follow all new builder metadata/error conventions.

### 23.4 Coordinated rollout sequence

1. Deploy reviewed backend code without prematurely enabling public cutover; preserve the legacy frontend behavior.
2. Configure/verify server publication, Mongo transactions, media storage, Redis, and the separate publishing worker in the intended environment. Secrets stay server-side.
3. Wire the super-admin editor to the new routes and pass the acceptance checklist.
4. Wire customer rendering, navigation, context headers, caching/fallbacks, and preview mode; test using `/ui-layouts/customer_home`.
5. Publish and verify a complete initial global version in the intended environment. Do not assume legacy sections were imported automatically.
6. Agree on remaining old-client compatibility and rollback procedure. Prefer keeping the new app on the new endpoint if no shared legacy cutover is needed.
7. Only if required and safe for affected clients, enable the coordinated legacy GET cutover. Clear/isolate old-format local cache entries; parse the new shape.
8. Disable the legacy ordering editor for clients using the new renderer so it cannot misleadingly appear to update their live layout.
9. Retire legacy endpoints/storage only through a separately confirmed removal/migration after old clients no longer require them. They have not been removed by this implementation.

Rollback of a published version and rollback of the endpoint cutover are different operations. A version rollback preserves the new response shape. Disabling cutover restores legacy GET behavior but does not delete builder versions or reconstruct legacy order from them. Do not combine these actions implicitly.

## 24. Complete use-case playbooks

The requests and full DTOs above are reusable building blocks. Follow the relevant sequence below; do not concatenate alternative examples as if they were one chronological session. In every release playbook, publication must be enabled in the target environment and local unsaved work must first be synchronized.

### 24.1 First-ever Home with no external artwork

1. Authenticate as super-admin and fetch catalog.
2. Create blank, store returned draft ID and revision 1.
3. Add a supported built-in, valid section UUID/name/position and `data: {}`; add enabled Home navigation; keep global targeting.
4. Full PATCH with If-Match 1 and a fresh mutation UUID; store returned revision 2.
5. Validate; require valid true for revision 2.
6. Create/read preview of revision 2, if the app has a preview renderer. This is not a published version.
7. Obtain admin confirmation/reason, publish now with revision 2 and a fresh idempotency key.
8. Retain version ID; read public under guest and logged-in contexts; check shape/rendering/cache behavior.
9. Confirm legacy GET is still legacy before any coordinated cutover.

No image upload, entity creation, layout-parent creation API, or review approval API is needed for this minimal path.

### 24.2 Add a promo and curated item grid

1. Open/clone an editable draft and retain current revision.
2. Upload artwork or select a ready library image; retain exact `url` separately from asset ID.
3. Select actual category/product/brand IDs from existing domain pickers, or use the supported screen/approved URL action.
4. Add the promo and dynamic examples from 11.3–11.4 to the full section array. Keep existing IDs/configuration and assign consecutive unique positions.
5. Preserve complete navigation, targeting, optional FAB, draft name/note in the full PATCH.
6. Await save, adopt normalized order/revision, validate references and conditions.
7. Fix findings through another complete save, not by resending only the failing field.
8. Preview with the intended renderer state; check CTA, individual item taps, See all, cropping, guest visibility, grid and slider variants.
9. Publish or schedule only the acknowledged valid revision; refresh history/public state.

If the uploaded URL is not ready/registered, do not replace it with a guessed CDN link. If the entity is inactive/missing, choose a valid entity or remove the action through a save.

### 24.3 Reorder, toggle, remove, and duplicate

- **Reorder sections:** move records locally without changing IDs; regenerate consecutive positions; full-save.
- **Reorder navigation:** keep each fixed tuple unchanged; regenerate unique orders; full-save.
- **Toggle custom block/navigation:** change the corresponding `enabled`, retain valid configuration; full-save. Disabled records remain public and require renderer filtering.
- **Remove built-in/custom block:** remove its record from the full array; full-save. Do not call a nonexistent section-delete route.
- **Duplicate custom block:** copy data, generate a new section UUID and unique key if kept, assign a new position. Generate new item IDs for new duplicated item identities; do not duplicate a built-in type.
- **Clear Home accidentally:** saving an incomplete draft is possible, but validation/preview/publication blocks until an enabled Home item is restored.
- **Delete last section:** can save an empty draft, cannot publish it. Existing customers remain on the prior published snapshot.
- **Toggle chatbot preference:** save the FAB object, but show it as a stored future preference, not an effective customer control.

### 24.4 Next edit after publication

1. Read history and choose the desired active scope/version rather than assuming the newest row is global.
2. Create `source.type: published` with that version ID.
3. Store the new draft ID/revision 1; content/targeting/FAB are copied, but release history stays immutable.
4. Edit/full-save/validate/preview/publish using the new draft.
5. With exact targeting unchanged, the old version in that scope is superseded; other scopes stay active.

An old preview of the previous draft remains its own snapshot until expiry/revoke; it does not become a preview of the new draft.

### 24.5 Target a language/platform/country/audience

1. Ensure a live global fallback exists.
2. Clone its version or create a complete new draft.
3. Set complete targeting, exact locale/header vocabulary, and a priority higher than global.
4. Save and validate. If overlap is reported, compare active scopes in history and correct priority/rules deliberately.
5. Publish and read public with matching and nonmatching headers/auth states.
6. Verify the matching customer gets only the targeted snapshot and the others retain global; check locale/account context cache separation.

Targeted text must be authored in that language. There is no automatic bilingual string object or pet-type targeting. Skip location constraints until the identifier mapping is agreed.

### 24.6 Schedule an event, change it, or stop it

1. Prepare a complete saved valid draft; choose a UTC time with at least a two-minute server lead plus practical buffer.
2. Confirm/reason and schedule with a fresh key; mark scheduled, not live.
3. Refresh draft/history at the due time; wait for actual published state/version confirmation.
4. To change content/time or publish now, cancel first; GET the increased revision.
5. Edit/save if needed, revalidate, then schedule/publish with a new key.
6. If cancel loses to publication, inspect the now-live version and rollback/correct through a new release if required.
7. If failure is recorded, cancel to unlock, validate/repair references or overlap, save and schedule anew. Do not erase the failure banner merely because the due time passed.

### 24.7 End a targeted campaign

There is no automatic end-time or active-target removal API. Do not omit a campaign from a global draft and expect that to deactivate its separate scope. Do not change its priority and expect the old active scope to disappear.

With the current contract, the available content-replacement approach is:

1. Find the campaign's exact targeting object, including priority, and current global/default content.
2. Create a new editable draft, copying the desired default content but keeping the campaign's exact targeting.
3. Save/validate/preview/publish or schedule that replacement.
4. The campaign scope remains active, but now serves default-equivalent content instead of campaign content.
5. Verify both the targeted cohort and global cohort. Later global changes will not automatically propagate to this copied targeted snapshot.

This is not scope deletion. If actual deactivation/removal/automatic expiry is required, that is a separate backend requirement to agree before promising it in the editor. Rollback to a previous version of that exact scope is another option when one exists and remains valid.

### 24.8 Rollback after a bad release

1. Identify the affected scope and previous version in history; GET version to review content and targeting.
2. Confirm exact impact and enter a reason.
3. Rollback with a retained fresh idempotency UUID.
4. Observe the new higher-numbered version, not a renumbered old release.
5. Refresh the affected public contexts; other scopes are intentionally unchanged.
6. If old references are invalid, clone/repair/publish a corrected draft instead. Never weaken validation to force a historical snapshot live.

### 24.9 Abandon work without losing it accidentally

For a local-only draft, explicit local discard removes only the device record; no server route exists for its local ID. For a server draft, archive only after confirming whether unsent changes should first be saved/exported/kept locally. A scheduled draft must be canceled before archive. A published version cannot be archived/deleted through these APIs. Assets are not deleted when a draft is abandoned.

### 24.10 Authentication, app restart, and network failures

Pause synchronization on 401; preserve dirty Hive work and pending keyed requests through token refresh/login. On a different account, isolate the prior account's local workspace. Restore pending operations on restart, retry the same keyed operation to recover its outcome, and GET current state before a new action. A 403 requires account permission recovery, not repeated retries. A timeout is uncertain outcome, not proof the server rolled back.

### 24.11 Customer first launch, offline launch, and context change

On first launch with no valid cache and no compatible publication, use an agreed bundled safe Home. On later offline launch use the compatible last-known-good cache. On reconnect revalidate with its ETag. On login/logout, locale, country/location, platform/version, or environment change, change cache namespace and fetch the corresponding layout. If 304 arrives without a body in that namespace, fetch again without ETag. Never promote a preview to last-known-good production Home.

## 25. Integration acceptance checklist

These checks are for FE/backend/QA integration before rollout. Passed backend tests alone do not tick all frontend acceptance boxes.

### Authentication and transport

- [ ] Verified super-admin can use every new admin route; ordinary admin/customer/guest cannot.
- [ ] Expired token recovery preserves unsent work; account/environment changes isolate local records.
- [ ] Data/meta and errors parse without a required success flag; validation false/200 is handled.
- [ ] Empty 204/304, unknown/global error envelope, and non-JSON proxy errors do not crash parsing.
- [ ] API base includes `/api/v1` exactly once; JSON and multipart content types are correct.
- [ ] Required quoted revision and UUID headers are sent and retained before requests.

### Editor and contract

- [ ] All ten built-ins and both custom types use exact names/schemas; unsupported widgets/fields cannot be sent.
- [ ] Built-ins have empty data and cannot repeat; custom IDs/keys/positions are unique.
- [ ] Draft can be incomplete; publish-required fields and conditional dependencies are visible in forms.
- [ ] Promo templates, colors/alpha, image cropping, CTA and authentication visibility render correctly.
- [ ] Dynamic styles/layouts, item order/limit/grid columns, See all, and item actions render correctly.
- [ ] Fixed navigation labels/icons/routes, toggles/order, and mandatory Home are correct.
- [ ] Disabled blocks/navigation remain in backend payload and are filtered by customer/preview rendering.
- [ ] FAB is accurately labeled storage-only; public/preview absence is expected.
- [ ] Full replacement preserves unrelated settings; omitted fields are intentionally removed/reset.
- [ ] Unknown/future schema or section does not crash customer Home.

### Assets and references

- [ ] Multipart single PNG/JPEG/WebP path succeeds; missing/corrupt/oversized/unsupported files fail visibly.
- [ ] Upload response URL is retained exactly; ID is not used as image_url.
- [ ] Original dimensions/byte count are not misrepresented as output properties.
- [ ] Asset-created timestamp caveat is handled, or backend fixes it in a separately verified change.
- [ ] Library paging uses its opaque cursor, not timestamps/version numbers.
- [ ] Selected existing entity IDs are actual ObjectIds; unavailable products/removed references block release correctly.
- [ ] Canonical versus transformed catalog image URL mismatch is covered.
- [ ] Upload timeout recovery does not blindly loop or lose local image selection.

### Synchronization and concurrency

- [ ] Local save survives offline/restart; server acknowledgement is distinguished from device save.
- [ ] Autosaves are serialized; late acknowledgements preserve newer local edits.
- [ ] Identical save retry, including concurrent retry, does not create another revision.
- [ ] Changed payload with reused mutation key is detected, not silently accepted.
- [ ] Two-editor conflict preserves both snapshots and requires explicit resolution.
- [ ] Replayed old responses do not downgrade a newer known revision/current state.
- [ ] Unknown create outcome is reconciled without blind duplicate drafts.
- [ ] Offline publishing/scheduling/rollback is not automatically queued as a new release.

### Preview and release

- [ ] Preview uses the acknowledged revision; stale revision/invalid configuration fails visibly.
- [ ] Preview snapshots stay frozen after edits and never contaminate published caches.
- [ ] Preview expiry/revoke/rate limit are handled; tokens are redacted from logs/analytics.
- [ ] UI does not claim preview hints apply server targeting or automatic translation.
- [ ] Immediate publish changes only the intended scope and freezes the draft.
- [ ] Exact publish/schedule/rollback retries do not create duplicate releases/operations.
- [ ] Required note, release-disabled and scheduling-unavailable paths are handled.
- [ ] Schedule local-time-to-UTC conversion, lead time, pending queue, delayed execution, and failure display are correct.
- [ ] Cancel advances revision; cancellation/publication race and reschedule are correct.
- [ ] History distinguishes multiple active scopes and superseded versions; detail omits status.
- [ ] Rollback creates a new version, checks old references, and preserves unrelated active scopes.

### Targeting, caching, and rollout

- [ ] Initial global publication exists before targeted release/production cutover.
- [ ] Exact header/locale/country/version/audience matching and missing-header fallback are tested.
- [ ] Equal-priority overlap blocks; exact-scope replacement and priority-change new-scope behavior are understood.
- [ ] Location namespace is agreed before enabling location targeting; pet targeting is not invented.
- [ ] Public 200/304 and context-aware cache isolation are tested across guest/login/logout/locale changes.
- [ ] First/offline launch, image/destination failures, and last-known-good fallback work.
- [ ] Customer refresh after publication/rollback obtains the intended new snapshot without stale-epoch reuse.
- [ ] Legacy GET/PATCH behavior remains compatible until a coordinated cutover.
- [ ] Production worker supervision/restart/shutdown, Redis/media/Mongo environment, monitoring, and admin failure notification are accepted separately.
- [ ] Load, security, privacy, mobile rendering, and actual release-environment acceptance have their own evidence; local backend tests are not presented as that evidence.

## 26. Current limitations and outstanding integration decisions

### 26.1 Asset timestamp serialization

The asset service emits `created_at` using `toISOString()` with milliseconds, such as `2026-10-01T10:00:00.000Z`. The main application's JSON replacer currently converts strings of that exact millisecond-UTC pattern to Cairo local clock strings **without a timezone suffix**, for example `2026-10-01T13:00:00.000` for that instant. Most UI layout service timestamps strip milliseconds first and remain UTC with `Z`.

Consequently, route-level/harness asset JSON and mounted main-server asset JSON can differ. Do not interpret the offsetless asset timestamp as UTC, append `Z`, or use it as a schedule/cursor input. Other layout timestamps remain the preferred canonical UTC examples here. Display conversion depends on the actual date/timezone rules, not a hardcoded permanent +3-hour assumption. A consistent timestamp fix needs a separate code change/verification; this documentation task has not changed the serializer.

### 26.2 Canonical existing image URLs

Reference validation compares exact registered/stored URLs. Product DTOs commonly expose images as `{id, url}`; category DTOs can expose an image object with a delivery-transformed URL; brand DTOs can expose an image string. A Cloudinary transformed URL can differ from the stored `image.url` even though it displays correctly, causing `ASSET_NOT_READY`.

Do not reverse-engineer or strip transforms on the FE. Prefer builder-upload URLs, or coordinate a canonical selectable-image URL contract with the backend before using transformed catalog picker URLs. Publication validation confirms DB reference readiness, not an HTTP fetch of every CDN object.

### 26.3 Decisions before enabling particular features

| Topic | Settled/current behavior | Still requires agreement or acceptance |
| --- | --- | --- |
| Editor host | Super-admin mobile app. | Actual screen/navigation/Hive wiring and QA. |
| Customer integration | Current app still uses static/legacy ordering; new endpoint available. | Renderer, navigation, preview entry, context cache, compatible cutover. |
| Images | One-step multipart, library ready URLs. | Existing transformed catalog URL selection and desired renderer cropping. |
| Location | Syntax/equality targeting only. | Exact shared business ID namespace and source in both apps. |
| Country/locale | Exact header matching; locale language fallback. | Consistent app-selected sources and supported values. |
| Chatbot | Preference saved privately in draft/history, omitted publicly. | Public renderer support before turning it into an effective toggle. |
| Remote preview flag | Backend exists; catalog still false. | Customer preview entry and capability update through a separate verified change. |
| Schedules | Durable accepted snapshot, worker revalidation/reconciliation. | Production supervision/health/late-publication handling and actual failure alert delivery. |
| Campaign ending | Replace exact scope's content; no deactivation/expiry endpoint. | Additional lifecycle requirement if genuine scope removal/end-time is needed. |
| Review roles | Super-admin directly publishes; no submit/approve/reject. | Separate confirmed requirement before any review-workflow UI/API. |
| Localization | Literal strings or separate locale-targeted snapshots. | No multilingual object/translation service promised. |
| Pet personalization | Existing built-in runtime behavior. | No configurable pet-type/prime-location targeting in v1. |
| Safety/performance | Local focused/integration backend checks passed. | Actual mobile, deployment, load/security/monitoring release acceptance. |

These limitations are intentionally visible so the FE does not wire proposed but absent features or mistake a server configuration flag for a client field. This document describes current behavior; it does not authorize modifying infrastructure, deleting live data, enabling cutover, or expanding the schema.

### 26.4 Important non-features

No arbitrary component tree, arbitrary screen route, executable HTML/JS, client-owned data fetch expressions, upload slot/completion, asset delete, draft restore, version edit/delete, review workflow, percentage targeting, pet-rule targeting, campaign end-time, active-scope delete, server-assisted three-way merge, full security analytics, or automatic legacy import exists in this contract. Local draft creation/upload/preview creation are not deduplicated by release keys.

The backend caps content and the final publication payload at 256 KiB, sections at 30, and dynamic items at 20 per section. The catalog's generic schemas do not fully express conditional rules, reference availability, or overlap. Always keep server validation as the final authority.

## 27. Backend source map and maintenance

Paths below are relative to the repository root so this guide remains portable when sent to the FE. They are implementation references, not additional request fields.

| Source | Contract responsibility |
| --- | --- |
| `src/app/routes.js` | Router prefixes/mount points and public preview mounting. |
| `src/app/server.js` | JSON parser, language middleware, CORS, request IDs, and timestamp JSON replacer. |
| `src/shared/utils/egyptTimezone.js` | Actual millisecond-UTC to offsetless Cairo timestamp serialization. |
| `src/domains/uiLayout/uiLayout.routes.js` | Exact method/path combinations and ordered attachment of authentication, guards, upload middleware, validators, controllers, and error middleware. |
| `src/domains/uiLayout/uiLayout.limiters.js` | Independent preview read/create rate limits and their existing 429 response contract. |
| `src/domains/uiLayout/uiLayout.middleware.js` | Bounded multipart parsing, publication release guard, and domain error-envelope handling. |
| `src/domains/uiLayout/uiLayout.error.js` | Operational domain errors shared by HTTP and worker paths. |
| `src/domains/uiLayout/uiLayout.controller.js` | Validated input handoff, authenticated actor context, response envelopes, HTTP codes, and cache headers. |
| `src/domains/uiLayout/uiLayout.validators.js` | Endpoint middleware validates/normalizes IDs, revision/key headers, query parameters, preview/public context, and allowed request keys before controllers. |
| `src/domains/uiLayout/uiLayout.constants.js` | Shared supported values, ID/version/locale patterns, schema version, and layout/upload limits. |
| `src/domains/uiLayout/uiLayout.catalog.js` | Editor catalog schemas and live publication/scheduling capabilities. |
| `src/domains/uiLayout/uiLayout.contract.js` | Pure section/action/navigation/FAB/target validation, publish conditions, normalization, public FAB omission. |
| `src/domains/uiLayout/uiLayout.targeting.js` | Target defaults, scope identity, global rule, overlap, eligibility/ranking. |
| `src/domains/uiLayout/uiLayout.service.js` | Business validation, transactions, locks, retry replay, preview, publication/schedule/rollback/history/audit/public selection; direct model access remains the persistence layer. |
| `src/domains/uiLayout/uiLayout.release.service.js` | Immediate/scheduled release orchestration, including enqueue failure recovery without undoing an accepted schedule. |
| `src/domains/uiLayout/uiLayout.serialization.js` | Pure draft/version/public/asset response mapping and existing timestamp formatting. |
| `src/domains/uiLayout/uiLayout.references.js` | Exact ready image/catalog entity reference checks. |
| `src/domains/uiLayout/uiLayout.assets.js` | Upload limits/format/reference record and library response/paging. |
| `src/shared/utils/imageUpload.js` | Shared image conversion/provider delivery used by builder uploads. |
| `src/domains/uiLayout/uiLayout.pagination.js` | Opaque draft/asset/audit cursor implementation. |
| `src/domains/uiLayout/uiLayout.model.js` | Stored statuses, snapshots, immutable versions, active pointers, operation records, previews/assets/audit. |
| `src/domains/uiLayout/uiLayout.queue.js` | Queue configuration, retry/reconciliation timings, scheduled jobs. |
| `src/domains/uiLayout/uiLayout.jobs.js` | Due execution, terminal failure recording, audit and in-app failure notification. |
| `src/workers/uiLayoutPublish.worker.js` | Separate worker process lifecycle. |
| `ecosystem.ui-layout.config.cjs` | Separate server process-supervision template; not a FE configuration file. |
| `src/domains/auth/auth.middleware.js` | Existing auth/role/account protection. |
| `src/domains/homeLayout/homeLayout.routes.js` | Preserved legacy routes and gated GET cutover. |
| `src/domains/homeLayout/homeLayout.service.js` | Actual legacy default/read/order-update behavior. |
| `test/domains/uiLayout/` | Focused backend contract/service/HTTP/worker/reference/asset checks. |
| `scripts/testUiLayoutMongoIntegration.js` | Guarded copied-database HTTP/media/local Redis/separate worker integration checks. |
| `UI_BUILDER_BACKEND_HANDOFF.md` | Backend checkpoint and verification/release boundaries. |
| `UI_BUILDER_FE_RECONCILIATION.md` | Historical proposal reconciliation; source and this checked guide take precedence if an older summary differs. |

### Documentation verification and future changes

For this guide, compare every route/body/DTO against these sources. JSON examples use valid syntax; reference fixtures are clearly illustrative and must be replaced by actual IDs/URLs/keys/times. Examples with no external references can be checked with the pure content/targeting validators without touching MongoDB/media/Redis.

When a contract changes, update the field dictionary, all affected examples, sequence prerequisites, retry/recovery behavior, capability meanings, acceptance checklist, and this checked date together. A new route or extra field requires confirmed scope and implementation; merely adding it to this document does not create backend support.

Do not rerun guarded integration scripts casually on `.env` infrastructure. Use only explicitly approved copied/test Mongo targets with host/database guards and isolated Redis prefixes; provider writes require their own approval and cleanup. Credentials must never be copied into this guide. The completed local backend checks do not authorize production test writes, deployment, cutover, commits, or pushes.
