# UI Builder publishing blockers — backend response

Date: 2026-10-16. Timezone: Africa/Cairo; evidence timestamps below are UTC (`Z`).
Input: `UI_BUILDER_PUBLISH_BLOCKERS_REQUEST_2026-10-16.md`, read in full.

## 1. Summary and current status

**Backend configuration corrected; frontend revalidation remains required.**

The server had general publication enabled, but neither compatible customer-version floor was configured. This deliberately allowed ordinary sections while disabling release of ID-only custom blocks, carousel images and subcategory actions. It was not a missing implementation or a payload-size failure.

The owner relayed these exact frontend confirmations:

- Current live customer app: **5.1.8**, without this feature.
- First customer app supporting custom blocks, multi-image carousel banners and subcategory actions together: **5.1.9**.
- Current final-test customer version: **5.1.9**. A separate build number was not supplied.

Both backend floors are now **5.1.9**. The old 2.1.1 screenshot value is not the approved floor and must not be used. Publication of incompatible layouts remains blocked; validation was not weakened.

No draft, targeting, content, preview or publication record was modified by this investigation. The custom `new test` draft is currently **archived**, so the frontend must use an editable draft/copy through the existing workflow. No layout was published.

## 2. Environment and evidence

### Deployed source and service

| Item | Observed value |
| --- | --- |
| Primary API origin | `https://api.petyardstores.com` |
| API base | `https://api.petyardstores.com/api/v1` |
| Deployed checkout | `/root/Petyard` |
| Deployed Git revision | `402dce99c4213f49823f6cefcf31c08ab035044f` |
| Revision subject | `fix(cors): allow localhost:8080 in production` |
| Initial server Git status | Clean before the authorized configuration correction. |
| Final API process | `petyard`, PM2 ID 9, correct `src/app/server.js`, online; started `2026-10-16T16:40:57.380Z`. |
| Final UI worker | `petyard-ui-layout-publish-worker`, PM2 ID 8, correct `src/workers/uiLayoutPublish.worker.js`, online; started `2026-10-16T16:40:32.346Z`. |
| Final module/database evidence | `2026-10-16T16:42:34.415Z` |

The final check showed zero restarts for the newly restored API and UI worker entries. Other application workers were not restarted.

A later stability check at `2026-10-16T16:45:51.252Z` confirmed the same PIDs, zero restarts, the UI worker's successful `Started` marker and another HTTP 200 for app 5.1.8 selecting unchanged Home version 14, request ID `57d8a44c-21c2-4840-8b10-d04d401a482b`. Local/server `.env` contents also matched after newline normalization; the server's only Git modification was `.env`.

### Evidence boundary: catalog

The full deployed catalog was evaluated from the deployed source with the server configuration and the process startup environment. The pre-change `.env` modification time preceded API startup; after correction the API and worker were restarted to load the changed file.

The complete resulting object and provenance are in [the catalog evidence JSON](UI_BUILDER_PUBLISH_BLOCKERS_CATALOG_EVIDENCE.json). This is **not an authenticated HTTP response capture** and is not represented as one. No valid superAdmin token was available in the connected Production Postman environment. Authentication was not bypassed or fabricated.

An unauthenticated request to the primary catalog endpoint at `2026-10-16T16:25:14.645Z` correctly returned HTTP 401, request ID `7695118d-952f-4701-bdb7-6b71fb7c8ef0`, with `Cache-Control: no-store`. Its actual response was:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Please login first",
    "request_id": "7695118d-952f-4701-bdb7-6b71fb7c8ef0",
    "details": []
  }
}
```

The successful authenticated catalog contract remains `{data: <catalog>, meta: {request_id: ...}}`. FE must capture a fresh successful response from its authenticated session to close the session/cache evidence gap.

### Requested catalog fields: before and after

Types below are JSON types, not string representations of booleans.

| Field | Before correction | After correction | Type |
| --- | --- | --- | --- |
| `schema_version` | 1 | 1 | number |
| `product_reference_formats` | `["id_only_v1"]` | Same | array of strings |
| `section_types` composed entry | Present; key `composed_section`, repeatable true, requires `id_only_v1` | Same | object in array |
| `capabilities.product_id_draft_storage` | true | true | boolean |
| `capabilities.product_id_references` | false | true | boolean |
| `capabilities.component_tree_draft_storage` | true | true | boolean |
| `capabilities.component_tree` | false | true | boolean |
| `capabilities.banner_carousel_draft_storage` | true | true | boolean |
| `capabilities.banner_carousel` | false | true | boolean |
| `capabilities.subcategory_actions_draft_storage` | true | true | boolean |
| `capabilities.subcategory_actions` | false | true | boolean |
| `capabilities.publish_now` | true | true | boolean |
| `capabilities.scheduled_publish` | true | true | boolean |
| `id_only_min_app_version` | null | `"5.1.9"` | null → string |
| `extensions_min_app_version` | null | `"5.1.9"` | null → string |
| `limits.max_banner_images` | 10 | 10 | number |

The full composed schema is in the evidence JSON; its source/profile contract did not change. Scheduled capability reflects configured queue support, not proof of a new end-to-end scheduled publication.

### Effective policy

| Variable | Before | After |
| --- | --- | --- |
| `UI_BUILDER_PUBLISH_ENABLED` | `true` | `true` — unchanged |
| `UI_BUILDER_ID_ONLY_MIN_APP_VERSION` | Absent | `5.1.9` |
| `UI_BUILDER_EXTENSIONS_MIN_APP_VERSION` | Absent | `5.1.9` |
| `UI_BUILDER_PUBLIC_CUTOVER_ENABLED` | `false` | `false` — unchanged |

The two new values are encrypted with the existing dotenvx key. Private key files were not changed or exposed. Local and server configuration received the same encrypted additions. These new configuration changes are not yet committed or pushed.

The catalog mapping is intentional: core release capabilities require publication enabled plus a valid core floor; carousels require publication enabled plus both floors; subcategory actions require publication enabled plus the extension floor. Draft-storage capabilities are separate.

### Environment routing

The connected Production Postman environment still names `https://petyard.duckdns.org`. Its catalog probe timed out; it is not evidence for the primary origin. No Postman URL was changed. FE should confirm that its session actually uses `https://api.petyardstores.com/api/v1` and reload that environment's catalog.

## 3. Finding-by-finding diagnosis

| Finding | Status and evidence | Owner / resolution |
| --- | --- | --- |
| Core `LOCAL_CLIENT_VERSION_UNSUPPORTED` | **Changed and verified** for server configuration. Missing core floor produced a real backend compatibility finding. Core catalog release capabilities are now true. Existing saved minimum `2.2.2` remains below the approved `5.1.9`. | Backend configuration corrected. FE must save approved targeting in an editable draft. |
| Extension `LOCAL_CLIENT_VERSION_UNSUPPORTED` | **Changed and verified** for server configuration. Missing extension floor separately produced a backend compatibility finding. The saved section uses two-image carousel content and subcategory actions. | Backend configuration corrected. FE must use minimum >=5.1.9 and a fresh catalog. |
| `LOCAL_BANNER_CAROUSEL_RELEASE_UNSUPPORTED` | **Changed and verified** at the deployed-module boundary: actual pre-change value false, now boolean true. | FE must confirm its fresh authenticated HTTP catalog also contains boolean true. A cached/mismatched session remains **Not yet verified**. |
| `LOCAL_VERSION` / associated `VERSION` message | **Not yet verified** in frontend. Exact ASCII `2.1.1`, `5.1.9` and the actual saved `2.2.2` are syntactically valid. No hidden character exists in the inspected server values. | Admin FE owns reproduction against its exact checked snapshot and fresh validation. Do not blame the operator or relax the parser without that evidence. |
| Ordinary sections publish; custom sections do not | **Confirmed** in stored data. Version 14 contains only ordinary sections and no ID-only/custom/carousel content. Custom release invokes extra checks; this was not a global publication outage. | No ordinary-section code change required. |
| Reported renderer size 2974/262144 | Below the limit as reported; the inspected saved content also passes completed-content structural validation. | Not the observed blocker. No payload limit increase made. |

Standalone `CLIENT_VERSION_UNSUPPORTED` and `VERSION` display lines are messages associated with findings, not additional independent backend errors.

### Actual draft identity and raw values

Two stored drafts have the name `new test`. Name-only identification is unsafe:

| Draft ID | Revision | Status | Content |
| --- | --- | --- | --- |
| `84e6e11d-f3a6-4489-8cfc-e689fca726b0` | 28 | archived | Custom `id_only_v1` layout; one two-image carousel and subcategory actions. |
| `81fdf0c0-5bd8-4a35-ad9c-cee8d8767755` | 8 | draft | Older ordinary-section layout, not the reported custom content. |

The custom draft's current raw JSON is:

```json
{"min_app_version":"2.2.2","max_app_version":"6.0.0"}
```

- Minimum code points: `U+0032 U+002E U+0032 U+002E U+0032`.
- Maximum code points: `U+0036 U+002E U+0030 U+002E U+0030`.
- Both are strings with ordinary ASCII digits/dots and no hidden characters.

This differs from the screenshot's `2.1.1`. It proves only the later stored value, not which local snapshot produced the screenshot finding.

The revision-28 save audit is timestamped `2026-10-16T08:38:03.429Z`, request ID `2738a14b-f232-4d1c-bd93-f09ea2fc7ccb`. The following validation at `08:38:04.041Z`, request ID `e68a86c6-8ed5-44b5-867c-5a6c16d3facd`, records revision 28, `valid:false`, and exactly two `CLIENT_VERSION_UNSUPPORTED` codes. The latest recorded validation therefore used that acknowledged revision. Historical audit does not retain the full HTTP status/response body or every historical targeting value.

The draft was archived at `2026-10-16T13:57:28.247Z`, request ID `afbb8f4c-6f11-4a5e-8782-b3a2b45f01bf`. No unarchive, copy or content deletion was performed here.

No publication audit event was found for that draft. This does **not** prove a rejected publish request was never attempted: failed requests may not create publication audit events. FE must inspect its network history to distinguish local blocking from an actual HTTP rejection.

## 4. Approved customer versions and targeting

The owner confirms first support is **5.1.9**, with live **5.1.8** lacking support. A pre-release build is sufficient for authorized testing; store release is not required to prove renderer compatibility. That does not authorize publishing arbitrary test content to real customers.

For a layout using these features:

```json
{"min_app_version":"5.1.9","max_app_version":"6.0.0"}
```

This is a **targeting fragment**, not a complete PATCH body. Use the existing full snapshot contract. The minimum may be later if intentional; it must not be earlier than 5.1.9.

The existing maximum `6.0.0` was preserved, not newly approved or removed. Its business intent still belongs to the layout/release owner; future apps above that maximum will not match.

Backend checks confirm that targeting this version range excludes 5.1.8, 2.1.1, 2.2.2, missing versions and versions above the unchanged maximum, while accepting 5.1.9. Compatible fallback remains available. Build number, signed build identity and physical platform/RTL/rendering results were not supplied or independently verified.

## 5. Changes made

1. Added only the two encrypted version-floor settings to local and server `.env`, both set to 5.1.9. Existing publication enablement and legacy cutover values were preserved.
2. Activated the configuration in the API and existing UI publication worker. No application validation code, route, required header, request field or response envelope changed.
3. Created this response and the separate full catalog evidence artifact. They do not replace the FE's need to capture its fresh authenticated catalog response.

### Restart incident and recovery

During activation, my first restart command incorrectly forwarded API process metadata to the UI worker, creating a duplicate API process and an API restart loop. I detected it immediately in process verification. The incorrect worker/API entries were removed, then the UI worker and API were restored from their existing ecosystem configurations. Their final correct roles, stable process identities and successful public responses were verified afterward. Other workers were left running. No layout was published or changed during this incident.

The final runtime processes and startup timestamps are recorded in section 2. This incident is not presented as a successful first-attempt restart or hidden from the deployment evidence.

## 6. Test results

| Check | Result / evidence |
| --- | --- |
| Exact source/environment revision | **PASS** — deployed source and clean starting Git status inspected. |
| Missing floors reproduce two backend findings | **PASS** — deployed compatibility function against the real saved custom content. |
| Encrypted values decode to 5.1.9 | **PASS** — local/server value checks; existing key reused. |
| Core/carousel/subcategory catalog capabilities true | **PASS** — deployed-module evaluation after correction. |
| Authenticated HTTP catalog from affected FE session | **NOT RUN** — valid token unavailable; FE capture still needed. |
| Original saved content structure/targeting syntax | **PASS** — current saved snapshot, no writes. |
| Original saved Product/subcategory/media references | **PASS** — real database lookups through existing reference validator; no findings. |
| Unchanged saved minimum 2.2.2 after correction | **EXPECTED BLOCK** — two findings correctly require >=5.1.9. |
| In-memory copy with minimum 5.1.9 | **PASS** — same content/references, no compatibility findings; global fallback exists, no same-priority overlap. This was not saved or published. |
| Old/missing/out-of-range versions protected | **PASS** — focused compatibility/target-selection assertions. |
| Existing extension regression file | **PASS** — five tests, zero failures/skips. |
| No unexpected publication activation | **PASS** — no active extended publication or scheduled draft before change; no schedule afterward; current public version unchanged. |
| Primary API after recovery, app 5.1.8 | **PASS** — HTTP 200; request ID `00255b5e-99f6-4861-8113-0b6f30d14844`. |
| Primary API after recovery, app 5.1.9 | **PASS** — HTTP 200; request ID `07c01552-510b-4c13-8c0a-0f2cd974b25f`. |
| Existing public layout unchanged | **PASS** — both responses selected version 14, ID `337142fe-64c0-4162-8828-234693017bc6`, with ordinary sections only. |
| Fresh HTTP validate of an editable FE draft | **NOT RUN** — no draft write or validation-audit write performed; inspected custom draft is archived. |
| Original frontend `LOCAL_VERSION` reproduction | **NOT RUN** — exact FE checked snapshot/session unavailable. |
| Independent text-only/single-image/carousel/product A–I workflow | **NOT RUN end-to-end** — existing focused tests cover backend structures; no live test copies/publications created. |
| Customer 5.1.9 renderer/scrolling/EN/AR/RTL/variants | **NOT RUN** — frontend/device owner acceptance required. |

The real-draft checks invoked validators directly with read-only database queries. They did not call the mutating validation endpoint and are not mislabeled as its HTTP response.

## 7. Remaining actions

- **Admin FE:** reload the catalog from the correct primary API, retain the actual response/request ID, and verify true booleans and both 5.1.9 floors. Reproduce any remaining version-format finding using raw current strings and character code points.
- **Admin FE/operator:** identify an editable custom draft by ID. The inspected custom draft is archived; the older same-name draft is unrelated. Preserve content when creating an independent editable copy through the normal workflow. There is no new unarchive endpoint.
- **Layout owner:** set the intended editable draft's minimum to 5.1.9 or later; confirm whether maximum 6.0.0 is intentional. Do not publish without the normal explicit approval.
- **Customer FE/release owner:** record the 5.1.9 build number, tested platforms and actual rendering/navigation/RTL results. The feature implementation is not being requested again.
- **Backend/repository owner:** commit/push the encrypted configuration additions and evidence documents when requested. Server `.env` now has the same two uncommitted additions as the local checkout; review this before a future pull rather than overwriting either file blindly. No commit/push was performed in this correction.

## 8. Exact operator steps

1. Use the customer test app version **5.1.9**. Keep installed live 5.1.8 as a fallback/compatibility test, not a custom-section renderer.
2. Reopen the admin editor or explicitly refresh `GET /api/v1/admin/ui-builder/catalog` at the primary API. Confirm both version fields are `"5.1.9"` and core/carousel/subcategory release flags are JSON boolean true.
3. Open the intended **editable** draft by ID, preserving its sections, image URLs, translations and exact Product manifest. Do not try to edit/publish archived ID `84e6e11d-f3a6-4489-8cfc-e689fca726b0` as if it were still draft status.
4. Set `targeting.min_app_version` to exact ASCII **`5.1.9`**. Keep the existing maximum unless its owner approves a different range. Do not raise the minimum randomly to hide an error.
5. Save the entire authored snapshot through the existing PATCH, using quoted `If-Match` from the latest acknowledged revision and the normal logical-save mutation UUID. Do not send the small targeting fragment alone.
6. Retain the returned draft ID, revision and acknowledged targeting. Run `POST /admin/home-layouts/drafts/:id/validate` with `{}` and inspect `data.valid`, complete findings and returned revision—not only HTTP 200.
7. If the same `LOCAL_VERSION` remains while the exact checked value is `5.1.9`, capture raw string/code points, fresh catalog and local/server revisions for the admin FE. Do not keep changing server flags: the backend format and compatibility checks pass for this exact value.
8. Issue a new authorized preview for the saved revision. Verify custom content, carousel behavior and destination navigation on the real 5.1.9 customer build. An old preview is immutable and will not track later saves.
9. Only then use the normal owner-approved publish workflow. Old/missing versions must retain compatible fallback. No publication is required merely to finish this investigation, and legacy Home cutover remains false.
